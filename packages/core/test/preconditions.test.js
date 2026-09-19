import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { HINT, LegionRefuseError } from "../dist/index.js";
import {
  git,
  initProject,
  makeTask,
  passingVerificationCommand,
  seedFrozenSpec,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

function isGitRepoRefusal(err) {
  assert.equal(err instanceof LegionRefuseError, true, String(err));
  assert.match(err.message, /git repository with at least one commit/);
  assert.equal(err.nextHint, HINT.spawnGitRepo);
  assert.match(err.nextHint, /git init && git add -A && git commit -m "start"/);
  return true;
}

test("KD-3 / F-012: execute outside a git repo is refused with the next step and does not block the task", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine, { git: false });
        await seedPlanReady(store, {
          task: {
            contract: {
              filesAllowed: ["src/main.ts"],
              expectedArtifacts: ["src/main.ts"],
              verificationCommands: [passingVerificationCommand()],
            },
          },
        });
        await assert.rejects(() => engine.execute("auto"), isGitRepoRefusal);
        assert.equal((await store.readTask("TSK-0001")).data.status, "ready");
        assert.equal((await store.readState()).data.currentTaskId, null);
      },
      { skillsDir },
    );
  });
});

test("KD-3: plan in an unborn repo (git init, no commit) is refused with the next step", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine, { git: false });
        git(dir, ["init"]);
        await seedFrozenSpec(store);
        await assert.rejects(() => engine.plan("spec-checkin"), isGitRepoRefusal);
        assert.equal((await store.readState()).data.phase, "spec_frozen");
      },
      { skillsDir },
    );
  });
});

test("F-060 / F-087: .LEGION-CLI/ in filesAllowed is refused at ticket, amend and plan", async () => {
  const upper = ".LEGION-CLI/tasks/TSK-0001.md";
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store);
        await assert.rejects(
          () => engine.fileTicket({ title: "forge", contract: { filesAllowed: [upper] } }),
          (err) => err instanceof LegionRefuseError && err.nextHint === HINT.concretePaths,
        );
        await assert.rejects(
          () =>
            engine.amendTask("TSK-0001", {
              filesAllowed: [upper],
              expectedArtifacts: [],
              verificationCommands: [passingVerificationCommand()],
              filesForbidden: [],
              maxFilesTouched: 1,
            }),
          (err) => err instanceof LegionRefuseError && err.nextHint === HINT.concretePaths,
        );
        await assert.rejects(
          () =>
            engine.fileTicket({ title: "forge git", contract: { filesAllowed: [".GIT/config"] } }),
          (err) => err instanceof LegionRefuseError,
        );
      },
      { skillsDir },
    );
  });
});

test("F-060: plan readiness FAILs a task whose filesAllowed names .LEGION-CLI/", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
        const bad = makeTask({
          contract: {
            filesAllowed: [".LEGION-CLI/STATE.md"],
            expectedArtifacts: [],
            verificationCommands: [passingVerificationCommand()],
            filesForbidden: [],
            maxFilesTouched: 1,
          },
        });
        await store.writeTask(bad, "Forged scope.\n");
        const readiness = await engine.plan("spec-checkin");
        assert.equal(readiness, "FAIL");
      },
      { skillsDir },
    );
  });
});
