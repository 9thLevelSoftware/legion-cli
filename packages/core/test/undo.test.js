import assert from "node:assert/strict";
import test from "node:test";
import { undoLastTask } from "../dist/index.js";
import { initProject, makeTask, withEngine, writeTask } from "./helpers.js";

test("undoLastTask reverts the last done task to todo status", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    const task = makeTask({ id: "TSK-0001", status: "done" });
    await writeTask(store, task);

    const result = await undoLastTask({
      projectRoot: dir,
      store,
    });

    assert.equal(result.taskId, "TSK-0001");
    assert.match(result.message, /Reverted task TSK-0001 to todo/);

    const updated = await store.readTask("TSK-0001");
    assert.equal(updated.data.status, "todo");
    assert.match(updated.data.notes, /\[undo\]: reverted to todo/);
  });
});

test("undoLastTask rewinds state phase to executing and cascades to dependent ready tasks", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    const task1 = makeTask({ id: "TSK-0001", status: "done" });
    const task2 = makeTask({ id: "TSK-0002", status: "ready", blockedBy: ["TSK-0001"] });
    await writeTask(store, task1);
    await writeTask(store, task2);

    const state = await store.readState();
    await store.writeState({ ...state.data, phase: "ready_to_ship" }, state.body);

    const result = await undoLastTask({
      projectRoot: dir,
      store,
    });

    assert.equal(result.taskId, "TSK-0001");

    const stateAfter = await store.readState();
    assert.equal(stateAfter.data.phase, "executing");

    const updatedTask2 = await store.readTask("TSK-0002");
    assert.equal(updatedTask2.data.status, "todo");
    assert.match(updatedTask2.data.notes, /dependency TSK-0001 undone, reverted to todo/);
  });
});
