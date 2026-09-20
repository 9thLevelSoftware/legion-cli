import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  gitDiscoverChanges,
  gitPathExistsAtRef,
  gitRestoreWorktree,
  gitRmWorktree,
  toFsPath,
  toPosixPath,
  tryGitHead,
} from "@9thlevelsoftware/legion-cli-persist";
import { hasGitSegment, isAllowedPath, isEngineOwned, isEngineRuntimePath, matchesGlob } from "./contracts.js";
import { isProtectedPath, type ProtectedRestoreResult } from "./protected.js";

export const HEAD_MOVED_WARNING =
  "agent committed; Legion CLI did not `reset`. `legion-cli ship` is the human commit gate.";

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
};

export function recordPreSpawnRef(projectRoot: string): string | null {
  return tryGitHead(projectRoot);
}

/** Worktree dirt at spawn start so engine writes (STATE, new tasks) are not extras. */
export function snapshotDirtyPaths(projectRoot: string, preSpawnRef: string | null): Set<string> {
  return new Set(gitDiscoverChanges(projectRoot, preSpawnRef));
}

export async function snapshotPaths(projectRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  await walk(projectRoot, "", out);
  return out;
}

async function walk(root: string, rel: string, out: Set<string>): Promise<void> {
  const abs = rel ? join(root, rel) : root;
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const posix = toPosixPath(rel ? `${rel}/${entry.name}` : entry.name);
    if (hasGitSegment(posix)) continue;
    // Walk dist/node_modules too: gitignored extras there must still revert.
    if (isEngineOwned(posix)) continue;
    if (entry.isDirectory()) {
      await walk(root, posix, out);
    } else if (entry.isFile()) {
      out.add(posix);
    }
  }
}

function forbiddenByContract(posixPath: string, filesForbidden: readonly string[] | undefined): boolean {
  if (!filesForbidden || filesForbidden.length === 0) return false;
  return filesForbidden.some((pattern) => pattern === posixPath || matchesGlob(pattern, posixPath));
}

/**
 * The git-based pass over the rest of the tree, after the protected-set restore (KD-1). `.git` and
 * `.legion-cli` are handled by P; `runId` scopes the engine-runtime exemption to this run's cache.
 */
export async function revertExtras(opts: {
  projectRoot: string;
  runId?: string;
  preSpawnRef: string | null;
  allowedRoots: readonly string[];
  filesForbidden?: readonly string[];
  snapshot?: Set<string>;
  dirtyAtStart?: ReadonlySet<string>;
}): Promise<RevertResult> {
  const extrasReverted: string[] = [];
  const headNow = tryGitHead(opts.projectRoot);
  const headMoved = Boolean(opts.preSpawnRef && headNow && headNow !== opts.preSpawnRef);

  const candidates = new Set(gitDiscoverChanges(opts.projectRoot, opts.preSpawnRef));
  if (opts.snapshot) {
    const after = await snapshotPaths(opts.projectRoot);
    for (const posix of after) {
      // New paths vs the pre-spawn filesystem snapshot (gitignored extras).
      // Pre-existing ignored files stay in `opts.snapshot` so they are not extras.
      if (!opts.snapshot.has(posix)) candidates.add(posix);
    }
  }
  let incident = false;

  for (const posix of candidates) {
    if (hasGitSegment(posix)) {
      incident = true;
      continue;
    }
    // P (`.legion-cli/**` minus engine runtime areas, git control files) was already compared and
    // restored byte-for-byte before this git-based pass (KD-1); engine runtime areas are not
    // agent output. Neither is ever reverted here, and `dirtyAtStart` never excuses a P path.
    if (isProtectedPath(posix) || isEngineRuntimePath(posix, opts.runId)) {
      continue;
    }
    if (opts.dirtyAtStart?.has(posix)) {
      continue;
    }
    if (isAllowedPath(posix, opts.allowedRoots) && !forbiddenByContract(posix, opts.filesForbidden)) {
      continue;
    }
    extrasReverted.push(posix);
    await restoreOne(opts.projectRoot, opts.preSpawnRef, posix);
  }

  return { extrasReverted, incident, headMoved, preSpawnRef: opts.preSpawnRef };
}

async function restoreOne(projectRoot: string, preSpawnRef: string | null, posix: string): Promise<void> {
  const abs = toFsPath(projectRoot, posix);
  if (preSpawnRef && gitPathExistsAtRef(projectRoot, preSpawnRef, posix)) {
    gitRestoreWorktree(projectRoot, preSpawnRef, posix);
    return;
  }
  if (preSpawnRef) {
    try {
      gitRmWorktree(projectRoot, posix);
      return;
    } catch {
      // untracked extra
    }
  }
  await rm(abs, { recursive: true, force: true });
}
