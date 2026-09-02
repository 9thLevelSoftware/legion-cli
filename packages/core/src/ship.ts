import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { gitPathTracked, isGitRepo, toFsPath, toPosixPath } from "@9thlevelsoftware/legion-cli-persist";
import type { Task } from "@9thlevelsoftware/legion-cli-schema";

const LEGION_PREFIX = ".legion-cli";

export function unionDoneFilesAllowed(tasks: readonly Task[]): string[] {
  const paths = new Set<string>();
  for (const task of tasks) {
    if (task.status !== "done" && task.status !== "compacted") continue;
    for (const path of task.contract.filesAllowed) paths.add(toPosixPath(path));
  }
  return [...paths].sort();
}

export function isLegionStatePath(path: string): boolean {
  const posix = toPosixPath(path);
  if (posix === LEGION_PREFIX || posix.startsWith(`${LEGION_PREFIX}/`)) {
    return !posix.startsWith(`${LEGION_PREFIX}/index/`) && !posix.startsWith(`${LEGION_PREFIX}/cache/`);
  }
  return false;
}

export function isShipAllowedPath(path: string, allowedFiles: ReadonlySet<string>): boolean {
  const posix = toPosixPath(path);
  if (isLegionStatePath(posix)) return true;
  return allowedFiles.has(posix);
}

export function unrelatedDirty(dirty: readonly string[], allowedFiles: ReadonlySet<string>): string[] {
  return dirty.filter((path) => !isShipAllowedPath(path, allowedFiles)).sort();
}

export function displayStagedRoots(paths: readonly string[]): string {
  const roots = new Set<string>();
  for (const path of paths) {
    const posix = toPosixPath(path);
    if (posix === LEGION_PREFIX || posix.startsWith(`${LEGION_PREFIX}/`)) {
      roots.add(".legion-cli/");
      continue;
    }
    const slash = posix.indexOf("/");
    roots.add(slash === -1 ? posix : `${posix.slice(0, slash)}/`);
  }
  return [...roots].sort().join(", ");
}

function shipPathAddable(projectRoot: string, path: string, git: boolean): boolean {
  try {
    if (existsSync(toFsPath(projectRoot, path))) return true;
  } catch {
    return false;
  }
  // Tracked missing paths must still be `git add`ed so deletions reach the index.
  return git && gitPathTracked(projectRoot, path);
}

/** Existing files plus tracked deletions under the ship allowed set. */
export function shipAddPaths(projectRoot: string, allowedFiles: readonly string[]): string[] {
  const git = isGitRepo(projectRoot);
  const out: string[] = [];
  if (shipPathAddable(projectRoot, LEGION_PREFIX, git)) out.push(LEGION_PREFIX);
  for (const path of allowedFiles) {
    if (path === LEGION_PREFIX) continue;
    if (shipPathAddable(projectRoot, path, git)) out.push(path);
  }
  return out;
}

export function tryCreatePullRequest(cwd: string, title: string, body: string): { url?: string; error?: string } {
  const result = spawnSync("gh", ["pr", "create", "--title", title, "--body", body], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.error) return { error: result.error.message };
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if ((result.status ?? 1) !== 0) {
    return { error: stderr.trim() || stdout.trim() || "gh pr create failed" };
  }
  const url = [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)]
    .map((line) => line.trim())
    .find((line) => /^https?:\/\//.test(line));
  return { url };
}

export function ghAvailable(): boolean {
  const result = spawnSync("gh", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  return !result.error && (result.status ?? 1) === 0;
}
