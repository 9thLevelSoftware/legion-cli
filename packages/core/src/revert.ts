import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWriteFile,
  gitBlobIdsAtRef,
  gitCatFileFiltered,
  gitHashObjects,
  gitIgnoredEntries,
  gitRevListRange,
  gitStatusRecords,
  gitUpdateRef,
  retryFsOp,
  toFsPath,
  toPosixPath,
  tryGitBranch,
  tryGitHead,
} from "@9thlevelsoftware/legion-cli-persist";
import { hasGitSegment, isAllowedPath, isEngineRuntimePath, isEnvBasename, matchesGlob } from "./contracts.js";
import { isProtectedPath, type ProtectedRestoreResult } from "./protected.js";
import { sha256File, type Quarantine } from "./quarantine.js";

export const HEAD_MOVED_WARNING =
  "agent committed; Legion CLI did not `reset`. `legion-cli ship` is the human commit gate.";

/** Per-file and total backup caps for the pre-spawn snapshot (KD-16). */
export const BACKUP_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const BACKUP_TOTAL_MAX_BYTES = 256 * 1024 * 1024;

/** Directory name inside the run's control dir that holds the pre-spawn backups (R-8). */
export const BACKUP_DIR_NAME = "pre";
export const TREE_MANIFEST_NAME = "tree-manifest.json";

export type RevertResult = {
  extrasReverted: string[];
  incident: boolean;
  headMoved: boolean;
  preSpawnRef: string | null;
  /** Protected-set comparison and restore (KD-1), done before any git call. */
  protected?: ProtectedRestoreResult;
  /** An incident from outside the protected-set restore (e.g. a jail write under `.git`). */
  otherIncident?: boolean;
  sandboxCopied?: string[];
  sandboxDropped?: string[];
  /**
   * Jailed runs only: real-tree paths that changed outside the jail and outside the contract.
   * They are reverted like any other extra, but they are not the agent's scope creep, so no
   * scope ticket is filed for them (Q1).
   */
  outsideJail?: string[];
  /** Ignored build output and other non-incident observations, named for the run summary (R-7). */
  warnings?: string[];
  /** Paths that were quarantined but could not be put back (each one an incident). */
  unrestorable?: string[];
  /** The checked-out branch changed during the run (R-20). */
  branchMoved?: boolean;
  /** Agent commits kept reachable under `refs/legion-quarantine/<runId>` (R-20). */
  quarantinedCommits?: string[];
  /** The one command that undoes the agent's ref movement (R-20). */
  commitRecovery?: string;
};

export function recordPreSpawnRef(projectRoot: string): string | null {
  return tryGitHead(projectRoot);
}

/* ------------------------------------------------------------------ keys */

const FOLDS = process.platform === "win32" || process.platform === "darwin";

/** NFC, case-folded on win32/darwin (KD-16). The on-disk spelling is kept alongside. */
export function foldKey(posixPath: string): string {
  const nfc = posixPath.normalize("NFC");
  return FOLDS ? nfc.toLowerCase() : nfc;
}

/** `.env*` and the other names whose loss would be a credential leak (KD-4, KD-16). */
export function isSecretLikeName(name: string): boolean {
  if (isEnvBasename(name)) return true;
  const lower = name.toLowerCase();
  if (/(^|[._-])(secret|secrets|credential|credentials|token|password|passwd)([._-]|$)/.test(lower)) return true;
  if (/(^|[._-])api[._-]?keys?([._-]|$)/.test(lower)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(lower)) return true;
  return /\.(pem|key|p12|pfx|keystore|jks)$/.test(lower);
}

function isSecretLikePath(posixPath: string): boolean {
  return posixPath.split("/").some((part) => isSecretLikeName(part));
}

/* ------------------------------------------------------------- the walk */

export type TreeKind = "file" | "dir" | "link" | "other";
export type TreeStat = { size: number; mtimeMs: number; kind: TreeKind };
export type GitClass = "tracked-clean" | "dirty" | "untracked" | "ignored";
export type RestoreSource = "git" | "backup" | "none";

export type PreEntry = TreeStat & {
  /** On-disk spelling, project-relative POSIX. */
  path: string;
  cls: GitClass;
  restoreFrom: RestoreSource;
  /** Absolute path of the backup copy under `<controlDir>/pre/`. */
  backup?: string;
  /** sha256 of the pre-spawn bytes (only when backed up). */
  sha256?: string;
};

export type TreeSnapshot = {
  projectRoot: string;
  runId: string;
  preSpawnRef: string | null;
  preSpawnBranch: string | null;
  /** foldKey(path) → entry, for everything outside ignored directories. */
  entries: Map<string, PreEntry>;
  /** foldKey(dir) → the ignored directory's on-disk spelling (contents are not walked). */
  ignoredDirs: Map<string, string>;
  /** foldKey(dir) → its top-level entries, keyed by foldKey(name) (KD-16). */
  ignoredDirTop: Map<string, Map<string, TreeStat & { name: string }>>;
  /** Ignored files outside ignored directories with no backup (over the cap). */
  overCap: Set<string>;
  backupDir: string | null;
  backupBytes: number;
  /** True when a git call the snapshot needed failed; the finish makes it an incident (F-044). */
  gitUnavailable: boolean;
  takenAt: string;
};

/** Walk prunes these `.legion-cli` children by name: engine runtime, never agent work (F-035). */
const PRUNED_LEGION_CHILDREN = new Set(["cache", "index", "sandbox", "worktrees"]);

function prunedDir(posix: string): boolean {
  const parts = posix.split("/");
  if (parts.some((part) => part.toLowerCase() === ".git")) return true;
  return parts.length === 2 && (parts[0] ?? "").toLowerCase() === ".legion-cli" && PRUNED_LEGION_CHILDREN.has((parts[1] ?? "").toLowerCase());
}

function kindOf(st: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): TreeKind {
  if (st.isSymbolicLink()) return "link";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

async function statEntry(abs: string): Promise<TreeStat | null> {
  try {
    const st = await lstat(abs);
    return { size: Number(st.size), mtimeMs: Math.round(st.mtimeMs), kind: kindOf(st) };
  } catch {
    return null;
  }
}

/** Top-level entries of an ignored directory: names and stats only, never descending (KD-16). */
async function listTop(abs: string): Promise<Map<string, TreeStat & { name: string }>> {
  const out = new Map<string, TreeStat & { name: string }>();
  let names: string[];
  try {
    names = await readdir(abs);
  } catch {
    return out;
  }
  for (const name of names) {
    const st = await statEntry(join(abs, name));
    if (st) out.set(foldKey(name), { ...st, name });
  }
  return out;
}

type WalkResult = {
  entries: Map<string, TreeStat & { path: string }>;
  ignoredDirs: Map<string, string>;
  ignoredDirTop: Map<string, Map<string, TreeStat & { name: string }>>;
};

/**
 * lstat-only walk of the non-ignored tree (KD-16). Links are recorded and never followed,
 * `.git` and the engine's runtime areas are pruned by name, and ignored directories are recorded
 * with their top-level entries only.
 */
async function walkTree(projectRoot: string, ignoredDirKeys: ReadonlySet<string>): Promise<WalkResult> {
  const entries = new Map<string, TreeStat & { path: string }>();
  const ignoredDirs = new Map<string, string>();
  const ignoredDirTop = new Map<string, Map<string, TreeStat & { name: string }>>();

  const visit = async (rel: string): Promise<void> => {
    const abs = rel ? join(projectRoot, ...rel.split("/")) : projectRoot;
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const posix = toPosixPath(rel ? `${rel}/${dirent.name}` : dirent.name);
      if (prunedDir(posix)) continue;
      const key = foldKey(posix);
      const st = await statEntry(join(abs, dirent.name));
      if (!st) continue;
      if (st.kind === "dir" && ignoredDirKeys.has(key)) {
        ignoredDirs.set(key, posix);
        ignoredDirTop.set(key, await listTop(join(abs, dirent.name)));
        continue;
      }
      entries.set(key, { ...st, path: posix });
      if (st.kind === "dir") await visit(posix);
    }
  };
  await visit("");
  return { entries, ignoredDirs, ignoredDirTop };
}

/* --------------------------------------------------------- the snapshot */

function classify(projectRoot: string): {
  dirty: Set<string>;
  untracked: Set<string>;
  ignoredFiles: Set<string>;
  ignoredDirKeys: Set<string>;
  ok: boolean;
} {
  const dirty = new Set<string>();
  const untracked = new Set<string>();
  const ignoredFiles = new Set<string>();
  const ignoredDirKeys = new Set<string>();
  let ok = true;

  const ignored = gitIgnoredEntries(projectRoot);
  if (ignored) {
    for (const dir of ignored.dirs) ignoredDirKeys.add(foldKey(dir));
    for (const file of ignored.files) ignoredFiles.add(foldKey(file));
  } else {
    ok = false;
  }

  const status = gitStatusRecords(projectRoot);
  if (status) {
    for (const record of status) {
      const key = foldKey(record.path);
      if (record.x === "?" && record.y === "?") untracked.add(key);
      else dirty.add(key);
      if (record.from) dirty.add(foldKey(record.from));
    }
  } else {
    ok = false;
  }
  return { dirty, untracked, ignoredFiles, ignoredDirKeys, ok };
}

/**
 * Pre-spawn snapshot (KD-16), taken under the lock just before the protected-set snapshot.
 * Nothing is hashed here except the files that are backed up: one `ls-files` and one `status`
 * classify the tree, and the walk records `{size, mtimeMs, kind}` only.
 */
export async function snapshotTree(opts: {
  projectRoot: string;
  runId: string;
  preSpawnRef: string | null;
  controlDir?: string | null;
}): Promise<TreeSnapshot> {
  const { projectRoot } = opts;
  const { dirty, untracked, ignoredFiles, ignoredDirKeys, ok } = classify(projectRoot);
  const walked = await walkTree(projectRoot, ignoredDirKeys);

  const entries = new Map<string, PreEntry>();
  for (const [key, stat] of walked.entries) {
    const cls: GitClass = ignoredFiles.has(key)
      ? "ignored"
      : untracked.has(key)
        ? "untracked"
        : dirty.has(key)
          ? "dirty"
          : ok
            ? "tracked-clean"
            : "untracked";
    entries.set(key, { ...stat, cls, restoreFrom: cls === "tracked-clean" ? "git" : "none" });
  }

  const snapshot: TreeSnapshot = {
    projectRoot,
    runId: opts.runId,
    preSpawnRef: opts.preSpawnRef,
    preSpawnBranch: tryGitBranch(projectRoot),
    entries,
    ignoredDirs: walked.ignoredDirs,
    ignoredDirTop: walked.ignoredDirTop,
    overCap: new Set<string>(),
    backupDir: null,
    backupBytes: 0,
    gitUnavailable: !ok,
    takenAt: new Date().toISOString(),
  };

  if (opts.controlDir) await takeBackups(snapshot, opts.controlDir);
  return snapshot;
}

/**
 * Backups for everything git cannot reproduce: dirty and untracked non-ignored files, and every
 * pre-existing ignored file outside ignored directories. Secret-like names go first so the cap
 * never squeezes them out (KD-16).
 */
async function takeBackups(snapshot: TreeSnapshot, controlDir: string): Promise<void> {
  const candidates: PreEntry[] = [];
  for (const entry of snapshot.entries.values()) {
    if (entry.kind !== "file") continue;
    if (entry.cls === "tracked-clean") continue;
    if (isProtectedPath(entry.path) || isEngineRuntimePath(entry.path)) continue;
    candidates.push(entry);
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => {
    const secret = Number(isSecretLikePath(b.path)) - Number(isSecretLikePath(a.path));
    return secret || a.path.localeCompare(b.path);
  });

  const dir = join(controlDir, BACKUP_DIR_NAME);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  snapshot.backupDir = dir;
  let total = 0;
  let n = 0;
  for (const entry of candidates) {
    if (entry.size > BACKUP_FILE_MAX_BYTES || total + entry.size > BACKUP_TOTAL_MAX_BYTES) {
      if (entry.cls === "ignored") snapshot.overCap.add(entry.path);
      continue;
    }
    const dest = join(dir, `${(n += 1).toString(36).padStart(4, "0")}.bin`);
    try {
      const bytes = await readFile(join(snapshot.projectRoot, ...entry.path.split("/")));
      await writeFile(dest, bytes, { mode: 0o600, flag: "wx" });
      entry.backup = dest;
      entry.sha256 = createHash("sha256").update(bytes).digest("hex");
      entry.restoreFrom = "backup";
      total += bytes.length;
    } catch {
      if (entry.cls === "ignored") snapshot.overCap.add(entry.path);
    }
  }
  snapshot.backupBytes = total;

  await writeFile(
    join(controlDir, TREE_MANIFEST_NAME),
    `${JSON.stringify(
      {
        runId: snapshot.runId,
        projectRoot: snapshot.projectRoot,
        preSpawnRef: snapshot.preSpawnRef,
        preSpawnBranch: snapshot.preSpawnBranch,
        takenAt: snapshot.takenAt,
        backupBytes: total,
        entries: [...snapshot.entries.values()]
          .filter((entry) => entry.restoreFrom !== "none" || snapshot.overCap.has(entry.path))
          .map((entry) => ({
            path: entry.path,
            cls: entry.cls,
            restoreFrom: entry.restoreFrom,
            ...(entry.backup ? { backup: entry.backup, sha256: entry.sha256 } : {}),
          })),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  ).catch(() => undefined);
}

/** R-8: a finish with no incident keeps nothing; incident runs keep the backups for recovery. */
export async function dropBackups(controlDir: string): Promise<void> {
  await rm(join(controlDir, BACKUP_DIR_NAME), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
    () => undefined,
  );
  await rm(join(controlDir, TREE_MANIFEST_NAME), { force: true }).catch(() => undefined);
}

/* -------------------------------------------------------- agent commits */

export type AgentCommits = {
  headMoved: boolean;
  branchMoved: boolean;
  commits: string[];
  recovery?: string;
};

/**
 * R-20: an agent that committed moved `HEAD` or the branch. The commits are kept reachable under
 * `refs/legion-quarantine/<runId>`; the engine never moves the user's refs itself, it prints the
 * one command that does.
 */
export function detectAgentCommits(snapshot: TreeSnapshot): AgentCommits {
  const { projectRoot, preSpawnRef, preSpawnBranch } = snapshot;
  const headNow = tryGitHead(projectRoot);
  const branchNow = tryGitBranch(projectRoot);
  const headMoved = Boolean(preSpawnRef && headNow && headNow !== preSpawnRef);
  const branchMoved = preSpawnBranch !== branchNow;
  if (!headMoved && !branchMoved) return { headMoved: false, branchMoved: false, commits: [] };

  const commits = headMoved && preSpawnRef && headNow ? gitRevListRange(projectRoot, preSpawnRef, headNow) : [];
  if (commits.length > 0) {
    // Purely so `git gc` cannot drop them: the user's own refs are left exactly where they are.
    gitUpdateRef(projectRoot, `refs/legion-quarantine/${snapshot.runId}`, commits[0] as string);
  }
  const recovery = branchMoved
    ? `git checkout ${preSpawnBranch ?? preSpawnRef ?? "HEAD"}`
    : `git reset ${preSpawnRef ?? "HEAD"}`;
  return { headMoved, branchMoved, commits, recovery };
}

/* ----------------------------------------------------------- the revert */

function forbiddenByContract(posixPath: string, filesForbidden: readonly string[] | undefined): boolean {
  if (!filesForbidden || filesForbidden.length === 0) return false;
  return filesForbidden.some((pattern) => pattern === posixPath || matchesGlob(pattern, posixPath));
}

export type RevertTreeOpts = {
  snapshot: TreeSnapshot;
  runId: string;
  allowedRoots: readonly string[];
  filesForbidden?: readonly string[];
  /** Shared with the protected-set restore, so one run has one quarantine folder. */
  quarantine: Quarantine;
};

export type RevertTreeResult = {
  reverted: string[];
  warnings: string[];
  unrestorable: string[];
  incident: boolean;
  agentCommits: AgentCommits;
};

type Candidate = {
  key: string;
  /** Pre-spawn entry, when the path existed before the run. */
  before?: PreEntry;
  /** Current stat and on-disk spelling, when the path exists now. */
  after?: TreeStat & { path: string };
};

/**
 * Post-spawn pass (KD-16), after the protected-set restore. Stat-first: a candidate is any path
 * whose stat, kind or on-disk spelling changed, or that was added or removed. Candidates are then
 * confirmed by content (batched `hash-object` against the `preSpawnRef` blob, or the backup sha)
 * before anything is touched. Every confirmed change outside the contract is quarantined first
 * and only then restored from a verified source (KD-1); a failed quarantine skips the restore.
 */
export async function revertTree(opts: RevertTreeOpts): Promise<RevertTreeResult> {
  const { snapshot, quarantine } = opts;
  const { projectRoot } = snapshot;
  const result: RevertTreeResult = {
    reverted: [],
    warnings: [],
    unrestorable: [],
    incident: snapshot.gitUnavailable,
    agentCommits: { headMoved: false, branchMoved: false, commits: [] },
  };
  if (snapshot.gitUnavailable) {
    result.warnings.push("git was unavailable when the run started; only backed-up files can be restored");
  }

  const post = gitIgnoredEntries(projectRoot);
  if (!post) result.incident = true;
  const postIgnoredDirKeys = new Set((post?.dirs ?? []).map(foldKey));
  const postIgnoredFileKeys = new Set((post?.files ?? []).map(foldKey));
  // A directory that was ignored before the run stays pruned even if git can no longer say so.
  for (const key of snapshot.ignoredDirs.keys()) postIgnoredDirKeys.add(key);

  const after = await walkTree(projectRoot, postIgnoredDirKeys);
  ignoredDirWarnings(snapshot, after, postIgnoredDirKeys, result);

  /* --- collect candidates ------------------------------------------- */
  const candidates: Candidate[] = [];
  const skip = (posix: string): boolean =>
    hasGitSegment(posix) ||
    isProtectedPath(posix) ||
    isEngineRuntimePath(posix, opts.runId) ||
    (isAllowedPath(posix, opts.allowedRoots) && !forbiddenByContract(posix, opts.filesForbidden));

  for (const [key, before] of snapshot.entries) {
    const now = after.entries.get(key);
    if (now && unchangedStat(before, now)) continue;
    if (skip(before.path) && (!now || skip(now.path))) continue;
    candidates.push({ key, before, ...(now ? { after: now } : {}) });
  }
  for (const [key, now] of after.entries) {
    if (snapshot.entries.has(key)) continue;
    // A directory the agent created is not work by itself; its files are candidates of their own.
    if (now.kind === "dir") continue;
    if (skip(now.path)) continue;
    candidates.push({ key, after: now });
  }

  /* --- confirm by content ------------------------------------------- */
  const unchanged = await confirmUnchanged(snapshot, candidates);

  /* --- act ----------------------------------------------------------- */
  const gitRestores = candidates.filter(
    (candidate) =>
      !unchanged.has(candidate.key) && candidate.before?.kind === "file" && candidate.before.restoreFrom === "git",
  );
  const blobs =
    snapshot.preSpawnRef && gitRestores.length > 0
      ? gitBlobIdsAtRef(projectRoot, snapshot.preSpawnRef, gitRestores.map((candidate) => (candidate.before as PreEntry).path))
      : new Map<string, string | null>();
  const contents =
    snapshot.preSpawnRef && gitRestores.length > 0
      ? gitCatFileFiltered(projectRoot, snapshot.preSpawnRef, gitRestores.map((candidate) => (candidate.before as PreEntry).path))
      : new Map<string, Buffer | null>();

  // Shallowest first, so a restored ancestor directory exists before its children are written.
  candidates.sort((a, b) => {
    const pa = a.before?.path ?? a.after?.path ?? "";
    const pb = b.before?.path ?? b.after?.path ?? "";
    return pa.split("/").length - pb.split("/").length || pa.localeCompare(pb);
  });

  for (const candidate of candidates) {
    if (unchanged.has(candidate.key)) continue;
    const before = candidate.before;
    const now = candidate.after;
    const display = now?.path ?? before?.path ?? "";
    // A directory the agent created is not work by itself; its files are handled one by one.
    if (!before && now?.kind === "dir") continue;

    // Ignored-path policy (KD-16, R-7).
    if (!before && (postIgnoredFileKeys.has(candidate.key) || underIgnoredDir(candidate.key, postIgnoredDirKeys))) {
      if (isSecretLikePath(display)) {
        try {
          await quarantine.move(toFsPath(projectRoot, display), display, "new", null);
          result.reverted.push(display);
        } catch (err) {
          result.incident = true;
          result.unrestorable.push(`${display} (${describe(err)})`);
        }
      } else {
        result.warnings.push(`${display} (new ignored output; left in place)`);
      }
      continue;
    }
    if (before?.cls === "ignored" && before.restoreFrom === "none") {
      result.warnings.push(`${display} (not restorable (over the 4 MiB / 256 MiB backup cap))`);
      continue;
    }
    if (before && before.kind === "file" && before.restoreFrom === "none") {
      result.incident = true;
      result.unrestorable.push(`${display} (no restore source: it was neither tracked nor backed up)`);
      continue;
    }

    try {
      await revertOne(snapshot, candidate, quarantine, blobs, contents);
      result.reverted.push(display);
    } catch (err) {
      result.incident = true;
      result.unrestorable.push(`${display} (${describe(err)})`);
    }
  }

  result.agentCommits = detectAgentCommits(snapshot);
  if (result.agentCommits.headMoved || result.agentCommits.branchMoved) result.incident = true;
  return result;
}

/**
 * Stat-first comparison. A directory's own mtime changes whenever a child is added or removed,
 * which is not work on the directory itself — its children are candidates of their own — so a
 * directory only counts as changed when its kind or its on-disk spelling changed.
 */
function unchangedStat(before: PreEntry, now: TreeStat & { path: string }): boolean {
  if (now.kind !== before.kind || now.path !== before.path) return false;
  if (before.kind === "dir") return true;
  return now.size === before.size && now.mtimeMs === before.mtimeMs;
}

function underIgnoredDir(key: string, ignoredDirKeys: ReadonlySet<string>): boolean {
  for (const dir of ignoredDirKeys) {
    if (key.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/**
 * Top-level entries of pre-existing ignored directories (and whole new ignored directories) are
 * reported, never restored: they are build output. Secret-like new names are quarantined (KD-16).
 */
function ignoredDirWarnings(
  snapshot: TreeSnapshot,
  after: WalkResult,
  postIgnoredDirKeys: ReadonlySet<string>,
  result: RevertTreeResult,
): void {
  for (const [key, spelling] of after.ignoredDirs) {
    const beforeTop = snapshot.ignoredDirTop.get(key);
    const afterTop = after.ignoredDirTop.get(key) ?? new Map();
    if (!beforeTop) {
      if (!snapshot.entries.has(key)) result.warnings.push(`${spelling}/ (new ignored directory; left in place)`);
      continue;
    }
    for (const [name, stat] of afterTop) {
      const was = beforeTop.get(name);
      if (was && was.kind === stat.kind && was.size === stat.size && was.mtimeMs === stat.mtimeMs) continue;
      result.warnings.push(`${spelling}/${stat.name} (${was ? "changed" : "new"} ignored output; left in place)`);
    }
    for (const [name, stat] of beforeTop) {
      if (!afterTop.has(name)) result.warnings.push(`${spelling}/${stat.name} (deleted ignored output; not restored)`);
    }
  }
  for (const key of snapshot.ignoredDirs.keys()) {
    if (!after.ignoredDirs.has(key) && postIgnoredDirKeys.has(key)) {
      result.warnings.push(`${snapshot.ignoredDirs.get(key)}/ (ignored directory removed; not restored)`);
    }
  }
}

/** Stat changes are only a hint: confirm each candidate by content before touching anything. */
async function confirmUnchanged(snapshot: TreeSnapshot, candidates: readonly Candidate[]): Promise<Set<string>> {
  const unchanged = new Set<string>();
  const trackedNow: Candidate[] = [];
  for (const candidate of candidates) {
    const before = candidate.before;
    const now = candidate.after;
    if (!before || !now || before.kind !== "file" || now.kind !== "file" || now.path !== before.path) continue;
    if (before.restoreFrom === "git") {
      trackedNow.push(candidate);
      continue;
    }
    if (before.restoreFrom === "backup" && before.sha256) {
      try {
        if ((await sha256File(join(snapshot.projectRoot, ...before.path.split("/")))) === before.sha256) {
          unchanged.add(candidate.key);
        }
      } catch {
        // treat as changed
      }
    }
  }
  if (trackedNow.length === 0 || !snapshot.preSpawnRef) return unchanged;
  const paths = trackedNow.map((candidate) => (candidate.before as PreEntry).path);
  const blobs = gitBlobIdsAtRef(snapshot.projectRoot, snapshot.preSpawnRef, paths);
  const hashes = gitHashObjects(
    snapshot.projectRoot,
    paths.map((path) => join(snapshot.projectRoot, ...path.split("/"))),
  );
  for (const candidate of trackedNow) {
    const path = (candidate.before as PreEntry).path;
    const blob = blobs.get(path);
    const hash = hashes.get(join(snapshot.projectRoot, ...path.split("/")));
    if (blob && hash && blob === hash) unchanged.add(candidate.key);
  }
  return unchanged;
}

/**
 * One confirmed change: lstat the ancestors, quarantine the agent's version first, and only then
 * restore from a verified source. A failed quarantine throws before anything is restored, and a
 * restore that does not verify keeps the quarantined copy and throws (R-18, R-25).
 */
async function revertOne(
  snapshot: TreeSnapshot,
  candidate: Candidate,
  quarantine: Quarantine,
  blobs: ReadonlyMap<string, string | null>,
  contents: ReadonlyMap<string, Buffer | null>,
): Promise<void> {
  const { projectRoot } = snapshot;
  const before = candidate.before;
  const now = candidate.after;

  if (now) {
    const abs = toFsPath(projectRoot, now.path);
    await ensureRealAncestors(projectRoot, now.path, quarantine);
    const reason = before ? (now.kind === before.kind ? "changed" : "replaced") : "new";
    // `move` is itself non-overwriting and retried (EPERM/EBUSY); a failure throws before any
    // restore happens, so the agent's version is never lost.
    await quarantine.move(abs, now.path, reason, before ? "snapshot" : null);
  }
  if (!before) return;

  const abs = toFsPath(projectRoot, before.path);
  await ensureRealAncestors(projectRoot, before.path, quarantine);

  if (before.kind === "dir") {
    await mkdir(abs, { recursive: true });
    return;
  }
  if (before.kind !== "file") {
    throw new Error("not a regular file before the run; moved aside, not recreated");
  }

  if (before.restoreFrom === "backup" && before.backup && before.sha256) {
    await retryFsOp(() => copyFile(before.backup as string, abs, fsConstants.COPYFILE_EXCL));
    if ((await sha256File(abs)) !== before.sha256) {
      throw new Error("the restored bytes did not match the backup; the agent's version is kept in quarantine");
    }
    return;
  }

  const bytes = contents.get(before.path);
  const blob = blobs.get(before.path);
  if (!bytes || !blob) {
    throw new Error("git could not produce the pre-run bytes; the agent's version is kept in quarantine");
  }
  await atomicWriteFile(abs, bytes, { root: projectRoot, symlinkMessage: "restore target is a link" });
  // R-18: verify what actually landed on disk, so a planted replace ref or filter cannot swap it.
  const rehash = gitHashObjects(projectRoot, [abs]).get(abs);
  if (rehash !== blob) {
    throw new Error("the restored bytes did not hash to the pre-run blob; the agent's version is kept in quarantine");
  }
}

/** Every ancestor is lstat'ed; a link or junction is quarantined as a link and replaced (A-025). */
async function ensureRealAncestors(projectRoot: string, posix: string, quarantine: Quarantine): Promise<void> {
  const parts = posix.split("/");
  let cursor = "";
  for (const part of parts.slice(0, -1)) {
    cursor = cursor ? `${cursor}/${part}` : part;
    const abs = toFsPath(projectRoot, cursor);
    let st;
    try {
      st = await lstat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await mkdir(abs);
      continue;
    }
    if (st.isSymbolicLink()) {
      await quarantine.quarantineLink(abs, cursor, "directory");
      await mkdir(abs);
    } else if (!st.isDirectory()) {
      await quarantine.move(abs, cursor, "replaced", "directory");
      await mkdir(abs);
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
