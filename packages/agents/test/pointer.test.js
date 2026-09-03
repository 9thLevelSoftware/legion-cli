import assert from "node:assert/strict";
import test from "node:test";
import { POINTER_PROMPT_MAX_CHARS, buildPointerPrompt } from "../dist/index.js";

test("pointer prompt uses LEGION CLI untrusted marker and stays under the cap", () => {
  const prompt = buildPointerPrompt("abc", "review");
  assert.ok(prompt.length <= POINTER_PROMPT_MAX_CHARS);
  assert.doesNotMatch(prompt, /SHERPA/);
  assert.match(prompt, /BEGIN LEGION CLI UNTRUSTED CONTENT/);
  assert.match(prompt, /do not load their bodies/);
  assert.match(prompt, /Do not run legion-cli/);
  assert.match(prompt, /runId=abc/);
  assert.match(prompt, /skill=review/);
  assert.match(prompt, /\.legion-cli\/cache\/runs\/abc\/prompt\.md/);
  assert.match(prompt, /\.legion-cli\/cache\/skills\/abc\/SKILL\.md/);
  assert.match(prompt, /Do not `git add` or `git commit`/);
  assert.match(prompt, /\.legion-cli\/cache\/runs\/abc\/summary\.md/);
});
