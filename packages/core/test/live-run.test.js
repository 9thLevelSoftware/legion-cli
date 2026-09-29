import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isPidAlive, ownProcessStartedAt, processIdentity } from "@9thlevelsoftware/legion-cli-persist";
import { HINT, LegionEngine, LegionRefuseError } from "../dist/index.js";
import { initGitRepo, initProject, seedPlanReady, withEngine, withFakeAdapter } from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

function markerDir(dir) {
  return join(dir, ".legion-cli", "cache", "live-spawn");
}

async function writeMarker(dir, overrides = {}) {
  const marker = {
    schemaVersion: "legion-cli-live-run/v1",
    runId: "execute-test-run",
    skillId: "execute",
    taskId: "TSK-0001",
    enginePid: 2_000_000_000,
    agentPid: null,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
  await mkdir(markerDir(dir), { recursive: true });
  await writeFile(join(markerDir(dir), `${marker.runId}.json`), `${JSON.stringify(marker)}\n`, "utf8");
  return marker;
}

/** A real, long-lived child whose identity is recorded the way the engine records it. */
async function liveChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  assert.ok(child.pid);
  const startedAt = await processIdentity(child.pid);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return {
    pid: child.pid,
    startedAt,
    async kill() {
      child.kill();
      await exited;
    },
  };
}

async function refusedBy(engine) {
  try {
    await engine.setControlMode("guarded");
    return null;
  } catch (err) {
    assert.equal(err instanceof LegionRefuseError, true, err?.message);
    return err;
  }
}

async function ready(fn) {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, store }) => {
      const engine = new LegionEngine(dir, undefined, { skillsDir });
      await initProject(engine);
      await seedPlanReady(store, { phase: "plan_ready" });
      initGitRepo(dir);
      await fn({ dir, store, engine });
    });
  });
}

test("a marker with a dead engine pid and a dead agent does not block, and is cleared", async () => {
  await ready(async ({ dir, engine }) => {
    await writeMarker(dir, { enginePid: 2_000_000_000, agentPid: 2_000_000_001 });
    assert.equal(await refusedBy(engine), null);
    assert.deepEqual(await readdir(markerDir(dir)), []);
  });
});

test("a live engine with a matching identity keeps the guard", async () => {
  await ready(async ({ dir, engine }) => {
    await writeMarker(dir, { enginePid: process.pid, engineStartedAt: ownProcessStartedAt() });
    const err = await refusedBy(engine);
    assert.ok(err, "expected a refusal");
    assert.match(err.message, /execute run execute-test-run is live/);
    assert.equal(err.nextHint, HINT.status);
  });
});

test("pid reuse cannot keep a dead run live: identity must match", async () => {
  await ready(async ({ dir, engine }) => {
    // The recorded process started long before the process now holding that pid.
    await writeMarker(dir, {
      enginePid: process.pid,
      engineStartedAt: ownProcessStartedAt() - 60 * 60 * 1000,
    });
    assert.equal(await refusedBy(engine), null);
  });
});

test("an engine crash leaves the guard holding only while the agent lives", async () => {
  await ready(async ({ dir, engine }) => {
    const child = await liveChild();
    try {
      await writeMarker(dir, {
        enginePid: 2_000_000_000, // the engine is gone
        agentPid: child.pid,
        agentStartedAt: child.startedAt ?? undefined,
      });
      const err = await refusedBy(engine);
      assert.ok(err, "a surviving agent must keep the guard");
      assert.match(err.message, /is live/);
      await child.kill();
      assert.equal(isPidAlive(child.pid), false);
      assert.equal(await refusedBy(engine), null, "guard clears once both processes are gone");
    } finally {
      await child.kill().catch(() => undefined);
    }
  });
});

test("a legacy cache/live-spawn.json is read once and cleared (dead engine)", async () => {
  await ready(async ({ dir, engine }) => {
    const legacy = join(dir, ".legion-cli", "cache", "live-spawn.json");
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, `${JSON.stringify({ enginePid: 2_000_000_000, skillId: "execute", runId: "execute-old" })}\n`);
    assert.equal(await refusedBy(engine), null);
    assert.equal(existsSync(legacy), false);
  });
});

test("a legacy cache/live-spawn.json with a live engine still guards, then is migrated", async () => {
  await ready(async ({ dir, engine }) => {
    const child = await liveChild();
    try {
      const legacy = join(dir, ".legion-cli", "cache", "live-spawn.json");
      await mkdir(dirname(legacy), { recursive: true });
      await writeFile(legacy, `${JSON.stringify({ enginePid: child.pid, skillId: "review", runId: "review-old" })}\n`);
      const err = await refusedBy(engine);
      assert.ok(err);
      assert.match(err.message, /review run review-old is live/);
      assert.equal(existsSync(legacy), false, "legacy file is consumed");
      assert.deepEqual(await readdir(markerDir(dir)), ["review-old.json"]);
      await child.kill();
      assert.equal(await refusedBy(engine), null);
    } finally {
      await child.kill().catch(() => undefined);
    }
  });
});
