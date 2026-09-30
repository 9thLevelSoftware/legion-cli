import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createLegionStore,
  DEFAULT_LOCK_TIMEOUT_MS,
  EMPTY_LOCK_STALE_MS,
  EngineLockedError,
  MAX_LOCK_HOLD_MS,
} from "@9thlevelsoftware/legion-cli-persist";
import { LegionEngine, LegionRefuseError, listCacheResumesCalls, resetListCacheResumesCalls } from "../dist/index.js";
import {
  initGitRepo,
  initProject,
  makeQaScore,
  makeTask,
  passingVerificationCommand,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  writeTask,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createInjectedClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

async function seedExecute(store) {
  return seedPlanReady(store, {
    task: {
      contract: {
        filesAllowed: ["src/main.ts"],
        expectedArtifacts: ["src/main.ts"],
        verificationCommands: [passingVerificationCommand()],
      },
    },
  });
}

test("F-018: nested withLock across LegionStore instances does not deadlock", async () => {
  await withEngine(async ({ dir, store }) => {
    const engine = new LegionEngine(dir, store);
    await initProject(engine);
    const other = createLegionStore(dir);
    const state = await store.readState();
    await store.withLock(async () => {
      await other.writeState({ ...state.data, currentTaskId: "TSK-nested" }, state.body);
    }, { timeoutMs: 800 });
    assert.equal((await store.readState()).data.currentTaskId, "TSK-nested");
  });
});

test("F-018: concurrent dashboard+CLI writers never interleave", async () => {
  await withEngine(async ({ dir, store }) => {
    const engine = new LegionEngine(dir, store);
    await initProject(engine);
    const dashboard = createLegionStore(dir);
    const cli = store;
    let inside = 0;
    let overlap = false;
    const order = [];
    await Promise.all([
      cli.withLock(async () => {
        inside += 1;
        if (inside > 1) overlap = true;
        order.push("cli-enter");
        const state = await cli.readState();
        await cli.writeState({ ...state.data, currentTaskId: "TSK-cli" }, `${state.body}cli\n`);
        await delay(20);
        inside -= 1;
        order.push("cli-exit");
      }),
      dashboard.withLock(async () => {
        inside += 1;
        if (inside > 1) overlap = true;
        order.push("dash-enter");
        const state = await dashboard.readState();
        await dashboard.writeState({ ...state.data, currentTaskId: "TSK-dash" }, `${state.body}dash\n`);
        await delay(20);
        inside -= 1;
        order.push("dash-exit");
      }),
    ]);
    assert.equal(overlap, false, `writers overlapped: ${order.join(",")}`);
    const current = (await store.readState()).data.currentTaskId;
    assert.ok(current === "TSK-cli" || current === "TSK-dash", current);
    const body = await readFile(store.paths.stateMd, "utf8");
    assert.match(body, /cli|dash/);
  });
});

test("F-026/F-040/F-089: execute drops engine.lock while its verification commands run (injected clock)", async () => {
  await withFakeAdapter(async () => {
    const clock = createInjectedClock();
    await withEngine(async ({ dir }) => {
      const store = createLegionStore(dir, { clock });
      let lockHeldDuringVerify = false;
      const engine = new LegionEngine(dir, store, {
        skillsDir,
        fakeOnVerify: async () => {
          lockHeldDuringVerify = existsSync(store.paths.lock);
          clock.advance(5 * 60 * 1000);
        },
      });
      await initProject(engine);
      await seedExecute(store);
      initGitRepo(dir);
      store.resetHoldStats();
      const result = await engine.execute("auto");
      assert.equal(result.status, "done");
      assert.ok(
        store.maxHoldMs <= MAX_LOCK_HOLD_MS,
        `verify held engine.lock for ${store.maxHoldMs} ms; bound is ${MAX_LOCK_HOLD_MS} ms (acquire timeout ${DEFAULT_LOCK_TIMEOUT_MS})`,
      );
      assert.equal(lockHeldDuringVerify, false, "engine.lock must be dropped during verify");
      assert.equal(MAX_LOCK_HOLD_MS, DEFAULT_LOCK_TIMEOUT_MS);
    });
  });
});

test("F-026/F-040: qa cannot hold engine.lock past the acquire timeout (injected clock)", async () => {
  const clock = createInjectedClock();
  await withEngine(async ({ dir }) => {
    const store = createLegionStore(dir, { clock });
    let lockHeldDuringQa = false;
    const engine = new LegionEngine(dir, store, {
      fakeOnQa: async () => {
        lockHeldDuringQa = existsSync(store.paths.lock);
        clock.advance(5 * 60 * 1000);
      },
    });
    await initProject(engine);
    await seedPlanReady(store, {
      phase: "executing",
      lastReview: "PASS",
      task: { status: "done" },
    });
    store.resetHoldStats();
    const score = await engine.qa({ score: makeQaScore() });
    assert.equal(score.pass, true);
    assert.ok(
      store.maxHoldMs <= MAX_LOCK_HOLD_MS,
      `qa held engine.lock for ${store.maxHoldMs} ms; bound is ${MAX_LOCK_HOLD_MS} ms`,
    );
    assert.equal(lockHeldDuringQa, false, "engine.lock must be dropped during qa");
  });
});

test("F-047: a stale empty lock file is stolen", async () => {
  await withEngine(async ({ dir }) => {
    const store = createLegionStore(dir);
    await mkdir(store.paths.indexDir, { recursive: true });
    await writeFile(store.paths.lock, "", "utf8");
    const old = new Date(Date.now() - EMPTY_LOCK_STALE_MS - 5_000);
    await utimes(store.paths.lock, old, old);
    await store.withLock(async () => {
      const held = JSON.parse(await readFile(store.paths.lock, "utf8"));
      assert.equal(held.pid, process.pid);
    }, { timeoutMs: 400 });
  });
});

test("F-047: a dead-pid lock is stolen; a live lock is refused with a hint", async () => {
  await withEngine(async ({ dir }) => {
    const store = createLegionStore(dir);
    await mkdir(store.paths.indexDir, { recursive: true });
    await writeFile(
      store.paths.lock,
      `${JSON.stringify({ pid: 2_000_000_000, pidStartedAt: 1, acquiredAt: "2000-01-01T00:00:00.000Z", token: "dead" })}\n`,
      "utf8",
    );
    await store.withLock(async () => {
      assert.equal(JSON.parse(await readFile(store.paths.lock, "utf8")).pid, process.pid);
    }, { timeoutMs: 400 });

    const holder = createLegionStore(dir);
    let release;
    const held = new Promise((done) => {
      release = done;
    });
    let inside;
    const ready = new Promise((done) => {
      inside = done;
    });
    const holding = holder.withLock(async () => {
      inside();
      await held;
    });
    await ready;
    try {
      await assert.rejects(
        () => store.withLock(async () => {}, { timeoutMs: 200 }),
        (err) => {
          assert.equal(err instanceof EngineLockedError, true);
          assert.match(err.message, /another legion-cli is running/);
          return true;
        },
      );
    } finally {
      release();
      await holding;
    }
  });
});

test("F-050: sibling withLock does not run inside another chain's acquireLock", async () => {
  await withEngine(async ({ dir, store }) => {
    const engine = new LegionEngine(dir, store);
    await initProject(engine);
    const other = createLegionStore(dir);
    let inside = 0;
    let overlap = false;
    let release;
    const held = new Promise((done) => {
      release = done;
    });
    let ready;
    const started = new Promise((done) => {
      ready = done;
    });
    const holding = Promise.resolve().then(async () => {
      await store.acquireLock({ timeoutMs: 400 });
      ready();
      inside += 1;
      if (inside > 1) overlap = true;
      await held;
      inside -= 1;
      await store.releaseLock();
    });
    await started;
    await assert.rejects(
      () =>
        other.withLock(async () => {
          inside += 1;
          if (inside > 1) overlap = true;
          inside -= 1;
        }, { timeoutMs: 200 }),
      EngineLockedError,
    );
    assert.equal(overlap, false, "sibling withLock overlapped an acquireLock hold");
    release();
    await holding;
  });
});

test("F-050: acquireLock then nested withLock on another store re-enters", async () => {
  await withEngine(async ({ dir, store }) => {
    const engine = new LegionEngine(dir, store);
    await initProject(engine);
    const other = createLegionStore(dir);
    await store.acquireLock({ timeoutMs: 400 });
    try {
      assert.equal(store.holdsLock(), true, "holder must report holdsLock");
      assert.equal(other.holdsLock(), true, "peer store must re-enter after acquireLock");
      await other.withLock(async () => {
        const state = await other.readState();
        await other.writeState({ ...state.data, currentTaskId: "TSK-cross" }, state.body);
      }, { timeoutMs: 400 });
      assert.equal((await store.readState()).data.currentTaskId, "TSK-cross");
    } finally {
      await store.releaseLock();
    }
  });
});

test("F-050: acquireLock then nested withLock on the same store re-enters", async () => {
  await withEngine(async ({ dir, store }) => {
    const engine = new LegionEngine(dir, store);
    await initProject(engine);
    await store.acquireLock({ timeoutMs: 400 });
    try {
      await store.withLock(async () => {
        const state = await store.readState();
        await store.writeState({ ...state.data, currentTaskId: "TSK-bare" }, state.body);
      }, { timeoutMs: 400 });
      assert.equal((await store.readState()).data.currentTaskId, "TSK-bare");
    } finally {
      await store.releaseLock();
    }
  });
});

test("F-043: skill and design-system installs route writes under engine.lock", async () => {
  const skillsCli = await readFile(join(repoRoot, "packages", "cli", "src", "skills.ts"), "utf8");
  const designCli = await readFile(join(repoRoot, "packages", "cli", "src", "design-system.ts"), "utf8");
  const installLock = await readFile(join(repoRoot, "packages", "cli", "src", "install-lock.ts"), "utf8");
  assert.match(skillsCli, /installWithLock/);
  assert.match(designCli, /installWithLock/);
  assert.match(installLock, /store\.withLock/);
});

test("F-054: dead-in-progress recovery scans cache/runs once per lock, not per task", async () => {
  await withEngine(async ({ dir, store, engine }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "in_progress" }));
    await writeTask(store, makeTask({ id: "TSK-0002", status: "verifying", blockedBy: ["TSK-0001"] }));
    const state = await store.readState();
    await store.writeState({ ...state.data, phase: "executing", currentTaskId: "TSK-0001" }, state.body);
    const runsDir = join(dir, ".legion-cli", "cache", "runs");
    await mkdir(runsDir, { recursive: true });
    for (let i = 0; i < 8; i += 1) {
      const runId = `scan-${i}`;
      await mkdir(join(runsDir, runId), { recursive: true });
      await writeFile(
        join(runsDir, runId, "resume.json"),
        `${JSON.stringify({
          schemaVersion: "legion-cli-resume/v1",
          runId,
          taskId: i < 4 ? "TSK-0001" : "TSK-0002",
          skillId: "execute",
          preSpawnRef: "UNBORN",
          startedAt: new Date(Date.now() - (8 - i) * 1000).toISOString(),
          pid: 2_000_000_000,
          adapterId: "fake",
          binary: "(in-process)",
          argvSummary: "{{pointer}}",
          resolutionSource: "default",
        })}\n`,
        "utf8",
      );
    }
    resetListCacheResumesCalls();
    await engine.recoverStaleInProgress();
    assert.equal(
      listCacheResumesCalls,
      1,
      `listCacheResumes must run once per lock, not per task (got ${listCacheResumesCalls})`,
    );
    assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
    assert.equal((await store.readTask("TSK-0002")).data.status, "blocked");
  });
});

test("F-031: recovery skips the cache/runs scan with no current task and no in-flight task", async () => {
  await withEngine(async ({ dir, store, engine }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    const state = await store.readState();
    await store.writeState({ ...state.data, phase: "executing", currentTaskId: null }, state.body);
    const runsDir = join(dir, ".legion-cli", "cache", "runs");
    await mkdir(runsDir, { recursive: true });
    for (let i = 0; i < 50; i += 1) await mkdir(join(runsDir, `old-${i}`), { recursive: true });
    resetListCacheResumesCalls();
    await engine.recoverStaleInProgress();
    assert.equal(listCacheResumesCalls, 0, "no scan when nothing can be in flight");

    // A dead in_progress task with no current task is still found and recovered.
    await writeTask(store, makeTask({ id: "TSK-0002", status: "in_progress" }));
    await mkdir(join(runsDir, "dead-1"), { recursive: true });
    await writeFile(
      join(runsDir, "dead-1", "resume.json"),
      `${JSON.stringify({
        schemaVersion: "legion-cli-resume/v1",
        runId: "dead-1",
        taskId: "TSK-0002",
        skillId: "execute",
        preSpawnRef: "UNBORN",
        startedAt: new Date(Date.now() - 5000).toISOString(),
        pid: 2_000_000_000,
        adapterId: "fake",
        binary: "(in-process)",
        argvSummary: "{{pointer}}",
        resolutionSource: "default",
      })}
`,
      "utf8",
    );
    resetListCacheResumesCalls();
    await engine.recoverStaleInProgress();
    assert.equal(listCacheResumesCalls, 1);
    assert.equal((await store.readTask("TSK-0002")).data.status, "blocked");
  });
});

test("F-031: recovery still scans when a task is current or a task is verifying", async () => {
  for (const scenario of ["current", "verifying"]) {
    await withEngine(async ({ dir, store, engine }) => {
      await initProject(engine);
      const status = scenario === "current" ? "in_progress" : "verifying";
      await writeTask(store, makeTask({ id: "TSK-0001", status }));
      const state = await store.readState();
      await store.writeState(
        { ...state.data, phase: "executing", currentTaskId: scenario === "current" ? "TSK-0001" : null },
        state.body,
      );
      await mkdir(join(dir, ".legion-cli", "cache", "runs"), { recursive: true });
      resetListCacheResumesCalls();
      await engine.recoverStaleInProgress();
      assert.equal(listCacheResumesCalls, 1, `scenario ${scenario} must scan`);
    });
  }
});

test("second execute is refused while a task is verifying", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, store }) => {
      let secondErr;
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeOnVerify: async () => {
          assert.equal((await store.readTask("TSK-0001")).data.status, "verifying");
          const other = new LegionEngine(dir, undefined, { skillsDir });
          try {
            await other.execute("auto");
          } catch (err) {
            secondErr = err;
          }
        },
      });
      await initProject(engine);
      await seedPlanReady(store, {
        extraTasks: [
          makeTask({
            id: "TSK-0002",
            title: "sibling",
            status: "ready",
            contract: {
              filesAllowed: ["src/other.ts"],
              expectedArtifacts: ["src/other.ts"],
              verificationCommands: [passingVerificationCommand()],
            },
          }),
        ],
        task: {
          contract: {
            filesAllowed: ["src/main.ts"],
            expectedArtifacts: ["src/main.ts"],
            verificationCommands: [passingVerificationCommand()],
          },
        },
      });
      initGitRepo(dir);
      const first = await engine.execute("auto");
      assert.equal(first.status, "done");
      assert.equal(secondErr instanceof LegionRefuseError, true, String(secondErr));
      assert.match(secondErr.message, /execute run execute-.* is live/);
      assert.equal((await store.readTask("TSK-0002")).data.status, "ready");
    });
  });
});

test("post-verify STATE.md does not clobber a newer currentTaskId", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, store }) => {
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeOnVerify: async () => {
          const state = await store.readState();
          await store.writeState({ ...state.data, currentTaskId: "TSK-0002" }, state.body);
        },
      });
      await initProject(engine);
      await seedPlanReady(store, {
        extraTasks: [
          makeTask({
            id: "TSK-0002",
            title: "sibling",
            status: "ready",
            contract: {
              filesAllowed: ["src/other.ts"],
              expectedArtifacts: ["src/other.ts"],
              verificationCommands: [passingVerificationCommand()],
            },
          }),
        ],
        task: {
          contract: {
            filesAllowed: ["src/main.ts"],
            expectedArtifacts: ["src/main.ts"],
            verificationCommands: [passingVerificationCommand()],
          },
        },
      });
      initGitRepo(dir);
      await engine.execute("auto");
      assert.equal((await store.readState()).data.currentTaskId, "TSK-0002");
    });
  });
});

test("F-048/F-061 documented exception: intent --confirm holds engine.lock across its agent run", async () => {
  // Unlike execute/review (start, drop the lock, wait, relock), these verbs run the agent inside
  // one lock hold: verify, intent --confirm, spec and ingest --distill. Other verbs wait for the
  // lock (and time out with "engine locked") for the length of the run; the run marker is still
  // written so a second process sees a live run.
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, store }) => {
      const readyPath = join(dir, ".legion-cli", "cache", "fake-wait", "confirm-ready");
      const releasePath = join(dir, ".legion-cli", "cache", "fake-wait", "confirm-release");
      const filler = new LegionEngine(dir, undefined, { skillsDir });
      await initProject(filler);
      await filler.beginIntent();
      await filler.intentTurn(["Teammates who miss who is in.", "Five chat apps every morning."]);
      await filler.intentTurn(["Tap in or out in under five seconds.", "No payroll in v0."]);
      await filler.intentTurn(["existing auth"]);
      await filler.intentTurn(["Open the board, tap In, see yourself.", "Empty board, network error."]);
      await filler.intentTurn(["board", "phone"]);
      await filler.intentTurn(["none", "none"]);
      const held = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeHoldWait: { readyPath, releasePath, timeoutMs: 15_000 },
      });
      const pending = held.confirmIntent({ id: "tester" });
      const start = Date.now();
      while (!existsSync(readyPath) && Date.now() - start < 10_000) await delay(20);
      assert.equal(existsSync(readyPath), true, "agent hold never started");
      assert.equal(existsSync(store.paths.lock), true, "confirm holds engine.lock while its agent runs");
      await writeFile(releasePath, "go" + String.fromCharCode(10));
      await pending;
      assert.equal(existsSync(store.paths.lock), false);
    });
  });
});
