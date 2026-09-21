import assert from "node:assert/strict";
import test from "node:test";

import { formatReadyTaskLine, nextCommand } from "../dist/next.js";

function task(status, id = "TSK-0001") {
  return {
    schemaVersion: "legion-cli-task/v1",
    id,
    title: id,
    status,
    type: "feature",
    priority: "P0",
    specId: "spec-checkin",
    blockedBy: [],
    blocks: [],
    contract: {
      filesAllowed: ["src/main.ts"],
      filesForbidden: [".git/**"],
      expectedArtifacts: ["src/main.ts"],
      verificationCommands: ["pnpm test"],
      maxFilesTouched: 20,
    },
    assignee: "agent",
    notes: "",
  };
}

function executing(lastReview, slice) {
  return nextCommand(
    {
      schemaVersion: "legion-cli-state/v1",
      phase: "executing",
      activeSpecId: "spec-checkin",
      currentTaskId: slice[0]?.id ?? null,
      lastReadiness: "PASS",
      lastReview,
      lastQaId: null,
    },
    slice,
  );
}

test("initialized brownfield hints legion-cli brownfield", () => {
  const next = nextCommand(
    {
      schemaVersion: "legion-cli-state/v1",
      phase: "initialized",
      activeSpecId: null,
      currentTaskId: null,
      lastReadiness: null,
      lastReview: null,
      lastQaId: null,
    },
    [],
    "brownfield",
  );
  assert.equal(next.run, "legion-cli brownfield");
});

test("executing + lastReview FAIL + open work hints execute, not review", () => {
  const next = executing("FAIL", [task("ready")]);
  assert.equal(next.run, "legion-cli execute");
});

test("executing + lastReview FAIL + all-done slice hints review", () => {
  const next = executing("FAIL", [task("done")]);
  assert.equal(next.run, "legion-cli review");
});

test("executing + blocked P0 with no ready P0 hints task retry", () => {
  const next = executing("FAIL", [task("blocked")]);
  assert.equal(next.run, "legion-cli task retry TSK-0001");
});

test("open brownfield run hints brownfield --resume before the lifecycle next", () => {
  const next = nextCommand(
    {
      schemaVersion: "legion-cli-state/v1",
      phase: "executing",
      activeSpecId: "spec-checkin",
      currentTaskId: "TSK-0001",
      lastReadiness: "PASS",
      lastReview: null,
      lastQaId: null,
    },
    [task("ready")],
    "brownfield",
    undefined,
    { brownfieldRun: { runId: "87437d5f", phase: "execute" } },
  );
  assert.equal(next.run, "legion-cli brownfield --resume 87437d5f");
});

test("executing + lastReview PASS + terminal slice hints qa", () => {
  const next = executing("PASS", [task("done")]);
  assert.equal(next.run, "legion-cli qa");
});

test("executing + lastReview PASS + open work hints execute", () => {
  const next = executing("PASS", [task("done"), task("ready", "TSK-0002")]);
  assert.equal(next.run, "legion-cli execute");
});

test("advisory plan_ready and executing open work hint control-mode guarded", () => {
  const planReady = nextCommand(
    {
      schemaVersion: "legion-cli-state/v1",
      phase: "plan_ready",
      activeSpecId: "spec-checkin",
      currentTaskId: null,
      lastReadiness: "PASS",
      lastReview: null,
      lastQaId: null,
    },
    [task("ready")],
    undefined,
    "advisory",
  );
  assert.equal(planReady.run, "legion-cli control-mode guarded");
  const executingOpen = nextCommand(
    {
      schemaVersion: "legion-cli-state/v1",
      phase: "executing",
      activeSpecId: "spec-checkin",
      currentTaskId: "TSK-0001",
      lastReadiness: "PASS",
      lastReview: null,
      lastQaId: null,
    },
    [task("ready")],
    undefined,
    "advisory",
  );
  assert.equal(executingOpen.run, "legion-cli control-mode guarded");
});

test("formatReadyTaskLine suffixes raw Task.adapter when set", () => {
  assert.equal(
    formatReadyTaskLine({ id: "TSK-0100", title: "settings screen", priority: "P1", adapter: "grok" }),
    "  TSK-0100  settings screen  P1  grok",
  );
});

test("formatReadyTaskLine omits adapter when Task.adapter is unset", () => {
  assert.equal(
    formatReadyTaskLine({ id: "TSK-0100", title: "settings screen", priority: "P1" }),
    "  TSK-0100  settings screen  P1",
  );
});
