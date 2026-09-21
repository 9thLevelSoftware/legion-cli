import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  atomicWriteFile,
  canonicalizePath,
  formatMarkdownDocument,
  gitControlDirs,
  isProtectedSetExcluded,
  nextFileId,
  parseMarkdownDocument,
  toPosixPath,
} from "@9thlevelsoftware/legion-cli-persist";
import { TaskSchema } from "@9thlevelsoftware/legion-cli-schema";
import { isAllowedPath } from "./contracts.js";
import { Quarantine, sha256File } from "./quarantine.js";

/** Files up to this size are held as bytes and restored; larger ones are hashed only (KD-1). */
export const PROTECTED_INLINE_MAX_BYTES = 4 * 1024 * 1024;

export type ProtectedEntry =
  | { kind: "file"; size: number; sha256: string; bytes?: Buffer }
  | { kind: "dir" }
  | { kind: "link"; target: string }
  | { kind: "other" };

/**
 * One tree of P. `base` is where writes are anchored: every ancestor between `base` and a path
 * is lstat'ed before anything is written there. Keys are POSIX paths relative to `base`.
 */
export type ProtectedScope = {
  base: string;
  /** Shown in messages and the quarantine manifest (project-relative, or absolute outside). */
  label: (rel: string) => string;
  /** Paths walked (relative to base). */
  roots: string[];
  /** Agent contract roots may exempt paths in this scope (never for git control files). */
  contractScoped: boolean;
  entries: Map<string, ProtectedEntry>;
};

export type ProtectedSnapshot = {
  projectRoot: string;
  scopes: ProtectedScope[];
  takenAt: string;
};

export type ProtectedRestoreResult = {
  /** P paths the agent changed (restored or not), display form. */
  changed: string[];
  /** Changed P paths that could not be restored (listed in the incident). */
  unrestorable: string[];
  /** New task files admitted under the new-task rule (ids, after any re-allocation). */
  admittedTaskIds: string[];
  /** Existing task files whose bytes changed (ids). */
  rewrittenTaskIds: string[];
  /** New task files that failed validation and were quarantined (display paths). */
  rejectedTaskFiles: string[];
  /** True when any P change other than an admitted or rejected new task file happened. */
  incident: boolean;
  quarantine: { dir: string; manifestSha256: string; entries: number } | null;
};

const LEGION = ".legion-cli";
const GIT_CONTROL_ROOTS = [
  "config",
  "config.worktree",
  "commondir",
  "hooks",
  "info",
  "objects/info/alternates",
];

/** Per-submodule control files: `git status` in the superproject reads them (R-21). */
const SUBMODULE_CONTROL_ROOTS = ["config", "config.worktree", "hooks"];

/** `modules/<name>/{config,config.worktree,hooks}` for each submodule git dir (one level). */
async function submoduleControlRoots(gitDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(gitDir, "modules"));
  } catch {
    return [];
  }
  return names.flatMap((name) => SUBMODULE_CONTROL_ROOTS.map((root) => `modules/${name}/${root}`));
}
/**
 * A new task file the copy-out gate admits. The finish must accept exactly the same shape, so a
 * badly named one is quarantined as an invalid task instead of becoming an incident (R-3).
 */
const NEW_TASK_FILE = /^\.legion-cli\/tasks\/(TSK-[^/]*)\.md$/i;

/** The only id shape that may enter the store; anything else is re-allocated (R-3). */
const CANONICAL_TASK_ID = /^TSK-\d{4,}$/i;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function absOf(scope: ProtectedScope, rel: string): string {
  return join(scope.base, ...rel.split("/"));
}

async function readEntry(abs: string, withBytes = true): Promise<ProtectedEntry | null> {
  let st;
  try {
    st = await lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw err;
  }
  if (st.isSymbolicLink()) return { kind: "link", target: await readlink(abs).catch(() => "") };
  if (st.isDirectory()) return { kind: "dir" };
  if (!st.isFile()) return { kind: "other" };
  if (withBytes && st.size <= PROTECTED_INLINE_MAX_BYTES) {
    const bytes = await readFile(abs);
    return { kind: "file", size: bytes.length, sha256: sha256(bytes), bytes };
  }
  return { kind: "file", size: st.size, sha256: await sha256File(abs) };
}

/**
 * lstat-only walk: a link is recorded as a link and never followed. The after-walk only compares
 * sizes and hashes, so it keeps no file bytes (R-5).
 */
async function walkScope(scope: ProtectedScope, withBytes = true): Promise<Map<string, ProtectedEntry>> {
  const out = new Map<string, ProtectedEntry>();
  const visit = async (rel: string, top: boolean): Promise<void> => {
    const entry = await readEntry(absOf(scope, rel), withBytes);
    if (!entry) return;
    out.set(rel, entry);
    if (entry.kind !== "dir") return;
    let names: string[];
    try {
      names = await readdir(absOf(scope, rel));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (top && rel === LEGION && isProtectedSetExcluded(name)) continue;
      await visit(`${rel}/${name}`, false);
    }
  };
  for (const root of scope.roots) await visit(root, true);
  return out;
}

/**
 * P (KD-1): `.legion-cli/**` except cache/, index/, sandbox/, worktrees/ and serve.json; the
 * `.git` file of a linked worktree, `.gitmodules`, `.gitattributes`; and under both the git dir
 * and the common dir: config, config.worktree, commondir, hooks/**, info/**,
 * objects/info/alternates. Taken as the last step before the adapter spawns (KD-15).
 */
export async function snapshotProtected(projectRoot: string): Promise<ProtectedSnapshot> {
  // The real path, so a project reached through a link still anchors ancestor checks inside it.
  const root = canonicalizePath(resolve(projectRoot));
  const projectScope: ProtectedScope = {
    base: root,
    label: (rel) => rel,
    roots: [LEGION, ".gitmodules", ".gitattributes"],
    contractScoped: true,
    entries: new Map(),
  };
  const gitScopes: ProtectedScope[] = [];
  const dirs = gitControlDirs(root);
  const seen = new Set<string>();
  const gitDotEntry = await lstat(join(root, ".git")).catch(() => null);
  if (gitDotEntry && !gitDotEntry.isDirectory()) projectScope.roots.push(".git"); // worktree `.git` file (or a link)
  for (const dir of dirs ? [dirs.gitDir, dirs.commonDir] : []) {
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    const roots = [...GIT_CONTROL_ROOTS, ...(await submoduleControlRoots(dir))];
    if (isInside(root, dir)) {
      const relDir = toPosixPath(relative(root, dir));
      projectScope.roots.push(...roots.map((name) => `${relDir}/${name}`));
    } else {
      gitScopes.push({
        base: dir,
        label: (rel) => toPosixPath(join(dir, ...rel.split("/"))),
        roots,
        contractScoped: false,
        entries: new Map(),
      });
    }
  }
  const scopes = [projectScope, ...gitScopes];
  for (const scope of scopes) scope.entries = await walkScope(scope);
  return { projectRoot: root, scopes, takenAt: new Date().toISOString() };
}

/** JSON form for the control dir (crash replay, PR 6): inline bytes as base64. */
export function serializeProtectedSnapshot(snapshot: ProtectedSnapshot): string {
  return JSON.stringify({
    projectRoot: snapshot.projectRoot,
    takenAt: snapshot.takenAt,
    scopes: snapshot.scopes.map((scope) => ({
      base: scope.base,
      roots: scope.roots,
      contractScoped: scope.contractScoped,
      entries: [...scope.entries].map(([rel, entry]) =>
        entry.kind === "file"
          ? [rel, { kind: "file", size: entry.size, sha256: entry.sha256, ...(entry.bytes ? { b64: entry.bytes.toString("base64") } : {}) }]
          : [rel, entry],
      ),
    })),
  });
}

/**
 * Read a snapshot back from the control dir for crash replay (PR 6). The JSON form is data an
 * unjailed agent could have reached (KD-2's honest limit), so replay never *trusts* it: the
 * replay always fails the last review and blocks the task afterwards, whatever these bytes say.
 * Anything malformed is dropped rather than throwing, so a partly written file still restores
 * what it can.
 */
export function parseProtectedSnapshot(json: string): ProtectedSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const projectRoot = typeof rec.projectRoot === "string" ? rec.projectRoot : null;
  if (!projectRoot || !Array.isArray(rec.scopes)) return null;
  const scopes: ProtectedScope[] = [];
  for (const scopeRaw of rec.scopes) {
    if (!scopeRaw || typeof scopeRaw !== "object") continue;
    const scopeRec = scopeRaw as Record<string, unknown>;
    const base = typeof scopeRec.base === "string" ? scopeRec.base : null;
    if (!base || !Array.isArray(scopeRec.entries)) continue;
    const entries = new Map<string, ProtectedEntry>();
    for (const pair of scopeRec.entries) {
      if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
      const entry = parseProtectedEntry(pair[1]);
      if (entry) entries.set(pair[0], entry);
    }
    const inProject = canonicalizePath(base) === canonicalizePath(projectRoot);
    scopes.push({
      base,
      // The project scope labels paths relative to the root; a control dir outside it is absolute.
      label: inProject ? (rel) => rel : (rel) => toPosixPath(join(base, ...rel.split("/"))),
      roots: Array.isArray(scopeRec.roots) ? scopeRec.roots.filter((r): r is string => typeof r === "string") : [],
      contractScoped: scopeRec.contractScoped === true,
      entries,
    });
  }
  if (scopes.length === 0) return null;
  return {
    projectRoot,
    scopes,
    takenAt: typeof rec.takenAt === "string" ? rec.takenAt : new Date(0).toISOString(),
  };
}

function parseProtectedEntry(value: unknown): ProtectedEntry | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (rec.kind === "dir" || rec.kind === "other") return { kind: rec.kind };
  if (rec.kind === "link") return typeof rec.target === "string" ? { kind: "link", target: rec.target } : null;
  if (rec.kind !== "file") return null;
  if (typeof rec.size !== "number" || typeof rec.sha256 !== "string") return null;
  const bytes = typeof rec.b64 === "string" ? Buffer.from(rec.b64, "base64") : undefined;
  return { kind: "file", size: rec.size, sha256: rec.sha256, ...(bytes ? { bytes } : {}) };
}

function sameEntry(a: ProtectedEntry | undefined, b: ProtectedEntry | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.size === b.size && a.sha256 === b.sha256;
  if (a.kind === "link" && b.kind === "link") return a.target === b.target;
  return true;
}

function depth(rel: string): number {
  return rel.split("/").length;
}

export type RestoreProtectedOpts = {
  runId: string;
  /** The spawn's SkillContract roots (plus FileContract paths); P paths they match are exempt. */
  allowedRoots: readonly string[];
  /** plan/review/verify: a NEW valid `.legion-cli/tasks/TSK-*.md` is admitted (R-2). */
  admitNewTasks: boolean;
  /**
   * A quarantine folder shared with the tree revert (PR 5), so one run has one folder and one
   * manifest. When given, the caller finalizes it after the tree revert has run.
   */
  quarantine?: Quarantine;
};

/**
 * Compare P against the snapshot and put it back, before any git call (KD-1). Per change, in
 * its own try/catch: lstat every ancestor (a link ancestor is quarantined as a link and replaced
 * by a real directory), quarantine the current content (moved when new, copied when changed),
 * and restore the snapshot bytes only if the quarantine succeeded. Fails closed: anything that
 * could not be restored is listed and makes the run an incident.
 */
export async function restoreProtected(
  snapshot: ProtectedSnapshot,
  opts: RestoreProtectedOpts,
): Promise<ProtectedRestoreResult> {
  const quarantine = opts.quarantine ?? new Quarantine(snapshot.projectRoot, opts.runId);
  const result: ProtectedRestoreResult = {
    changed: [],
    unrestorable: [],
    admittedTaskIds: [],
    rewrittenTaskIds: [],
    rejectedTaskFiles: [],
    incident: false,
    quarantine: null,
  };
  const newTaskCandidates: string[] = [];

  for (const scope of snapshot.scopes) {
    let after: Map<string, ProtectedEntry>;
    try {
      after = await walkScope(scope, false);
    } catch (err) {
      result.incident = true;
      result.unrestorable.push(`${scope.label(scope.roots[0] ?? "")} (walk failed: ${describe(err)})`);
      continue;
    }
    const paths = [...new Set([...scope.entries.keys(), ...after.keys()])].sort(
      (a, b) => depth(a) - depth(b) || a.localeCompare(b),
    );
    const handled: string[] = [];
    for (const rel of paths) {
      const before = scope.entries.get(rel);
      const now = after.get(rel);
      if (sameEntry(before, now)) continue;
      // Under a link or a replaced directory that was already dealt with.
      if (handled.some((done) => rel.startsWith(`${done}/`))) {
        if (!before) continue;
      }
      // Only `.legion-cli` paths can be exempted by a contract; git control files never are.
      if (scope.contractScoped && isProtectedLegionPath(rel) && isAllowedPath(rel, opts.allowedRoots)) continue;
      // A new directory is not work by itself; its files are handled one by one.
      if (!before && now?.kind === "dir") continue;
      const display = scope.label(rel);
      const taskMatch = scope.contractScoped ? NEW_TASK_FILE.exec(rel) : null;
      if (taskMatch && !before && now?.kind === "file" && opts.admitNewTasks) {
        newTaskCandidates.push(rel);
        continue;
      }
      if (taskMatch && before?.kind === "file") result.rewrittenTaskIds.push(taskMatch[1] as string);
      result.changed.push(display);
      result.incident = true;
      try {
        await restoreOne(scope, rel, before, quarantine, display);
        if (now?.kind === "link" || (before?.kind === "dir" && now && now.kind !== "dir")) handled.push(rel);
        if (before?.kind === "file" && !before.bytes) {
          // Say what actually happened (R-11): the agent's version is still the live file.
          result.unrestorable.push(
            `${display} (over 4 MiB: the agent's version is still in place, a copy of it is in quarantine — restore the file yourself from git)`,
          );
        }
      } catch (err) {
        result.unrestorable.push(`${display} (${describe(err)})`);
      }
    }
  }

  if (newTaskCandidates.length > 0) {
    await admitNewTasks(snapshot, newTaskCandidates, quarantine, result);
  }

  // Second pass (R-20): a process the agent left behind can write after the compare. Verify only —
  // anything that differs now is reported as unrestorable instead of being restored in a loop.
  for (const scope of snapshot.scopes) {
    let after: Map<string, ProtectedEntry>;
    try {
      after = await walkScope(scope, false);
    } catch (err) {
      result.incident = true;
      result.unrestorable.push(`${scope.label(scope.roots[0] ?? "")} (second walk failed: ${describe(err)})`);
      continue;
    }
    for (const rel of new Set([...scope.entries.keys(), ...after.keys()])) {
      if (sameEntry(scope.entries.get(rel), after.get(rel))) continue;
      const display = scope.label(rel);
      if (result.admittedTaskIds.some((id) => rel.toLowerCase() === `${LEGION}/tasks/${id.toLowerCase()}.md`)) continue;
      if (scope.contractScoped && isProtectedLegionPath(rel) && isAllowedPath(rel, opts.allowedRoots)) continue;
      if (result.rejectedTaskFiles.includes(display)) continue;
      const before = scope.entries.get(rel);
      // A directory the agent created is not work by itself (same rule as the first pass), and
      // over-cap files are knowingly left in place and already reported.
      if (!before && after.get(rel)?.kind === "dir") continue;
      if (before?.kind === "file" && !before.bytes) continue;
      result.incident = true;
      result.unrestorable.push(`${display} (changed again after the restore)`);
    }
  }

  if (!opts.quarantine) {
    try {
      const finalized = await quarantine.finalize();
      if (finalized) {
        result.quarantine = { ...finalized, entries: quarantine.entries.length };
      }
    } catch (err) {
      result.incident = true;
      result.unrestorable.push(`quarantine manifest (${describe(err)})`);
    }
  }
  result.rewrittenTaskIds.sort();
  return result;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Walk from the scope base to the parent of `rel`: a link or junction ancestor is quarantined
 * as a link (never followed) and replaced by a real directory; a non-directory is moved aside.
 */
async function ensureRealAncestors(scope: ProtectedScope, rel: string, quarantine: Quarantine): Promise<void> {
  const parts = rel.split("/");
  const baseSt = await lstat(scope.base);
  if (baseSt.isSymbolicLink() || !baseSt.isDirectory()) {
    throw new Error(`${scope.base} is not a real directory`);
  }
  let cursor = "";
  for (const part of parts.slice(0, -1)) {
    cursor = cursor ? `${cursor}/${part}` : part;
    const abs = absOf(scope, cursor);
    let st;
    try {
      st = await lstat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await mkdir(abs);
      continue;
    }
    if (st.isSymbolicLink()) {
      await quarantine.quarantineLink(abs, scope.label(cursor), "directory");
      await mkdir(abs);
    } else if (!st.isDirectory()) {
      await quarantine.move(abs, scope.label(cursor), "replaced", "directory");
      await mkdir(abs);
    }
  }
}

async function restoreOne(
  scope: ProtectedScope,
  rel: string,
  before: ProtectedEntry | undefined,
  quarantine: Quarantine,
  display: string,
): Promise<void> {
  await ensureRealAncestors(scope, rel, quarantine);
  const abs = absOf(scope, rel);
  const current = await lstat(abs).catch(() => null);

  if (!before) {
    // New entry: moved out whole (a link is only unlinked).
    if (current) await quarantine.move(abs, display, "new", null);
    return;
  }

  if (before.kind === "dir") {
    if (current?.isDirectory() && !current.isSymbolicLink()) return;
    if (current) await quarantine.move(abs, display, "replaced", "directory");
    await mkdir(abs);
    return;
  }

  if (before.kind === "link") {
    if (current) await quarantine.move(abs, display, current.isSymbolicLink() ? "link" : "replaced", "link");
    await symlink(before.target, abs);
    return;
  }

  if (before.kind === "other") {
    if (current) await quarantine.move(abs, display, "replaced", null);
    throw new Error("not a regular file before the run; moved aside, not recreated");
  }

  // before is a file.
  if (current) {
    if (current.isFile() && !current.isSymbolicLink()) {
      // Changed file: copy its bytes out, then restore in place (the path never goes missing).
      await quarantine.copy(abs, display, before.bytes ? "changed" : "unrestorable", before.bytes ? "snapshot" : null);
    } else {
      await quarantine.move(abs, display, current.isSymbolicLink() ? "link" : "replaced", before.bytes ? "snapshot" : null);
    }
  }
  if (!before.bytes) return; // over the inline cap: quarantined, reported as unrestorable
  await atomicWriteFile(abs, before.bytes, { root: scope.base, symlinkMessage: "protected path is a link" });
}

/**
 * R-2: plan/review/verify may create new task files. A new `TSK-*.md` that parses as a valid task
 * is admitted; a colliding or mismatched id is re-allocated from file names. Invalid files are
 * quarantined (the verb FAILs normally; not an incident).
 */
async function admitNewTasks(
  snapshot: ProtectedSnapshot,
  rels: readonly string[],
  quarantine: Quarantine,
  result: ProtectedRestoreResult,
): Promise<void> {
  const scope = snapshot.scopes[0] as ProtectedScope;
  const tasksDir = join(snapshot.projectRoot, LEGION, "tasks");
  const takenBefore = new Set<string>();
  for (const [rel, entry] of scope.entries) {
    const match = NEW_TASK_FILE.exec(rel);
    if (match && entry.kind === "file") takenBefore.add((match[1] as string).toUpperCase());
  }
  const claimed = new Set<string>(takenBefore);
  for (const rel of rels) {
    const abs = absOf(scope, rel);
    const display = scope.label(rel);
    const fileId = (NEW_TASK_FILE.exec(rel)?.[1] ?? "") as string;
    try {
      await ensureRealAncestors(scope, rel, quarantine);
      const st = await lstat(abs);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error("not a regular file");
      const raw = await readFile(abs, "utf8");
      const doc = parseMarkdownDocument(raw);
      const parsed = TaskSchema.safeParse(doc.frontmatter);
      if (!parsed.success) {
        await quarantine.move(abs, display, "invalid-task", null);
        result.rejectedTaskFiles.push(display);
        continue;
      }
      let id = parsed.data.id;
      if (!CANONICAL_TASK_ID.test(id) || id.toUpperCase() !== fileId.toUpperCase() || claimed.has(id.toUpperCase())) {
        // Re-allocate: only canonical `TSK-\d{4,}` ids enter the store, and an id is never
        // overwritten or kept under a mismatched name (R-3).
        const fresh = await nextFileId(tasksDir, "TSK", 4);
        const task = { ...parsed.data, id: fresh };
        const body = raw.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/, "");
        await writeFile(join(tasksDir, `${fresh}.md`), formatMarkdownDocument(task, body), { encoding: "utf8", flag: "wx" });
        await quarantine.move(abs, display, "replaced", null);
        id = fresh;
      }
      claimed.add(id.toUpperCase());
      result.admittedTaskIds.push(id);
    } catch (err) {
      result.incident = true;
      result.unrestorable.push(`${display} (${describe(err)})`);
    }
  }
}

/** True when a project-relative POSIX path is inside P's `.legion-cli/` scope. */
export function isProtectedLegionPath(posixPath: string): boolean {
  const parts = posixPath.split("/");
  if ((parts[0] ?? "").toLowerCase() !== LEGION) return false;
  if (parts.length === 1) return true;
  return !isProtectedSetExcluded(parts[1] ?? "");
}

/** Every path under the project root that P owns: `.legion-cli/**` (minus exclusions) and git files. */
export function isProtectedPath(posixPath: string): boolean {
  if (isProtectedLegionPath(posixPath)) return true;
  const first = (posixPath.split("/")[0] ?? "").toLowerCase();
  return first === ".git" || first === ".gitmodules" || first === ".gitattributes";
}
