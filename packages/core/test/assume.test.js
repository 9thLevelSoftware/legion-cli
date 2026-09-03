import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { queryIndex } from "@9thlevelsoftware/legion-cli-persist";
import { WIKI_INDEX_STORE_PATH } from "@9thlevelsoftware/legion-cli-wiki";

import { HINT, LegionRefuseError } from "../dist/index.js";
import {
  initProject,
  makeTask,
  seedFrozenSpec,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  writeTask,
} from "./helpers.js";

function makeAssumption(overrides = {}) {
  return {
    schemaVersion: "legion-cli-assumption/v1",
    id: "ASM-0001",
    statement: "Need office wifi",
    status: "open",
    blocking: true,
    escalatesTo: "user",
    createdIn: "intent",
    ...overrides,
  };
}

test("assumeList and assumeAnswer refuse until init", async () => {
  await withEngine(async ({ engine }) => {
    await assert.rejects(
      () => engine.assumeList(),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.nextHint, /legion-cli init/);
        return true;
      },
    );
    await assert.rejects(
      () => engine.assumeAnswer("ASM-0001", "confirmed"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.nextHint, /legion-cli init/);
        return true;
      },
    );
  });
});

test("assumeList returns intent-written ASM files; assumeAnswer writes confirmed|rejected", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await store.writeAssumption(makeAssumption(), "Need office wifi\n");
    await store.writeAssumption(
      makeAssumption({
        id: "ASM-0002",
        statement: "Dark mode is nice",
        blocking: false,
      }),
      "Dark mode is nice\n",
    );

    const listed = await engine.assumeList();
    assert.deepEqual(
      listed.map((item) => item.id),
      ["ASM-0001", "ASM-0002"],
    );
    assert.equal(listed[0].status, "open");
    assert.equal(listed[0].blocking, true);

    const confirmed = await engine.assumeAnswer("ASM-0001", "confirmed");
    assert.equal(confirmed.status, "confirmed");
    assert.equal((await store.readAssumption("ASM-0001")).data.status, "confirmed");
    assert.equal((await store.readAssumption("ASM-0001")).body.trim(), "Need office wifi");

    const rows = queryIndex(engine.projectRoot, "SELECT id, status FROM assumptions_idx ORDER BY id");
    assert.deepEqual(rows, [
      { id: "ASM-0001", status: "confirmed" },
      { id: "ASM-0002", status: "open" },
    ]);

    const rejected = await engine.assumeAnswer("ASM-0002", "rejected");
    assert.equal(rejected.status, "rejected");
    assert.equal((await store.readAssumption("ASM-0002")).data.status, "rejected");
  });
});

test("assumeAnswer unknown id or invalid status refuses", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await store.writeAssumption(makeAssumption(), "Need office wifi\n");
    await assert.rejects(
      () => engine.assumeAnswer("ASM-9999", "confirmed"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /unknown assumption ASM-9999/);
        assert.equal(err.nextHint, HINT.assumeList);
        return true;
      },
    );
    await assert.rejects(
      () => engine.assumeAnswer("ASM-0001", "open"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /confirmed or rejected/);
        assert.equal(err.nextHint, HINT.assumeAnswer);
        return true;
      },
    );
    assert.equal((await store.readAssumption("ASM-0001")).data.status, "open");
  });
});

test("confirming a blocking assumption unblocks isTaskReady", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { task: { status: "ready" } });
    await store.writeAssumption(makeAssumption(), "Need office wifi\n");
    assert.deepEqual(
      (await engine.nextTasks()).map((task) => task.id),
      [],
    );
    await engine.assumeAnswer("ASM-0001", "confirmed");
    assert.deepEqual(
      (await engine.nextTasks()).map((task) => task.id),
      ["TSK-0001"],
    );
  });
});

test("plan with a blocking assumption leaves todo; assumeAnswer promotes to ready", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedFrozenSpec(store);
      await writeTask(store, makeTask({ status: "todo" }));
      await store.writeAssumption(makeAssumption(), "Need office wifi\n");
      await engine.plan("spec-checkin");
      assert.equal((await store.readTask("TSK-0001")).data.status, "todo");
      assert.deepEqual(
        (await engine.nextTasks()).map((task) => task.id),
        [],
      );
      await engine.assumeAnswer("ASM-0001", "confirmed");
      assert.deepEqual(
        (await engine.nextTasks()).map((task) => task.id),
        ["TSK-0001"],
      );
      assert.equal((await store.readTask("TSK-0001")).data.status, "ready");
    });
  });
});

test("rejecting a blocking assumption also unblocks isTaskReady", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { task: { status: "ready" } });
    await store.writeAssumption(makeAssumption(), "Need office wifi\n");
    await engine.assumeAnswer("ASM-0001", "rejected");
    assert.deepEqual(
      (await engine.nextTasks()).map((task) => task.id),
      ["TSK-0001"],
    );
  });
});

test("assumeAnswer refreshes the wiki catalog", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
    await engine.ingest(["notes.md"], { noCommit: true });
    await store.writeAssumption(makeAssumption(), "Need office wifi\n");
    await writeFile(join(dir, ".legion-cli", "wiki", "index.md"), "spawn overwrote this\n", "utf8");
    await engine.assumeAnswer("ASM-0001", "confirmed");
    const index = await store.readWikiPage(WIKI_INDEX_STORE_PATH);
    assert.equal(index.data.title, "Wiki index");
    assert.equal(index.data.trust, "reviewed");
    assert.match(index.body, /Catalog of compiled pages/);
  });
});
