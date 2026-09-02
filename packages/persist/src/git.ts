import { spawnSync } from "node:child_process";
import { PersistError } from "./errors.js";
import type { IngestReceipt } from "@9thlevelsoftware/legion-cli-schema";

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
