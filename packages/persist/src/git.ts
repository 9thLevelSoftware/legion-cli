import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { IngestReceipt } from "@9thlevelsoftware/legion-cli-schema";
import { PersistError } from "./errors.js";
import { toPosixPath } from "./paths.js";

/**
 * Git output for ls-files, status and diff scales with repo size; the Node default (1 MiB) is far
 * too small. 256 MiB per stream is a ceiling that still fails closed (ENOBUFS, named) rather than a size to expect.
 */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

let resolvedGit: string | undefined;

/**
 * Windows: resolve `git` to an absolute path once, from a neutral cwd and never a hit in the
 * project. A bare `git` makes CreateProcess look in the child's cwd (the audited repo) first.
 * Elsewhere the PATH search is already safe.
 */
export function gitExecutable(projectDir?: string): string | null {
  if (process.platform !== "win32") return "git";
  if (resolvedGit !== undefined) return resolvedGit;
  const found = spawnSync("where.exe", ["git"], {
    cwd: join(process.env.SystemRoot || process.env.windir || "C:/Windows", "System32"),
    env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (found.status === 0) {
    const rejected = [process.cwd(), projectDir ?? process.cwd()].map((d) => resolve(d).toLowerCase());
    const hit = String(found.stdout)
      .split("\n")
      .map((line) => line.trim())
      .find(
        (abs) => abs.toLowerCase().endsWith(".exe") && isAbsolute(abs) && !rejected.includes(dirname(resolve(abs)).toLowerCase()),
      );
    if (hit) resolvedGit = hit;
  }
  // No absolute git.exe: fail rather than let a bare `git` be looked up next to the project. Not cached.
  return resolvedGit ?? null;
}

export type GitRunResult = { status: number; stdout: string; stderr: string; error?: string };

export function runGit(cwd: string, args: string[], opts: { maxBuffer?: number } = {}): GitRunResult {
  const exe = gitExecutable(cwd);
  if (exe === null) {
    const error = "git could not be found on PATH (Windows needs git.exe; git.cmd shims are not supported)";
    return { status: 1, stdout: "", stderr: error, error };
  }
  const result = spawnSync(exe, args, {
    cwd,
    env: process.platform === "win32" ? { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" } : process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    maxBuffer: opts.maxBuffer ?? GIT_MAX_BUFFER,
  });
  const error = result.error
    ? `git ${args[0] ?? ""} could not complete (${(result.error as NodeJS.ErrnoException).code ?? result.error.name}): ${result.error.message}`
    : undefined;
  return {
    status: result.error ? 1 : (result.status ?? 1),
    stdout: result.stdout ?? "",
    stderr: error ?? result.stderr ?? "",
    ...(error ? { error } : {}),
  };
}

/**
 * stderr, else the first 512 bytes of stdout (`git commit` reports "nothing to commit" there).
 * stdout can be megabytes of listing or diff, so it is never embedded whole.
 */
function failText(result: GitRunResult): string {
  const err = result.stderr.trim();
  if (err) return err;
  const out = result.stdout.trim();
  return out.length > 512 ? `${out.slice(0, 512)}...` : out;
}

/** Git already reports `/`; only a Windows `\` needs converting. On POSIX a backslash is part of the name. */
function gitPath(name: string): string {
  return process.platform === "win32" ? toPosixPath(name) : name;
}

function nulFields(stdout: string): string[] {
  return stdout.split("\0").filter((field) => field.length > 0);
}

function gitLines(cwd: string, args: string[]): string[] {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new PersistError(`git ${args.join(" ")} failed: ${failText(result)}`);
  }
  return nulFields(result.stdout).map(gitPath);
}

/**
 * Parse `git diff --name-status -z`: `S\0path\0`, and `R100\0source\0dest\0` (also C).
 * Returns source and destination for renames/copies.
 */
function parseNameStatusZ(stdout: string): string[] {
  const fields = nulFields(stdout);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++];
    const count = code.startsWith("R") || code.startsWith("C") ? 2 : 1;
    for (let n = 0; n < count && i < fields.length; n++) paths.push(gitPath(fields[i++]));
  }
  return paths;
}

function gitNameStatusPaths(cwd: string, args: string[]): string[] {
  const result = runGit(cwd, [...args, "-z"]);
  if (result.status !== 0) {
    throw new PersistError(`git ${args.join(" ")} failed: ${failText(result)}`);
  }
  return parseNameStatusZ(result.stdout);
}

export function isGitRepo(cwd: string): boolean {
  const result = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

export function gitHead(cwd: string): string {
  const result = runGit(cwd, ["rev-parse", "HEAD"]);
  if (result.status !== 0) {
    throw new PersistError(`git rev-parse HEAD failed: ${failText(result)}`);
  }
  return result.stdout.trim();
}

/** Cached index entries (`<mode> <sha> <stage>	<path>`), NUL-separated in git, one string per entry. */
export function gitIndexEntries(cwd: string): string[] {
  const result = runGit(cwd, ["ls-files", "-s", "-z", "--cached", "--full-name"]);
  if (result.status !== 0) {
    throw new PersistError(`git ls-files --cached failed: ${failText(result)}`);
  }
  return nulFields(result.stdout);
}

export function gitStatusPorcelain(cwd: string, paths?: string[]): string {
  const args = ["status", "--porcelain", "-uall"];
  if (paths && paths.length > 0) args.push("--", ...paths);
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new PersistError(`git status failed: ${failText(result)}`);
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
    throw new PersistError(`git add failed: ${failText(add)}`);
  }
  const status = gitStatusPorcelain(cwd, paths);
  if (status.trim() === "") return false;
  const commit = runGit(cwd, ["commit", "-m", message, "--", ...paths]);
  if (commit.status !== 0) {
    throw new PersistError(`git commit failed: ${failText(commit)}`);
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
    throw new PersistError(`git restore failed for ${storePath}: ${failText(result)}`);
  }
}

export function gitRmWorktree(cwd: string, storePath: string): void {
  const result = runGit(cwd, ["rm", "-f", "--", storePath]);
  if (result.status !== 0) {
    throw new PersistError(`git rm failed for ${storePath}: ${failText(result)}`);
  }
}

/**
 * `status --porcelain=v1 -z`: records are `XY <path>\0`; a rename or copy (X or Y is R/C) is
 * `XY <dest>\0<source>\0`, destination first. Both are returned: revert needs the source.
 */
function parsePorcelainZ(stdout: string): string[] {
  const fields = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (record.length < 4) continue;
    paths.push(gitPath(record.slice(3)));
    if (/[RC]/.test(record.slice(0, 2)) && i + 1 < fields.length && fields[i + 1].length > 0) {
      paths.push(gitPath(fields[++i]));
    }
  }
  return paths;
}

function porcelainPaths(cwd: string): string[] {
  const result = runGit(cwd, ["status", "--porcelain=v1", "-z", "-uall"]);
  if (result.status !== 0) {
    throw new PersistError(`git status failed: ${failText(result)}`);
  }
  return parsePorcelainZ(result.stdout);
}

/**
 * Union of committed, staged, unstaged, and untracked paths since preSpawnRef.
 * Ignored files are excluded by git's standard excludes on purpose. Execute
 * revert discovers gitignored extras via a filesystem snapshot, not
 * `git status --ignored` (that would also revert pre-existing ignored files).
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
  for (const path of gitLines(cwd, ["ls-files", "-z", "--others", "--exclude-standard"])) paths.add(path);
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

/**
 * realpath of the longest existing prefix of `path`, with the missing remainder appended.
 * Native realpath expands Windows 8.3 names (RUNNER~1) on that prefix so they match git's
 * long-form `worktree list` paths; the caller decides whether the last segment is followed.
 */
function realPrefix(path: string): string {
  const tail: string[] = [];
  let head = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

/**
 * Compare a worktree path with one git recorded. Git stores realpaths, so a project reached
 * through a link (junction, symlinked --project) must be resolved first. The last segment is not
 * followed: a link at the worktree path itself must never match the checkout it points at.
 * Parent 8.3 short names are expanded by realPrefix; the trailing name stays as given.
 */
export function sameWorktreePath(a: string, b: string): boolean {
  const canonical = (path: string) => join(realPrefix(dirname(resolve(path))), basename(resolve(path)));
  return sameAbsPath(canonical(a), canonical(b));
}

export function listGitWorktrees(cwd: string): GitWorktree[] {
  const result = runGit(cwd, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) {
    throw new PersistError(`git worktree list failed: ${failText(result)}`);
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

export function gitBranchExists(cwd: string, branch: string): boolean {
  const result = runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.status === 0;
}

function gitWorktreePrune(cwd: string): void {
  runGit(cwd, ["worktree", "prune"]);
}

/** True when `candidate` is strictly below `root` (not equal, not outside, not another drive). */
function strictlyUnder(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..";
}

/** Like existsSync, but a dangling link still counts as present. */
function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function hasGitSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((part) => part.toLowerCase() === ".git");
}

/** True when `abs` is the top level of a live git checkout (of any repository). */
function isOwnCheckout(abs: string): boolean {
  const top = runGit(abs, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || !top.stdout.trim()) return false;
  try {
    return sameAbsPath(realpathSync.native(top.stdout.trim()), realpathSync.native(abs));
  } catch {
    return false;
  }
}

/**
 * Stale-checkout cleanup may only touch `<project>/.legion-cli/worktrees/…`, and only where that
 * resolves (through any linked `.legion-cli` or `worktrees` directory) inside the project: never
 * the project itself, never `.git` or a directory holding one. A link at the target is only
 * unlinked, never followed.
 */
function assertRemovableWorktreePath(cwd: string, worktreeAbs: string): void {
  const root = resolve(cwd, ".legion-cli", "worktrees");
  const target = resolve(worktreeAbs);
  const refuse = (why: string): never => {
    throw new PersistError(`refusing to remove ${target}: ${why}`);
  };
  if (!strictlyUnder(root, target)) {
    refuse("stale worktrees are only removed under .legion-cli/worktrees/");
  }
  if (hasGitSegment(relative(root, target))) refuse("it is a .git directory");
  if (!pathPresent(target)) return;
  // Every existing ancestor chain must stay inside the project once links are followed.
  const realCwd = realpathSync.native(cwd);
  const realRoot = realpathSync.native(root);
  if (!strictlyUnder(realCwd, realRoot) || hasGitSegment(relative(realCwd, realRoot))) {
    refuse(".legion-cli/worktrees resolves outside the project");
  }
  const realParent = realpathSync.native(dirname(target));
  if (!sameAbsPath(realParent, realRoot) && !strictlyUnder(realRoot, realParent)) {
    refuse("it resolves outside .legion-cli/worktrees/");
  }
  if (lstatSync(target).isSymbolicLink()) return;
  const realTarget = realpathSync.native(target);
  if (!strictlyUnder(realRoot, realTarget) || hasGitSegment(relative(realRoot, realTarget))) {
    refuse("it resolves outside .legion-cli/worktrees/");
  }
  let gitEntry: ReturnType<typeof lstatSync> | undefined;
  try {
    gitEntry = lstatSync(join(target, ".git"));
  } catch {
    gitEntry = undefined;
  }
  if (gitEntry && !gitEntry.isFile()) refuse("it contains a .git directory");
}

function dropStaleWorktree(cwd: string, worktreeAbs: string): void {
  assertRemovableWorktreePath(cwd, worktreeAbs);
  const listed = listGitWorktrees(cwd).find((wt) => sameWorktreePath(wt.path, worktreeAbs));
  if (listed) {
    const removed = runGit(cwd, ["worktree", "remove", "--force", listed.path]);
    if (removed.status !== 0) gitWorktreePrune(cwd);
  } else {
    gitWorktreePrune(cwd);
  }
  if (!pathPresent(worktreeAbs)) return;
  if (lstatSync(worktreeAbs).isSymbolicLink()) {
    unlinkSync(worktreeAbs); // the link only, never its target
    return;
  }
  // A plain leftover directory is "inside" the main work tree for git, so isGitRepo can't tell it
  // apart; only a live checkout of its own (e.g. another repository's worktree) is kept.
  if (isOwnCheckout(worktreeAbs)) {
    throw new PersistError(`refusing to remove ${worktreeAbs}: it is a live checkout that is not this repository's worktree`);
  }
  rmSync(worktreeAbs, { recursive: true, force: true });
}

/** Reuse only a registered worktree of `cwd` that is a real directory and its own checkout top level. */
function isReusableWorktree(cwd: string, abs: string): boolean {
  if (!pathPresent(abs) || lstatSync(abs).isSymbolicLink()) return false;
  if (!listGitWorktrees(cwd).some((wt) => sameWorktreePath(wt.path, abs))) return false;
  return isOwnCheckout(abs);
}

/**
 * Isolated checkout for brownfield --execute. Greenfield execute stays in-place.
 * Reuses an existing branch tip (never `-B`). A missing branch is created at
 * `startPoint` when given, else at the current HEAD.
 */
export function gitWorktreeAdd(cwd: string, worktreePath: string, branch: string, startPoint?: string): string {
  if (!isGitRepo(cwd)) {
    throw new PersistError("git worktree add requires a git repository");
  }
  const abs = resolve(worktreePath);
  if (isReusableWorktree(cwd, abs)) return abs;
  dropStaleWorktree(cwd, abs);
  // Recreate the existing branch tip; do not -B (that would reset to current HEAD).
  const args = gitBranchExists(cwd, branch)
    ? ["worktree", "add", abs, branch]
    : ["worktree", "add", "-b", branch, abs, ...(startPoint ? [startPoint] : [])];
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new PersistError(`git worktree add failed: ${failText(result)}`);
  }
  return abs;
}

/** Remove a linked worktree and prune. The branch is kept. Returns false when nothing was registered or on disk. */
export function gitWorktreeRemove(cwd: string, worktreePath: string, opts: { force?: boolean } = {}): boolean {
  if (!isGitRepo(cwd)) {
    throw new PersistError("git worktree remove requires a git repository");
  }
  const abs = resolve(worktreePath);
  const listed = listGitWorktrees(cwd).find((wt) => sameWorktreePath(wt.path, abs));
  if (!listed) {
    gitWorktreePrune(cwd);
    return false;
  }
  const args = ["worktree", "remove", ...(opts.force ? ["--force"] : []), listed.path];
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new PersistError(`git worktree remove failed: ${failText(result)}`);
  }
  gitWorktreePrune(cwd);
  return true;
}

/** Create `branch` at `startPoint` without checking it out. No-op when the branch already exists. */
export function gitBranchCreate(cwd: string, branch: string, startPoint: string): boolean {
  if (gitBranchExists(cwd, branch)) return false;
  const result = runGit(cwd, ["branch", branch, startPoint]);
  if (result.status !== 0) {
    throw new PersistError(`git branch failed: ${failText(result)}`);
  }
  return true;
}

/** Current branch name, or null when HEAD is detached, unborn-without-branch, or not a repo. */
export function tryGitBranch(cwd: string): string | null {
  if (!isGitRepo(cwd)) return null;
  const result = runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (result.status !== 0) return null;
  const name = result.stdout.trim();
  return name.length > 0 ? name : null;
}

/** Commit sha a ref resolves to, or null. */
export function gitRevParse(cwd: string, ref: string): string | null {
  const result = runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
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
    throw new PersistError(`git add failed: ${failText(add)}`);
  }
}

export function gitDiffCached(cwd: string): string {
  const result = runGit(cwd, ["diff", "--cached"]);
  if (result.status !== 0) {
    throw new PersistError(`git diff --cached failed: ${failText(result)}`);
  }
  return result.stdout;
}

export function gitStagedPaths(cwd: string): string[] {
  return gitLines(cwd, ["diff", "--cached", "--name-only", "-z"]);
}

export function gitHasStaged(cwd: string): boolean {
  const result = runGit(cwd, ["diff", "--cached", "--quiet"]);
  return result.status === 1;
}

export function gitRestoreStaged(cwd: string, paths: string[]): void {
  if (paths.length === 0) return;
  const result = runGit(cwd, ["restore", "--staged", "--", ...paths]);
  if (result.status !== 0) {
    throw new PersistError(`git restore --staged failed: ${failText(result)}`);
  }
}

export function gitCommitIndex(cwd: string, message: string): string {
  const commit = runGit(cwd, ["commit", "-m", message]);
  if (commit.status !== 0) {
    throw new PersistError(`git commit failed: ${failText(commit)}`);
  }
  return gitHead(cwd);
}

/** Undo a commit we just made; keep the worktree (not --hard). */
export function gitResetMixed(cwd: string, ref: string): void {
  const result = runGit(cwd, ["reset", "--mixed", ref]);
  if (result.status !== 0) {
    throw new PersistError(`git reset failed: ${failText(result)}`);
  }
}
