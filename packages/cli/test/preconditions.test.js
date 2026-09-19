import assert from "node:assert/strict";
import test from "node:test";

import { allowCopyJailIn, normalize, runCli, withTempDir } from "./helpers.js";

test("KD-3: init outside a git repo prints the git next step; doctor reports the missing repository", async () => {
  await withTempDir(
    async (dir) => {
      const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
      assert.equal(init.status, 0, init.stderr);
      assert.match(normalize(init.stderr), /git repository with at least one commit/);
      assert.match(normalize(init.stderr), /git init && git add -A && git commit -m "start"/);
      await allowCopyJailIn(dir);
      const doctor = runCli(["doctor", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
      assert.notEqual(doctor.status, 0);
      assert.match(normalize(doctor.stdout), /FAIL {2}git repository \(not a git repository; next: git init/);
    },
    { git: false },
  );
});

test("KD-3: init inside a repo with a commit prints no git hint", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    assert.doesNotMatch(normalize(init.stderr), /git repository/);
  });
});
