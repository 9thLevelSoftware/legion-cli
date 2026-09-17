import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createLegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { HINT, LegionEngine, LegionRefuseError } from "../dist/index.js";
import {
  initGitRepo,
  initProject,
  makeTask,
  passingVerificationCommand,
  quoteArg,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
const holdExecute = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hold-execute.js");

async function seedExecute(store, opts = {}) {
  const verify = opts.verify ?? [passingVerificationCommand()];
  return seedPlanReady(store, {
    task: {
      contract: {
        filesAllowed: opts.filesAllowed ?? ["src/main.ts"],
        expectedArtifacts: opts.expectedArtifacts ?? ["src/main.ts"],
        verificationCommands: verify,
        ...(opts.contract ?? {}),
      },
      ...(opts.task ?? {}),
    },
    extraTasks: opts.extraTasks,
    phase: opts.phase,
    lastReview: opts.lastReview,
  });
}

async function waitUntil(predicate, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function writeResume(dir, taskId, pid) {
  const runId = `execute-race-${taskId}`;
  const resumeDir = join(dir, ".legion-cli", "cache", "runs", runId);
  await mkdir(resumeDir, { recursive: true });
  await writeFile(
    join(resumeDir, "resume.json"),
    `${JSON.stringify(
      {
        schemaVersion: "legion-cli-resume/v1",
        runId,
        taskId,
        skillId: "execute",
        preSpawnRef: "UNBORN",
        startedAt: new Date().toISOString(),
        pid,
        adapterId: "fake",
        binary: "(in-process)",
        argvSummary: "{{pointer}}",
        resolutionSource: "default",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function hangingVerificationCommand() {
  return `${quoteArg(process.execPath)} -e ${quoteArg("setTimeout(() => {}, 60_000)")}`;
}

test("during a fake long spawn, status is in_progress and engine.lock is absent", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ store, dir }) => {
      const readyPath = join(dir, ".legion-cli", "cache", "fake-wait", "ready");
      const releasePath = join(dir, ".legion-cli", "cache", "fake-wait", "release");
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeHoldWait: { readyPath, releasePath, timeoutMs: 15_000 },
      });
      await initProject(engine);
      await seedExecute(store);
      initGitRepo(dir);
      const pending = engine.execute("auto");
      await waitUntil(() => existsSync(readyPath), 10_000, "fake wait never became ready");
      assert.equal((await store.readTask("TSK-0001")).data.status, "in_progress");
      assert.equal((await store.readState()).data.currentTaskId, "TSK-0001");
      assert.equal(existsSync(store.paths.lock), false);
      await writeFile(releasePath, "go\n");
      const result = await pending;
      assert.equal(result.status, "done");
    });
  });
});

test("two processes execute auto: second is refused and never two in_progress", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ store, dir }) => {
      const readyPath = join(dir, ".legion-cli", "cache", "fake-wait", "child-ready");
      const releasePath = join(dir, ".legion-cli", "cache", "fake-wait", "child-release");
      const parent = new LegionEngine(dir, undefined, { skillsDir });
      await initProject(parent);
      await seedExecute(store);
      initGitRepo(dir);

      const child = spawn(process.execPath, [holdExecute, dir, skillsDir, readyPath, releasePath], {
        env: { ...process.env, LEGION_CLI_ADAPTER: "fake" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      try {
        await waitUntil(() => existsSync(readyPath), 15_000, `child never became ready: ${stderr}`);
        assert.equal((await store.readTask("TSK-0001")).data.status, "in_progress");
        assert.equal(existsSync(store.paths.lock), false);

        await assert.rejects(
          () => parent.execute("auto"),
          (err) => {
            assert.equal(err instanceof LegionRefuseError, true);
            assert.match(err.message, /in_progress/);
            assert.equal(err.nextHint, HINT.status);
            return true;
          },
        );
        assert.equal((await store.readTask("TSK-0001")).data.status, "in_progress");
        const tasks = (await parent.listSliceTasks()).filter((task) => task.status === "in_progress");
        assert.equal(tasks.length, 1);

        await writeFile(releasePath, "go\n");
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });
        assert.equal(code, 0, stderr);
        assert.equal((await store.readTask("TSK-0001")).data.status, "done");
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }
    });
  });
});

test("live resume pid is not demoted by recovery", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ store, dir }) => {
      const readyPath = join(dir, ".legion-cli", "cache", "fake-wait", "live-ready");
      const releasePath = join(dir, ".legion-cli", "cache", "fake-wait", "live-release");
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeHoldWait: { readyPath, releasePath, timeoutMs: 15_000 },
      });
      await initProject(engine);
      await seedExecute(store);
      initGitRepo(dir);
      const pending = engine.execute("auto");
      await waitUntil(() => existsSync(readyPath), 10_000, "fake wait never became ready");
      const other = new LegionEngine(dir, undefined, { skillsDir });
      await other.recoverStaleInProgress();
      assert.equal((await store.readTask("TSK-0001")).data.status, "in_progress");
      await writeFile(releasePath, "go\n");
      const result = await pending;
      assert.equal(result.status, "done");
    });
  });
});

test("dead resume pid is recovered to blocked", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedExecute(store, { task: { status: "in_progress" } });
      await store.writeState(
        { ...(await store.readState()).data, phase: "executing", currentTaskId: "TSK-0001" },
        "Current task: TSK-0001.\n",
      );
      await writeResume(dir, "TSK-0001", 2_000_000_000);
      await engine.recoverStaleInProgress();
      assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
      assert.equal((await store.readState()).data.currentTaskId, null);
    }, { skillsDir });
  });
});

test("crash between CAS and wait: next execute recovers to blocked", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedExecute(store, { task: { status: "in_progress" } });
      await store.writeState(
        { ...(await store.readState()).data, phase: "executing", currentTaskId: "TSK-0001" },
        "Current task: TSK-0001.\n",
      );
      await assert.rejects(
        () => engine.execute("auto"),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /no ready task|not ready|in_progress/);
          return true;
        },
      );
      assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
    }, { skillsDir });
  });
});

test("amend and ship refuse while a fake long spawn is in_progress", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ store, dir }) => {
      const readyPath = join(dir, ".legion-cli", "cache", "fake-wait", "amend-ready");
      const releasePath = join(dir, ".legion-cli", "cache", "fake-wait", "amend-release");
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeHoldWait: { readyPath, releasePath, timeoutMs: 15_000 },
      });
      await initProject(engine);
      await seedExecute(store, { lastReview: "PASS" });
      initGitRepo(dir);
      const pending = engine.execute("auto");
      await waitUntil(() => existsSync(readyPath), 10_000, "fake wait never became ready");
      const other = new LegionEngine(dir, undefined, { skillsDir });
      await assert.rejects(
        () =>
          other.amendTask("TSK-0001", {
            filesAllowed: ["src/main.ts"],
            filesForbidden: [".git/**"],
            expectedArtifacts: ["src/main.ts"],
            verificationCommands: [passingVerificationCommand()],
            maxFilesTouched: 20,
          }),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /in_progress/);
          assert.equal(err.nextHint, HINT.status);
          return true;
        },
      );
      await assert.rejects(
        () => other.ship(),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /in_progress/);
          assert.equal(err.nextHint, HINT.status);
          return true;
        },
      );
      await writeFile(releasePath, "go\n");
      await pending;
    });
  });
});

test("hung verificationCommands time out, block the task, and do not hold the lock", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store, { verify: [hangingVerificationCommand()] });
        initGitRepo(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
        assert.equal(existsSync(store.paths.lock), false);
      },
      { skillsDir, verificationTimeoutMs: 400 },
    );
  });
});

test("--until-blocked drops engine.lock between two fake spawns", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ store, dir }) => {
      const lockPath = createLegionStore(dir).paths.lock;
      let waits = 0;
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeOnWait: async () => {
          waits += 1;
          assert.equal(existsSync(lockPath), false, `engine.lock held during wait ${waits}`);
        },
      });
      await initProject(engine);
      await seedExecute(store, {
        extraTasks: [
          makeTask({
            id: "TSK-0002",
            status: "ready",
            blockedBy: ["TSK-0001"],
            contract: {
              filesAllowed: ["src/board.ts"],
              expectedArtifacts: ["src/board.ts"],
              verificationCommands: [passingVerificationCommand()],
            },
          }),
        ],
      });
      initGitRepo(dir);
      const result = await engine.execute("auto", { untilBlocked: true });
      assert.equal(result.tasks.length, 2);
      assert.equal(result.tasks[0].status, "done");
      assert.equal(result.tasks[1].status, "done");
      assert.equal(waits, 2);
      assert.equal(existsSync(lockPath), false);
    });
  });
});

test("empty lock file does not steal during a waiter", async () => {
  await withEngine(async ({ dir }) => {
    const store = createLegionStore(dir);
    await mkdir(store.paths.indexDir, { recursive: true });
    await writeFile(store.paths.lock, "", "utf8");
    const { EngineLockedError } = await import("@9thlevelsoftware/legion-cli-persist");
    await assert.rejects(() => store.acquireLock({ timeoutMs: 200 }), EngineLockedError);
    assert.equal(await readFile(store.paths.lock, "utf8"), "");
  });
});
