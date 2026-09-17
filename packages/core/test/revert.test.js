import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";

import { restoreChangedTaskFiles, snapshotTaskFiles } from "../dist/revert.js";
import { withEngine } from "./helpers.js";

test("restoreChangedTaskFiles recreates the tasks dir and replaces symlinks", async () => {
  await withEngine(async ({ dir }) => {
    const tasksDir = join(dir, "tasks");
    await mkdir(tasksDir, { recursive: true });
    const taskPath = join(tasksDir, "TSK-0001.md");
    await writeFile(taskPath, "original\n");
    const before = await snapshotTaskFiles(tasksDir);
    await writeFile(join(dir, "evil.txt"), "pwned\n");
    await unlink(taskPath);
    let linked = false;
    try {
      await symlink(join(dir, "evil.txt"), taskPath);
      linked = true;
    } catch (err) {
      if (err?.code !== "EPERM") throw err;
    }
    if (!linked) {
      await rm(tasksDir, { recursive: true, force: true });
    }
    const ids = await restoreChangedTaskFiles(tasksDir, before);
    assert.deepEqual(ids, ["TSK-0001"]);
    assert.equal(await readFile(taskPath, "utf8"), "original\n");
    if (linked) {
      assert.equal(await readFile(join(dir, "evil.txt"), "utf8"), "pwned\n");
      assert.equal((await lstat(taskPath)).isSymbolicLink(), false);
    }
  });
});
