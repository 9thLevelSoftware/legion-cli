import assert from "node:assert/strict";
import test from "node:test";

import { applyIntentAnswers, emptyIntentAnswers, intentProgress } from "../dist/intent.js";
import { templateDecisions } from "../dist/discuss.js";

const LEGACY = {
  failure: "What does failure look like (empty, error, changed mind)?",
  screens: "What screens or moments must exist in v0?",
  platforms: "Phone, desktop, or both?",
  brand: "Any existing brand file we must follow? (path or `none`)",
  blockers: "Anything unsure that would block building?",
};

test("legacy interview rounds replay into mapped intent and do not repeat neutral replacements", () => {
  let file = emptyIntentAnswers();
  file = applyIntentAnswers(file, ["Who is this for, in one sentence?", "What are they stuck doing today?"], ["operators", "deployments fail"]).file;
  file = applyIntentAnswers(file, ["What must be true when this is done?", "What must we not change, and what will we not build?"], ["roll back safely", "No UI rewrite"]).file;
  file = applyIntentAnswers(file, ["What must we not change?"], ["the release API"]).file;
  file = applyIntentAnswers(file, ["Walk through the happy path in 3–5 steps.", LEGACY.failure], ["Run deploy, verify health, roll back when needed.", "network error"] ).file;
  file = applyIntentAnswers(file, [LEGACY.screens, LEGACY.platforms], ["deploy command", "desktop"] ).file;
  file = applyIntentAnswers(file, [LEGACY.brand, LEGACY.blockers], ["none", "none"] ).file;

  assert.deepEqual(file.mapped.screens, ["deploy command"]);
  assert.equal(file.mapped.happyPath, "Run deploy, verify health, roll back when needed.");
  assert.deepEqual(intentProgress(file).nextQuestions, []);
});

test("backend intent does not invent browser or on-device storage decisions", () => {
  let file = emptyIntentAnswers();
  file = applyIntentAnswers(
    file,
    ["What interfaces or touchpoints must exist in v0? (use `none` for a service or library)", "What runtime or deployment environment matters, if any? (for example CLI, service, browser, mobile, Python, Rust; or `none`)"],
    ["HTTP endpoint and Python client", "Rust service deployed in Kubernetes"],
  ).file;
  const side = applyIntentAnswers(
    emptyIntentAnswers(),
    ["What runtime or deployment environment matters, if any? (for example CLI, service, browser, mobile, Python, Rust; or `none`)"],
    ["Rust service deployed in Kubernetes"],
  ).side;

  assert.deepEqual(file.mapped.screens, ["HTTP endpoint and Python client"]);
  assert.deepEqual(side.platforms, []);
  const decisions = templateDecisions(file.mapped, {
    schemaVersion: "legion-cli-context/v1",
    standingInstructions: "",
    platforms: side.platforms,
  });
  assert.equal(decisions.some((item) => /browser|mobile web|on the device|remote server/i.test(item.statement)), false);
});
