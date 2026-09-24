import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";

import { appendAuditEvent, RestoreRefusedError, sha256Content } from "@9thlevelsoftware/legion-cli-persist";
import { LegionRefuseError } from "../dist/errors.js";
import {
  openEngineCommand,
  restoreChangedTaskFiles,
  restoreEngineState,
  revertExtras,
  snapshotTaskFiles,
} from "../dist/revert.js";
import { finishStartedSpawn } from "../dist/spawn.js";
import {
  initGitRepo,
  initProject,
  makeTask,
  passingVerificationCommand,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
} from "./helpers.js";

const coreSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

test("restoreChangedTaskFiles recreates the tasks dir and replaces symlinks", async () => {
  await withEngine(async ({ dir }) => {
    const tasksDir = join(dir, "tasks");
    await mkdir(tasksDir, { recursive: true });
    const taskPath = join(tasksDir, "TSK-0001.md");
    await writeFile(taskPath, "original\n");
    const before = await snapshotTaskFiles(tasksDir);
    await writeFile(join(dir, "evil.txt"), "pwned\n");
    await unlink(taskPath);
    let linked = false;
    try {
      await symlink(join(dir, "evil.txt"), taskPath);
      linked = true;
    } catch (err) {
      if (err?.code !== "EPERM") throw err;
    }
    if (!linked) {
      await rm(tasksDir, { recursive: true, force: true });
    }
    const ids = await restoreChangedTaskFiles(tasksDir, before);
    assert.deepEqual(ids, ["TSK-0001"]);
    assert.equal(await readFile(taskPath, "utf8"), "original\n");
    if (linked) {
      assert.equal(await readFile(join(dir, "evil.txt"), "utf8"), "pwned\n");
      assert.equal((await lstat(taskPath)).isSymbolicLink(), false);
    }
  });
});

test("FileContract revert still runs after sandboxed execute copy-out", async () => {
  await withFakeAdapter(async () => {
    let projectDir;
    await withEngine(
      async ({ engine, store, dir }) => {
        projectDir = dir;
        await initProject(engine);
        await seedPlanReady(store, {
          task: {
            contract: {
              filesAllowed: ["src/main.ts"],
              expectedArtifacts: ["src/main.ts"],
              verificationCommands: [passingVerificationCommand()],
            },
          },
        });
        initGitRepo(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
        assert.ok(result.tasks[0].extrasReverted.includes("src/secret.ts"));
        assert.equal(existsSync(join(dir, "src", "operator-extra.ts")), false);
        assert.ok(result.tasks[0].extrasReverted.includes("src/operator-extra.ts"));
      },
      {
        fakeArtifacts: [{ path: "src/secret.ts", content: "export const secret = true;\n" }],
        fakeOnWait: async () => {
          await mkdir(join(projectDir, "src"), { recursive: true });
          await writeFile(join(projectDir, "src", "operator-extra.ts"), "only-revert-sees-this\n", "utf8");
        },
      },
    );
  });
});

test("F-012: forged done on a dirty-at-start task file does not survive revert", async () => {
  await withEngine(async ({ dir, store, engine }) => {
    await initProject(engine);
    await store.writeTask(makeTask({ status: "ready" }), "body\n");
    const taskPath = join(store.paths.tasksDir, "TSK-0001.md");
    const original = await readFile(taskPath, "utf8");
    const originalHash = sha256(original);
    await openEngineCommand(dir, "cmd-f012");
    const forged = original.replace("status: ready", "status: done");
    assert.notEqual(forged, original);
    await writeFile(taskPath, forged, "utf8");
    const result = await revertExtras({
      projectRoot: dir,
      preSpawnRef: null,
      allowedRoots: ["src/main.ts"],
      dirtyAtStart: new Set([".legion-cli/tasks/TSK-0001.md"]),
      commandId: "cmd-f012",
      agentAlive: false,
      jailWritable: false,
    });
    const restored = await readFile(taskPath, "utf8");
    assert.equal(restored, original);
    assert.equal(sha256(restored), originalHash);
    assert.ok(result.engineRestored.includes(".legion-cli/tasks/TSK-0001.md"));
    assert.match(restored, /status: ready/);
    assert.doesNotMatch(restored, /status: done/);
  });
});

test("audit append made during the window survives revert", async () => {
  await withEngine(async ({ dir, store, engine }) => {
    await initProject(engine);
    await openEngineCommand(dir, "cmd-audit");
    const event = await appendAuditEvent(dir, {
      ts: "2026-09-01T12:00:00.000Z",
      type: "execute",
      phase: "executing",
      actor: "agent",
      data: { during: "spawn" },
    });
    await revertExtras({
      projectRoot: dir,
      preSpawnRef: null,
      allowedRoots: [],
      commandId: "cmd-audit",
      agentAlive: false,
      jailWritable: false,
    });
    const jsonl = await readFile(join(store.paths.auditDir, "events.jsonl"), "utf8");
    assert.match(jsonl, /"during":"spawn"/);
    assert.equal(event.type, "execute");
  });
});

test("forged STATE.md restores byte-exact in a non-git fixture", async () => {
  await withEngine(async ({ dir, store, engine }) => {
    await initProject(engine);
    const original = await readFile(store.paths.stateMd, "utf8");
    const originalHash = sha256(original);
    await openEngineCommand(dir, "cmd-state");
    await writeFile(store.paths.stateMd, "forged-state\n", "utf8");
    await revertExtras({
      projectRoot: dir,
      preSpawnRef: null,
      allowedRoots: [],
      commandId: "cmd-state",
      agentAlive: false,
      jailWritable: false,
    });
    const restored = await readFile(store.paths.stateMd, "utf8");
    assert.equal(restored, original);
    assert.equal(sha256(restored), originalHash);
    assert.equal(sha256Content(restored), originalHash);
  });
});

test("engine update plus agent forgery on the same file restores journaled bytes and records tamper", async () => {
  await withEngine(async ({ dir, store, engine }) => {
    await initProject(engine);
    await store.writeTask(makeTask({ status: "ready" }), "body\n");
    await openEngineCommand(dir, "cmd-tamper");
    await store.writeTask(makeTask({ status: "in_progress" }), "body\n");
    const engineBytes = await readFile(join(store.paths.tasksDir, "TSK-0001.md"), "utf8");
    const engineHash = sha256(engineBytes);
    await writeFile(join(store.paths.tasksDir, "TSK-0001.md"), engineBytes.replace("in_progress", "done"), "utf8");
    const result = await revertExtras({
      projectRoot: dir,
      preSpawnRef: null,
      allowedRoots: [],
      commandId: "cmd-tamper",
      agentAlive: false,
      jailWritable: false,
    });
    const restored = await readFile(join(store.paths.tasksDir, "TSK-0001.md"), "utf8");
    assert.equal(restored, engineBytes);
    assert.equal(sha256(restored), engineHash);
    assert.equal(result.tamperIncident, true);
    assert.match(restored, /status: in_progress/);
  });
});

test("QA-score write in the window is journaled and survives revert", async () => {
  await withEngine(async ({ dir, store, engine }) => {
    await initProject(engine);
    await openEngineCommand(dir, "cmd-qa");
    const scorePath = join(store.paths.qaDir, "scores", "qa-window.json");
    const { writeTextFile } = await import("@9thlevelsoftware/legion-cli-persist");
    const body = `${JSON.stringify({ id: "qa-window", pass: true }, null, 2)}\n`;
    await writeTextFile(scorePath, body, { root: dir });
    await revertExtras({
      projectRoot: dir,
      preSpawnRef: null,
      allowedRoots: [],
      commandId: "cmd-qa",
      agentAlive: false,
      jailWritable: false,
    });
    assert.equal(await readFile(scorePath, "utf8"), body);
  });
});

test("executed-step undo: forged tasks/<id>.md restores byte-exact", async () => {
  await withEngine(async ({ dir, store, engine }) => {
    await initProject(engine);
    await store.writeTask(makeTask({ status: "in_progress" }), "truncated-keep\n");
    const original = await readFile(join(store.paths.tasksDir, "TSK-0001.md"), "utf8");
    await openEngineCommand(dir, "cmd-undo");
    await writeFile(join(store.paths.tasksDir, "TSK-0001.md"), "forged-truncated\n", "utf8");
    await restoreEngineState(dir, "cmd-undo", { agentAlive: false, jailWritable: false });
    assert.equal(await readFile(join(store.paths.tasksDir, "TSK-0001.md"), "utf8"), original);
  });
});

test("restore entry point refuses while the agent tree is alive or the jail is writable", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    await openEngineCommand(dir, "cmd-alive");
    await assert.rejects(
      () => restoreEngineState(dir, "cmd-alive", { agentAlive: true, jailWritable: false }),
      RestoreRefusedError,
    );
    await assert.rejects(
      () => restoreEngineState(dir, "cmd-alive", { agentAlive: false, jailWritable: true }),
      RestoreRefusedError,
    );
  });
});

test("finishStartedSpawn refuses restore when jail destroy fails", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    await openEngineCommand(dir, "run-jail");
    await assert.rejects(
      () =>
        finishStartedSpawn({
          spawned: true,
          runId: "run-jail",
          handle: { pid: null, wait: async () => ({ exitCode: 0, timedOut: false, aborted: false }), abort: async () => undefined },
          started: Date.now(),
          revertCtx: {
            projectRoot: dir,
            preSpawnRef: null,
            allowedRoots: [],
            filesForbidden: undefined,
            snapshot: undefined,
            gitPolicy: { config: null, hooks: {} },
            dirtyAtStart: new Set(),
            chatSessions: new Map(),
            commandId: "run-jail",
          },
          resolution: { id: "fake", source: "default" },
          binary: "(in-process)",
          argvSummary: "",
          sandbox: {
            backend: "copy",
            hardened: false,
            jailRoot: dir,
            spawnOpts: () => ({ cwd: dir, env: process.env, translateInvoke: (invoke) => invoke }),
            copyOut: async () => ({ copied: [], dropped: [] }),
            destroy: async () => {
              throw new Error("destroy failed");
            },
          },
        }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /jail is writable/);
        return true;
      },
    );
  });
});

test("git error during extras restore is a named refusal", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    initGitRepo(dir);
    await writeFile(join(dir, ".git", "HEAD"), "not-a-ref\n", "utf8");
    await assert.rejects(
      () =>
        revertExtras({
          projectRoot: dir,
          preSpawnRef: "HEAD",
          allowedRoots: ["src/main.ts"],
        }),
      (err) => {
        assert.equal(err instanceof RestoreRefusedError, true);
        assert.match(err.message, /git restore refused/);
        return true;
      },
    );
  });
});

test("funnel conformance: no manifest-relevant engine write bypasses writeTextFile", async () => {
  const writeImport = /import\s*\{[^}]*\bwriteFile\b[^}]*\}\s*from\s*["']node:fs(?:\/promises)?["']/;
  const files = [
    join(coreSrc, "engine.ts"),
    join(coreSrc, "wireframe-run.ts"),
    join(coreSrc, "revert.ts"),
    join(coreSrc, "undo.ts"),
    join(coreSrc, "..", "..", "qa", "src", "run.ts"),
    join(coreSrc, "..", "..", "qa", "src", "checklist.ts"),
    join(coreSrc, "..", "..", "map", "src", "generate.ts"),
  ];
  const hits = [];
  for (const abs of files) {
    const text = await readFile(abs, "utf8");
    if (writeImport.test(text) || /\bfs\.writeFile\s*\(/.test(text)) hits.push(abs.replaceAll("\\", "/"));
  }
  assert.deepEqual(hits, [], `raw fs.writeFile bypasses writeTextFile:\n${hits.join("\n")}`);
  const wireframe = await readFile(join(coreSrc, "wireframe-run.ts"), "utf8");
  assert.match(wireframe, /writeTextFile/);
  assert.match(wireframe, /wireframes/);
  const mapSrc = await readFile(join(coreSrc, "..", "..", "map", "src", "generate.ts"), "utf8");
  assert.match(mapSrc, /writeTextFile/);
  const undo = await readFile(join(coreSrc, "undo.ts"), "utf8");
  assert.doesNotMatch(undo, /\bwriteFile\b/);
});
