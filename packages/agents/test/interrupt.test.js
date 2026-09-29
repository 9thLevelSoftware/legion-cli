import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fixturesDir, withTempDir } from "./helpers.js";

const parentScript = join(fixturesDir, "interrupt-parent.js");

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

async function waitUntil(predicate, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function readPid(path) {
  return Number((await readFile(path, "utf8")).trim());
}

function startParent(dir, mode) {
  const parent = spawn(process.execPath, [parentScript, dir, mode], { stdio: "ignore", windowsHide: true });
  const exited = new Promise((resolve) => parent.once("exit", resolve));
  return { parent, exited };
}

async function assertTreeGone(dir) {
  const agent = await readPid(join(dir, "agent-pid.txt"));
  const grandchild = await readPid(join(dir, "child-pid.txt"));
  await waitUntil(() => !pidAlive(agent) && !pidAlive(grandchild), 10_000, `agent ${agent} or its child ${grandchild} survived`);
}

test("an exiting engine takes the agent process tree with it", async () => {
  await withTempDir(async (dir) => {
    const { exited } = startParent(dir, "exit");
    await exited;
    assert.equal(existsSync(join(dir, "agent-pid.txt")), true, "parent never reported the agent");
    await assertTreeGone(dir);
  });
});

test("SIGTERM to the engine kills the agent tree (POSIX)", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (dir) => {
    const { parent, exited } = startParent(dir, "wait");
    await waitUntil(() => existsSync(join(dir, "agent-pid.txt")), 20_000, "parent never reported the agent");
    parent.kill("SIGTERM");
    await exited;
    await assertTreeGone(dir);
  });
});
