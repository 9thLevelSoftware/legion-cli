import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import { gitDiffRevision, isGitRepo, resolveGitBinary, runGit, tryGitHead } from "../dist/index.js";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function withRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-git-hardening-"));
  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["config", "user.email", "t@example.com"]);
    await writeFile(join(dir, "a.txt"), "a\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "one"]);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("R-22: git is resolved once to an absolute path from PATH", () => {
  const binary = resolveGitBinary();
  assert.ok(binary, "git on PATH");
  assert.equal(isAbsolute(binary), true);
});

test("R-22: a git.exe planted in the project root is never executed (win32)", { skip: process.platform !== "win32" }, async () => {
  await withRepo(async (dir) => {
    // A node.exe named git.exe that writes a marker whenever it starts (NODE_OPTIONS --require).
    const planted = join(dir, "git.exe");
    try {
      await link(process.execPath, planted);
    } catch {
      await copyFile(process.execPath, planted);
    }
    const marker = join(dir, "planted-ran.txt");
    const hook = join(dir, "planted-hook.cjs");
    await writeFile(hook, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    const nodeOptions = `--require "${hook.replaceAll("\\", "/")}"`;
    // Control: the harness really detects the planted binary when it runs.
    const direct = spawnSync(planted, ["-e", "0"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
    });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(existsSync(marker), true, "control: planted binary should write the marker");
    await rm(marker, { force: true });
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = nodeOptions;
    try {
      assert.equal(isGitRepo(dir), true);
      assert.match(tryGitHead(dir) ?? "", /^[0-9a-f]{40}$/);
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
    assert.equal(existsSync(marker), false, "the planted git.exe ran");
  });
});

test("R-19: hardened read calls never run the repo fsmonitor", async () => {
  await withRepo(async (dir) => {
    const marker = join(dir, "fsmonitor-ran.txt");
    const script = join(dir, "fsmonitor.js").replaceAll("\\", "/");
    await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    git(dir, ["config", "core.fsmonitor", `"${process.execPath.replaceAll("\\", "/")}" "${script}"`]);
    // Positive control (R-32): the planted value is something this git really invokes.
    git(dir, ["status", "--porcelain"]);
    assert.equal(existsSync(marker), true, "control: an unhardened status runs the fsmonitor");
    await rm(marker, { force: true });
    const status = runGit(dir, ["status", "--porcelain"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(existsSync(marker), false, "fsmonitor ran on a hardened read");
  });
});

test("F-096: ingest --diff revisions can never be read as git options", async () => {
  await withRepo(async (dir) => {
    const out = join(dir, "pwned.txt");
    assert.equal(gitDiffRevision(dir, `--output=${out}`), null);
    assert.equal(existsSync(out), false);
    assert.equal(typeof gitDiffRevision(dir, "HEAD"), "string");
  });
});
