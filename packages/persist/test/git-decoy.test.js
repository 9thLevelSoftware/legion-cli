import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";

import { gitExecutable, runGit } from "../dist/git.js";

// A bare `git` is looked up by the process search; on Windows the resolver must return an
// absolute git.exe that is not in the project or the cwd. (Reverting gitExecutable to "git"
// makes this test fail.)
test("git resolves to an absolute git.exe outside the project (Windows)", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-git-decoy-"));
  const before = process.cwd();
  try {
    copyFileSync(process.execPath, join(dir, "git.exe"));
    process.chdir(dir);
    const exe = gitExecutable(dir);
    assert.ok(exe && isAbsolute(exe), `absolute path expected, got ${exe}`);
    assert.match(exe, /\.exe$/i);
    assert.notEqual(dirname(exe).toLowerCase(), dir.toLowerCase());
    const result = runGit(dir, ["--version"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^git version /);
  } finally {
    process.chdir(before);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("gitExecutable is plain git off Windows", { skip: process.platform === "win32" }, () => {
  assert.equal(gitExecutable(), "git");
});
