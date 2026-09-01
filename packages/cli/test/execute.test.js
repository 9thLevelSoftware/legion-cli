import assert from "node:assert/strict";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { normalize, runCli, withTempDir } from "./helpers.js";

function quoteArg(value) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function passingVerify() {
  return `${quoteArg(process.execPath)} -e process.exit(0)`;
}

function makeTask(overrides = {}) {
  const { contract, ...rest } = overrides;
  return {
    schemaVersion: "legion-cli-task/v1",
    id: "TSK-0001",
    title: "in/out button",
    status: "ready",
    type: "feature",
    priority: "P0",
    specId: "spec-checkin",
    blockedBy: [],
    blocks: [],
    assignee: "agent",
    notes: "",
    ...rest,
    contract: {
      filesAllowed: ["src/main.ts"],
      filesForbidden: [".git/**"],
      expectedArtifacts: ["src/main.ts"],
      verificationCommands: [passingVerify()],
      maxFilesTouched: 20,
      ...contract,
    },
  };
}

async function seedPlanReady(dir, extra = {}) {
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
    { ...state.data, phase: "plan_ready", activeSpecId: "spec-checkin", lastReadiness: "PASS" },
    state.body,
  );
  await engine.store.writeTask(makeTask(extra.task ?? {}), "Implement the in/out button.\n");
  if (extra.extraTasks) {
    for (const task of extra.extraTasks) {
      await engine.store.writeTask(task, `${task.title}.\n`);
    }
  }
  return engine;
}

test("execute refuses before plan_ready", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["execute", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /plan_ready or executing/);
  });
});

test("execute one ready task and stay executing", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir);
    const result = runCli(["execute", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /TSK-0001/);
    assert.match(out, /Verification PASS/);
    assert.match(out, /Dashboard: http:\/\/127\.0\.0\.1:7420/);
    assert.doesNotMatch(out, /OS isolation|sandbox/i);
    const engine = createLegionEngine(dir);
    assert.equal((await engine.getState()).phase, "executing");
    assert.equal((await engine.store.readTask("TSK-0001")).data.status, "done");
  });
});

test("execute --until-blocked loops remaining ready tasks", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir, {
      extraTasks: [
        makeTask({
          id: "TSK-0002",
          title: "board",
          contract: {
            filesAllowed: ["src/board.ts"],
            expectedArtifacts: ["src/board.ts"],
            verificationCommands: [passingVerify()],
          },
        }),
      ],
    });
    const result = runCli(["execute", "--until-blocked", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /TSK-0001/);
    assert.match(out, /TSK-0002/);
    assert.match(out, /Slice complete/);
    const engine = createLegionEngine(dir);
    assert.equal((await engine.store.readTask("TSK-0001")).data.status, "done");
    assert.equal((await engine.store.readTask("TSK-0002")).data.status, "done");
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("execute --fix is accepted", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir);
    const result = runCli(["execute", "--fix", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test("help lists execute flags", async () => {
  const result = runCli(["help", "execute"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /until-blocked/);
  assert.match(out, /fix/);
});
