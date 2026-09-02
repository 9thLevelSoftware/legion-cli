import assert from "node:assert/strict";
import test from "node:test";

import { nextCommand } from "../dist/next.js";

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

test("executing + lastReview FAIL + open work hints execute, not review", () => {
  const next = executing("FAIL", [task("ready")]);
  assert.equal(next.run, "legion-cli execute");
});

test("executing + lastReview FAIL + terminal slice hints review", () => {
  const next = executing("FAIL", [task("done"), task("blocked", "TSK-0002")]);
  assert.equal(next.run, "legion-cli review");
});

test("executing + lastReview PASS + terminal slice hints qa", () => {
  const next = executing("PASS", [task("done")]);
  assert.equal(next.run, "legion-cli qa");
});

test("executing + lastReview PASS + open work hints execute", () => {
  const next = executing("PASS", [task("done"), task("ready", "TSK-0002")]);
  assert.equal(next.run, "legion-cli execute");
});
