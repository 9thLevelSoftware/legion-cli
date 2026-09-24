import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyChatAction,
  canTransition,
  canTransitionBrownfield,
  canTransitionTaskStatus,
  LEGAL_BROWNFIELD_PHASE_TRANSITIONS,
  LEGAL_PHASE_TRANSITIONS,
  LEGAL_TASK_TRANSITIONS,
  LegionEngine,
  LegionRefuseError,
  sanitizeChatAction,
  SHIP_COMMIT_PREFIX,
  undoLastTask,
} from "../dist/index.js";
import {
  git,
  gitHead,
  initGitRepo,
  initProject,
  makeTask,
  patchState,
  seedPlanReady,
  withEngine,
  writeTask,
} from "./helpers.js";

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
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    await assert.rejects(() => engine.transition("executing"), (err) =>
      isRefuse(err, /cannot transition from initialized to executing/, /legion-cli/),
    );
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

    await assert.rejects(() => engine.transition("spec_draft"), (err) =>
      isRefuse(err, /cannot transition from executing to spec_draft/),
    );

    const chatDropped = sanitizeChatAction({ type: "execute" }, { phase: "executing", utterance: "execute" });
    assert.equal(chatDropped.type, "next_verb");
    const applied = await applyChatAction(engine, { type: "status" });
    assert.equal(applied.applied, true);

    const packet = await engine.newPacket({ title: "design ask" });
    assert.equal(packet.packet.status, "open");
    assert.equal((await store.readTask("TSK-0001")).data.status, "in_progress");
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
