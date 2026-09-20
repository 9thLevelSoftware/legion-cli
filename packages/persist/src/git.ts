import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { IngestReceipt } from "@9thlevelsoftware/legion-cli-schema";
import { PersistError } from "./errors.js";
import { toPosixPath } from "./paths.js";

/**
 * `read` (status, ls-files, diff, cat-file, rev-parse, restore, worktree, …) runs with the
 * repository's fsmonitor, hooks, ext-diff and attributes file switched off. `commit` (the user's
 * own commits: ship, ingest auto-commit) runs the user's hooks. Both ignore replace refs.
 */
export type GitKind = "read" | "commit";

let resolvedGit: { path: string; binary: string | null } | undefined;

/**
 * Absolute path of the git executable, resolved once from PATH (absolute entries only). Spawning
 * the bare name `git` would let Windows pick up a `git.exe` planted in the child's cwd.
 */
export function resolveGitBinary(): string | null {
  const pathVar = process.env.PATH ?? process.env.Path ?? "";
  if (resolvedGit && resolvedGit.path === pathVar) return resolvedGit.binary;
  const names = process.platform === "win32" ? ["git.exe"] : ["git"];
  let binary: string | null = null;
  for (const dir of pathVar.split(delimiter)) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed || !isAbsolute(trimmed)) continue;
    for (const name of names) {
      const candidate = join(trimmed, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, fsConstants.X_OK);
        binary = candidate;
        break;
      } catch {
        // not here
      }
    }
    if (binary) break;
  }
  resolvedGit = { path: pathVar, binary };
  return binary;
}

let hardening: { hooksPath: string; attributesFile: string } | undefined;

/** An empty hooks directory and an empty attributes file, outside every project. */
function hardeningPaths(): { hooksPath: string; attributesFile: string } {
  if (hardening) return hardening;
  const dir = mkdtempSync(join(tmpdir(), "legion-cli-git-"));
  const hooksPath = join(dir, "hooks");
  const attributesFile = join(dir, "attributes");
  mkdirSync(hooksPath);
  writeFileSync(attributesFile, "");
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
  hardening = { hooksPath, attributesFile };
  return hardening;
}

let preserved: string[] | undefined;

/**
 * Read calls ignore the system and global config (R-21), which would also drop two keys people
 * legitimately set there: `safe.directory` (container and shared checkouts) and, on Windows,
 * `core.longpaths`. Those two are read back from the system/global scopes only — never from the
 * repository config, which an agent can write — and re-injected with `-c`.
 */
function preservedGlobalConfig(): string[] {
  if (preserved) return preserved;
  const out: string[] = [];
  const binary = resolveGitBinary();
  if (!binary) return (preserved = out);
  const read = (scope: string, args: string[]): string[] => {
    const result = spawnSync(binary, ["config", scope, ...args], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    });
    if (result.status !== 0) return [];
    return (result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  };
  for (const scope of ["--system", "--global"]) {
    for (const dir of read(scope, ["--get-all", "safe.directory"])) out.push("-c", `safe.directory=${dir}`);
    if (process.platform === "win32") {
      for (const value of read(scope, ["--get", "core.longpaths"])) out.push("-c", `core.longpaths=${value}`);
    }
  }
  preserved = out;
  return out;
}

function gitArgv(args: readonly string[], kind: GitKind): string[] {
  if (kind === "commit") return [...args];
  const paths = hardeningPaths();
  const sub = args[0] === "diff" ? ["diff", "--no-ext-diff", ...args.slice(1)] : [...args];
  return [
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${paths.hooksPath}`,
    "-c",
    "core.quotePath=false",
    "-c",
    `core.attributesFile=${paths.attributesFile}`,
    ...preservedGlobalConfig(),
    ...sub,
  ];
}

export type GitRunOpts = { kind?: GitKind; maxBuffer?: number; input?: string | Buffer };

/** Every engine git spawn goes through here; `runGitBuffer` is the binary-safe variant. */
export function runGit(
  cwd: string,
  args: readonly string[],
  opts: GitRunOpts = {},
): { status: number; stdout: string; stderr: string } {
  const raw = runGitBuffer(cwd, args, opts);
  return { status: raw.status, stdout: raw.stdout.toString("utf8"), stderr: raw.stderr };
}

/** Binary-safe git spawn: `stdout` stays a Buffer (blob contents must never go through utf8). */
export function runGitBuffer(
  cwd: string,
  args: readonly string[],
  opts: GitRunOpts = {},
): { status: number; stdout: Buffer; stderr: string } {
  const binary = resolveGitBinary();
  if (!binary) {
    return { status: 1, stdout: Buffer.alloc(0), stderr: "git executable not found on PATH" };
  }
  const rel = relative(resolve(cwd), binary);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    return { status: 1, stdout: Buffer.alloc(0), stderr: `refusing to run git from inside the project (${binary})` };
  }
  const kind = opts.kind ?? "read";
  const result = spawnSync(binary, gitArgv(args, kind), {
    cwd,
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      GIT_NO_REPLACE_OBJECTS: "1",
      // Read/restore calls also ignore the system and global config, so no file outside the
      // repository can introduce a filter or diff driver either (R-21).
      ...(kind === "read"
        ? { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: hardeningPaths().attributesFile }
        : {}),
    },
    ...(opts.input === undefined ? {} : { input: opts.input }),
    ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
  });
  const stderr = result.stderr ? Buffer.from(result.stderr).toString("utf8") : "";
  return {
    status: result.status ?? 1,
    stdout: result.stdout ? Buffer.from(result.stdout) : Buffer.alloc(0),
    stderr: stderr || result.error?.message || "",
  };
}

/**
 * Absolute git dir and common dir (`rev-parse --git-dir --git-common-dir`). In a linked worktree
 * the git dir is `<main>/.git/worktrees/<name>` and the common dir is the main `.git`. Null
 * outside a repository.
 */
export function gitControlDirs(cwd: string): { gitDir: string; commonDir: string } | null {
  const result = runGit(cwd, ["rev-parse", "--git-dir", "--git-common-dir"]);
  if (result.status !== 0) return null;
  const [gitDir, commonDir] = result.stdout.split(/\r?\n/).map((line) => line.trim());
  if (!gitDir || !commonDir) return null;
  return { gitDir: resolve(cwd, gitDir), commonDir: resolve(cwd, commonDir) };
}

/** `git ls-files -z` (tracked paths), or null when git fails. */
export function gitLsFiles(cwd: string): string[] | null {
  const result = runGit(cwd, ["ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return result.stdout.split("\0").filter(Boolean);
}

/** `git diff <revision>` text; the revision can never be read as an option. Null on failure. */
export function gitDiffRevision(cwd: string, revision: string): string | null {
  const result = runGit(cwd, ["diff", "--end-of-options", revision], { maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** Path-listing git calls all use `-z`, so a path is never quoted nor split on ` -> ` (KD-16). */
function gitPathsZ(cwd: string, args: string[]): string[] {
  const result = runGit(cwd, args, { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new PersistError(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout
    .split("\0")
    .map((line) => toPosixPath(line))
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
  const commit = runGit(cwd, ["commit", "-m", message, "--", ...paths], { kind: "commit" });
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

/** One `git status -z` record: the XY code and its path (plus a rename/copy source). */
export type GitStatusRecord = { x: string; y: string; path: string; from?: string };

/**
 * `git status -z --porcelain=v1 -uall`, NUL-parsed (KD-16). `-z` never quotes and never uses
 * ` -> `, so a path containing that literal text is parsed correctly. Null when git fails.
 */
export function gitStatusRecords(cwd: string): GitStatusRecord[] | null {
  const result = runGit(cwd, ["status", "-z", "--porcelain=v1", "-uall"], { maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) return null;
  const fields = result.stdout.split("\0");
  const out: GitStatusRecord[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (!record || record.length < 4) continue;
    const x = record[0] as string;
    const y = record[1] as string;
    const path = toPosixPath(record.slice(3));
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      // The source path is the next NUL-separated field.
      const from = fields[i + 1];
      i += 1;
      out.push({ x, y, path, ...(from ? { from: toPosixPath(from) } : {}) });
      continue;
    }
    out.push({ x, y, path });
  }
  return out;
}

function porcelainPaths(cwd: string): string[] {
  const records = gitStatusRecords(cwd);
  if (!records) throw new PersistError("git status failed");
  const paths: string[] = [];
  for (const record of records) {
    if (record.path) paths.push(record.path);
    if (record.from) paths.push(record.from);
  }
  return paths;
}

/** The subset of `paths` an ignore rule matches, in one `git check-ignore -z --stdin`. */
export function gitCheckIgnoreMany(cwd: string, paths: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (paths.length === 0) return out;
  const result = runGit(cwd, ["check-ignore", "-z", "--stdin"], {
    input: `${paths.join("\0")}\0`,
    maxBuffer: 64 * 1024 * 1024,
  });
  // 0 = some matched, 1 = none matched; anything else is a real failure.
  if (result.status !== 0 && result.status !== 1) return out;
  for (const raw of result.stdout.split("\0")) {
    if (raw) out.add(toPosixPath(raw));
  }
  return out;
}

/**
 * Ignored entries (KD-16): `dirs` are directories an ignore rule matches outright, which the walk
 * prunes; `files` are ignored files outside them, which are backed up and restored. `--directory`
 * also collapses a directory that merely *happens* to contain nothing but ignored files (say
 * `config/` holding only `local.json`); those are expanded back into individual files with one
 * scoped `ls-files`, so the user's `config/local.json` is protected like any other ignored file.
 * Null when git fails.
 */
export function gitIgnoredEntries(cwd: string): { dirs: string[]; files: string[] } | null {
  const result = runGit(cwd, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  const collapsed: string[] = [];
  const files: string[] = [];
  for (const raw of result.stdout.split("\0")) {
    if (!raw) continue;
    const posix = toPosixPath(raw);
    if (posix.endsWith("/")) collapsed.push(posix.slice(0, -1));
    else files.push(posix);
  }
  if (collapsed.length === 0) return { dirs: [], files };
  const trulyIgnored = gitCheckIgnoreMany(cwd, collapsed);
  const dirs = collapsed.filter((dir) => trulyIgnored.has(dir));
  const expand = collapsed.filter((dir) => !trulyIgnored.has(dir));
  if (expand.length > 0) {
    const inner = runGit(cwd, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--", ...expand], {
      maxBuffer: 256 * 1024 * 1024,
    });
    if (inner.status === 0) {
      for (const raw of inner.stdout.split("\0")) {
        if (raw) files.push(toPosixPath(raw));
      }
    }
  }
  return { dirs, files };
}

/**
 * Blob ids of `<ref>:<path>` in one `git cat-file --batch-check` (F-033). Missing paths map to
 * null. Keys are the input paths.
 */
export function gitBlobIdsAtRef(cwd: string, ref: string, paths: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (paths.length === 0) return out;
  const result = runGit(cwd, ["cat-file", "--batch-check"], {
    input: `${paths.map((path) => `${ref}:${path}`).join("\n")}\n`,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    for (const path of paths) out.set(path, null);
    return out;
  }
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  paths.forEach((path, index) => {
    const line = lines[index] ?? "";
    const parts = line.trim().split(/\s+/);
    out.set(path, parts.length >= 2 && parts[1] === "blob" ? (parts[0] as string) : null);
  });
  return out;
}

/**
 * `git hash-object --stdin-paths` over absolute worktree paths, filters applied (autocrlf, LFS
 * clean), in one spawn (F-033). Unreadable paths map to null.
 */
export function gitHashObjects(cwd: string, absPaths: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (absPaths.length === 0) return out;
  const result = runGit(cwd, ["hash-object", "--stdin-paths"], {
    input: `${absPaths.join("\n")}\n`,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    // One unreadable path aborts the batch; fall back to one call per path.
    for (const abs of absPaths) {
      const one = runGit(cwd, ["hash-object", "--", abs]);
      out.set(abs, one.status === 0 ? one.stdout.trim() : null);
    }
    return out;
  }
  const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
  absPaths.forEach((abs, index) => out.set(abs, (lines[index] ?? "").trim() || null));
  return out;
}

/**
 * Worktree bytes of `<ref>:<path>` with the smudge filters applied, batched through
 * `git cat-file --batch --filters` and falling back to one call per path on older gits.
 */
export function gitCatFileFiltered(cwd: string, ref: string, paths: readonly string[]): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  if (paths.length === 0) return out;
  const batch = runGitBuffer(cwd, ["cat-file", "--batch", "--filters"], {
    input: `${paths.map((path) => `${ref}:${path}`).join("\n")}\n`,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (batch.status === 0) {
    let cursor = 0;
    let ok = true;
    for (const path of paths) {
      const nl = batch.stdout.indexOf(0x0a, cursor);
      if (nl < 0) {
        ok = false;
        break;
      }
      const header = batch.stdout.subarray(cursor, nl).toString("utf8").trim();
      const parts = header.split(/\s+/);
      if (parts.length < 3 || parts[1] !== "blob") {
        out.set(path, null);
        cursor = nl + 1;
        if (header.endsWith("missing")) continue;
        ok = false;
        break;
      }
      const size = Number(parts[2]);
      if (!Number.isFinite(size) || nl + 1 + size > batch.stdout.length) {
        ok = false;
        break;
      }
      out.set(path, batch.stdout.subarray(nl + 1, nl + 1 + size));
      cursor = nl + 1 + size + 1; // trailing LF
    }
    if (ok) return out;
    out.clear();
  }
  for (const path of paths) {
    const one = runGitBuffer(cwd, ["cat-file", "--filters", `${ref}:${path}`], { maxBuffer: 512 * 1024 * 1024 });
    out.set(path, one.status === 0 ? one.stdout : null);
  }
  return out;
}

/** Commit shas in `<from>..<to>`, newest first. Empty when the range is empty or git fails. */
export function gitRevListRange(cwd: string, from: string, to: string): string[] {
  const result = runGit(cwd, ["rev-list", "--end-of-options", `${from}..${to}`], { maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** Point a ref at a commit (`refs/legion-quarantine/<runId>`, R-20). False when git refuses. */
export function gitUpdateRef(cwd: string, ref: string, sha: string): boolean {
  return runGit(cwd, ["update-ref", "--end-of-options", ref, sha]).status === 0;
}

export type GitWorktree = {
  path: string;
  branch: string | null;
};

/**
 * Lexical, case-insensitive comparison only. Callers canonicalize first (with the native
 * realpath, so Windows 8.3 short names such as RUNNER~1 match git's long form) and decide
 * whether the last segment may be followed. Never realpath here: that would follow a link at a
 * worktree node path and make it match the checkout it points at.
 */
function sameAbsPath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return left === right || left.toLowerCase() === right.toLowerCase();
}

/** realpath of the longest existing prefix of `path`, with the missing remainder appended. */
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
 */
export function sameWorktreePath(a: string, b: string): boolean {
  const canonical = (path: string) => join(realPrefix(dirname(resolve(path))), basename(resolve(path)));
  return sameAbsPath(canonical(a), canonical(b));
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
    throw new PersistError(`git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`);
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
    throw new PersistError(`git worktree remove failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  gitWorktreePrune(cwd);
  return true;
}

/** Create `branch` at `startPoint` without checking it out. No-op when the branch already exists. */
export function gitBranchCreate(cwd: string, branch: string, startPoint: string): boolean {
  if (gitBranchExists(cwd, branch)) return false;
  const result = runGit(cwd, ["branch", branch, startPoint]);
  if (result.status !== 0) {
    throw new PersistError(`git branch failed: ${result.stderr.trim() || result.stdout.trim()}`);
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
  return gitPathsZ(cwd, ["diff", "--cached", "--name-only", "-z"]);
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
  const commit = runGit(cwd, ["commit", "-m", message], { kind: "commit" });
  if (commit.status !== 0) {
    throw new PersistError(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }
  return gitHead(cwd);
}

/** Undo a commit we just made; keep the worktree (not --hard). */
export function gitResetMixed(cwd: string, ref: string): void {
  const result = runGit(cwd, ["reset", "--mixed", ref]);
  if (result.status !== 0) {
    throw new PersistError(`git reset failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}
