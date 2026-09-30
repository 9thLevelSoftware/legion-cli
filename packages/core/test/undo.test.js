import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { listOpenCommandIds, ownProcessStartedAt } from "@9thlevelsoftware/legion-cli-persist";
import {
  applyChatAction,
  assertCanUndoTransition,
  canTransition,
  canTransitionBrownfield,
  canTransitionTaskStatus,
  LEGAL_BROWNFIELD_PHASE_TRANSITIONS,
  LEGAL_PHASE_TRANSITIONS,
  LEGAL_TASK_TRANSITIONS,
  LegionEngine,
  LegionRefuseError,
  refuse,
  sanitizeChatAction,
  setUndoGitResetHard,
  setUndoGitRevert,
  SHIP_COMMIT_PREFIX,
  undoLastTask,
} from "../dist/index.js";
import {
  git,
  gitHead,
  initGitRepo,
  initProject,
  makeTask,
  passingVerificationCommand,
  patchState,
  seedFrozenSpec,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  writeTask,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

async function writeLiveResume(dir, taskId) {
  const runId = `live-${taskId}`;
  const resumeDir = join(dir, ".legion-cli", "cache", "runs", runId);
  await mkdir(resumeDir, { recursive: true });
  await writeFile(
    join(resumeDir, "resume.json"),
    `${JSON.stringify({
      schemaVersion: "legion-cli-resume/v1",
      runId,
      taskId,
      skillId: "execute",
      preSpawnRef: "UNBORN",
      startedAt: new Date().toISOString(),
      pid: process.pid,
      adapterId: "fake",
      binary: "(in-process)",
      argvSummary: "{{pointer}}",
      resolutionSource: "default",
    })}\n`,
    "utf8",
  );
}

/** The live-run marker a real execute leaves while its agent runs. */
async function writeLiveMarker(dir, taskId) {
  const runId = `live-${taskId}`;
  const markerDir = join(dir, ".legion-cli", "cache", "live-spawn");
  await mkdir(markerDir, { recursive: true });
  await writeFile(
    join(markerDir, `${runId}.json`),
    JSON.stringify({
      schemaVersion: "legion-cli-live-run/v1",
      runId,
      skillId: "execute",
      taskId,
      enginePid: process.pid,
      engineStartedAt: ownProcessStartedAt(),
      agentPid: null,
      startedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const coreSrc = join(repoRoot, "packages", "core", "src");

function isRefuse(err, message, hint) {
  assert.equal(err instanceof LegionRefuseError, true, `expected LegionRefuseError, got ${err?.name}: ${err?.message}`);
  if (message) assert.match(err.message, message);
  if (hint) assert.match(err.nextHint, hint);
  return true;
}

function emptyCatchCount(src) {
  const re = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*)?\}/g;
  return [...src.matchAll(re)].length;
}

async function walkSourceFiles(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await walkSourceFiles(abs, acc);
    else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) acc.push(abs);
  }
  return acc;
}

async function snapshotTask(store, id) {
  const doc = await store.readTask(id);
  return { status: doc.data.status, notes: doc.data.notes, body: doc.body };
}

test("undoLastTask reverts the last done task to todo status", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    const task = makeTask({ id: "TSK-0001", status: "done" });
    await writeTask(store, task);

    const result = await engine.undoLastTask();

    assert.equal(result.taskId, "TSK-0001");
    assert.match(result.message, /Reverted task TSK-0001 to todo/);

    const updated = await store.readTask("TSK-0001");
    assert.equal(updated.data.status, "todo");
    assert.match(updated.data.notes, /\[undo\]: reverted to todo/);
  });
});

test("undoLastTask rewinds state phase to executing and cascades to dependent ready tasks", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    const task1 = makeTask({ id: "TSK-0001", status: "done" });
    const task2 = makeTask({ id: "TSK-0002", status: "ready", blockedBy: ["TSK-0001"] });
    await writeTask(store, task1);
    await writeTask(store, task2);

    const state = await store.readState();
    await store.writeState({ ...state.data, phase: "ready_to_ship" }, state.body);

    const result = await engine.undoLastTask();

    assert.equal(result.taskId, "TSK-0001");

    const stateAfter = await store.readState();
    assert.equal(stateAfter.data.phase, "executing");

    const updatedTask2 = await store.readTask("TSK-0002");
    assert.equal(updatedTask2.data.status, "todo");
    assert.match(updatedTask2.data.notes, /dependency TSK-0001 undone, reverted to todo/);
  });
});

test("in_progress -> todo is illegal; undo cascades in_progress dependents to blocked", async () => {
  assert.equal(canTransitionTaskStatus("in_progress", "todo"), false);
  assert.equal(LEGAL_TASK_TRANSITIONS.in_progress.includes("todo"), false);

  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    await writeTask(
      store,
      makeTask({ id: "TSK-0002", status: "in_progress", blockedBy: ["TSK-0001"] }),
    );

    await engine.undoLastTask();

    const dependent = await store.readTask("TSK-0002");
    assert.equal(dependent.data.status, "blocked");
    assert.match(dependent.data.notes, /reverted to blocked/);
    assert.notEqual(dependent.data.status, "todo");
  });
});

test("phase move outside LEGAL_PHASE_TRANSITIONS is refused by the engine", async () => {
  assert.equal(canTransition("initialized", "executing"), false);
  assert.equal(canTransition("shipped", "executing"), false, "engine writes may never take the undo-only edge");
  assert.doesNotThrow(() => assertCanUndoTransition("shipped", "executing"));
  assert.throws(() => assertCanUndoTransition("ready_to_ship", "executing"), LegionRefuseError);
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    await assert.rejects(() => engine.execute("auto"), (err) => err instanceof LegionRefuseError);
    assert.equal((await engine.getState()).phase, "initialized");
  });
});

for (const raced of ["abandoned", "shipped"]) test(`the state write refuses a phase move the on-disk phase does not allow (${raced})`, async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, store }) => {
      const readyPath = join(dir, ".legion-cli", "cache", "fake-wait", "ready");
      const releasePath = join(dir, ".legion-cli", "cache", "fake-wait", "release");
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeHoldWait: { readyPath, releasePath, timeoutMs: 15_000 },
      });
      await initProject(engine);
      await seedPlanReady(store, {
        task: { contract: { verificationCommands: [passingVerificationCommand()] } },
      });
      initGitRepo(dir);
      const pending = engine.execute("auto");
      for (let i = 0; i < 500 && !existsSync(readyPath); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(existsSync(readyPath), true, "fake wait never became ready");
      // A writer that bypasses the engine abandons the project while the agent runs unlocked.
      await patchState(store, { phase: raced });
      await writeFile(releasePath, "go\n");
      const result = await pending;
      assert.match(JSON.stringify(result), new RegExp(`cannot transition from ${raced} to executing`));
      assert.equal((await store.readState()).data.phase, raced, "the run must not resurrect the phase");
    });
  });
});

test("undo refuses unknown task, non-done task, and empty selection", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "ready" }));
    await assert.rejects(() => engine.undoLastTask({ taskId: "TSK-missing" }), (err) =>
      isRefuse(err, /unknown task TSK-missing/, /legion-cli undo/),
    );
    await assert.rejects(() => engine.undoLastTask({ taskId: "TSK-0001" }), (err) =>
      isRefuse(err, /cannot undo task TSK-0001 from ready/, /legion-cli undo/),
    );
    await assert.rejects(() => engine.undoLastTask(), (err) =>
      isRefuse(err, /no task or commit found to undo/, /legion-cli status/),
    );
  });
});

test("undo selects the last done task by id", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    await writeTask(store, makeTask({ id: "TSK-0002", status: "done" }));
    const result = await engine.undoLastTask();
    assert.equal(result.taskId, "TSK-0002");
    assert.equal((await store.readTask("TSK-0001")).data.status, "done");
    assert.equal((await store.readTask("TSK-0002")).data.status, "todo");
  });
});

test("unknown-type legion commits are refused; ship commits are reverted", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    initGitRepo(dir);
    git(dir, ["commit", "--allow-empty", "-m", "chore(legion): human commit"]);
    await assert.rejects(() => engine.undoLastTask(), (err) =>
      isRefuse(err, /unknown-type commit cannot be undone/, /legion-cli undo/),
    );
    assert.equal((await store.readTask("TSK-0001")).data.status, "done");
  });

  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    await patchState(store, { phase: "shipped", lastReview: "PASS", lastQaId: "qa-1" });
    initGitRepo(dir);
    await writeFile(join(dir, "shipped.txt"), "ship\n", "utf8");
    git(dir, ["add", "shipped.txt"]);
    git(dir, ["commit", "-m", `${SHIP_COMMIT_PREFIX} spec-checkin`]);
    const before = gitHead(dir);
    const result = await engine.undoLastTask();
    assert.equal(result.taskId, "TSK-0001");
    assert.ok(result.commitSha);
    assert.notEqual(gitHead(dir), before);
    assert.equal((await store.readTask("TSK-0001")).data.status, "todo");
    const state = await engine.getState();
    assert.equal(state.phase, "executing");
    assert.equal(state.lastReview, null);
    assert.equal(state.lastQaId, null);
  });
});

async function seedShipCommit(dir, engine, store) {
  await initProject(engine);
  await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
  await patchState(store, { phase: "shipped" });
  initGitRepo(dir);
}

test("undo of a ship commit refuses on a dirty tracked file under .legion-cli and keeps it", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await seedShipCommit(dir, engine, store);
    const notePath = join(dir, ".legion-cli", "note.md");
    await writeFile(notePath, "before\n", "utf8");
    git(dir, ["add", "-A", "-f"]);
    git(dir, ["commit", "-m", "note"]);
    await writeFile(join(dir, "shipped.txt"), "ship\n", "utf8");
    git(dir, ["add", "shipped.txt"]);
    git(dir, ["commit", "-m", `${SHIP_COMMIT_PREFIX} spec-checkin`]);
    const shipHead = gitHead(dir);
    // Not touched by the ship commit, so git itself would not stop the revert.
    await writeFile(notePath, "my uncommitted edit\n", "utf8");

    await assert.rejects(() => engine.undoLastTask(), (err) => isRefuse(err, /clean tracked tree/, /git status/));
    assert.equal(gitHead(dir), shipHead);
    assert.equal(await readFile(notePath, "utf8"), "my uncommitted edit\n");
    assert.equal((await engine.getState()).phase, "shipped");
    assert.equal((await store.readTask("TSK-0001")).data.status, "done");
  });
});

test("a post-revert failure rolls back without touching untracked files", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await seedShipCommit(dir, engine, store);
    await writeFile(join(dir, "shipped.txt"), "ship\n", "utf8");
    git(dir, ["add", "shipped.txt"]);
    git(dir, ["commit", "-m", `${SHIP_COMMIT_PREFIX} spec-checkin`]);
    const shipHead = gitHead(dir);
    await writeFile(join(dir, "scratch.txt"), "untracked\n", "utf8");
    store.writeTask = async () => {
      throw new Error("injected store failure after git");
    };
    await assert.rejects(() => engine.undoLastTask(), /injected store failure after git/);
    assert.equal(gitHead(dir), shipHead);
    assert.equal(await readFile(join(dir, "scratch.txt"), "utf8"), "untracked\n");
  });
});

test("a real conflicting revert is aborted: no REVERT_HEAD, no markers, phase and HEAD unchanged", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await seedShipCommit(dir, engine, store);
    await writeFile(join(dir, "a.txt"), "1\n", "utf8");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "a1"]);
    await writeFile(join(dir, "a.txt"), "2\n", "utf8");
    git(dir, ["commit", "-am", "a2"]);
    const a2 = gitHead(dir);
    await writeFile(join(dir, "a.txt"), "3\n", "utf8");
    git(dir, ["commit", "-am", "a3"]);
    await writeFile(join(dir, "shipped.txt"), "ship\n", "utf8");
    git(dir, ["add", "shipped.txt"]);
    git(dir, ["commit", "-m", `${SHIP_COMMIT_PREFIX} spec-checkin`]);
    const shipHead = gitHead(dir);
    // Reverting HEAD cannot conflict on a clean tree, so stand in a revert that really does:
    // a2 changed the line a3 changed again. Real git starts it, stops on the conflict, leaves REVERT_HEAD.
    setUndoGitRevert((root) => {
      try {
        git(root, ["revert", "--no-edit", a2]);
        return { ok: true, out: "" };
      } catch (err) {
        assert.equal(existsSync(join(root, ".git", "REVERT_HEAD")), true, "git really stopped mid-revert");
        return { ok: false, out: String(err.message) };
      }
    });
    try {
      await assert.rejects(() => engine.undoLastTask(), (err) => isRefuse(err, /git revert failed and was aborted/, /git status/));
    } finally {
      setUndoGitRevert(null);
    }
    assert.equal(existsSync(join(dir, ".git", "REVERT_HEAD")), false);
    assert.equal(gitHead(dir), shipHead);
    assert.equal(git(dir, ["status", "--porcelain", "--untracked-files=no"]), "");
    assert.equal((await readFile(join(dir, "a.txt"), "utf8")).trim(), "3");
    assert.equal((await engine.getState()).phase, "shipped");
    assert.equal((await store.readTask("TSK-0001")).data.status, "done");
  });
});

test("undo leaves a revert the user already has in progress alone", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await seedShipCommit(dir, engine, store);
    await writeFile(join(dir, "a.txt"), "1\n", "utf8");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "a1"]);
    await writeFile(join(dir, "a.txt"), "2\n", "utf8");
    git(dir, ["commit", "-am", "a2"]);
    const a2 = gitHead(dir);
    await writeFile(join(dir, "a.txt"), "3\n", "utf8");
    git(dir, ["commit", "-am", "a3"]);
    await writeFile(join(dir, "shipped.txt"), "ship\n", "utf8");
    git(dir, ["add", "shipped.txt"]);
    git(dir, ["commit", "-m", `${SHIP_COMMIT_PREFIX} spec-checkin`]);
    assert.throws(() => git(dir, ["revert", "--no-edit", a2]));
    assert.equal(existsSync(join(dir, ".git", "REVERT_HEAD")), true);
    const marked = await readFile(join(dir, "a.txt"), "utf8");

    await assert.rejects(() => engine.undoLastTask(), (err) => isRefuse(err, /revert is in progress/, /git status/));
    assert.equal(existsSync(join(dir, ".git", "REVERT_HEAD")), true, "the user's revert is untouched");
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), marked);
    git(dir, ["revert", "--abort"]);
  });
});

test("undo of a ship commit refuses when tracked edits outside .legion-cli would be at risk", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    await writeFile(join(dir, "app.txt"), "one\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "shipped.txt"), "ship\n", "utf8");
    git(dir, ["add", "shipped.txt"]);
    git(dir, ["commit", "-m", `${SHIP_COMMIT_PREFIX} spec-checkin`]);
    const shipHead = gitHead(dir);
    await writeFile(join(dir, "app.txt"), "two\n", "utf8");
    await assert.rejects(() => engine.undoLastTask(), (err) => isRefuse(err, /clean tracked tree/, /git status/));
    assert.equal(gitHead(dir), shipHead);
    assert.equal(await readFile(join(dir, "app.txt"), "utf8"), "two\n");
  });
});

test("undo holds the engine lock for git + store writes", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    let sawLock = false;
    const original = store.writeTask.bind(store);
    store.writeTask = async (...args) => {
      sawLock = store.holdsLock();
      return original(...args);
    };
    await engine.undoLastTask();
    assert.equal(sawLock, true);
  });
});

test("undo mid-failure leaves pre-undo or fully undone state, never a mix", async () => {
  async function runFailAt(failAt) {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
      await writeTask(store, makeTask({ id: "TSK-0002", status: "ready", blockedBy: ["TSK-0001"] }));
      await patchState(store, { phase: "ready_to_ship" });

      const before = {
        one: await snapshotTask(store, "TSK-0001"),
        two: await snapshotTask(store, "TSK-0002"),
        phase: (await store.readState()).data.phase,
      };

      let calls = 0;
      for (const method of ["writeTask", "writeState"]) {
        const original = store[method].bind(store);
        store[method] = async (...args) => {
          calls += 1;
          if (calls === failAt) throw new Error(`injected store failure at step ${failAt}`);
          return original(...args);
        };
      }

      await assert.rejects(() => engine.undoLastTask(), /injected store failure/);

      const after = {
        one: await snapshotTask(store, "TSK-0001"),
        two: await snapshotTask(store, "TSK-0002"),
        phase: (await store.readState()).data.phase,
      };

      const fullyUndone =
        after.one.status === "todo" && after.two.status === "todo" && after.phase === "executing";
      const preUndo =
        after.one.status === before.one.status &&
        after.two.status === before.two.status &&
        after.phase === before.phase;
      const mixed =
        (after.one.status !== before.one.status) !== (after.two.status !== before.two.status) ||
        (after.one.status === "todo" && after.phase === "ready_to_ship");
      assert.equal(mixed, false, `mixed state after fail at step ${failAt}: ${JSON.stringify(after)}`);
      assert.ok(preUndo || fullyUndone, `expected pre-undo or fully undone at step ${failAt}`);
    });
  }

  await runFailAt(1);
  await runFailAt(2);
  await runFailAt(3);
});

test("undo after git revert rolls git back when a later store write fails", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    initGitRepo(dir);
    await writeFile(join(dir, "shipped.txt"), "ship\n", "utf8");
    git(dir, ["add", "shipped.txt"]);
    git(dir, ["commit", "-m", `${SHIP_COMMIT_PREFIX} spec-checkin`]);
    const shipHead = gitHead(dir);

    const original = store.writeTask.bind(store);
    store.writeTask = async () => {
      throw new Error("injected store failure after git");
    };

    await assert.rejects(() => engine.undoLastTask(), /injected store failure after git/);
    assert.equal(gitHead(dir), shipHead);
    assert.equal((await store.readTask("TSK-0001")).data.status, "done");
  });
});

test("failed git reset during undo rollback does not restore engine files", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    await writeTask(store, makeTask({ id: "TSK-0002", status: "ready", blockedBy: ["TSK-0001"] }));
    await patchState(store, { phase: "ready_to_ship" });
    initGitRepo(dir);
    await writeFile(join(dir, "shipped.txt"), "ship\n", "utf8");
    git(dir, ["add", "shipped.txt"]);
    git(dir, ["commit", "-m", `${SHIP_COMMIT_PREFIX} spec-checkin`]);
    const shipHead = gitHead(dir);

    let writes = 0;
    for (const method of ["writeTask", "writeState"]) {
      const original = store[method].bind(store);
      store[method] = async (...args) => {
        writes += 1;
        if (writes === 2) throw new Error("injected store failure at step 2");
        return original(...args);
      };
    }
    setUndoGitResetHard(() => {
      refuse("git reset failed during undo rollback: injected", "git status");
    });
    try {
      await assert.rejects(() => engine.undoLastTask(), (err) =>
        isRefuse(err, /git reset failed during undo rollback/, /git status/),
      );
      assert.notEqual(gitHead(dir), shipHead);
      assert.equal((await store.readTask("TSK-0001")).data.status, "todo");
      assert.equal((await store.readState()).data.phase, "ready_to_ship");
    } finally {
      setUndoGitResetHard(null);
    }
  });
});

test("failed undo closes the command so reconcile cannot keep a mix", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    await writeTask(store, makeTask({ id: "TSK-0002", status: "ready", blockedBy: ["TSK-0001"] }));
    await patchState(store, { phase: "ready_to_ship" });

    let writes = 0;
    for (const method of ["writeTask", "writeState"]) {
      const original = store[method].bind(store);
      store[method] = async (...args) => {
        writes += 1;
        if (writes === 2) throw new Error("injected store failure at step 2");
        return original(...args);
      };
    }

    await assert.rejects(() => engine.undoLastTask(), /injected store failure/);
    assert.equal((await store.readTask("TSK-0001")).data.status, "done");
    assert.equal((await store.readState()).data.phase, "ready_to_ship");
    assert.deepEqual(await listOpenCommandIds(dir), []);

    const other = new LegionEngine(dir, store);
    await other.recoverStaleInProgress();
    assert.equal((await store.readTask("TSK-0001")).data.status, "done");
    assert.equal((await store.readTask("TSK-0002")).data.status, "ready");
    assert.equal((await store.readState()).data.phase, "ready_to_ship");
  });
});

test("undo refuses during a live execute", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    await writeTask(
      store,
      makeTask({ id: "TSK-0002", status: "in_progress", blockedBy: ["TSK-0001"] }),
    );
    await patchState(store, { phase: "executing", currentTaskId: "TSK-0002" });
    await writeLiveResume(dir, "TSK-0002");
    await writeLiveMarker(dir, "TSK-0002");
    await assert.rejects(() => engine.undoLastTask(), (err) =>
      isRefuse(err, /execute run live-TSK-0002 is live/, /legion-cli status/),
    );
    assert.equal((await store.readTask("TSK-0002")).data.status, "in_progress");
    assert.equal((await store.readTask("TSK-0001")).data.status, "done");
  });
});

test("task recover refuses a live verifying task", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", task: { status: "verifying" }, currentTaskId: "TSK-0001" });
    await writeLiveResume(dir, "TSK-0001");
    await assert.rejects(() => engine.recoverTask("TSK-0001"), (err) =>
      isRefuse(err, /cannot recover TSK-0001 while verification is live/, /legion-cli status/),
    );
    assert.equal((await store.readTask("TSK-0001")).data.status, "verifying");
  });
});

test("#writeTask does not skip the guard when an existing task read fails", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", task: { status: "blocked" } });
    const original = store.readTask.bind(store);
    let reads = 0;
    store.readTask = async (id) => {
      reads += 1;
      if (reads > 1) throw new Error("corrupt task file");
      return original(id);
    };
    try {
      await assert.rejects(() => engine.unblockTask("TSK-0001"), /corrupt task file/);
    } finally {
      store.readTask = original;
    }
    assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
  });
});

test("plan clamp skips compacted tasks instead of requesting compacted -> blocked", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedFrozenSpec(store);
        await writeTask(store, makeTask({ id: "TSK-0001", status: "compacted" }));
        try {
          await engine.plan();
        } catch (err) {
          assert.doesNotMatch(String(err?.message ?? err), /compacted to blocked|from compacted to blocked/);
        }
        assert.equal((await store.readTask("TSK-0001")).data.status, "compacted");
      },
      { skillsDir },
    );
  });
});

test("abandoned, blocked, and verifying have CLI round-trips back to a working state", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing" });
    await engine.abandon("park this increment");
    assert.equal((await engine.getState()).phase, "abandoned");
    await engine.newSpec();
    assert.equal((await engine.getState()).phase, "intent_draft");
  });

  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", task: { status: "blocked" } });
    const task = await engine.unblockTask("TSK-0001");
    assert.ok(task.status === "todo" || task.status === "ready", task.status);
  });

  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", task: { status: "verifying" }, currentTaskId: null });
    const recovered = await engine.recoverTask("TSK-0001");
    assert.equal(recovered.status, "blocked");
    const unblocked = await engine.unblockTask("TSK-0001");
    assert.ok(unblocked.status === "todo" || unblocked.status === "ready", unblocked.status);
  });
});

test("unguarded setTaskStatus is not a public mutator", async () => {
  await withEngine(async ({ engine }) => {
    assert.equal(typeof engine.setTaskStatus, "undefined");
    assert.equal(Object.prototype.hasOwnProperty.call(LegionEngine.prototype, "setTaskStatus"), false);
  });
});

test("refusal matrix: illegal transitions are named refusals across callers", async () => {
  const illegalTasks = [
    ["in_progress", "todo"],
    ["in_progress", "done"],
    ["verifying", "todo"],
    ["verifying", "ready"],
    ["compacted", "todo"],
    ["todo", "done"],
    ["todo", "in_progress"],
  ];
  for (const [from, to] of illegalTasks) {
    assert.equal(canTransitionTaskStatus(from, to), false, `${from} -> ${to} must stay illegal`);
  }

  const illegalPhases = [
    ["initialized", "executing"],
    ["abandoned", "executing"],
    ["shipped", "executing"],
    ["uninitialized", "shipped"],
    ["ready_to_ship", "initialized"],
  ];
  for (const [from, to] of illegalPhases) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to} must stay illegal`);
  }

  assert.deepEqual(
    { ...LEGAL_TASK_TRANSITIONS },
    {
      todo: ["ready", "blocked"],
      ready: ["in_progress", "blocked", "todo"],
      in_progress: ["verifying", "blocked"],
      verifying: ["done", "blocked"],
      blocked: ["todo", "ready"],
      done: ["compacted", "todo"],
      compacted: [],
    },
  );

  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", task: { status: "in_progress" } });

    await assert.rejects(() => engine.newSpec(), (err) =>
      isRefuse(err, /Start a new spec after this one ships or is abandoned/),
    );

    const chatDropped = sanitizeChatAction({ type: "execute" }, { phase: "executing", utterance: "execute" });
    assert.equal(chatDropped.type, "next_verb");
    await assert.rejects(() => applyChatAction(engine, { type: "execute" }), (err) =>
      isRefuse(err, /chat cannot apply execute/, /legion-cli status/),
    );
    const applied = await applyChatAction(engine, { type: "status" });
    assert.equal(applied.applied, true);

    const packet = await engine.newPacket({ title: "design ask" });
    assert.equal(packet.packet.status, "open");
    assert.equal((await store.readTask("TSK-0001")).data.status, "in_progress");

    await writeLiveResume(engine.projectRoot, "TSK-0001");
    await patchState(store, { currentTaskId: "TSK-0001" });
    const verifyingDoc = await store.readTask("TSK-0001");
    await store.writeTask({ ...verifyingDoc.data, status: "verifying" }, verifyingDoc.body);
    await assert.rejects(() => engine.recoverTask("TSK-0001"), (err) =>
      isRefuse(err, /cannot recover TSK-0001 while verification is live/, /legion-cli status/),
    );
  });

  const cliUndo = await readFile(join(repoRoot, "packages", "cli", "src", "undo.ts"), "utf8");
  assert.match(cliUndo, /createLegionEngine/);
  assert.match(cliUndo, /engine\.undoLastTask/);
  assert.doesNotMatch(cliUndo, /writeTask/);
  assert.doesNotMatch(cliUndo, /createLegionStore/);

  const dashboardWrite = await readFile(join(repoRoot, "packages", "dashboard", "src", "write.ts"), "utf8");
  assert.match(dashboardWrite, /ENGINE_WRITE_METHODS/);
  assert.match(dashboardWrite, /"ticket"/);
  assert.doesNotMatch(dashboardWrite, /setTaskStatus/);
  assert.doesNotMatch(dashboardWrite, /writeTask/);
  assert.doesNotMatch(dashboardWrite, /writeState/);

  const mcpServer = await readFile(join(repoRoot, "packages", "mcp", "src", "server.ts"), "utf8");
  assert.match(mcpServer, /readOnlyHint:\s*true/);
  assert.doesNotMatch(mcpServer, /setTaskStatus/);
  assert.doesNotMatch(mcpServer, /writeTask/);
});

test("cross-module: no second phase-order table", async () => {
  const files = await walkSourceFiles(join(repoRoot, "packages"));
  const phaseOrderHits = [];
  const tableAssignments = [];
  for (const file of files) {
    const rel = file.replaceAll("\\", "/");
    if (rel.includes("/test/") || rel.includes(".test.")) continue;
    const src = await readFile(file, "utf8");
    if (/\b(?:const|let|var)\s+PHASE_ORDER\b/.test(src) || /\bPHASE_ORDER\s*=/.test(src)) {
      phaseOrderHits.push(file);
    }
    if (/LEGAL_PHASE_TRANSITIONS(?:\s*:[^=]+)?\s*=/.test(src)) tableAssignments.push(file);
  }
  assert.deepEqual(phaseOrderHits, [], `PHASE_ORDER must not exist: ${phaseOrderHits.join(", ")}`);
  assert.equal(tableAssignments.length, 1, `LEGAL_PHASE_TRANSITIONS assigned in ${tableAssignments.join(", ")}`);
  assert.match(tableAssignments[0].replaceAll("\\", "/"), /packages\/core\/src\/phases\.ts$/);
  assert.equal(LEGAL_PHASE_TRANSITIONS.abandoned.includes("intent_draft"), true);
  assert.equal(LEGAL_PHASE_TRANSITIONS.abandoned.includes("executing"), false);
  assert.equal(canTransitionBrownfield("complete", "intent"), false);
  assert.ok(LEGAL_BROWNFIELD_PHASE_TRANSITIONS.design.includes("review"));
  assert.ok(LEGAL_BROWNFIELD_PHASE_TRANSITIONS.review.includes("design"));
});

test("undo.ts has no empty catches and guards every task write", async () => {
  const src = await readFile(join(coreSrc, "undo.ts"), "utf8");
  assert.equal(emptyCatchCount(src), 0, "undo.ts must not swallow failures");
  assert.match(src, /assertTaskStatusTransition/);
  assert.match(src, /assertCanTransition/);
  assert.match(src, /openEngineCommand/);
  assert.match(src, /restoreUndoPreimages/);
  assert.match(src, /readCommandRecord/);
  assert.doesNotMatch(src, /chore\(legion\):\s*"\s*\|\|/);
});

test("standalone undoLastTask still takes the store lock", async () => {
  await withEngine(async ({ dir, store, engine }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    const result = await undoLastTask({ projectRoot: dir, store });
    assert.equal(result.taskId, "TSK-0001");
    assert.equal((await store.readTask("TSK-0001")).data.status, "todo");
  });
});

test("undo never rewinds the audit log: a ship commit that touched it, on success and on rollback", async () => {
  const { appendChainedAuditLine, assertAuditChainUsable } = await import("@9thlevelsoftware/legion-cli-persist");
  for (const failStore of [false, true]) {
    await withEngine(async ({ dir, engine, store }) => {
      await seedShipCommit(dir, engine, store);
      // Baseline commit has the audit files as of init; the ship commit adds lines to both.
      await appendChainedAuditLine(dir, JSON.stringify({ type: "shipish", n: 1 }));
      await appendChainedAuditLine(dir, JSON.stringify({ type: "shipish", n: 2 }));
      await writeFile(join(dir, "shipped.txt"), "ship\n", "utf8");
      git(dir, ["add", "-A", "-f"]);
      git(dir, ["commit", "-m", `${SHIP_COMMIT_PREFIX} spec-checkin`]);
      const shipHead = gitHead(dir);
      const events = join(dir, ".legion-cli", "audit", "events.jsonl");
      const chain = join(dir, ".legion-cli", "audit", "chain.json");
      const eventsBefore = await readFile(events);
      const chainBefore = await readFile(chain);
      if (failStore) {
        store.writeTask = async () => {
          throw new Error("injected store failure after git");
        };
        // Damage the audit files as the rollback's reset runs, so a missing restore shows on any OS.
        setUndoGitResetHard((root, ref) => {
          git(root, ["reset", "--hard", ref]);
          writeFileSync(events, "damaged");
          writeFileSync(chain, "damaged");
        });
        try {
          await assert.rejects(() => engine.undoLastTask(), /injected store failure after git/);
        } finally {
          setUndoGitResetHard(null);
        }
        assert.equal(gitHead(dir), shipHead);
        assert.deepEqual(await readFile(events), eventsBefore);
        assert.deepEqual(await readFile(chain), chainBefore);
      } else {
        await engine.undoLastTask();
        const after = await readFile(events);
        assert.deepEqual(after.subarray(0, eventsBefore.length), eventsBefore, "audit lines survive the revert");
        assert.match(after.toString("utf8"), /"type":"undo"/);
      }
      await assertAuditChainUsable(dir);
    });
  }
});
