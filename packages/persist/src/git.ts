import { spawnSync } from "node:child_process";
import type { IngestReceipt } from "@9thlevelsoftware/legion-cli-schema";
import { PersistError } from "./errors.js";
import { toPosixPath } from "./paths.js";

function runGit(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function gitLines(cwd: string, args: string[]): string[] {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new PersistError(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => toPosixPath(line.replace(/^"(.*)"$/, "$1").trim()))
    .filter((line) => line.length > 0);
}

export function isGitRepo(cwd: string): boolean {
  const result = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

export function gitHead(cwd: string): string {
  const result = runGit(cwd, ["rev-parse", "HEAD"]);
  if (result.status !== 0) {
    throw new PersistError(`git rev-parse HEAD failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function gitStatusPorcelain(cwd: string, paths?: string[]): string {
  const args = ["status", "--porcelain", "-uall"];
  if (paths && paths.length > 0) args.push("--", ...paths);
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new PersistError(`git status failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function gitCheckIgnore(cwd: string, path: string): boolean {
  const result = runGit(cwd, ["check-ignore", "-q", "--", path]);
  return result.status === 0;
}

export function commitPaths(cwd: string, paths: string[], message: string): boolean {
  if (paths.length === 0) return false;
  if (!isGitRepo(cwd)) {
    throw new PersistError("ingest auto-commit requires a git repository");
  }
  const add = runGit(cwd, ["add", "--", ...paths]);
  if (add.status !== 0) {
    throw new PersistError(`git add failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }
  const status = gitStatusPorcelain(cwd, paths);
  if (status.trim() === "") return false;
  const commit = runGit(cwd, ["commit", "-m", message, "--", ...paths]);
  if (commit.status !== 0) {
    throw new PersistError(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }
  return true;
}

export function commitIngest(projectRoot: string, receipt: IngestReceipt): boolean {
  const pages = [...receipt.pagesCreated, ...receipt.pagesUpdated];
  if (pages.length === 0) return false;
  return commitPaths(projectRoot, pages, `legion-cli ingest: ${receipt.id}`);
}

/** HEAD sha, or null when the repo has no commits yet / is not a git repo. */
export function tryGitHead(cwd: string): string | null {
  if (!isGitRepo(cwd)) return null;
  const result = runGit(cwd, ["rev-parse", "HEAD"]);
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

export function gitPathExistsAtRef(cwd: string, ref: string, storePath: string): boolean {
  const result = runGit(cwd, ["cat-file", "-e", `${ref}:${storePath}`]);
  return result.status === 0;
}

export function gitRestoreWorktree(cwd: string, ref: string, storePath: string): void {
  const result = runGit(cwd, ["restore", `--source=${ref}`, "--worktree", "--staged", "--", storePath]);
  if (result.status !== 0) {
    throw new PersistError(`git restore failed for ${storePath}: ${result.stderr.trim()}`);
  }
}

export function gitRmWorktree(cwd: string, storePath: string): void {
  const result = runGit(cwd, ["rm", "-f", "--", storePath]);
  if (result.status !== 0) {
    throw new PersistError(`git rm failed for ${storePath}: ${result.stderr.trim()}`);
  }
}

function porcelainPaths(cwd: string): string[] {
  const result = runGit(cwd, ["status", "--porcelain", "-uall"]);
  if (result.status !== 0) {
    throw new PersistError(`git status failed: ${result.stderr.trim()}`);
  }
  const paths: string[] = [];
  for (const raw of result.stdout.split(/\r?\n/)) {
    if (raw.length < 4) continue;
    const rest = raw.slice(3);
    const renamed = rest.split(" -> ");
    const target = renamed.length > 1 ? renamed[1] : rest;
    const posix = toPosixPath(target.replace(/^"(.*)"$/, "$1").trim());
    if (posix) paths.push(posix);
    if (renamed.length > 1) {
      const from = toPosixPath(renamed[0].replace(/^"(.*)"$/, "$1").trim());
      if (from) paths.push(from);
    }
  }
  return paths;
}

/**
 * Union of committed, staged, unstaged, and untracked paths since preSpawnRef.
 * Ignored files (cache, index) are excluded by git's standard excludes.
 */
export function gitDiscoverChanges(cwd: string, preSpawnRef: string | null): string[] {
  if (!isGitRepo(cwd)) return [];
  const paths = new Set<string>();
  if (preSpawnRef) {
    for (const path of gitLines(cwd, ["diff", "--name-only", preSpawnRef, "HEAD"])) paths.add(path);
    for (const path of gitLines(cwd, ["diff", "--name-only", preSpawnRef])) paths.add(path);
  }
  for (const path of porcelainPaths(cwd)) paths.add(path);
  for (const path of gitLines(cwd, ["ls-files", "--others", "--exclude-standard"])) paths.add(path);
  return [...paths];
}
