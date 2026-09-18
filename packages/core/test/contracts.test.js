import assert from "node:assert/strict";
import test from "node:test";

import { SkillIdSchema } from "@9thlevelsoftware/legion-cli-schema";
import { SKILL_CONTRACTS, isEngineOwned, skillContract } from "../dist/index.js";

test("SKILL_CONTRACTS covers every SkillId including map, wireframe, chat", () => {
  assert.deepEqual(Object.keys(SKILL_CONTRACTS).sort(), [...SkillIdSchema.options].sort());
  assert.deepEqual(SKILL_CONTRACTS.map, [".legion-cli/map/**", ".legion-cli/cache/runs/<id>/**"]);
  assert.deepEqual(SKILL_CONTRACTS.wireframe, [
    ".legion-cli/specs/<activeSpecId>/wireframes/**",
    ".legion-cli/cache/runs/<id>/**",
  ]);
  assert.deepEqual(SKILL_CONTRACTS.chat, [".legion-cli/cache/runs/<id>/**"]);

  const map = skillContract("map", { runId: "abc" });
  assert.deepEqual(map.allowedRoots, [".legion-cli/map/**", ".legion-cli/cache/runs/abc/**"]);
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
  assert.equal(isEngineOwned(".legion-cli/chat/session.json"), true);
});
