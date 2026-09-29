import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runGit } from "../dist/index.js";

test("runGit ignores a decoy git.exe in the project directory (Windows)", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-git-decoy-"));
  try {
    copyFileSync(process.execPath, join(dir, "git.exe"));
    const result = runGit(dir, ["--version"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^git version /);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
