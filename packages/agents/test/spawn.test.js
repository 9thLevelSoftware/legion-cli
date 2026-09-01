import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  AdapterNotEnabled,
  GenericAdapter,
  buildPointerPrompt,
  createAdapter,
  filterSpawnEnv,
} from "../dist/index.js";
import { fixturesDir, setupRun, withTempDir } from "./helpers.js";

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "EPERM") return true;
    return false;
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

test("fake writes expected artifacts and summary.md", async () => {
  await withTempDir(async (dir) => {
    const { job, paths } = await setupRun(dir, {
      expectedArtifacts: [
        { path: "src/main.ts", content: "export const ok = true;\n" },
        ".legion-cli/plans/plan.md",
      ],
    });
    const adapter = createAdapter("fake");
    const handle = await adapter.spawn(job);
    const result = await handle.wait();
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
    assert.equal(await readFile(join(dir, "src", "main.ts"), "utf8"), "export const ok = true;\n");
    assert.equal(await readFile(join(dir, ".legion-cli", "plans", "plan.md"), "utf8"), "\n");
    assert.equal(result.summaryPath, paths.summaryPath);
    assert.match(await readFile(paths.summaryPath, "utf8"), /Fake adapter completed/);
    assert.match(await readFile(paths.skillMd, "utf8"), /# skill/);
  });
});

test("generic spawn passes the pointer prompt as argv", async () => {
  await withTempDir(async (dir) => {
    const pointer = buildPointerPrompt("run-ptr", "plan");
    const { job } = await setupRun(dir, { runId: "run-ptr", pointerPrompt: pointer });
    const adapter = new GenericAdapter({
      binary: process.execPath,
      args: [join(fixturesDir, "echo-argv.js"), "{{pointer}}"],
    });
    const handle = await adapter.spawn(job);
    const result = await handle.wait();
    assert.equal(result.exitCode, 0, await readFile(result.stderrPath, "utf8"));
    const argv = JSON.parse(await readFile(join(dir, "argv.json"), "utf8"));
    assert.equal(argv.at(-1), pointer);
    assert.match(pointer, /runId=run-ptr/);
    assert.equal(result.summaryPath, job.promptPath.replace(/prompt\.md$/, "summary.md"));
  });
});

test("process-group abort kills the spawn tree", async () => {
  await withTempDir(async (dir) => {
    const { job } = await setupRun(dir, { timeoutMs: 20_000 });
    const adapter = new GenericAdapter({
      binary: process.execPath,
      args: [join(fixturesDir, "sleep-tree.js")],
    });
    const handle = await adapter.spawn(job);
    const started = Date.now();
    const childPidPath = join(dir, "child-pid.txt");
    await waitUntil(
      async () => {
        try {
          await readFile(childPidPath, "utf8");
          return true;
        } catch {
          return false;
        }
      },
      5000,
      "grandchild pid file was not written",
    );
    const childPid = Number((await readFile(childPidPath, "utf8")).trim());
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.equal(pidAlive(handle.pid), true);
    assert.equal(pidAlive(childPid), true);
    const waiting = handle.wait();
    await handle.abort();
    const result = await waiting;
    assert.ok(Date.now() - started < 12_000);
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    await waitUntil(() => !pidAlive(handle.pid) && !pidAlive(childPid), 3000, "process group still alive");
  });
});

test("timeout aborts the process group", async () => {
  await withTempDir(async (dir) => {
    const { job } = await setupRun(dir, { timeoutMs: 400 });
    const adapter = new GenericAdapter({
      binary: process.execPath,
      args: [join(fixturesDir, "sleep-tree.js")],
    });
    const handle = await adapter.spawn(job);
    const result = await handle.wait();
    assert.equal(result.timedOut, true);
    assert.equal(result.aborted, true);
    assert.notEqual(result.exitCode, 0);
  });
});

test("filterSpawnEnv keeps allowlisted keys and inherits SSH_AUTH_SOCK", () => {
  const filtered = filterSpawnEnv({
    PATH: "/bin",
    HOME: "/home/u",
    SECRET: "nope",
    CLAUDE_API_KEY: "k",
    SSH_AUTH_SOCK: "/tmp/ssh",
    TERM: "xterm",
  });
  assert.equal(filtered.PATH, "/bin");
  assert.equal(filtered.HOME, "/home/u");
  assert.equal(filtered.CLAUDE_API_KEY, "k");
  assert.equal(filtered.SSH_AUTH_SOCK, "/tmp/ssh");
  assert.equal(filtered.TERM, "xterm");
  assert.equal(filtered.SECRET, undefined);
  const noSock = filterSpawnEnv({ PATH: "/bin" });
  assert.equal(noSock.SSH_AUTH_SOCK, undefined);
});

test("createAdapter grok spawn still throws without a job cwd", async () => {
  await assert.rejects(
    () => createAdapter("grok").spawn({
      runId: "x",
      skillId: "qa",
      promptPath: "p",
      pointerPrompt: "ptr",
      cwd: ".",
      timeoutMs: 1,
      env: {},
    }),
    AdapterNotEnabled,
  );
});
