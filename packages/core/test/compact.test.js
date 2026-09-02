import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionStore } from "@9thlevelsoftware/legion-cli-persist";
import {
  COMPACT_AUDIT_POINTER,
  canTransitionTaskStatus,
  compactTaskBody,
  LegionRefuseError,
  outcomeFromTask,
  p0TasksNotDone,
  unionDoneFilesAllowed,
} from "../dist/index.js";
import { initProject, makeTask, withEngine, writeTask } from "./helpers.js";

test("done → compacted is legal; other statuses are not", () => {
  assert.equal(canTransitionTaskStatus("done", "compacted"), true);
  assert.equal(canTransitionTaskStatus("todo", "compacted"), false);
  assert.equal(canTransitionTaskStatus("ready", "compacted"), false);
  assert.equal(canTransitionTaskStatus("in_progress", "compacted"), false);
  assert.equal(canTransitionTaskStatus("verifying", "compacted"), false);
  assert.equal(canTransitionTaskStatus("blocked", "compacted"), false);
  assert.equal(canTransitionTaskStatus("compacted", "done"), false);
});

test("compactTaskBody keeps title, outcome, and audit pointer", () => {
  const fromNotes = compactTaskBody(
    "in/out button",
    outcomeFromTask("Shipped the button.", "# log\n\nAgent dumped 400 lines here.\n"),
  );
  assert.match(fromNotes, /^# in\/out button/m);
  assert.match(fromNotes, /Shipped the button/);
  assert.match(fromNotes, new RegExp(COMPACT_AUDIT_POINTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(fromNotes, /Agent dumped 400 lines here/);

  const fromLine = compactTaskBody(
    "in/out button",
    outcomeFromTask("", "# log\n\nAgent dumped 400 lines here.\nOutcome: button shipped.\n"),
  );
  assert.match(fromLine, /button shipped/);
  assert.doesNotMatch(fromLine, /Agent dumped/);
  assert.equal(outcomeFromTask("", "# log\n\nVerbose spawn output.\n"), "Done.");
});

test("compacted P0 counts as done for ship gates and filesAllowed", () => {
  const compacted = makeTask({ status: "compacted", priority: "P0" });
  assert.equal(p0TasksNotDone([compacted]).length, 0);
  assert.deepEqual(unionDoneFilesAllowed([compacted]), ["src/main.ts"]);
});

test("context compact rewrites only done tasks with no in_progress sibling", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await writeTask(
      store,
      makeTask({ id: "TSK-0001", status: "done", specId: "spec-checkin" }),
      "# agent log\n\nVerbose spawn output that should drop.\nOutcome: button shipped.\n",
    );
    await writeTask(
      store,
      makeTask({
        id: "TSK-0002",
        status: "todo",
        specId: "spec-checkin",
        contract: { filesAllowed: ["src/board.ts"], expectedArtifacts: ["src/board.ts"] },
      }),
      "Do not rewrite this todo body.\n",
    );
    await writeTask(
      store,
      makeTask({
        id: "TSK-0003",
        status: "blocked",
        specId: "spec-checkin",
        contract: { filesAllowed: ["src/blocked.ts"], expectedArtifacts: ["src/blocked.ts"] },
      }),
      "Blocked body stays.\n",
    );
    await writeTask(
      store,
      makeTask({
        id: "TSK-0004",
        status: "done",
        specId: "spec-other",
        contract: { filesAllowed: ["src/other.ts"], expectedArtifacts: ["src/other.ts"] },
      }),
      "Other spec verbose log.\n",
    );
    await writeTask(
      store,
      makeTask({
        id: "TSK-0005",
        status: "in_progress",
        specId: "spec-other",
        contract: { filesAllowed: ["src/running.ts"], expectedArtifacts: ["src/running.ts"] },
      }),
      "Running sibling.\n",
    );
    await writeTask(
      store,
      makeTask({
        id: "TSK-0006",
        status: "ready",
        specId: "spec-checkin",
        contract: { filesAllowed: ["src/ready.ts"], expectedArtifacts: ["src/ready.ts"] },
      }),
      "Ready body stays.\n",
    );
    await writeTask(
      store,
      makeTask({
        id: "TSK-0007",
        status: "verifying",
        specId: "spec-checkin",
        contract: { filesAllowed: ["src/verifying.ts"], expectedArtifacts: ["src/verifying.ts"] },
      }),
      "Verifying body stays.\n",
    );

    const result = await engine.compactContext();
    assert.deepEqual(
      result.compacted.map((task) => task.id),
      ["TSK-0001"],
    );
    assert.deepEqual(
      result.skipped.map((task) => task.id),
      ["TSK-0004"],
    );
    assert.equal(result.skipped[0].reason, "in_progress sibling");

    const done = await store.readTask("TSK-0001");
    assert.equal(done.data.status, "compacted");
    assert.match(done.body, /in\/out button/);
    assert.match(done.body, /\.legion-cli\/audit\//);
    assert.doesNotMatch(done.body, /Verbose spawn output/);

    assert.equal((await store.readTask("TSK-0002")).data.status, "todo");
    assert.match((await store.readTask("TSK-0002")).body, /Do not rewrite this todo body/);
    assert.equal((await store.readTask("TSK-0003")).data.status, "blocked");
    assert.match((await store.readTask("TSK-0003")).body, /Blocked body stays/);
    assert.equal((await store.readTask("TSK-0004")).data.status, "done");
    assert.match((await store.readTask("TSK-0004")).body, /Other spec verbose log/);
    assert.equal((await store.readTask("TSK-0005")).data.status, "in_progress");
    assert.match((await store.readTask("TSK-0005")).body, /Running sibling/);
    assert.equal((await store.readTask("TSK-0006")).data.status, "ready");
    assert.match((await store.readTask("TSK-0006")).body, /Ready body stays/);
    assert.equal((await store.readTask("TSK-0007")).data.status, "verifying");
    assert.match((await store.readTask("TSK-0007")).body, /Verifying body stays/);

    const again = await engine.compactContext();
    assert.deepEqual(again.compacted, []);
    const still = await store.readTask("TSK-0001");
    assert.equal(still.data.status, "compacted");
    assert.equal(still.body, done.body);
  });
});

test("context compact refuses while engine.lock is held", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ status: "done" }), "Verbose log to compact.\n");
    const other = createLegionStore(dir);
    await other.acquireLock({ timeoutMs: 200 });
    try {
      await assert.rejects(
        () => engine.compactContext({ timeoutMs: 200 }),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /another legion-cli is running/);
          assert.match(err.nextHint, /context compact/);
          return true;
        },
      );
      const doc = await store.readTask("TSK-0001");
      assert.equal(doc.data.status, "done");
      assert.match(doc.body, /Verbose log to compact/);
    } finally {
      await other.releaseLock();
    }
  });
});

test("setTaskStatus compacted is refused; garden and compact refuse uninitialized", async () => {
  await withEngine(async ({ engine, store }) => {
    await assert.rejects(() => engine.garden(), (err) => {
      assert.equal(err instanceof LegionRefuseError, true);
      assert.match(err.message, /init/);
      return true;
    });
    await assert.rejects(() => engine.compactContext(), (err) => {
      assert.equal(err instanceof LegionRefuseError, true);
      assert.match(err.message, /init/);
      return true;
    });

    await initProject(engine);
    await writeTask(store, makeTask({ status: "done" }), "Done body.\n");
    await assert.rejects(() => engine.setTaskStatus("TSK-0001", "compacted"), (err) => {
      assert.equal(err instanceof LegionRefuseError, true);
      assert.match(err.nextHint, /context compact/);
      return true;
    });
    assert.equal((await store.readTask("TSK-0001")).data.status, "done");
  });
});

test("context compact writes an audit event", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ status: "done", notes: "Shipped the button." }), "Agent log dump.\n");
    await engine.compactContext();
    const jsonl = await readFile(join(store.paths.auditDir, "events.jsonl"), "utf8");
    assert.match(jsonl, /context_compact/);
    assert.match(jsonl, /TSK-0001/);
  });
});
