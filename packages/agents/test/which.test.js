import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveBinary, whichAll, withNoCwdExeSearch } from "../dist/index.js";
import { withTempDir } from "./helpers.js";

const win = process.platform === "win32";

test("withNoCwdExeSearch sets NoDefaultCurrentDirectoryInExePath only on Windows", () => {
  const env = withNoCwdExeSearch({ A: "1" });
  assert.equal(env.A, "1");
  assert.equal(env.NoDefaultCurrentDirectoryInExePath, win ? "1" : undefined);
});

test("a decoy git.exe in the cwd is not resolved (Windows)", { skip: !win }, async () => {
  await withTempDir(async (dir) => {
    const decoy = join(dir, "git.exe");
    copyFileSync(process.execPath, decoy);
    const before = process.cwd();
    process.chdir(dir);
    try {
      for (const hit of [...whichAll("git"), resolveBinary("git") ?? ""]) {
        assert.notEqual(dirname(hit).toLowerCase(), dir.toLowerCase(), hit);
      }
    } finally {
      process.chdir(before);
    }
  });
});
