import assert from "node:assert/strict";
import test from "node:test";

import { SkillIdSchema } from "@9thlevelsoftware/legion-cli-schema";
import {
  SKILL_CONTRACTS,
  isAllowedPath,
  isEngineOwned,
  isImplicitForbidden,
  isProtectedPath,
  skillContract,
} from "../dist/index.js";

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
  assert.equal(isImplicitForbidden(".env"), true);
  assert.equal(isImplicitForbidden(".ENV"), true);
  assert.equal(isImplicitForbidden(".env.local"), true);
  assert.equal(isImplicitForbidden("src/.ENV"), true);
  assert.equal(isImplicitForbidden(".ENV.local"), true);
  assert.equal(isImplicitForbidden("src/main.ts"), false);
});

test("F-025/F-047/R-2: verify, review and qa roots are narrowed; audit and QA scores are protected", () => {
  assert.deepEqual(SKILL_CONTRACTS.review, [".legion-cli/qa/review.md", ".legion-cli/cache/runs/<id>/**"]);
  assert.deepEqual(SKILL_CONTRACTS.verify, [
    ".legion-cli/qa/verify.md",
    ".legion-cli/qa/verify/*.md",
    ".legion-cli/cache/runs/<id>/**",
  ]);
  assert.deepEqual(SKILL_CONTRACTS.qa, [".legion-cli/cache/runs/<id>/**"]);
  assert.equal(SKILL_CONTRACTS.ingest.includes(".legion-cli/audit/**"), false);
  const review = skillContract("review", { runId: "r1" }).allowedRoots;
  assert.equal(isAllowedPath(".legion-cli/qa/review.md", review), true);
  assert.equal(isAllowedPath(".legion-cli/qa/checklist.json", review), false);
  assert.equal(isAllowedPath(".legion-cli/qa/scores/x.json", review), false);
  assert.equal(isAllowedPath(".legion-cli/tasks/TSK-0001.md", review), false);
  // ENGINE_OWNED no longer lets any skill write audit/** (F-046).
  assert.equal(isEngineOwned(".legion-cli/audit/events.jsonl"), false);
  assert.equal(isAllowedPath(".legion-cli/audit/events.jsonl", review), false);
  assert.equal(isProtectedPath(".legion-cli/audit/events.jsonl"), true);
  assert.equal(isProtectedPath(".legion-cli/serve.json"), false);
  assert.equal(isProtectedPath(".legion-cli/cache/runs/r1/prompt.md"), false);
  assert.equal(isProtectedPath(".git/config"), true);
});

test("F-060/F-087: .git and .legion-cli segment checks are case-insensitive", () => {
  assert.equal(isImplicitForbidden(".GIT/config"), true);
  assert.equal(isImplicitForbidden("sub/.Git/hooks/pre-commit"), true);
  assert.equal(isImplicitForbidden(".LEGION-CLI/config.yaml"), true);
  assert.equal(isImplicitForbidden(".Legion-Cli/index/legion-cli.db"), true);
  assert.equal(isAllowedPath(".LEGION-CLI/qa/review.md", [".legion-cli/qa/review.md"]), false);
  assert.equal(isProtectedPath(".LEGION-CLI/STATE.md"), true);
});
