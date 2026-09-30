import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
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

test("a marker with no recorded identity still detects pid reuse through its creation time", async () => {
  await ready(async ({ dir, engine }) => {
    // The process now holding this pid started long after the marker was created.
    await writeMarker(dir, {
      enginePid: process.pid,
      startedAt: new Date(ownProcessStartedAt() - 60 * 60 * 1000).toISOString(),
    });
    assert.equal(await refusedBy(engine), null);
  });
});

test("a fresh unparseable marker refuses; an old one is treated as dead and cleared", async () => {
  await ready(async ({ dir, engine }) => {
    await mkdir(markerDir(dir), { recursive: true });
    const path = join(markerDir(dir), "execute-torn.json");
    await writeFile(path, "{ torn", "utf8");
    const err = await refusedBy(engine);
    assert.ok(err, "a marker being written must not fail open");
    assert.match(err.message, /run execute-torn is live/);
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    assert.equal(await refusedBy(engine), null);
    assert.equal(existsSync(path), false);
  });
});

test("the refusal names the marker file to delete when a pid cannot be proven to be an agent", async () => {
  await ready(async ({ dir, engine }) => {
    await writeMarker(dir, { runId: "execute-other", enginePid: process.pid, engineStartedAt: ownProcessStartedAt() });
    const err = await refusedBy(engine);
    assert.ok(err);
    assert.ok(err.message.includes(".legion-cli/cache/live-spawn/execute-other.json"), err.message);
  });
});

test("a failed relock releases the run's marker (no leak in a long-lived process)", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, store }) => {
      const readyPath = join(dir, ".legion-cli", "cache", "fake-wait", "leak-ready");
      const releasePath = join(dir, ".legion-cli", "cache", "fake-wait", "leak-release");
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeHoldWait: { readyPath, releasePath, timeoutMs: 15_000 },
        fakeArtifacts: [
          {
            path: ".legion-cli/cache/runs/<id>/review.md",
            content: "# Review" + String.fromCharCode(10),
          },
        ],
      });
      await initProject(engine);
      await seedPlanReady(store, { phase: "executing", task: { status: "done" } });
      initGitRepo(dir);
      const pending = engine.review();
      const start = Date.now();
      while (!existsSync(readyPath) && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 20));
      // A different live run makes the owner's own finish relock refuse before finishStartedSpawn.
      await writeMarker(dir, { runId: "execute-foreign", enginePid: process.pid, engineStartedAt: ownProcessStartedAt() });
      await writeFile(releasePath, "go" + String.fromCharCode(10));
      await assert.rejects(pending, (err) => err instanceof LegionRefuseError && /execute-foreign is live/.test(err.message));
      assert.deepEqual(await readdir(markerDir(dir)), ["execute-foreign.json"], "the review run's marker leaked");
    });
  });
});
