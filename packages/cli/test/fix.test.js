import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine, regressionTestPath } from "@9thlevelsoftware/legion-cli-core";
import { normalize, runCli, withTempDir } from "./helpers.js";

async function seedExecutingDone(dir) {
  const engine = createLegionEngine(dir);
  await engine.init({ name: "Checkin", adapter: "fake" });
  await engine.store.writeSpec(
    {
      schemaVersion: "legion-cli-spec/v1",
      id: "spec-checkin",
      title: "Office check-in",
      status: "frozen",
      mustBeTrue: ["People can tap in or out on their phone in under five seconds"],
      mustNotChange: ["auth"],
      outOfScope: ["payroll"],
      acceptance: [
        {
          id: "AC-01",
          statement: "Tap in or out on a phone completes in under five seconds",
          kind: "behavior",
          priority: "P0",
        },
      ],
      personas: ["teammates"],
      happyPath: "Open the board, tap In.",
      frozenAt: "2026-09-01T12:00:00.000Z",
      frozenBy: "tester",
    },
    "Spec body.\n",
  );
  const project = await engine.store.readProject();
  await engine.store.writeProject({ ...project.data, activeSpecId: "spec-checkin" }, project.body);
  const state = await engine.store.readState();
  await engine.store.writeState(
    {
      ...state.data,
      phase: "executing",
      activeSpecId: "spec-checkin",
      lastReadiness: "PASS",
      lastReview: "PASS",
    },
    state.body,
  );
  await engine.store.writeTask(
    {
      schemaVersion: "legion-cli-task/v1",
      id: "TSK-0001",
      title: "in/out button",
      status: "done",
      type: "feature",
      priority: "P0",
      specId: "spec-checkin",
      blockedBy: [],
      blocks: [],
      assignee: "agent",
      notes: "",
      contract: {
        filesAllowed: ["src/main.ts"],
        filesForbidden: [".git/**"],
        expectedArtifacts: ["src/main.ts"],
        verificationCommands: ["pnpm test"],
        maxFilesTouched: 20,
      },
    },
    "Implement the in/out button.\n",
  );
  return engine;
}

test("fix refuses when the reproducing test is already GREEN", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir);
    const bug = "already passing";
    const testPath = regressionTestPath(bug);
    await mkdir(join(dir, "tests", "unit", "regression"), { recursive: true });
    await writeFile(
      join(dir, testPath),
      ['import test from "node:test";', `test(${JSON.stringify(`${bug} @p0`)}, () => {});`, ""].join("\n"),
      "utf8",
    );
    const result = runCli(["fix", bug, "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /this does not reproduce/);
  });
});

test("fix writes a RED test then execute must go GREEN", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir);
    const bug = "board does not refresh";
    const result = runCli(["fix", bug, "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const out = normalize(`${result.stdout}\n${result.stderr}`);
    assert.match(out, /Reproducing test is RED/);
    assert.match(out, /did not go GREEN/);
    const engine = createLegionEngine(dir);
    const tasks = (await engine.listSliceTasks()).filter((task) => task.type === "bug");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].priority, "P0");
    assert.match(tasks[0].contract.filesAllowed[0], /regression/);
    assert.ok(tasks[0].contract.filesAllowed.includes("src/main.js"));
  });
});
