import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWriteFile,
  gitAllRefs,
  gitBlobIdsAtRef,
  gitBundleCreate,
  gitCatFileFiltered,
  gitHashObjects,
  gitIgnoredEntries,
  gitIndexEntries,
  gitIsAncestor,
  gitLsFiles,
  gitResetIndexPaths,
  gitRevListRange,
  gitStatusRecords,
  gitUpdateRef,
  retryFsOp,
  toFsPath,
  toPosixPath,
  tryGitBranch,
  tryGitHead,
} from "@9thlevelsoftware/legion-cli-persist";
import { globToRegExp, hasGitSegment, isAllowedPath, isEngineRuntimePath, isEnvBasename } from "./contracts.js";
import { isProtectedPath, type ProtectedRestoreResult } from "./protected.js";
import { sha256File, type Quarantine } from "./quarantine.js";

/** Per-file and total *copy* caps for the pre-spawn backups (KD-16). Hardlinks are uncapped. */
export const BACKUP_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const BACKUP_TOTAL_MAX_BYTES = 256 * 1024 * 1024;

/** Directory name inside the run's control dir that holds the pre-spawn backups (R-8). */
export const BACKUP_DIR_NAME = "pre";
export const TREE_MANIFEST_NAME = "tree-manifest.json";
export const COMMIT_BUNDLE_NAME = "agent-commits.bundle";

/**
 * PR 4's "HEAD movement is only a warning" is gone: a commit made during a run is an incident
 * (KD-1, §5.2 item 5). The constant stays so a caller that still imports it gets the new wording
 * rather than the contradictory old one (R-49).
 */
export const HEAD_MOVED_WARNING =
  "commits were made during the agent run; the task is blocked and the shas are in STATE.quarantinedCommits";

export const GIT_CLASSIFY_FAILED_MESSAGE =
  "git could not classify your working tree, so Legion cannot protect your files during this run";

export type RevertResult = {
  extrasReverted: string[];
  incident: boolean;
  headMoved: boolean;
  preSpawnRef: string | null;
  /** The run this result belongs to, so messages can name `refs/legion-quarantine/<runId>`. */
  runId?: string;
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
  /** False when `update-ref` failed, so the commits are NOT safe from the next `gc` (R-22, R-32). */
  commitsPinned?: boolean;
  /** The run's quarantine folder, whenever anything was displaced (R-15). */
  quarantineDir?: string | null;
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

/** Case-sensitive but normalization-insensitive: `café.ts` in NFD and NFC are one spelling (R-19). */
function sameSpelling(a: string, b: string): boolean {
  return a.normalize("NFC") === b.normalize("NFC");
}

/**
 * `.env*` and the other names whose loss or exposure would be a credential incident (KD-4, R-28).
 * Deliberately broad: a false positive only means the file is quarantined instead of left alone.
 */
export function isSecretLikeName(name: string): boolean {
  if (isEnvBasename(name)) return true;
  const lower = name.toLowerCase();
  if (/(^|[._-])(secret|secrets|credential|credentials|token|password|passwd)([._-]|$)/.test(lower)) return true;
  if (/(^|[._-])api[._-]?keys?([._-]|$)/.test(lower)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(lower)) return true;
  if (/^(\.npmrc|\.netrc|_netrc|\.pgpass|\.htpasswd|\.dockercfg|kubeconfig|authorized_keys)$/.test(lower)) return true;
  if (/^service[-_]?account.*\.json$/.test(lower)) return true;
  return /\.(env|pem|key|p12|pfx|keystore|jks|ovpn|ppk|asc|gpg|tfstate)$/.test(lower);
}

function isSecretLikePath(posixPath: string): boolean {
  return posixPath.split("/").some((part) => isSecretLikeName(part));
}

/** Files that decide how git converts content; they are restored before anything is compared. */
function isAttributeOrIgnoreFile(posixPath: string): boolean {
  const base = (posixPath.split("/").pop() ?? "").toLowerCase();
  return base === ".gitattributes" || base === ".gitignore";
}

/* ------------------------------------------------------------- the walk */

export type TreeKind = "file" | "dir" | "link" | "other";
export type TreeStat = {
  size: number;
  mtimeMs: number;
  kind: TreeKind;
  /** Inode/file index: changes on the write-temp-then-rename every editor and most tools use. */
  ino: string;
  /** POSIX change time / NTFS MFT change time: `utimes` cannot forge it (R-26). */
  ctimeMs: number;
  nlink: number;
  /** POSIX permission bits, so a restored `0755` script stays executable (R-5). */
  mode: number;
};
export type GitClass = "tracked-clean" | "dirty" | "untracked" | "ignored";
export type RestoreSource = "git" | "backup" | "none";

export type PreEntry = TreeStat & {
  /** On-disk spelling, project-relative POSIX. */
  path: string;
  cls: GitClass;
  restoreFrom: RestoreSource;
  /** Absolute path of the backup copy (or hardlink) under `<controlDir>/pre/`. */
  backup?: string;
  /** sha256 of the pre-spawn bytes. Present for copied backups and for over-cap files (R-6, R-16). */
  sha256?: string;
  /**
   * For a **hardlinked** backup (over the copy cap, R-31): the pre-run stat of the shared inode.
   * A hardlink survives `rm`, `git clean` and rename-over, but not an in-place truncating write —
   * which changes this stat, so the copy is known to be stale rather than silently trusted.
   */
  backupStat?: { size: number; mtimeMs: number; ino: string; ctimeMs: number };
  /** Why no backup exists, when one was wanted (R-16). */
  noBackup?: "over-cap" | string;
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
  /** foldKey of every ignored FILE outside ignored directories, under the pre-spawn rules (R-27). */
  ignoredFileKeys: Set<string>;
  /**
   * Secret-like names at the top level of a pre-existing ignored directory (`secrets/prod.env`).
   * They are backed up and restored, but they live outside `entries` because the walk never
   * descends into an ignored directory, so they would otherwise read as deleted every run (R-28).
   */
  ignoredSecrets: Map<string, PreEntry>;
  /** Pre-existing files the backup pass could not protect, with the reason (R-16, R-31). */
  unprotected: Map<string, string>;
  /** `git ls-files -s -z` at spawn time, so an index-only change is still detected (R-4). */
  index: Map<string, string> | null;
  /** Every ref and its object id at spawn time (R-32). */
  refs: Map<string, string> | null;
  backupDir: string | null;
  backupBytes: number;
  /** True when a git call the snapshot needed failed; the spawn is refused (R-17). */
  gitUnavailable: boolean;
  takenAt: string;
};

/** `.legion-cli` children the walk prunes wholesale: engine runtime, never agent work (F-035). */
const PRUNED_LEGION_CHILDREN = new Set(["index", "sandbox", "worktrees"]);
const LEGION = ".legion-cli";

/**
 * `.git` and the engine's own runtime areas are pruned. Of `cache/`, only **this run's** subtrees
 * are — the agent's prompt, logs and staged skill. Another run's cache is still walked, so PR 4's
 * R-33 detection survives (it is reported, never restored: KD-2 means the engine trusts nothing
 * there, so it is not worth a backup or an incident).
 */
function prunedDir(posix: string, runId?: string): boolean {
  const parts = posix.split("/");
  if (parts.some((part) => part.toLowerCase() === ".git")) return true;
  if ((parts[0] ?? "").toLowerCase() !== LEGION) return false;
  const child = (parts[1] ?? "").toLowerCase();
  if (parts.length === 2 && PRUNED_LEGION_CHILDREN.has(child)) return true;
  if (!runId || parts.length !== 4 || child !== "cache") return false;
  const area = (parts[2] ?? "").toLowerCase();
  if (area !== "runs" && area !== "skills") return false;
  return (parts[3] ?? "").toLowerCase() === runId.toLowerCase();
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
    return {
      size: Number(st.size),
      mtimeMs: Math.round(st.mtimeMs),
      kind: kindOf(st),
      ino: String(st.ino),
      ctimeMs: Math.round(st.ctimeMs),
      nlink: Number(st.nlink),
      mode: st.mode & 0o7777,
    };
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
 * lstat-only walk of the non-ignored tree (KD-16). Links are recorded and never followed, `.git`
 * and the engine's runtime areas are pruned by name, and ignored directories are recorded with
 * their top-level entries only. `.legion-cli` is always walked, even though `init` gitignores it,
 * so another run's cache stays observable (R-33 from PR 4; R-9/R-34/R-46 here).
 */
async function walkTree(
  projectRoot: string,
  ignoredDirKeys: ReadonlySet<string>,
  runId?: string,
): Promise<WalkResult> {
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
      if (prunedDir(posix, runId)) continue;
      const key = foldKey(posix);
      const st = await statEntry(join(abs, dirent.name));
      if (!st) continue;
      const alwaysWalk = key === LEGION;
      if (st.kind === "dir" && ignoredDirKeys.has(key) && !alwaysWalk) {
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

type Classification = {
  tracked: Set<string>;
  dirty: Set<string>;
  untracked: Set<string>;
  untrackedPrefixes: string[];
  ignoredFiles: Set<string>;
  ignoredDirKeys: Set<string>;
  ok: boolean;
};

function classify(projectRoot: string): Classification {
  const tracked = new Set<string>();
  const dirty = new Set<string>();
  const untracked = new Set<string>();
  const untrackedPrefixes: string[] = [];
  const ignoredFiles = new Set<string>();
  const ignoredDirKeys = new Set<string>();
  let ok = true;

  // R-1: `ls-files` is the authoritative tracked set. Inferring "tracked-clean" by elimination
  // silently swallowed submodules and nested checkouts, which git reports as neither.
  const trackedPaths = gitLsFiles(projectRoot);
  if (trackedPaths) for (const path of trackedPaths) tracked.add(foldKey(path));
  else ok = false;

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
      // A nested repository comes back as the single directory record `?? vendor/` (R-1).
      const isDir = record.path.endsWith("/");
      const path = isDir ? record.path.slice(0, -1) : record.path;
      const key = foldKey(path);
      if (record.x === "?" && record.y === "?") {
        untracked.add(key);
        if (isDir) untrackedPrefixes.push(`${key}/`);
      } else {
        dirty.add(key);
      }
      if (record.from) dirty.add(foldKey(record.from));
    }
  } else {
    ok = false;
  }
  return { tracked, dirty, untracked, untrackedPrefixes, ignoredFiles, ignoredDirKeys, ok };
}

/**
 * Pre-spawn snapshot (KD-16), taken under the lock just before the protected-set snapshot.
 * Nothing is hashed here except the files that cannot be reproduced from git: one `ls-files`,
 * one `ls-files -i`, one `status` and one `ls-files -s` classify the tree, and the walk records
 * stat metadata only. When git cannot classify the tree the snapshot bails out immediately and
 * the caller refuses the spawn (R-17) rather than walking and copying the whole repository.
 */
export async function snapshotTree(opts: {
  projectRoot: string;
  runId: string;
  preSpawnRef: string | null;
  controlDir?: string | null;
  /** Hardlink over-cap files instead of leaving them unprotected (R-31). Off only for tests. */
  linkBackups?: boolean;
}): Promise<TreeSnapshot> {
  const { projectRoot } = opts;
  const classified = classify(projectRoot);
  const snapshot: TreeSnapshot = {
    projectRoot,
    runId: opts.runId,
    preSpawnRef: opts.preSpawnRef,
    preSpawnBranch: tryGitBranch(projectRoot),
    entries: new Map(),
    ignoredDirs: new Map(),
    ignoredDirTop: new Map(),
    ignoredFileKeys: classified.ignoredFiles,
    ignoredSecrets: new Map(),
    unprotected: new Map(),
    index: null,
    refs: null,
    backupDir: null,
    backupBytes: 0,
    gitUnavailable: !classified.ok,
    takenAt: new Date().toISOString(),
  };
  // Fail closed and cheap: no walk, no backups, nothing under the lock (R-7, R-17).
  if (!classified.ok) return snapshot;

  const walked = await walkTree(projectRoot, classified.ignoredDirKeys, opts.runId);
  for (const [key, stat] of walked.entries) {
    const underUntrackedDir = classified.untrackedPrefixes.some((prefix) => key.startsWith(prefix));
    // R-1: only a path git actually tracks can be restored from git. Everything else — including
    // a submodule's or a nested checkout's files, which `status` and `ls-files -i` both omit —
    // falls back to `untracked`, so it gets a backup.
    const cls: GitClass = classified.ignoredFiles.has(key)
      ? "ignored"
      : classified.tracked.has(key) && !underUntrackedDir
        ? classified.dirty.has(key)
          ? "dirty"
          : "tracked-clean"
        : "untracked";
    snapshot.entries.set(key, { ...stat, cls, restoreFrom: cls === "tracked-clean" ? "git" : "none" });
  }
  snapshot.ignoredDirs = walked.ignoredDirs;
  snapshot.ignoredDirTop = walked.ignoredDirTop;
  snapshot.index = gitIndexEntries(projectRoot);
  snapshot.refs = gitAllRefs(projectRoot);

  if (opts.controlDir) await takeBackups(snapshot, opts.controlDir, opts.linkBackups !== false);
  return snapshot;
}

/**
 * Backups for everything git cannot reproduce: dirty and untracked non-ignored files, every
 * pre-existing ignored file outside ignored directories, and any secret-like name sitting at the
 * top level of an ignored directory (R-28). A **hardlink** is tried first: it is O(1), costs no
 * space and survives `rm`, `git clean` and rename-over, which are the ways these files usually
 * die (R-31); only the copy fallback is capped. Secret-like names sort first either way.
 */
async function takeBackups(snapshot: TreeSnapshot, controlDir: string, linkBackups: boolean): Promise<void> {
  const candidates: PreEntry[] = [];
  for (const entry of snapshot.entries.values()) {
    if (entry.kind !== "file") continue;
    if (entry.cls === "tracked-clean") continue;
    if (isProtectedPath(entry.path) || isEngineRuntimePath(entry.path)) continue;
    candidates.push(entry);
  }
  // Secret-like names at the top level of a pre-existing ignored directory (`secrets/prod.env`).
  for (const [key, dir] of snapshot.ignoredDirs) {
    for (const top of (snapshot.ignoredDirTop.get(key) ?? new Map()).values()) {
      const path = `${dir}/${top.name}`;
      // The whole path, so everything under a `secrets/` or `.aws/` directory counts.
      if (top.kind !== "file" || !isSecretLikePath(path)) continue;
      const entry: PreEntry = { ...top, path, cls: "ignored", restoreFrom: "none" };
      snapshot.ignoredSecrets.set(foldKey(path), entry);
      candidates.push(entry);
    }
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => {
    const secret = Number(isSecretLikePath(b.path)) - Number(isSecretLikePath(a.path));
    return secret || a.path.localeCompare(b.path);
  });

  const dir = join(controlDir, BACKUP_DIR_NAME);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  snapshot.backupDir = dir;
  let copied = 0;
  let n = 0;
  for (const entry of candidates) {
    const src = join(snapshot.projectRoot, ...entry.path.split("/"));
    const dest = join(dir, `${(n += 1).toString(36).padStart(4, "0")}.bin`);
    if (entry.size <= BACKUP_FILE_MAX_BYTES && copied + entry.size <= BACKUP_TOTAL_MAX_BYTES) {
      try {
        const bytes = await readFile(src);
        await writeFile(dest, bytes, { mode: 0o400, flag: "wx" });
        entry.backup = dest;
        entry.sha256 = createHash("sha256").update(bytes).digest("hex");
        entry.restoreFrom = "backup";
        copied += bytes.length;
        continue;
      } catch (err) {
        // R-16/R-28c: say what actually failed instead of blaming the cap.
        entry.noBackup = `backup failed (${describe(err)})`;
      }
    }
    // Over the copy cap (or the copy failed): a hardlink is O(1), costs no space and survives
    // `rm`, `git clean -fdx` and rename-over — the ways these files actually die (R-31).
    if (linkBackups) {
      try {
        await link(src, dest);
        const st = await statEntry(dest);
        if (st) {
          entry.backup = dest;
          entry.restoreFrom = "backup";
          entry.backupStat = { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, ctimeMs: st.ctimeMs };
          delete entry.noBackup;
          continue;
        }
      } catch {
        // Cross-volume (the project on D:, the profile on C:) or a filesystem without links.
      }
    }
    entry.noBackup ??= "over-cap";
    snapshot.unprotected.set(
      entry.path,
      entry.noBackup === "over-cap" ? "over the 4 MiB / 256 MiB backup cap" : entry.noBackup,
    );
    // Hash it anyway, so a touched-but-identical file is confirmed unchanged instead of blocking
    // the run (R-6, R-16). Bounded: only files that had no backup at all reach this.
    entry.sha256 = await sha256File(src).catch(() => undefined);
  }
  snapshot.backupBytes = copied;

  await writeFile(
    join(controlDir, TREE_MANIFEST_NAME),
    `${JSON.stringify(
      {
        runId: snapshot.runId,
        projectRoot: snapshot.projectRoot,
        preSpawnRef: snapshot.preSpawnRef,
        preSpawnBranch: snapshot.preSpawnBranch,
        takenAt: snapshot.takenAt,
        backupBytes: copied,
        unprotected: [...snapshot.unprotected].map(([path, why]) => ({ path, why })),
        entries: [...snapshot.entries.values(), ...snapshot.ignoredSecrets.values()]
          .filter((entry) => entry.restoreFrom !== "none" || entry.noBackup)
          .map((entry) => ({
            path: entry.path,
            cls: entry.cls,
            restoreFrom: entry.restoreFrom,
            ...(entry.noBackup ? { noBackup: entry.noBackup } : {}),
            ...(entry.backup ? { backup: entry.backup } : {}),
            ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
          })),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  ).catch(() => undefined);
}

/**
 * R-20: the retained `pre/` folders hold plaintext copies of ignored files, `.env` among them, and
 * only the owning run's clean finish deletes its own. Drop any that is older than the ceiling at
 * the start of the next run, so an incident-heavy project does not accumulate secrets for ever.
 * The resume record and the quarantine manifest are left alone.
 */
export const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function reclaimOldBackups(controlProjectDir: string, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(controlProjectDir);
  } catch {
    return 0;
  }
  let dropped = 0;
  for (const name of names) {
    const dir = join(controlProjectDir, name);
    try {
      const st = await lstat(join(dir, BACKUP_DIR_NAME));
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (now - st.mtimeMs < BACKUP_RETENTION_MS) continue;
      await rm(join(dir, BACKUP_DIR_NAME), { recursive: true, force: true });
      dropped += 1;
    } catch {
      // no backups for this run, or it is in use
    }
  }
  return dropped;
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
  /** Refs that were deleted or moved so that pre-spawn commits are no longer reachable (R-32). */
  lostRefs: string[];
  /** `refs/legion-quarantine/<runId>` was created, so the commits survive a later `gc`. */
  pinned: boolean;
  recovery?: string;
};

/**
 * R-20/R-32: an agent that committed moved `HEAD`, the branch, or some other ref. The commits are
 * pinned under `refs/legion-quarantine/<runId>` and bundled beside the retained backups, outside
 * `.git`, so a later `gc --prune=now` cannot erase the evidence. The engine never moves the user's
 * refs itself; it prints the one command that does.
 */
export function detectAgentCommits(snapshot: TreeSnapshot, controlDir?: string | null): AgentCommits {
  const { projectRoot, preSpawnRef, preSpawnBranch } = snapshot;
  const headNow = tryGitHead(projectRoot);
  const branchNow = tryGitBranch(projectRoot);
  const headMoved = Boolean(preSpawnRef && headNow && headNow !== preSpawnRef);
  const branchMoved = preSpawnBranch !== branchNow;

  // Every other ref: a deleted branch, a force-moved one, a dropped stash, a deleted tag (R-32).
  const lostRefs: string[] = [];
  const refsNow = gitAllRefs(projectRoot);
  if (snapshot.refs && refsNow) {
    for (const [ref, sha] of snapshot.refs) {
      const now = refsNow.get(ref);
      if (now === sha) continue;
      if (!now) lostRefs.push(`${ref} (deleted, was ${sha.slice(0, 8)})`);
      else if (!gitIsAncestor(projectRoot, sha, now)) lostRefs.push(`${ref} (moved off ${sha.slice(0, 8)})`);
    }
  }

  if (!headMoved && !branchMoved && lostRefs.length === 0) {
    return { headMoved: false, branchMoved: false, commits: [], lostRefs, pinned: false };
  }

  const commits = headMoved && preSpawnRef && headNow ? gitRevListRange(projectRoot, preSpawnRef, headNow) : [];
  const ref = `refs/legion-quarantine/${snapshot.runId}`;
  let pinned = false;
  if (commits.length > 0) {
    // Purely so `git gc` cannot drop them: the user's own refs are left exactly where they are.
    pinned = gitUpdateRef(projectRoot, ref, commits[0] as string);
    if (controlDir) gitBundleCreate(projectRoot, join(controlDir, COMMIT_BUNDLE_NAME), pinned ? [ref] : commits);
  }
  const recovery = branchMoved
    ? `git checkout ${preSpawnBranch ?? preSpawnRef ?? "HEAD"}`
    : headMoved
      ? `git reset ${preSpawnRef ?? "HEAD"}`
      : undefined;
  return { headMoved, branchMoved, commits, lostRefs, pinned, ...(recovery ? { recovery } : {}) };
}

/* ----------------------------------------------------------- the revert */

/** Contract matchers compiled once per revert instead of per candidate (plan item 1, R-50). */
function compileMatchers(patterns: readonly string[]): RegExp[] {
  return patterns.map((pattern) => globToRegExp(pattern.normalize("NFC")));
}

export type RevertTreeOpts = {
  snapshot: TreeSnapshot;
  runId: string;
  allowedRoots: readonly string[];
  filesForbidden?: readonly string[];
  /** Shared with the protected-set restore, so one run has one quarantine folder. */
  quarantine: Quarantine;
  /** The run's control dir, for the agent-commit bundle. */
  controlDir?: string | null;
};

export type RevertTreeResult = {
  /** Out-of-contract paths that were quarantined and restored (they fail the contract). */
  reverted: string[];
  /** Pre-existing ignored files restored from backup: not the agent's scope creep (R-10). */
  restoredIgnored: string[];
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
 * whose stat, kind, identity or on-disk spelling changed, or that was added or removed.
 * Candidates are then confirmed by content before anything is touched. Every confirmed change
 * outside the contract is quarantined first and only then restored from a source that was
 * verified *before* the move (KD-1, R-29); a failed quarantine skips the restore.
 */
export async function revertTree(opts: RevertTreeOpts): Promise<RevertTreeResult> {
  const { snapshot, quarantine } = opts;
  const { projectRoot } = snapshot;
  const result: RevertTreeResult = {
    reverted: [],
    restoredIgnored: [],
    warnings: [],
    unrestorable: [],
    incident: snapshot.gitUnavailable,
    agentCommits: { headMoved: false, branchMoved: false, commits: [], lostRefs: [], pinned: false },
  };
  if (snapshot.gitUnavailable) {
    result.warnings.push("git could not classify the tree when the run started; nothing was protected");
  }

  const allowed = compileMatchers(opts.allowedRoots);
  const forbidden = compileMatchers(opts.filesForbidden ?? []);
  const handled: string[] = [];
  const skip = (posix: string): boolean => {
    const nfc = posix.normalize("NFC");
    if (hasGitSegment(posix) || isProtectedPath(posix) || isEngineRuntimePath(posix, opts.runId)) return true;
    if (!isAllowedPath(posix, opts.allowedRoots)) return false;
    return !forbidden.some((re) => re.test(nfc)) && allowed.some((re) => re.test(nfc));
  };

  // Walk with the PRE-spawn ignored directories: a directory the agent newly ignored must still
  // be enumerated, or it would be an escape hatch (R-27).
  const after = await walkTree(projectRoot, new Set(snapshot.ignoredDirs.keys()), opts.runId);

  /* --- collect candidates ------------------------------------------- */
  const candidates: Candidate[] = [];
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
  // Shallowest first, so a restored ancestor exists before its children are written.
  candidates.sort((a, b) => {
    const pa = a.before?.path ?? a.after?.path ?? "";
    const pb = b.before?.path ?? b.after?.path ?? "";
    return pa.split("/").length - pb.split("/").length || pa.localeCompare(pb);
  });

  /* --- 1. the trusted base: .gitattributes and .gitignore ------------ */
  // These decide what `hash-object` and `cat-file --filters` produce and what counts as ignored,
  // and git honours them even when the file is brand new and untracked (R-25, R-27). They are put
  // back before anything else is compared.
  const baseCandidates = candidates.filter((candidate) =>
    isAttributeOrIgnoreFile(candidate.after?.path ?? candidate.before?.path ?? ""),
  );
  const baseChanged = baseCandidates.length > 0;
  if (baseChanged) {
    const basePaths = baseCandidates
      .filter((candidate) => candidate.before?.kind === "file" && candidate.before.restoreFrom === "git")
      .map((candidate) => (candidate.before as PreEntry).path);
    const baseBlobs = snapshot.preSpawnRef
      ? gitBlobIdsAtRef(projectRoot, snapshot.preSpawnRef, basePaths)
      : new Map<string, string | null>();
    const baseContents = snapshot.preSpawnRef
      ? gitCatFileFiltered(projectRoot, snapshot.preSpawnRef, basePaths)
      : new Map<string, Buffer | null>();
    for (const candidate of baseCandidates) {
      const display = candidate.after?.path ?? candidate.before?.path ?? "";
      try {
        await actOn(candidate, { snapshot, quarantine, handled, result, blobs: baseBlobs, contents: baseContents });
        result.reverted.push(display);
      } catch (err) {
        result.incident = true;
        result.unrestorable.push(`${display} (${describe(err)})`);
      }
    }
    result.warnings.push(
      ".gitattributes/.gitignore changed during the run; they were put back before anything else was compared",
    );
  }

  // Now the ignore rules are the pre-run ones again, so this query classifies the post-run tree
  // under the PRE-run rules — which is exactly what the policy wants (R-27).
  const post = gitIgnoredEntries(projectRoot);
  if (!post) result.incident = true;
  const ignoredDirKeys = new Set((post?.dirs ?? []).map(foldKey));
  const ignoredFileKeys = new Set((post?.files ?? []).map(foldKey));
  for (const key of snapshot.ignoredDirs.keys()) ignoredDirKeys.add(key);
  ignoredDirWarnings(snapshot, after, result);

  /* --- 2. confirm by content ----------------------------------------- */
  const rest = candidates.filter((candidate) => !baseCandidates.includes(candidate));
  const { unchanged, blobs: confirmBlobs } = await confirmUnchanged(snapshot, rest);

  /* --- 3. act --------------------------------------------------------- */
  const live = rest.filter((candidate) => !unchanged.has(candidate.key));
  const gitPaths = live
    .filter((candidate) => candidate.before?.kind === "file" && candidate.before.restoreFrom === "git")
    .map((candidate) => (candidate.before as PreEntry).path);
  const blobs = new Map(confirmBlobs);
  const missing = gitPaths.filter((path) => !blobs.has(path));
  if (snapshot.preSpawnRef && missing.length > 0) {
    for (const [path, id] of gitBlobIdsAtRef(projectRoot, snapshot.preSpawnRef, missing)) blobs.set(path, id);
  }
  const contents =
    snapshot.preSpawnRef && gitPaths.length > 0
      ? gitCatFileFiltered(projectRoot, snapshot.preSpawnRef, gitPaths)
      : new Map<string, Buffer | null>();
  // `--filters` produces git's *canonical checkout* form. In an autocrlf repo a file that was on
  // disk with LF endings would come back as CRLF — a "verified" restore (both hash to the same
  // blob) that is not byte-identical to what was there. The recorded pre-run size settles which
  // form was actually on disk; only the paths that disagree cost a second batch.
  const wrongForm = live
    .filter((candidate) => {
      const before = candidate.before;
      if (!before || before.restoreFrom !== "git" || before.kind !== "file") return false;
      const bytes = contents.get(before.path);
      return Boolean(bytes) && bytes?.length !== before.size;
    })
    .map((candidate) => (candidate.before as PreEntry).path);
  if (snapshot.preSpawnRef && wrongForm.length > 0) {
    const raw = gitCatFileFiltered(projectRoot, snapshot.preSpawnRef, wrongForm, { filters: false });
    for (const path of wrongForm) {
      const bytes = raw.get(path);
      const size = live.find((candidate) => candidate.before?.path === path)?.before?.size;
      if (bytes && bytes.length === size) contents.set(path, bytes);
    }
  }
  // R-25 belt-and-braces: a changed attributes file means the git-sourced bytes were produced
  // under rules we had to repair, so say so instead of quietly trusting them.
  if (baseChanged && gitPaths.length > 0) {
    result.incident = true;
    result.unrestorable.push(
      "a .gitattributes/.gitignore file changed during the run, so the git-sourced restores could not be trusted to be byte-exact",
    );
  }

  const verify: { abs: string; blob: string; display: string }[] = [];
  for (const candidate of live) {
    const display = candidate.after?.path ?? candidate.before?.path ?? "";
    if (handled.some((done) => candidate.key.startsWith(`${done}/`))) continue;
    if (!candidate.before && candidate.after?.kind === "dir") continue;

    // Another run's engine cache (R-33): reported so a planted or rewritten one is visible, but
    // never restored — KD-2 means the engine trusts nothing there, so it is not agent output
    // worth a backup and not worth blocking a task over.
    if (isEngineRuntimePath(display)) {
      result.warnings.push(`${display} (another run's engine cache changed; left in place)`);
      continue;
    }

    // Ignored-path policy (KD-16, R-7, R-27), decided by the PRE-run rules.
    if (!candidate.before && (ignoredFileKeys.has(candidate.key) || underPrefix(candidate.key, ignoredDirKeys))) {
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
    if (candidate.before && candidate.before.kind === "file" && candidate.before.restoreFrom === "none") {
      await handleUnrestorable(candidate, snapshot, quarantine, result);
      continue;
    }

    try {
      const written = await actOn(candidate, { snapshot, quarantine, handled, result, blobs, contents });
      if (written) verify.push(written);
      if (candidate.before?.cls === "ignored") result.restoredIgnored.push(display);
      else result.reverted.push(display);
    } catch (err) {
      result.incident = true;
      result.unrestorable.push(`${display} (${describe(err)})`);
    }
  }

  /* --- 4. verify every git-sourced restore in ONE batch (R-18, R-37) -- */
  if (verify.length > 0) {
    const hashes = gitHashObjects(
      projectRoot,
      verify.map((item) => item.abs),
    );
    for (const item of verify) {
      if (hashes.get(item.abs) === item.blob) continue;
      result.incident = true;
      result.unrestorable.push(
        `${item.display} (the restored bytes did not hash to the pre-run blob; the agent's version is kept in quarantine)`,
      );
    }
  }

  /* --- 5. secret-like names inside ignored directories (R-28) ---------- */
  await restoreIgnoredSecrets(snapshot, quarantine, result);

  /* --- 6. the index (R-4) --------------------------------------------- */
  await resetIndex(snapshot, result, skip);

  result.agentCommits = detectAgentCommits(snapshot, opts.controlDir);
  const commits = result.agentCommits;
  if (commits.headMoved || commits.branchMoved || commits.lostRefs.length > 0) result.incident = true;
  return result;
}

/**
 * R-28: an ignored directory's contents are never walked, so a rewritten `secrets/prod.env` would
 * only ever produce a warning. These few names are stat-compared directly and put back from their
 * backup, with the agent's version quarantined — a credential file must never be left holding it.
 */
async function restoreIgnoredSecrets(
  snapshot: TreeSnapshot,
  quarantine: Quarantine,
  result: RevertTreeResult,
): Promise<void> {
  for (const before of snapshot.ignoredSecrets.values()) {
    const abs = join(snapshot.projectRoot, ...before.path.split("/"));
    const now = await statEntry(abs);
    if (now && unchangedStat(before, { ...now, path: before.path })) continue;
    if (before.restoreFrom !== "backup" || !before.backup) {
      result.incident = true;
      result.unrestorable.push(
        `LOST: ${before.path} (${snapshot.unprotected.get(before.path) ?? "no backup was taken"}; a credential-like file changed inside an ignored directory)`,
      );
      continue;
    }
    try {
      if (!(await backupIsIntact(before))) throw new Error("the hardlinked pre-run copy was rewritten in place");
      const expected = before.sha256 ?? (await sha256File(before.backup));
      if (now) await quarantine.move(abs, before.path, "changed", "snapshot");
      await retryFsOp(() => copyFile(before.backup as string, abs, fsConstants.COPYFILE_EXCL));
      if ((await sha256File(abs)) !== expected) throw new Error("the restored bytes did not match the backup");
      await applyMode(abs, before.mode);
      result.restoredIgnored.push(before.path);
    } catch (err) {
      result.incident = true;
      result.unrestorable.push(`${before.path} (${describe(err)})`);
    }
  }
}

/**
 * R-4: the worktree restore does not touch the index, so content the agent staged would survive
 * and `ship` would commit it. Every out-of-contract path whose index entry differs from the
 * pre-spawn index is reset back to `preSpawnRef` — which also catches a `git rm --cached`, the one
 * change a stat-first walk cannot see at all.
 */
async function resetIndex(
  snapshot: TreeSnapshot,
  result: RevertTreeResult,
  skip: (posix: string) => boolean,
): Promise<void> {
  if (!snapshot.index || !snapshot.preSpawnRef) return;
  const now = gitIndexEntries(snapshot.projectRoot);
  if (!now) {
    result.incident = true;
    result.unrestorable.push("the git index could not be read, so staged agent content may remain");
    return;
  }
  const changed: string[] = [];
  for (const [path, entry] of now) {
    if (snapshot.index.get(path) === entry) continue;
    if (skip(path)) continue;
    changed.push(path);
  }
  for (const path of snapshot.index.keys()) {
    if (now.has(path) || skip(path)) continue;
    changed.push(path);
  }
  if (changed.length === 0) return;
  if (!gitResetIndexPaths(snapshot.projectRoot, snapshot.preSpawnRef, changed)) {
    result.incident = true;
    result.unrestorable.push(`the index could not be reset for ${changed.join(", ")}`);
    return;
  }
  result.warnings.push(`staged changes were unstaged: ${changed.join(", ")}`);
}

/**
 * A confirmed change with no restore source. Nothing here can be put back, so the agent's version
 * is left exactly where it is unless the name is secret-like — the one case where leaving the
 * agent's bytes in a credential file is worse than losing them (R-14, R-16, R-28).
 */
async function handleUnrestorable(
  candidate: Candidate,
  snapshot: TreeSnapshot,
  quarantine: Quarantine,
  result: RevertTreeResult,
): Promise<void> {
  const before = candidate.before as PreEntry;
  const display = candidate.after?.path ?? before.path;
  const why = snapshot.unprotected.get(before.path) ?? "no backup was taken";
  if (isSecretLikePath(display) && candidate.after) {
    try {
      await quarantine.move(toFsPath(snapshot.projectRoot, display), display, "unrestorable", null);
      result.incident = true;
      result.unrestorable.push(`LOST: ${display} (${why}; the agent's version was quarantined, not restored)`);
    } catch (err) {
      result.incident = true;
      result.unrestorable.push(`LOST: ${display} (${why}; and the quarantine failed: ${describe(err)})`);
    }
    return;
  }
  if (!candidate.after) {
    // Deleted or replaced by the agent and not reproducible: the bytes are gone for good.
    result.incident = true;
    result.unrestorable.push(`LOST: ${display} (${why}; the pre-run content cannot be recovered)`);
    return;
  }
  result.warnings.push(`LOST: ${display} (${why}; the agent's version was left in place, not restored)`);
}

function underPrefix(key: string, prefixes: ReadonlySet<string>): boolean {
  for (const prefix of prefixes) {
    if (key.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/**
 * Stat-first comparison (KD-16, R-26). A directory's own mtime changes whenever a child is added
 * or removed, which is not work on the directory itself, so a directory only counts as changed
 * when its kind or its spelling changed. For files the identity fields (`ino`, `ctimeMs`,
 * `nlink`) come free from the `lstat` already taken and close the one-syscall `utimes` evasion.
 */
function unchangedStat(before: PreEntry, now: TreeStat & { path: string }): boolean {
  if (now.kind !== before.kind || !sameSpelling(now.path, before.path)) return false;
  if (before.kind === "dir") return true;
  if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) return false;
  if (now.mode !== before.mode || now.nlink !== before.nlink) return false;
  // A volatile `ino` or `ctimeMs` (some network and FUSE mounts) only costs an extra candidate,
  // which the content confirmation then clears — it can never produce a false *restore*.
  if (now.ino !== "0" && before.ino !== "0" && now.ino !== before.ino) return false;
  return now.ctimeMs === before.ctimeMs;
}

/**
 * Top-level entries of pre-existing ignored directories are reported, never restored: they are
 * build output. A new secret-like name is quarantined instead of warned about (KD-16, R-28).
 */
function ignoredDirWarnings(snapshot: TreeSnapshot, after: WalkResult, result: RevertTreeResult): void {
  for (const [key, spelling] of after.ignoredDirs) {
    const beforeTop = snapshot.ignoredDirTop.get(key);
    const afterTop = after.ignoredDirTop.get(key) ?? new Map();
    if (!beforeTop) {
      result.warnings.push(`${spelling}/ (new ignored directory; left in place)`);
      continue;
    }
    for (const [name, stat] of afterTop) {
      const was = beforeTop.get(name);
      if (was && was.kind === stat.kind && was.size === stat.size && was.mtimeMs === stat.mtimeMs) continue;
      // Only an entry `ignoredSecrets` actually enrolled is handled elsewhere. `ignoredSecrets`
      // takes files only, so a secret-NAMED directory (`secrets/prod/`) must still be reported
      // here rather than silently skipped for looking secret-like.
      if (snapshot.ignoredSecrets.has(foldKey(`${spelling}/${stat.name}`))) continue;
      result.warnings.push(`${spelling}/${stat.name} (${was ? "changed" : "new"} ignored output; left in place)`);
    }
    for (const [name, stat] of beforeTop) {
      if (afterTop.has(name) || snapshot.ignoredSecrets.has(foldKey(`${spelling}/${stat.name}`))) continue;
      result.warnings.push(`${spelling}/${stat.name} (deleted ignored output; not restored)`);
    }
  }
  for (const [key, spelling] of snapshot.ignoredDirs) {
    if (!after.ignoredDirs.has(key) && !after.entries.has(key)) {
      result.warnings.push(`${spelling}/ (ignored directory removed; not restored)`);
    }
  }
}

/** A hardlinked backup is only the pre-run content while nothing wrote through the shared inode. */
async function backupIsIntact(entry: PreEntry): Promise<boolean> {
  if (!entry.backup || !entry.backupStat) return true;
  const st = await statEntry(entry.backup);
  if (!st) return false;
  // Size and mtime only: unlinking the project-side name (a rename-over, the case the hardlink
  // exists to survive) also bumps the inode's change time, so `ctimeMs` cannot be used here.
  return st.size === entry.backupStat.size && st.mtimeMs === entry.backupStat.mtimeMs;
}

/** Stat changes are only a hint: confirm each candidate by content before touching anything. */
async function confirmUnchanged(
  snapshot: TreeSnapshot,
  candidates: readonly Candidate[],
): Promise<{ unchanged: Set<string>; blobs: Map<string, string | null> }> {
  const unchanged = new Set<string>();
  const blobs = new Map<string, string | null>();
  const trackedNow: Candidate[] = [];
  for (const candidate of candidates) {
    const before = candidate.before;
    const now = candidate.after;
    if (!before || !now || before.kind !== "file" || now.kind !== "file") continue;
    // A spelling difference that is only a normalization difference is still the same path (R-19).
    if (!sameSpelling(now.path, before.path)) continue;
    // Identical bytes with a different mode is still a change — a `chmod +x` on an out-of-contract
    // file is exactly the kind of thing the revert exists to undo. Only clear it when there is no
    // source to put the mode back from, where a LOST line for a bare chmod would be noise.
    if (now.mode !== before.mode && before.restoreFrom !== "none") continue;
    if (before.restoreFrom === "git") {
      trackedNow.push(candidate);
      continue;
    }
    let expected = before.sha256;
    if (!expected && before.backup && before.backupStat) {
      // A hardlinked backup SHARES the inode with the project file, so "same inode" is not
      // evidence of anything on its own — an in-place same-size rewrite (a sqlite page update,
      // a fixed-width binary, a padded config) changes the file and the backup together and
      // leaves the inode identical. The recorded stat of the shared inode is checked FIRST; only
      // if it is still the pre-run one does the inode identity mean "nothing was written".
      if (!(await backupIsIntact(before))) continue; // rewritten in place: the copy is stale
      if (
        now.ino !== "0" &&
        now.ino === before.backupStat.ino &&
        now.size === before.backupStat.size &&
        now.mtimeMs === before.backupStat.mtimeMs
      ) {
        unchanged.add(candidate.key);
        continue;
      }
      expected = await sha256File(before.backup).catch(() => undefined);
    }
    if (!expected) continue;
    try {
      if ((await sha256File(join(snapshot.projectRoot, ...before.path.split("/")))) === expected) {
        unchanged.add(candidate.key);
      }
    } catch {
      // treat as changed
    }
  }
  if (trackedNow.length === 0 || !snapshot.preSpawnRef) return { unchanged, blobs };
  const paths = trackedNow.map((candidate) => (candidate.before as PreEntry).path);
  for (const [path, id] of gitBlobIdsAtRef(snapshot.projectRoot, snapshot.preSpawnRef, paths)) blobs.set(path, id);
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
  return { unchanged, blobs };
}

type ActContext = {
  snapshot: TreeSnapshot;
  quarantine: Quarantine;
  handled: string[];
  result: RevertTreeResult;
  blobs: ReadonlyMap<string, string | null>;
  contents: ReadonlyMap<string, Buffer | null>;
};

/**
 * One confirmed change. The restore source is checked **first** (R-29), so a missing blob or a
 * tampered backup leaves the agent's version in place instead of emptying the path. Only then is
 * the agent's version quarantined, and only then is the pre-run content written back. Returns the
 * data the batched post-write verification needs, for git-sourced restores (R-18, R-37).
 */
async function actOn(
  candidate: Candidate,
  ctx: ActContext,
): Promise<{ abs: string; blob: string; display: string } | null> {
  const { snapshot, quarantine, handled } = ctx;
  const { projectRoot } = snapshot;
  const before = candidate.before;
  const now = candidate.after;
  const display = now?.path ?? before?.path ?? "";

  // 1. Is a restore possible at all? Checked before anything is moved.
  let bytes: Buffer | null = null;
  let blob: string | null = null;
  let backupSha: string | undefined;
  if (before?.kind === "file") {
    if (before.restoreFrom === "backup" && before.backup) {
      if (!(await backupIsIntact(before))) {
        throw new Error(
          "LOST: it was rewritten in place, which also destroyed the hardlinked pre-run copy; the agent's version was left in place, not restored",
        );
      }
      backupSha = before.sha256 ?? (await sha256File(before.backup));
      if (before.sha256 && backupSha !== before.sha256) {
        throw new Error(`the backup of ${display} no longer matches its recorded hash; nothing was moved`);
      }
    } else if (before.restoreFrom === "git") {
      bytes = ctx.contents.get(before.path) ?? null;
      blob = ctx.blobs.get(before.path) ?? null;
      if (!bytes || !blob) {
        throw new Error("git could not produce the pre-run bytes; the agent's version was left in place");
      }
    }
  }

  // 2. Quarantine the agent's version.
  if (now) {
    const abs = toFsPath(projectRoot, now.path);
    await ensureRealAncestors(projectRoot, now.path, quarantine, handled);
    if (before?.kind === "dir" && now.kind === "dir") {
      // A directory whose spelling changed: fix the name, never move the subtree, because the
      // children are candidates of their own (R-18, R-35).
      await renameInPlace(projectRoot, now.path, before.path);
      handled.push(candidate.key);
      return null;
    }
    const reason = before ? (now.kind === before.kind ? "changed" : "replaced") : "new";
    await quarantine.move(abs, now.path, reason, before ? "snapshot" : null);
    // Only a real directory is moved recursively, so only that swallows its children's
    // candidates. A link is unlinked and never followed, so whatever was under the real
    // directory it replaced still has to be restored (R-18, R-35).
    if (now.kind === "dir") handled.push(candidate.key);
  }
  if (!before) return null;

  const abs = toFsPath(projectRoot, before.path);
  await ensureRealAncestors(projectRoot, before.path, quarantine, handled);

  if (before.kind === "dir") {
    await mkdir(abs, { recursive: true });
    await applyMode(abs, before.mode);
    return null;
  }
  if (before.kind !== "file") {
    throw new Error("not a regular file before the run; moved aside, not recreated");
  }

  if (before.restoreFrom === "backup" && before.backup) {
    await retryFsOp(() => copyFile(before.backup as string, abs, fsConstants.COPYFILE_EXCL));
    if ((await sha256File(abs)) !== backupSha) {
      throw new Error("the restored bytes did not match the backup; the agent's version is kept in quarantine");
    }
    await applyMode(abs, before.mode);
    handled.push(candidate.key);
    return null;
  }

  await atomicWriteFile(abs, bytes as Buffer, { root: projectRoot, symlinkMessage: "restore target is a link" });
  await applyMode(abs, before.mode);
  handled.push(candidate.key);
  return { abs, blob: blob as string, display };
}

/** R-5: a restored `0755` script must still be executable; a backup copy must not stay `0400`. */
async function applyMode(abs: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  await chmod(abs, mode & 0o7777).catch(() => undefined);
}

/** A case-only or normalization-only directory rename, undone without moving the subtree. */
async function renameInPlace(projectRoot: string, from: string, to: string): Promise<void> {
  const src = toFsPath(projectRoot, from);
  const dest = toFsPath(projectRoot, to);
  if (src === dest) return;
  const via = `${dest}.legion-rename-${Date.now().toString(36)}`;
  await retryFsOp(() => rename(src, via));
  await retryFsOp(() => rename(via, dest));
}

/**
 * Every ancestor is lstat'ed; a link or junction is quarantined as a link and replaced (A-025).
 * A path this pass has already restored is never displaced (R-3).
 */
async function ensureRealAncestors(
  projectRoot: string,
  posix: string,
  quarantine: Quarantine,
  handled: readonly string[],
): Promise<void> {
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
    if (st.isDirectory() && !st.isSymbolicLink()) continue;
    if (handled.includes(foldKey(cursor))) {
      throw new Error(`${cursor} was already restored by this pass as a file; ${posix} cannot also be created`);
    }
    if (st.isSymbolicLink()) {
      await quarantine.quarantineLink(abs, cursor, "directory");
    } else {
      await quarantine.move(abs, cursor, "replaced", "directory");
    }
    await mkdir(abs);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
