import assert from "node:assert/strict";
import test from "node:test";

import { MAX_SPAWN_TIMEOUT_MS, ResumeFileSchema } from "../dist/index.js";

const base = {
  schemaVersion: "legion-cli-resume/v1",
  runId: "execute-abc",
  taskId: "TSK-0001",
  skillId: "execute",
  preSpawnRef: "UNBORN",
  startedAt: new Date().toISOString(),
  timeoutMs: 60_000,
  pid: 1234,
  enginePid: 1234,
};

test("R-15: a resume record may not start in the future or claim an unbounded timeout", () => {
  assert.equal(ResumeFileSchema.safeParse(base).success, true);
  const future = new Date(Date.now() + 24 * 3_600_000).toISOString();
  assert.equal(ResumeFileSchema.safeParse({ ...base, startedAt: future }).success, false);
  assert.equal(ResumeFileSchema.safeParse({ ...base, startedAt: "not a date" }).success, false);
  assert.equal(ResumeFileSchema.safeParse({ ...base, timeoutMs: MAX_SPAWN_TIMEOUT_MS }).success, true);
  assert.equal(ResumeFileSchema.safeParse({ ...base, timeoutMs: MAX_SPAWN_TIMEOUT_MS + 1 }).success, false);
});
