import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
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

function unquoteDiffPath(value: string): string {
  return toPosixPath(value.replace(/^"(.*)"$/, "$1").trim());
}

/** Parse one `git diff --name-status` line. R/C include source and destination. */
function parseNameStatusLine(line: string): string[] {
  if (!line) return [];
  const parts = line.split("\t");
  if (parts.length < 2) return [];
  const code = parts[0].trim();
  if (!code) return [];
  if ((code.startsWith("R") || code.startsWith("C")) && parts.length >= 3) {
    return [unquoteDiffPath(parts[1]), unquoteDiffPath(parts[2])].filter((path) => path.length > 0);
  }
  return [unquoteDiffPath(parts[1])].filter((path) => path.length > 0);
}

function gitNameStatusPaths(cwd: string, args: string[]): string[] {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new PersistError(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const paths: string[] = [];
  for (const raw of result.stdout.split(/\r?\n/)) {
    for (const path of parseNameStatusLine(raw)) paths.push(path);
  }
  return paths;
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
    // --name-status so a committed git mv yields both source and destination.
    for (const path of gitNameStatusPaths(cwd, ["diff", "--name-status", preSpawnRef, "HEAD"])) paths.add(path);
    for (const path of gitNameStatusPaths(cwd, ["diff", "--name-status", preSpawnRef])) paths.add(path);
  }
  for (const path of porcelainPaths(cwd)) paths.add(path);
  for (const path of gitLines(cwd, ["ls-files", "--others", "--exclude-standard"])) paths.add(path);
  return [...paths];
}

export type GitWorktree = {
  path: string;
  branch: string | null;
};

function sameAbsPath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return left === right || left.toLowerCase() === right.toLowerCase();
}

export function listGitWorktrees(cwd: string): GitWorktree[] {
  const result = runGit(cwd, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) {
    throw new PersistError(`git worktree list failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const out: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) out.push(current);
      current = { path: line.slice("worktree ".length).trim(), branch: null };
      continue;
    }
    if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      continue;
    }
    if (line.trim() === "" && current) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out;
}

function gitBranchExists(cwd: string, branch: string): boolean {
  const result = runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.status === 0;
}

function gitWorktreePrune(cwd: string): void {
  runGit(cwd, ["worktree", "prune"]);
}

function dropStaleWorktree(cwd: string, worktreeAbs: string): void {
  const listed = listGitWorktrees(cwd).find((wt) => sameAbsPath(wt.path, worktreeAbs));
  if (listed) {
    const removed = runGit(cwd, ["worktree", "remove", "--force", listed.path]);
    if (removed.status !== 0) gitWorktreePrune(cwd);
  } else {
    gitWorktreePrune(cwd);
  }
  if (existsSync(worktreeAbs) && !isGitRepo(worktreeAbs)) {
    rmSync(worktreeAbs, { recursive: true, force: true });
  }
}

/** Isolated checkout for brownfield --execute. Greenfield execute stays in-place. */
export function gitWorktreeAdd(cwd: string, worktreePath: string, branch: string): string {
  if (!isGitRepo(cwd)) {
    throw new PersistError("git worktree add requires a git repository");
  }
  const abs = resolve(worktreePath);
  if (isGitRepo(abs)) return abs;
  dropStaleWorktree(cwd, abs);
  // Recreate the existing branch tip; do not -B (that would reset to current HEAD).
  const result = gitBranchExists(cwd, branch)
    ? runGit(cwd, ["worktree", "add", abs, branch])
    : runGit(cwd, ["worktree", "add", "-b", branch, abs]);
  if (result.status !== 0) {
    throw new PersistError(`git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return abs;
}

export function gitPorcelainPaths(cwd: string): string[] {
  if (!isGitRepo(cwd)) return [];
  return porcelainPaths(cwd);
}

/** True when git still tracks the path (including a tracked deletion). */
export function gitPathTracked(cwd: string, path: string): boolean {
  if (!isGitRepo(cwd)) return false;
  const result = runGit(cwd, ["ls-files", "--error-unmatch", "--", path]);
  return result.status === 0;
}

export function gitAdd(cwd: string, paths: string[]): void {
  if (paths.length === 0) return;
  const add = runGit(cwd, ["add", "--", ...paths]);
  if (add.status !== 0) {
    throw new PersistError(`git add failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }
}

export function gitDiffCached(cwd: string): string {
  const result = runGit(cwd, ["diff", "--cached"]);
  if (result.status !== 0) {
    throw new PersistError(`git diff --cached failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

export function gitStagedPaths(cwd: string): string[] {
  return gitLines(cwd, ["diff", "--cached", "--name-only"]);
}

export function gitHasStaged(cwd: string): boolean {
  const result = runGit(cwd, ["diff", "--cached", "--quiet"]);
  return result.status === 1;
}

export function gitRestoreStaged(cwd: string, paths: string[]): void {
  if (paths.length === 0) return;
  const result = runGit(cwd, ["restore", "--staged", "--", ...paths]);
  if (result.status !== 0) {
    throw new PersistError(`git restore --staged failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export function gitCommitIndex(cwd: string, message: string): string {
  const commit = runGit(cwd, ["commit", "-m", message]);
  if (commit.status !== 0) {
    throw new PersistError(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }
  return gitHead(cwd);
}
