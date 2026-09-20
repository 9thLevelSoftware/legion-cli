import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";

import { restoreProtected, snapshotProtected } from "../dist/index.js";
import {
  initGitRepo,
  initProject,
  passingVerificationCommand,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
} from "./helpers.js";

// KD-13: the pre-P task-file restore is gone; the protected set is what restores task bytes now.
test("the protected-set restore replaces a symlinked task file without following the link", async () => {
  await withEngine(async ({ engine, dir }) => {
    await initProject(engine);
    const tasksDir = join(dir, ".legion-cli", "tasks");
    await mkdir(tasksDir, { recursive: true });
    const taskPath = join(tasksDir, "TSK-0001.md");
    await writeFile(taskPath, "original\n");
    const snapshot = await snapshotProtected(dir);
    await writeFile(join(dir, "evil.txt"), "pwned\n");
    await unlink(taskPath);
    let linked = false;
    try {
      await symlink(join(dir, "evil.txt"), taskPath);
      linked = true;
    } catch (err) {
      if (err?.code !== "EPERM") throw err;
    }
    const result = await restoreProtected(snapshot, {
      runId: "review-test",
      allowedRoots: [".legion-cli/qa/review.md"],
      admitNewTasks: true,
    });
    assert.equal(result.incident, true);
    assert.deepEqual(result.rewrittenTaskIds, ["TSK-0001"]);
    assert.deepEqual(result.unrestorable, []);
    assert.equal(await readFile(taskPath, "utf8"), "original\n");
    if (linked) {
      assert.equal(await readFile(join(dir, "evil.txt"), "utf8"), "pwned\n");
      assert.equal((await lstat(taskPath)).isSymbolicLink(), false);
      assert.ok(result.quarantine, "the link that replaced the task file is quarantined");
    }
  });
});

test("FileContract revert still runs after sandboxed execute copy-out", async () => {
  await withFakeAdapter(async () => {
    let projectDir;
    await withEngine(
      async ({ engine, store, dir }) => {
        projectDir = dir;
        await initProject(engine);
        await seedPlanReady(store, {
          task: {
            contract: {
              filesAllowed: ["src/main.ts"],
              expectedArtifacts: ["src/main.ts"],
              verificationCommands: [passingVerificationCommand()],
            },
          },
        });
        initGitRepo(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
        assert.ok(result.tasks[0].extrasReverted.includes("src/secret.ts"));
        assert.equal(existsSync(join(dir, "src", "operator-extra.ts")), false);
        assert.ok(result.tasks[0].extrasReverted.includes("src/operator-extra.ts"));
      },
      {
        fakeArtifacts: [{ path: "src/secret.ts", content: "export const secret = true;\n" }],
        fakeOnWait: async () => {
          await mkdir(join(projectDir, "src"), { recursive: true });
          await writeFile(join(projectDir, "src", "operator-extra.ts"), "only-revert-sees-this\n", "utf8");
        },
      },
    );
  });
});
