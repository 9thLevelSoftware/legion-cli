import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireEngineLock } from "../dist/index.js";

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

test("a zero-timeout contended acquire fails fast without the slow identity probe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-lockrel-"));
  try {
    const lockPath = join(dir, "engine.lock");
    const held = await acquireEngineLock(lockPath);
    const started = Date.now();
    await assert.rejects(() => acquireEngineLock(lockPath, { timeoutMs: 0 }));
    assert.ok(Date.now() - started < 1000);
    await held.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
