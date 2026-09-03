import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { LegionRefuseError } from "../dist/index.js";
import { initProject, seedPlanReady, withEngine } from "./helpers.js";

async function inProgressCount(store) {
  let files;
  try {
    files = await readdir(store.paths.tasksDir);
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
  let count = 0;
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    const task = (await store.readTask(file.replace(/\.md$/i, ""))).data;
    if (task.status === "in_progress") count += 1;
  }
  return count;
}

test("newPacket files a request outside the DAG", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    const result = await engine.newPacket({
      title: "Dark mode",
      request: "Users want a dark theme.",
      requester: "designer",
    });
    assert.equal(result.packet.id, "PKT-0001");
    assert.equal(result.packet.status, "open");
    assert.equal(result.packet.requester, "designer");
    assert.equal(result.path, ".legion-cli/packets/PKT-0001.md");
    assert.deepEqual(result.tickets, []);
    assert.deepEqual(result.packet.ticketIds, []);
    const doc = await store.readPacket("PKT-0001");
    assert.equal(doc.data.title, "Dark mode");
    assert.match(doc.body, /Users want a dark theme/);
    await assert.rejects(() => store.readTask("TSK-0001"));
  });
});

test("respondPacket spawns a ticket and does not execute", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedPlanReady(store);
    await engine.newPacket({ title: "Dark mode", request: "Users want a dark theme." });
    const inProgressBefore = await inProgressCount(store);
    const result = await engine.respondPacket({
      id: "PKT-0001",
      message: "Parked as a ticket.",
    });
    assert.equal(result.packet.status, "responded");
    assert.equal(result.tickets.length, 1);
    const ticket = result.tickets[0];
    assert.equal(ticket.title, "Dark mode");
    assert.match(ticket.notes, /PKT-0001/);
    assert.notEqual(ticket.status, "in_progress");
    assert.equal(await inProgressCount(store), inProgressBefore);
    assert.deepEqual(result.packet.ticketIds, [ticket.id]);
    const packet = (await store.readPacket("PKT-0001")).data;
    assert.equal(packet.status, "responded");
    assert.deepEqual(packet.ticketIds, [ticket.id]);
    await assert.rejects(() => access(join(dir, ".legion-cli", "cache", "runs")));
  });
});

test("respondPacket refuses unknown, already-responded, and missing spec", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    await engine.newPacket({ title: "Dark mode" });
    await assert.rejects(
      () => engine.respondPacket({ id: "PKT-0001" }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /active spec/);
        return true;
      },
    );
    await assert.rejects(
      () => engine.respondPacket({ id: "PKT-9999" }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /unknown packet PKT-9999/);
        assert.match(err.nextHint, /packet respond PKT-9999/);
        return true;
      },
    );
  });

  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store);
    await engine.newPacket({ title: "Dark mode" });
    await engine.respondPacket({ id: "PKT-0001" });
    await assert.rejects(
      () => engine.respondPacket({ id: "PKT-0001" }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /already responded/);
        return true;
      },
    );
  });
});

test("newPacket refuses uninitialized and empty title", async () => {
  await withEngine(async ({ engine }) => {
    await assert.rejects(
      () => engine.newPacket({ title: "Dark mode" }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /until init/);
        return true;
      },
    );
    await initProject(engine);
    await assert.rejects(
      () => engine.newPacket({ title: "   " }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /requires a title/);
        return true;
      },
    );
  });
});
