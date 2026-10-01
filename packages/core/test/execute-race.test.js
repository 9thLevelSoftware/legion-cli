import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { createLegionStore, isPidAlive } from "@9thlevelsoftware/legion-cli-persist";
import { materializeJail } from "@9thlevelsoftware/legion-cli-sandbox";
import {
  HINT,
  inspectResumeOwner,
  LegionEngine,
  LegionRefuseError,
  projectSourceIdentity,
  updateResumeStage,
} from "../dist/index.js";
import {
  git,
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

function exitedChildPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const pid = child.pid;
    if (!pid) {
      reject(new Error("spawned child has no pid"));
      return;
    }
    child.once("exit", () => resolve(pid));
    child.once("error", reject);
  });
}

test("resume owner inspection treats a recycled pid as stale", async () => {
  const resume = {
    schemaVersion: "legion-cli-resume/v2",
    runId: "execute-recycled",
    taskId: "TSK-0001",
    skillId: "execute",
    preSpawnRef: "UNBORN",
    startedAt: "2026-09-30T12:00:00.000Z",
    stage: "running",
    pid: process.pid,
    pidStartedAt: 1000,
    enginePid: process.pid,
    enginePidStartedAt: 1000,
    logs: { stdout: ".legion-cli/cache/runs/execute-recycled/stdout.log", stderr: ".legion-cli/cache/runs/execute-recycled/stderr.log" },
  };
  const status = await inspectResumeOwner(resume, async () => 20_000);
  assert.equal(status, "stale");
});

test("legacy resume records remain conservatively live when their pid exists", async () => {
  const resume = {
    schemaVersion: "legion-cli-resume/v1",
    runId: "execute-legacy",
    taskId: "TSK-0001",
    skillId: "execute",
    preSpawnRef: "UNBORN",
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
  assert.equal(await inspectResumeOwner(resume, async () => null), "live");
});

test("v2 resume with an alive child but unavailable start identity is unknown", async () => {
  const resume = {
    schemaVersion: "legion-cli-resume/v2",
    runId: "execute-unknown",
    taskId: "TSK-0001",
    skillId: "execute",
    preSpawnRef: "UNBORN",
    startedAt: "2026-09-30T12:00:00.000Z",
    stage: "running",
    stageUpdatedAt: "2026-09-30T12:00:00.000Z",
    pid: process.pid,
    pidStartedAt: null,
    enginePid: 2_000_000_001,
    enginePidStartedAt: 1000,
    logs: { stdout: "stdout.log", stderr: "stderr.log" },
  };
  assert.equal(await inspectResumeOwner(resume, async () => null), "unknown");
});

test("released engine ownership does not keep a dead run live", async () => {
  const resume = {
    schemaVersion: "legion-cli-resume/v2",
    runId: "execute-released",
    taskId: "TSK-0001",
    skillId: "execute",
    preSpawnRef: "UNBORN",
    startedAt: "2026-09-30T12:00:00.000Z",
    stage: "blocked",
    stageUpdatedAt: "2026-09-30T12:01:00.000Z",
    enginePid: process.pid,
    enginePidStartedAt: 1000,
    engineOwnershipReleasedAt: "2026-09-30T12:01:00.000Z",
    logs: { stdout: "stdout.log", stderr: "stderr.log" },
  };
  assert.equal(await inspectResumeOwner(resume, async () => 1000), "stale");
});

test("project source identity includes dirty and untracked files but excludes Legion state", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const version = 1;\n", "utf8");
    initGitRepo(dir);
    const initial = await projectSourceIdentity(dir);
    await mkdir(join(dir, ".legion-cli", "cache"), { recursive: true });
    await writeFile(join(dir, ".legion-cli", "cache", "identity-noise"), "ignored\n", "utf8");
    assert.equal(await projectSourceIdentity(dir), initial);
    await writeFile(join(dir, "src", "main.ts"), "export const version = 2;\n", "utf8");
    const dirty = await projectSourceIdentity(dir);
    assert.notEqual(dirty, initial);
    await writeFile(join(dir, "src", "new.ts"), "export const fresh = true;\n", "utf8");
    assert.notEqual(await projectSourceIdentity(dir), dirty);
  });
});

test("project source identity is unchanged when tracked and untracked tested bytes are only staged", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const version = 1;\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "src", "main.ts"), "export const version = 2;\n", "utf8");
    await writeFile(join(dir, "src", "new.ts"), "export const fresh = true;\n", "utf8");
    const beforeStage = await projectSourceIdentity(dir);
    git(dir, ["add", "src/main.ts", "src/new.ts"]);
    assert.equal(await projectSourceIdentity(dir), beforeStage);
  });
});

test("project source identity changes for a staged mode-only source change", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    await mkdir(join(dir, "src"), { recursive: true });
    const path = join(dir, "src", "main.ts");
    await writeFile(path, "export const version = 1;\n", "utf8");
    initGitRepo(dir);
    const initial = await projectSourceIdentity(dir);
    git(dir, ["update-index", "--chmod=+x", "src/main.ts"]);
    assert.notEqual(await projectSourceIdentity(dir), initial);
  });
});

test("POSIX dirty chmod changes source identity and staging it is identity-stable", {
  skip: process.platform === "win32",
}, async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    await mkdir(join(dir, "src"), { recursive: true });
    const path = join(dir, "src", "main.ts");
    await writeFile(path, "export const version = 1;\n", "utf8");
    initGitRepo(dir);
    const initial = await projectSourceIdentity(dir);
    await chmod(path, 0o755);
    const changed = await projectSourceIdentity(dir);
    assert.notEqual(changed, initial);
    git(dir, ["add", "src/main.ts"]);
    assert.equal(await projectSourceIdentity(dir), changed);
  });
});

test("project source identity is deterministic across many files", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    await mkdir(join(dir, "src", "many"), { recursive: true });
    await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        writeFile(join(dir, "src", "many", `${String(index).padStart(3, "0")}.ts`), `export const n = ${index};\n`, "utf8"),
      ),
    );
    initGitRepo(dir);
    const first = await projectSourceIdentity(dir);
    assert.equal(await projectSourceIdentity(dir), first);
    await writeFile(join(dir, "src", "many", "064.ts"), "export const n = 640;\n", "utf8");
    assert.notEqual(await projectSourceIdentity(dir), first);
  });
});

test("project source identity changes when a tracked submodule HEAD changes", async () => {
  await withEngine(async ({ dir }) => {
    await writeFile(join(dir, "README.md"), "parent\n", "utf8");
    initGitRepo(dir);
    const source = `${dir}-submodule-source`;
    await mkdir(source, { recursive: true });
    try {
      await writeFile(join(source, "module.txt"), "one\n", "utf8");
      initGitRepo(source);
      git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", pathToFileURL(source).href, "vendor/module"]);
      git(dir, ["add", ".gitmodules", "vendor/module"]);
      git(dir, ["commit", "-m", "add submodule"]);
      const initial = await projectSourceIdentity(dir);
      const checkout = join(dir, "vendor", "module");
      git(checkout, ["config", "user.name", "9thLevelSoftware"]);
      git(checkout, ["config", "user.email", "engineering@9thlevelsoftware.com"]);
      await writeFile(join(checkout, "module.txt"), "two\n", "utf8");
      git(checkout, ["add", "module.txt"]);
      git(checkout, ["commit", "-m", "advance module"]);
      assert.notEqual(await projectSourceIdentity(dir), initial);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});

test("resume stage updates surface corrupt records instead of silently losing progress", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    const runId = "execute-corrupt";
    const runDir = join(dir, ".legion-cli", "cache", "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "resume.json"), "{broken", "utf8");
    await assert.rejects(() => updateResumeStage(dir, runId, "interrupted"), SyntaxError);
  });
});

test("fresh-process recovery preserves a compatible HTTP checkpoint for execute --resume", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await seedExecute(store, {
      phase: "executing",
      task: { status: "in_progress" },
    });
    const state = await store.readState();
    await store.writeState({ ...state.data, currentTaskId: "TSK-0001" }, state.body);
    const runId = "execute-http-crash";
    const runDir = join(dir, ".legion-cli", "cache", "runs", runId);
    await mkdir(runDir, { recursive: true });
    const sandbox = await materializeJail({
      projectRoot: dir,
      runId,
      allowedWrites: ["src/main.ts"],
      readSet: [],
      backend: "copy",
      allowDegradedCopy: true,
    });
    const sourceIdentity = await projectSourceIdentity(dir);
    const identities = {
      promptHash: "prompt",
      configHash: "config",
      contractHash: "contract",
      sourceIdentity,
      jailIdentity: sandbox.identity,
    };
    await writeFile(
      join(runDir, "http-checkpoint.json"),
      `${JSON.stringify({
        version: 1,
        runId,
        identities,
        conversation: [],
        round: 0,
        toolOutcomes: [],
        usage: { requests: 1, toolCalls: 0, model: "fixture" },
        completion: { status: "complete", summary: "done" },
        updatedAt: "2026-09-30T12:01:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(runDir, "resume.json"),
      `${JSON.stringify({
        schemaVersion: "legion-cli-resume/v2",
        runId,
        taskId: "TSK-0001",
        skillId: "execute",
        preSpawnRef: "UNBORN",
        startedAt: "2026-09-30T12:00:00.000Z",
        stage: "running",
        stageUpdatedAt: "2026-09-30T12:00:00.000Z",
        pid: null,
        enginePid: 2_000_000_001,
        enginePidStartedAt: 1,
        adapterId: "http",
        logs: { stdout: "stdout.log", stderr: "stderr.log" },
        checkpointPath: `.legion-cli/cache/runs/${runId}/http-checkpoint.json`,
        sourceIdentity,
        contractIdentity: identities.contractHash,
        jailIdentity: identities.jailIdentity,
      })}\n`,
      "utf8",
    );

    const fresh = new LegionEngine(dir, undefined, { skillsDir });
    await assert.rejects(
      () => fresh.execute("auto", { resume: runId, allowNoSandbox: true }),
      (err) => {
        assert.doesNotMatch(err.message, /remain in_progress/);
        return true;
      },
    );
    assert.equal((await store.readTask("TSK-0001")).data.status, "in_progress");
    const recovered = JSON.parse(await readFile(join(runDir, "resume.json"), "utf8"));
    assert.equal(recovered.stage, "interrupted");
    assert.equal(recovered.recoveryCommand, `legion-cli execute --resume ${runId}`);
  });
});

test("fresh-process recovery reconciles only pending writes already present in the retained jail", async () => {
  for (const scenario of [
    { name: "matching", jailContents: "intended\n", expectedStatus: "in_progress" },
    { name: "mismatching", jailContents: "different\n", expectedStatus: "blocked" },
  ]) {
    await withEngine(async ({ dir, engine, store }) => {
      await initProject(engine);
      await seedExecute(store, { phase: "executing", task: { status: "in_progress" } });
      const state = await store.readState();
      await store.writeState({ ...state.data, currentTaskId: "TSK-0001" }, state.body);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "main.ts"), "baseline\n", "utf8");
      const runId = `execute-http-write-${scenario.name}`;
      const runDir = join(dir, ".legion-cli", "cache", "runs", runId);
      await mkdir(runDir, { recursive: true });
      const sandbox = await materializeJail({
        projectRoot: dir,
        runId,
        allowedWrites: ["src/main.ts"],
        readSet: [],
        backend: "copy",
        allowDegradedCopy: true,
      });
      await writeFile(join(sandbox.jailRoot, "src", "main.ts"), scenario.jailContents, "utf8");
      const sourceIdentity = await projectSourceIdentity(dir);
      const identities = {
        promptHash: "prompt",
        configHash: "config",
        contractHash: "contract",
        sourceIdentity,
        jailIdentity: sandbox.identity,
      };
      const toolArguments = JSON.stringify({ path: "src/main.ts", contents: "intended\n" });
      await writeFile(join(runDir, "http-checkpoint.json"), `${JSON.stringify({
        version: 1,
        runId,
        identities,
        conversation: [],
        round: 1,
        toolOutcomes: [{
          id: "write-1",
          signature: "a".repeat(64),
          name: "write_file",
          arguments: toolArguments,
          status: "pending",
        }],
        usage: { requests: 1, toolCalls: 1, model: "fixture" },
        completion: { status: "running" },
        updatedAt: "2026-09-30T12:01:00.000Z",
      }, null, 2)}\n`, "utf8");
      await writeFile(join(runDir, "resume.json"), `${JSON.stringify({
        schemaVersion: "legion-cli-resume/v2",
        runId,
        taskId: "TSK-0001",
        skillId: "execute",
        preSpawnRef: "UNBORN",
        startedAt: "2026-09-30T12:00:00.000Z",
        stage: "running",
        stageUpdatedAt: "2026-09-30T12:00:00.000Z",
        pid: null,
        enginePid: 2_000_000_001,
        enginePidStartedAt: 1,
        adapterId: "http",
        logs: { stdout: "stdout.log", stderr: "stderr.log" },
        checkpointPath: `.legion-cli/cache/runs/${runId}/http-checkpoint.json`,
        sourceIdentity,
        contractIdentity: identities.contractHash,
        jailIdentity: identities.jailIdentity,
      }, null, 2)}\n`, "utf8");

      const fresh = new LegionEngine(dir, undefined, { skillsDir });
      await fresh.recoverStaleInProgress();
      assert.equal((await store.readTask("TSK-0001")).data.status, scenario.expectedStatus);
      const recovered = JSON.parse(await readFile(join(runDir, "resume.json"), "utf8"));
      assert.equal(
        recovered.recoveryCommand,
        scenario.expectedStatus === "in_progress"
          ? `legion-cli execute --resume ${runId}`
          : "legion-cli task amend TSK-0001 --unblock",
      );
    });
  }
});

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

test("task amend is refused while review wait is live", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ store, dir }) => {
      const readyPath = join(dir, ".legion-cli", "cache", "fake-wait", "review-ready");
      const releasePath = join(dir, ".legion-cli", "cache", "fake-wait", "review-release");
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeHoldWait: { readyPath, releasePath, timeoutMs: 15_000 },
      });
      await initProject(engine);
      await seedPlanReady(store, { phase: "executing", task: { status: "done" } });
      initGitRepo(dir);
      const pending = engine.review();
      await waitUntil(() => existsSync(readyPath), 10_000, "fake wait never became ready");
      const contract = (await store.readTask("TSK-0001")).data.contract;
      await assert.rejects(
        () => engine.amendTask("TSK-0001", contract),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /task amend is refused while review is running/);
          assert.equal(err.nextHint, HINT.status);
          return true;
        },
      );
      await writeFile(releasePath, "go\n");
      const review = await pending;
      assert.equal(review.verdict, "PASS");
    });
  });
});

test("ticket create is refused while execute wait is live", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ store, dir }) => {
      const readyPath = join(dir, ".legion-cli", "cache", "fake-wait", "ticket-ready");
      const releasePath = join(dir, ".legion-cli", "cache", "fake-wait", "ticket-release");
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeHoldWait: { readyPath, releasePath, timeoutMs: 15_000 },
      });
      await initProject(engine);
      await seedExecute(store);
      initGitRepo(dir);
      const pending = engine.execute("auto");
      await waitUntil(() => existsSync(readyPath), 10_000, "fake wait never became ready");
      await assert.rejects(
        () => engine.fileTicket({ title: "park extra" }),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /ticket create is refused while /);
          assert.equal(err.nextHint, HINT.status);
          return true;
        },
      );
      await writeFile(releasePath, "go\n");
      const result = await pending;
      assert.equal(result.status, "done");
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

test("execute reaches done when the spawn handle pid is already dead", async () => {
  const deadPid = await exitedChildPid();
  assert.equal(isPidAlive(deadPid), false);
  await withFakeAdapter(async () => {
    await withEngine(async ({ store, dir }) => {
      const engine = new LegionEngine(dir, undefined, { skillsDir, fakeHandlePid: deadPid });
      await initProject(engine);
      await seedExecute(store);
      initGitRepo(dir);
      const result = await engine.execute("auto");
      assert.equal(result.status, "done");
      assert.equal((await store.readTask("TSK-0001")).data.status, "done");
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
