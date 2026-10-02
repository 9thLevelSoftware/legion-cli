import assert from "node:assert/strict";
import test from "node:test";

import { SkillIdSchema } from "@9thlevelsoftware/legion-cli-schema";
import { SKILL_CONTRACTS, isAllowedPath, isEngineOwned, isImplicitForbidden, skillContract } from "../dist/index.js";

test("SKILL_CONTRACTS covers every SkillId including map, wireframe, chat", () => {
  assert.deepEqual(Object.keys(SKILL_CONTRACTS).sort(), [...SkillIdSchema.options].sort());
  assert.deepEqual(SKILL_CONTRACTS.map, [".legion-cli/map/ARCHITECTURE.md", ".legion-cli/cache/runs/<id>/**"]);
  assert.deepEqual(SKILL_CONTRACTS.wireframe, [
    ".legion-cli/specs/<activeSpecId>/wireframes/**",
    ".legion-cli/cache/runs/<id>/**",
  ]);
  assert.deepEqual(SKILL_CONTRACTS.chat, [".legion-cli/cache/runs/<id>/**"]);

  const map = skillContract("map", { runId: "abc" });
  assert.deepEqual(map.allowedRoots, [".legion-cli/map/ARCHITECTURE.md", ".legion-cli/cache/runs/abc/**"]);
  const wireframe = skillContract("wireframe", { runId: "abc", specId: "spec-checkin" });
  assert.deepEqual(wireframe.allowedRoots, [
    ".legion-cli/specs/spec-checkin/wireframes/**",
    ".legion-cli/cache/runs/abc/**",
  ]);
  const chat = skillContract("chat", { runId: "abc" });
  assert.deepEqual(chat.allowedRoots, [".legion-cli/cache/runs/abc/**"]);
  const wireframeNoSpec = skillContract("wireframe", { runId: "abc" });
  assert.deepEqual(wireframeNoSpec.allowedRoots, [
    ".legion-cli/specs/*/wireframes/**",
    ".legion-cli/cache/runs/abc/**",
  ]);
  assert.equal(isEngineOwned(".legion-cli/sandbox/run-1/src/main.ts"), true);
  assert.equal(isEngineOwned(".legion-cli/chat/session.json"), false);
  assert.equal(isImplicitForbidden(".legion-cli/STATE.md"), true);
  assert.equal(isImplicitForbidden(".legion-cli/tasks/TSK-0001.md"), true);
  assert.equal(isImplicitForbidden(".env"), true);
  assert.equal(isImplicitForbidden(".ENV"), true);
  assert.equal(isImplicitForbidden(".env.local"), true);
  assert.equal(isImplicitForbidden("src/.ENV"), true);
  assert.equal(isImplicitForbidden(".ENV.local"), true);
  assert.equal(isImplicitForbidden("src/main.ts"), false);
});

// The audit chain is tamper evidence: an injected distill agent must not be able to rewrite
// events.jsonl + chain.json consistently. The engine writes the ingest receipt itself.
test("ingest contract does not allow audit writes", () => {
  assert.deepEqual(SKILL_CONTRACTS.ingest, [".legion-cli/wiki/**", ".legion-cli/cache/runs/<id>/**"]);
  const ingest = skillContract("ingest", { runId: "abc" });
  assert.equal(
    ingest.allowedRoots.some((root) => root.toLowerCase().startsWith(".legion-cli/audit")),
    false,
  );
});

// Contract checks are string-only: they cannot see a junction on disk. The junction defence is at
// revert time (revert.test.js), which acts on the link and never through it.
test("implicit forbidden compares normalised forms", () => {
  for (const bad of [
    ".GIT/x",
    ".Git./x",
    ".git /x",
    ".git:$DATA/x",
    "GIT~1/x",
    ".LEGION-CLI/STATE.md",
    ".legion-cli./state.md",
    ".legion-cli /state.md",
    "LEGION~1/TASKS/x.md",
    "ENV~1.LOC",
    ".legion-cli/CONFIG~1.YAM",
    ".legion-cli/STATE~1.MD",
  ]) {
    assert.equal(isImplicitForbidden(bad), true, bad);
  }
  assert.equal(isImplicitForbidden("notes~2.md"), false);
  assert.equal(isImplicitForbidden("src/a.ts"), false);
});

test("allowedRoots matching is as loose as the platform filesystem, never looser", () => {
  assert.equal(isAllowedPath("src/main.ts", ["src/main.ts"]), true);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  assert.equal(isAllowedPath("readme.md", ["README.md"]), caseInsensitive);
  // Trailing dots and :stream are aliases only on Windows.
  assert.equal(isAllowedPath("SRC/Main.ts.", ["src/main.ts"]), process.platform === "win32");
  assert.equal(isAllowedPath("src/main.ts:x", ["src/main.ts"]), process.platform === "win32");
  // The deny side normalises everywhere.
  assert.equal(isAllowedPath(".GIT/config", [".git/**", "**"]), false);
});

test("verify and review cannot write QA scores or checklists (F-081)", () => {
  const verify = skillContract("verify", { runId: "r1" }).allowedRoots;
  const review = skillContract("review", { runId: "r1" }).allowedRoots;
  for (const path of [
    ".legion-cli/qa/scores/QA-0001.json",
    ".legion-cli/qa/checklist.json",
    ".legion-cli/qa/notes.md",
  ]) {
    assert.equal(isAllowedPath(path, verify), false, `verify must not write ${path}`);
    assert.equal(isAllowedPath(path, review), false, `review must not write ${path}`);
  }
  assert.equal(isAllowedPath(".legion-cli/qa/verify.md", verify), true);
  assert.equal(isAllowedPath(".legion-cli/qa/verify/TSK-0001.md", verify), true);
  assert.equal(isAllowedPath(".legion-cli/qa/review.md", review), true);
  assert.equal(isAllowedPath(".legion-cli/qa/review.md", verify), false);
  // qa keeps its own roots.
  assert.equal(isAllowedPath(".legion-cli/qa/scores/QA-0001.json", skillContract("qa", { runId: "r1" }).allowedRoots), true);
});
