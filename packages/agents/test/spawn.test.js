import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  AgentError,
  EXTRA_ADAPTER_IDS,
  GenericAdapter,
  buildPointerPrompt,
  createAdapter,
  filterSpawnEnv,
  unwrapCmdShim,
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
    assert.match(argv.at(-1), /Do not `git add` or `git commit`/);
    assert.match(pointer, /runId=run-ptr/);
    assert.equal(result.summaryPath, job.promptPath.replace(/prompt\.md$/, "summary.md"));
  });
});

test("process-group abort kills the spawn tree", async () => {
  await withTempDir(async (dir) => {
    const { job } = await setupRun(dir, { timeoutMs: 20_000 });
    const adapter = new GenericAdapter({
      binary: process.execPath,
      args: [join(fixturesDir, "sleep-tree.js"), "{{pointer}}"],
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
      args: [join(fixturesDir, "sleep-tree.js"), "{{pointer}}"],
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
    GROK_API_KEY: "g",
    OPENAI_API_KEY: "o",
    MINIMAX_API_KEY: "m",
    SSH_AUTH_SOCK: "/tmp/ssh",
    TERM: "xterm",
  });
  assert.equal(filtered.PATH, "/bin");
  assert.equal(filtered.HOME, "/home/u");
  assert.equal(filtered.CLAUDE_API_KEY, undefined);
  assert.equal(filtered.GROK_API_KEY, undefined);
  assert.equal(filtered.OPENAI_API_KEY, undefined);
  assert.equal(filtered.MINIMAX_API_KEY, undefined);
  assert.equal(filtered.SSH_AUTH_SOCK, "/tmp/ssh");
  assert.equal(filtered.TERM, "xterm");
  assert.equal(filtered.SECRET, undefined);
  const noSock = filterSpawnEnv({ PATH: "/bin" });
  assert.equal(noSock.SSH_AUTH_SOCK, undefined);
});

test("filterSpawnEnv scopes provider credentials to the selected adapter", () => {
  const source = {
    PATH: "/bin",
    CLAUDE_API_KEY: "c",
    GROK_API_KEY: "g",
    XAI_API_KEY: "x",
    OPENAI_API_KEY: "o",
    MINIMAX_API_KEY: "m",
    SECRET: "nope",
  };
  const grok = filterSpawnEnv(source, "grok");
  assert.equal(grok.PATH, "/bin");
  assert.equal(grok.GROK_API_KEY, "g");
  assert.equal(grok.XAI_API_KEY, "x");
  assert.equal(grok.OPENAI_API_KEY, undefined);
  assert.equal(grok.CLAUDE_API_KEY, undefined);
  assert.equal(grok.MINIMAX_API_KEY, undefined);
  const claude = filterSpawnEnv(source, "claude");
  assert.equal(claude.CLAUDE_API_KEY, "c");
  assert.equal(claude.GROK_API_KEY, undefined);
  const openai = filterSpawnEnv(source, "openai");
  assert.equal(openai.OPENAI_API_KEY, "o");
  assert.equal(openai.GROK_API_KEY, undefined);
  const generic = filterSpawnEnv(source, "generic");
  assert.equal(generic.OPENAI_API_KEY, undefined);
  assert.equal(generic.CLAUDE_API_KEY, undefined);
  const genericClaude = filterSpawnEnv(source, "generic", "claude");
  assert.equal(genericClaude.CLAUDE_API_KEY, "c");
  assert.equal(genericClaude.OPENAI_API_KEY, undefined);
  const genericCodex = filterSpawnEnv(source, "generic", "C:\\npm\\codex.cmd");
  assert.equal(genericCodex.OPENAI_API_KEY, "o");
  assert.equal(genericCodex.CLAUDE_API_KEY, undefined);
  assert.equal(generic.CLAUDE_API_KEY, undefined);
  assert.equal(generic.SECRET, undefined);
});

function extraShim(id, script) {
  return createAdapter(id, {
    [id]: {
      binary: process.execPath,
      args: [join(fixturesDir, script), "{{pointer}}"],
    },
  });
}

test("extra adapters conformance: pointer prompt after skill staging copy", async () => {
  for (const id of EXTRA_ADAPTER_IDS) {
    await withTempDir(async (dir) => {
      const runId = `run-${id}`;
      const pointer = buildPointerPrompt(runId, "plan");
      const { job, paths } = await setupRun(dir, { runId, pointerPrompt: pointer });
      assert.equal(lstatSync(paths.skillDir).isSymbolicLink(), false);
      assert.equal(lstatSync(paths.skillMd).isSymbolicLink(), false);
      assert.equal(lstatSync(paths.skillMd).isFile(), true);
      assert.match(await readFile(paths.skillMd, "utf8"), /# skill/);
      const adapter = extraShim(id, "echo-argv.js");
      assert.equal(adapter.id, id);
      const handle = await adapter.spawn(job);
      const result = await handle.wait();
      assert.equal(result.exitCode, 0, await readFile(result.stderrPath, "utf8"));
      const argv = JSON.parse(await readFile(join(dir, "argv.json"), "utf8"));
      assert.equal(argv.at(-1), pointer);
      assert.match(argv.at(-1), /Do not `git add` or `git commit`/);
      assert.match(argv.at(-1), new RegExp(`\\.legion-cli/cache/skills/${runId}/SKILL\\.md`));
      assert.match(argv.at(-1), new RegExp(`\\.legion-cli/cache/runs/${runId}/prompt\\.md`));
    });
  }
});

test("extra adapters process-group abort kills the spawn tree", async () => {
  for (const id of EXTRA_ADAPTER_IDS) {
    await withTempDir(async (dir) => {
      const { job } = await setupRun(dir, { runId: `abort-${id}`, timeoutMs: 20_000 });
      const adapter = extraShim(id, "sleep-tree.js");
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
  }
});

test("unwrapCmdShim resolves npm .cmd shims to node + JS entry", () => {
  const unwrapped = unwrapCmdShim(join(fixturesDir, "echo-argv.cmd"));
  assert.ok(unwrapped);
  assert.equal(unwrapped.command, process.execPath);
  assert.equal(unwrapped.prefixArgs.length, 1);
  assert.match(unwrapped.prefixArgs[0].replaceAll("\\", "/"), /\/echo-argv\.js$/);
  assert.equal(unwrapCmdShim(join(fixturesDir, "not-a-shim.cmd")), null);
});

test("windows .cmd shim receives the full multiline pointer", { skip: process.platform !== "win32" }, async () => {
  await withTempDir(async (dir) => {
    const pointer = buildPointerPrompt("run-cmd", "execute");
    const { job } = await setupRun(dir, { runId: "run-cmd", pointerPrompt: pointer });
    const adapter = new GenericAdapter({
      binary: join(fixturesDir, "echo-argv.cmd"),
      args: [],
    });
    const handle = await adapter.spawn(job);
    const result = await handle.wait();
    assert.equal(result.exitCode, 0, await readFile(result.stderrPath, "utf8"));
    const argv = JSON.parse(await readFile(join(dir, "argv.json"), "utf8"));
    assert.equal(argv.at(-1), pointer);
    assert.match(argv.at(-1), /Do not `git add` or `git commit`/);
    assert.match(argv.at(-1), /\n/);
    assert.match(argv.at(-1), /BEGIN SHERPA UNTRUSTED CONTENT/);
  });
});

test("unwrappable .cmd with a multiline pointer fails closed", { skip: process.platform !== "win32" }, async () => {
  await withTempDir(async (dir) => {
    const pointer = buildPointerPrompt("run-badcmd", "plan");
    const { job } = await setupRun(dir, { runId: "run-badcmd", pointerPrompt: pointer });
    const adapter = new GenericAdapter({
      binary: join(fixturesDir, "not-a-shim.cmd"),
      args: ["{{pointer}}"],
    });
    await assert.rejects(() => adapter.spawn(job), AgentError);
  });
});
