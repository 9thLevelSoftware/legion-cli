import { readdir, readFile, rm } from "node:fs/promises";
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
import { isAllowedPath, isEngineOwned, matchesGlob } from "./contracts.js";

export const HEAD_MOVED_WARNING =
  "agent committed; Legion CLI did not `reset`. `legion-cli ship` is the human commit gate.";

export type GitPolicySnapshot = {
  config: string | null;
  hooks: Record<string, string>;
};

export type RevertResult = {
  extrasReverted: string[];
  incident: boolean;
  headMoved: boolean;
  preSpawnRef: string | null;
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
    if (posix === ".git" || posix.startsWith(".git/")) continue;
    if (isEngineOwned(posix)) continue;
    if (entry.isDirectory()) {
      await walk(root, posix, out);
    } else if (entry.isFile()) {
      out.add(posix);
    }
  }
}

export async function snapshotGitPolicy(projectRoot: string): Promise<GitPolicySnapshot> {
  const hooks: Record<string, string> = {};
  const hooksDir = join(projectRoot, ".git", "hooks");
  try {
    const entries = await readdir(hooksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const posix = `.git/hooks/${entry.name}`;
      try {
        hooks[posix] = await readFile(join(hooksDir, entry.name), "utf8");
      } catch {
        hooks[posix] = "";
      }
    }
  } catch {
    // no .git/hooks
  }
  let config: string | null = null;
  try {
    config = await readFile(join(projectRoot, ".git", "config"), "utf8");
  } catch {
    config = null;
  }
  return { config, hooks };
}

async function gitPolicyIncidents(
  projectRoot: string,
  snapshot: GitPolicySnapshot | undefined,
): Promise<string[]> {
  if (!snapshot) return [];
  const now = await snapshotGitPolicy(projectRoot);
  const incidents: string[] = [];
  if (now.config !== snapshot.config) incidents.push(".git/config");
  const names = new Set([...Object.keys(now.hooks), ...Object.keys(snapshot.hooks)]);
  for (const name of names) {
    if (now.hooks[name] !== snapshot.hooks[name]) incidents.push(name);
  }
  return incidents;
}

function forbiddenByContract(posixPath: string, filesForbidden: readonly string[] | undefined): boolean {
  if (!filesForbidden || filesForbidden.length === 0) return false;
  return filesForbidden.some((pattern) => pattern === posixPath || matchesGlob(pattern, posixPath));
}

export async function revertExtras(opts: {
  projectRoot: string;
  preSpawnRef: string | null;
  allowedRoots: readonly string[];
  filesForbidden?: readonly string[];
  snapshot?: Set<string>;
  gitPolicy?: GitPolicySnapshot;
  dirtyAtStart?: ReadonlySet<string>;
}): Promise<RevertResult> {
  const extrasReverted: string[] = [];
  const headNow = tryGitHead(opts.projectRoot);
  const headMoved = Boolean(opts.preSpawnRef && headNow && headNow !== opts.preSpawnRef);

  const candidates = new Set(gitDiscoverChanges(opts.projectRoot, opts.preSpawnRef));
  if (opts.snapshot) {
    const after = await snapshotPaths(opts.projectRoot);
    for (const posix of after) {
      if (!opts.snapshot.has(posix)) candidates.add(posix);
    }
  }

  const incidents = await gitPolicyIncidents(opts.projectRoot, opts.gitPolicy);
  for (const posix of incidents) candidates.add(posix);
  let incident = incidents.length > 0;

  for (const posix of candidates) {
    if (posix.startsWith(".git/") || posix === ".git") {
      incident = true;
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
