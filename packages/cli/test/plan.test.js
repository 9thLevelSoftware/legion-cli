import assert from "node:assert/strict";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { normalize, runCli, withTempDir } from "./helpers.js";

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
      verificationCommands: ["pnpm test"],
      maxFilesTouched: 20,
      ...contract,
    },
  };
}

async function seedFrozen(dir, extra = {}) {
  const engine = createLegionEngine(dir);
  await engine.init({ name: "Checkin", adapter: "fake" });
  await engine.store.writeSpec(
    {
      schemaVersion: "legion-cli-spec/v1",
      id: "spec-checkin",
      title: "Office check-in",
      status: "frozen",
      mustBeTrue: ["People can tap in or out on their phone in under five seconds"],
      mustNotChange: extra.mustNotChange ?? ["auth"],
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
      wireframesIndex: extra.wireframesIndex ?? null,
    },
    "Spec body.\n",
  );
  const project = await engine.store.readProject();
  await engine.store.writeProject({ ...project.data, activeSpecId: "spec-checkin" }, project.body);
  const state = await engine.store.readState();
  await engine.store.writeState({ ...state.data, phase: "spec_frozen", activeSpecId: "spec-checkin" }, state.body);
  if (extra.task !== false) {
    await engine.store.writeTask(makeTask(extra.task ?? {}), "Implement the in/out button.\n");
  }
  return engine;
}

test("plan requires a spawnable adapter", async () => {
  await withTempDir(async (dir) => {
    await seedFrozen(dir);
    const result = runCli(["plan", "--project", dir]);
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /spawnable adapter/);
  });
});

test("plan PASS/CONCERNS with fake adapter", async () => {
  await withTempDir(async (dir) => {
    await seedFrozen(dir, { mustNotChange: [] });
    const result = runCli(["plan", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(normalize(result.stdout), /Readiness: CONCERNS/);
  });
});

test("empty verificationCommands is plan FAIL", async () => {
  await withTempDir(async (dir) => {
    await seedFrozen(dir, { task: { contract: { verificationCommands: [] } } });
    const result = runCli(["plan", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 1, result.stdout);
    assert.match(normalize(result.stdout), /Readiness: FAIL/);
    assert.match(normalize(result.stdout), /verificationCommands/);
  });
});

test("overlapping filesAllowed is plan FAIL", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedFrozen(dir);
    await engine.store.writeTask(
      makeTask({
        id: "TSK-0002",
        title: "board",
        contract: { filesAllowed: ["src/main.ts"], expectedArtifacts: ["src/main.ts"] },
      }),
      "Overlap.\n",
    );
    const result = runCli(["plan", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 1, result.stdout);
    assert.match(normalize(result.stdout), /overlapping filesAllowed/);
  });
});

test("next lists ready tasks", async () => {
  await withTempDir(async (dir) => {
    await seedFrozen(dir);
    runCli(["plan", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    const result = runCli(["next", "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(normalize(result.stdout), /TSK-0001/);
    assert.match(normalize(result.stdout), /legion-cli execute/);
  });
});

test("ticket create without parent is ready for next", async () => {
  await withTempDir(async (dir) => {
    await seedFrozen(dir);
    runCli(["plan", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    const created = runCli(["ticket", "create", "--project", dir, "--title", "parked extra"]);
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    const engine = createLegionEngine(dir);
    const ticket = (await engine.store.readTask("TSK-0002")).data;
    assert.equal(ticket.status, "ready");
    const next = runCli(["next", "--project", dir]);
    assert.equal(next.status, 0, next.stderr);
    assert.match(normalize(next.stdout), /TSK-0002/);
  });
});

test("ticket create parks extra work linked to parent", async () => {
  await withTempDir(async (dir) => {
    await seedFrozen(dir);
    runCli(["plan", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    const result = runCli([
      "ticket",
      "create",
      "--project",
      dir,
      "--parent",
      "TSK-0001",
      "--title",
      "also do settings",
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(normalize(result.stdout), /Filed TSK-0002/);
    assert.match(normalize(result.stdout), /linked ticket/);
    const engine = createLegionEngine(dir);
    const parent = (await engine.store.readTask("TSK-0001")).data;
    assert.deepEqual(parent.contract.filesAllowed, ["src/main.ts"]);
    const child = (await engine.store.readTask("TSK-0002")).data;
    assert.equal(child.parentId, "TSK-0001");
    assert.equal(child.status, "todo");
    const next = runCli(["next", "--project", dir]);
    assert.doesNotMatch(normalize(next.stdout), /TSK-0002/);
  });
});

test("task amend updates filesAllowed", async () => {
  await withTempDir(async (dir) => {
    await seedFrozen(dir);
    runCli(["plan", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    const result = runCli([
      "task",
      "amend",
      "TSK-0001",
      "--project",
      dir,
      "--files-allowed",
      "src/in-out.ts",
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const engine = createLegionEngine(dir);
    const task = (await engine.store.readTask("TSK-0001")).data;
    assert.deepEqual(task.contract.filesAllowed, ["src/in-out.ts"]);
  });
});
