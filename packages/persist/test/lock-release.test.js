import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireEngineLock, EngineLockedError } from "../dist/index.js";

test("release leaves a lock file that now holds another token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-lockrel-"));
  try {
    const lockPath = join(dir, "engine.lock");
    const mine = await acquireEngineLock(lockPath);
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, token: "someone-else" })}\n`, "utf8");
    await mine.release();
    assert.equal(existsSync(lockPath), true, "a stolen-and-retaken lock must not be deleted by the old holder");
    const own = await acquireEngineLock(join(dir, "own.lock"));
    await own.release();
    assert.equal(existsSync(join(dir, "own.lock")), false, "an owned lock is removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("timeoutMs 0 skips the deep identity probe: a reused-PID lock is not stolen, while a waiting acquire steals it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-lockprobe-"));
  try {
    const lockPath = join(dir, "engine.lock");
    // Held by a live process (our parent) whose recorded start time is ancient: only the deep
    // probe can prove PID reuse and steal it.
    const payload = `${JSON.stringify({ pid: process.ppid, pidStartedAt: 1, acquiredAt: "2020-01-01T00:00:00.000Z", token: "old" })}\n`;
    await writeFile(lockPath, payload, "utf8");
    await assert.rejects(() => acquireEngineLock(lockPath, { timeoutMs: 0 }), EngineLockedError);
    assert.equal(existsSync(lockPath), true, "no probe, so nothing was stolen");
    const stolen = await acquireEngineLock(lockPath, { timeoutMs: 200 });
    await stolen.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lock payload records hostname/platform and foreign host/platform locks are not stolen on ESRCH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-lockhost-"));
  try {
    const lockPath = join(dir, "engine.lock");
    const held = await acquireEngineLock(lockPath);
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(parsed.hostname, hostname());
    assert.equal(parsed.platform, process.platform);
    await held.release();

    const otherHost = `${JSON.stringify({ pid: 2_000_000_000, hostname: `${hostname()}-wsl2`, platform: process.platform, token: "foreign-host" })}\n`;
    await writeFile(lockPath, otherHost, "utf8");
    await assert.rejects(() => acquireEngineLock(lockPath, { timeoutMs: 100 }), EngineLockedError);
    assert.equal(await readFile(lockPath, "utf8"), otherHost);

    const otherPlatform = `${JSON.stringify({ pid: 2_000_000_000, hostname: hostname(), platform: process.platform === "win32" ? "linux" : "win32", token: "foreign-plat" })}\n`;
    await writeFile(lockPath, otherPlatform, "utf8");
    await assert.rejects(() => acquireEngineLock(lockPath, { timeoutMs: 100 }), EngineLockedError);
    assert.equal(await readFile(lockPath, "utf8"), otherPlatform);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
