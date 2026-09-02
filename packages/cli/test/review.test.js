import assert from "node:assert/strict";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { normalize, runCli, withTempDir, withUnspawnableGrok } from "./helpers.js";

function makeTask(overrides = {}) {
  const { contract, ...rest } = overrides;
  return {
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

async function seedExecutingDone(dir, extra = {}) {
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
      phase: extra.phase ?? "executing",
      activeSpecId: "spec-checkin",
      lastReadiness: "PASS",
      lastReview: extra.lastReview ?? null,
    },
    state.body,
  );
  await engine.store.writeTask(makeTask(extra.task ?? {}), "Implement the in/out button.\n");
  return engine;
}

test("review refuses when the slice is not terminal", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir, { task: { status: "ready" } });
    const result = runCli(["review", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /terminal slice/);
  });
});

test("review PASS when spawn creates zero new tasks", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir);
    const result = runCli(["review", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /Review PASS/);
    assert.match(out, /Next: legion-cli qa/);
    const engine = createLegionEngine(dir);
    assert.equal((await engine.getState()).lastReview, "PASS");
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("verify is optional notes and not a ship gate", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir, { lastReview: "PASS" });
    const result = runCli(["verify", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /not a ship gate/);
    const engine = createLegionEngine(dir);
    assert.equal((await engine.getState()).lastReview, "PASS");
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("verify [id] is accepted", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir);
    const result = runCli(["verify", "TSK-0001", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test("help lists verify and review", async () => {
  const verify = runCli(["help", "verify"]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(normalize(verify.stdout), /not a ship gate/);
  const review = runCli(["help", "review"]);
  assert.equal(review.status, 0, review.stderr);
  assert.match(normalize(review.stdout), /FAIL/);
  const all = runCli(["help", "--all"]);
  assert.equal(all.status, 0, all.stderr);
  const out = normalize(all.stdout);
  assert.match(out, /verify \[id\]/);
  assert.match(out, /review/);
  assert.match(out, /--adapter/);
});

test("review --adapter grok refuses via cli when grok is unspawnable", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedExecutingDone(dir);
    await engine.store.writeConfig(withUnspawnableGrok(await engine.store.readConfig()));
    const result = runCli(["review", "--adapter", "grok", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /spawnable adapter \(grok, via cli\)/);
  });
});

test("verify --adapter grok is accepted as an optional skill", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedExecutingDone(dir, { lastReview: "PASS" });
    await engine.store.writeConfig(withUnspawnableGrok(await engine.store.readConfig()));
    const result = runCli(["verify", "--adapter", "grok", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(normalize(result.stdout), /not a ship gate/);
  });
});

test("verify --adapter bogus refuses", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir);
    const result = runCli(["verify", "--adapter", "bogus", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /adapter must be/);
  });
});
