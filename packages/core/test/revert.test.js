import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";

import { restoreProtected, snapshotProtected } from "../dist/index.js";
import {
  commitAll,
  gitHead,
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

// PR 5 (Q1): a jailed run's real-tree change is quarantined and restored, the task is blocked,
// and NO scope ticket is filed for it — it is not the agent's scope creep.
test("a user edit outside the jail is reverted, blocks the task, and files no TSK", async () => {
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
        await writeFile(join(dir, "README.md"), "my readme\n", "utf8");
        initGitRepo(dir);
        const before = await readFile(join(dir, "README.md"), "utf8");
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal(await readFile(join(dir, "README.md"), "utf8"), before);
        assert.ok(result.tasks[0].extrasReverted.includes("README.md"), JSON.stringify(result.tasks[0]));
        assert.match(result.tasks[0].reason ?? "", /outside the jail/);
        // No scope ticket: TSK-0002 must not exist (Q1).
        await assert.rejects(() => store.readTask("TSK-0002"));
      },
      {
        fakeArtifacts: [{ path: "src/main.ts", content: "export const ok = true;\n" }],
        fakeOnWait: async () => {
          await writeFile(join(projectDir, "README.md"), "the operator typed this mid-run\n", "utf8");
        },
      },
    );
  });
});

// R-20: an adapter that commits an out-of-contract edit blocks the task, and the sha is recorded
// in STATE.quarantinedCommits — which is in the protected set, so a later agent cannot erase it.
test("a commit made during the run blocks the task and lands in STATE.quarantinedCommits", async () => {
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
        await writeFile(join(dir, "README.md"), "my readme\n", "utf8");
        initGitRepo(dir);
        const pre = gitHead(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal(result.tasks[0].incident, true);
        assert.equal(await readFile(join(dir, "README.md"), "utf8"), "my readme\n");
        const state = await engine.getState();
        assert.ok(Array.isArray(state.quarantinedCommits), JSON.stringify(state));
        assert.equal(state.quarantinedCommits.length, 1);
        assert.notEqual(state.quarantinedCommits[0], pre);
        assert.match(result.tasks[0].reason ?? "", /git reset/);
      },
      {
        fakeArtifacts: [{ path: "src/main.ts", content: "export const ok = true;\n" }],
        fakeOnWait: async () => {
          await writeFile(join(projectDir, "README.md"), "committed by the agent\n", "utf8");
          commitAll(projectDir, "agent commit");
        },
      },
    );
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
