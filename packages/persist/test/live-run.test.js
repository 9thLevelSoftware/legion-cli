import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clearLiveRun,
  createLiveRun,
  liveRuns,
  liveRunState,
  ownProcessStartedAt,
  recordLiveRunAgent,
} from "../dist/index.js";

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-persist-live-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a run marker is created exclusively: a second spawn never overwrites it", async () => {
  await withDir(async (dir) => {
    await createLiveRun(dir, { runId: "execute-1", skillId: "execute", taskId: "TSK-1" });
    await assert.rejects(
      () => createLiveRun(dir, { runId: "execute-1", skillId: "execute", taskId: "TSK-1" }),
      (err) => err.code === "EEXIST",
    );
    await clearLiveRun(dir, "execute-1");
    await clearLiveRun(dir, "execute-1"); // already gone: not an error
  });
});

test("liveRunState: this process with its own identity is live, a recorded earlier start is not", async () => {
  await withDir(async (dir) => {
    const marker = await createLiveRun(dir, { runId: "execute-2", skillId: "execute", taskId: null });
    assert.equal((await liveRunState(marker)).live, true);
    const reused = { ...marker, engineStartedAt: ownProcessStartedAt() - 3_600_000 };
    assert.deepEqual(await liveRunState(reused), { engineAlive: false, agentAlive: false, live: false });
  });
});

test("the agent alone keeps a run live when the engine is gone", async () => {
  await withDir(async (dir) => {
    const created = await createLiveRun(dir, { runId: "execute-3", skillId: "execute", taskId: null });
    const marker = await recordLiveRunAgent(dir, { ...created, enginePid: 2_000_000_000 }, process.pid);
    assert.deepEqual(await liveRunState(marker), { engineAlive: false, agentAlive: true, live: true });
    const listed = await liveRuns(dir);
    assert.equal(listed.live.length, 1);
    assert.equal(listed.live[0].agentPid, process.pid);
  });
});

test("liveRuns clears provably dead markers only when asked", async () => {
  await withDir(async (dir) => {
    const created = await createLiveRun(dir, { runId: "execute-4", skillId: "execute", taskId: null });
    // rewrite as a dead run
    await recordLiveRunAgent(dir, { ...created, enginePid: 2_000_000_000, engineStartedAt: 1 }, 2_000_000_001);
    assert.equal((await liveRuns(dir)).dead.length, 1);
    assert.equal((await liveRuns(dir, { clearDead: true })).dead.length, 1);
    assert.equal((await liveRuns(dir)).dead.length, 0);
  });
});
