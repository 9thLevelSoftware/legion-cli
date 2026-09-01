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
import { isAllowedPath, isEngineOwned } from "./contracts.js";

export type RevertResult = {
  extrasReverted: string[];
  incident: boolean;
  headMoved: boolean;
  preSpawnRef: string | null;
};

export function recordPreSpawnRef(projectRoot: string): string | null {
  return tryGitHead(projectRoot);
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

export async function revertExtras(opts: {
  projectRoot: string;
  preSpawnRef: string | null;
  allowedRoots: readonly string[];
  snapshot?: Set<string>;
}): Promise<RevertResult> {
  const extrasReverted: string[] = [];
  let incident = false;
  const headNow = tryGitHead(opts.projectRoot);
  const headMoved = Boolean(opts.preSpawnRef && headNow && headNow !== opts.preSpawnRef);

  const candidates = new Set(gitDiscoverChanges(opts.projectRoot, opts.preSpawnRef));
  if (opts.snapshot) {
    const after = await snapshotPaths(opts.projectRoot);
    for (const posix of after) {
      if (!opts.snapshot.has(posix)) candidates.add(posix);
    }
  }

  for (const posix of candidates) {
    if (posix.startsWith(".git/") || posix === ".git") {
      incident = true;
      continue;
    }
    if (isAllowedPath(posix, opts.allowedRoots)) continue;
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
