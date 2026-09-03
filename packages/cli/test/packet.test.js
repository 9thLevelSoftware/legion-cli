import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { normalize, runCli, withTempDir } from "./helpers.js";

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

async function seedSpec(dir) {
  const engine = createLegionEngine(dir);
  await engine.init({ name: "Checkin", adapter: "fake" });
  await engine.store.writeSpec(
    {
      schemaVersion: "legion-cli-spec/v1",
      id: "spec-checkin",
      title: "Office check-in",
      status: "frozen",
      mustBeTrue: ["People can tap in or out on their phone in under five seconds"],
      mustNotChange: ["auth"],
      outOfScope: ["payroll"],
      acceptance: [
        {
          id: "AC-01",
          statement: "Tap in or out on a phone completes in under five seconds",
          kind: "behavior",
          priority: "P0",
        },
      ],
      personas: ["teammates"],
      happyPath: "Open the board, tap In.",
      frozenAt: "2026-09-01T12:00:00.000Z",
      frozenBy: "tester",
    },
    "Spec body.\n",
  );
  const project = await engine.store.readProject();
  await engine.store.writeProject({ ...project.data, activeSpecId: "spec-checkin" }, project.body);
  const state = await engine.store.readState();
  await engine.store.writeState(
    { ...state.data, phase: "plan_ready", activeSpecId: "spec-checkin", lastReadiness: "PASS" },
    state.body,
  );
  return engine;
}

test("packet new files a review packet without tickets", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli([
      "packet",
      "new",
      "--project",
      dir,
      "--title",
      "Dark mode",
      "--request",
      "Users want a dark theme.",
      "--requester",
      "designer",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const out = normalize(result.stdout);
    assert.match(out, /Filed PKT-0001/);
    assert.match(out, /\.legion-cli\/packets\/PKT-0001\.md/);
    assert.match(out, /Packets spawn tickets, not execute/);
    assert.match(out, /packet respond PKT-0001/);
    const engine = createLegionEngine(dir);
    const packet = (await engine.store.readPacket("PKT-0001")).data;
    assert.equal(packet.status, "open");
    assert.equal(packet.requester, "designer");
    await assert.rejects(() => engine.store.readTask("TSK-0001"));
  });
});

test("packet respond spawns tickets and does not execute", async () => {
  await withTempDir(async (dir) => {
    await seedSpec(dir);
    const filed = runCli(["packet", "new", "--project", dir, "--title", "Dark mode"]);
    assert.equal(filed.status, 0, filed.stderr);
    const engine = createLegionEngine(dir);
    const inProgressBefore = await inProgressCount(engine.store);
    const result = runCli(["packet", "respond", "PKT-0001", "--project", dir, "--message", "Parked."]);
    assert.equal(result.status, 0, result.stderr);
    const out = normalize(result.stdout);
    assert.match(out, /Responded to PKT-0001/);
    assert.match(out, /Spawned TSK-0001 \(not execute\)/);
    assert.match(out, /Packets spawn tickets, not execute/);
    const packet = (await engine.store.readPacket("PKT-0001")).data;
    assert.equal(packet.status, "responded");
    assert.deepEqual(packet.ticketIds, ["TSK-0001"]);
    const ticket = (await engine.store.readTask("TSK-0001")).data;
    assert.equal(ticket.title, "Dark mode");
    assert.notEqual(ticket.status, "in_progress");
    assert.equal(await inProgressCount(engine.store), inProgressBefore);
    await assert.rejects(() => access(join(dir, ".legion-cli", "cache", "runs")));
    const tasks = await readdir(join(dir, ".legion-cli", "tasks"));
    assert.ok(tasks.includes("TSK-0001.md"));
  });
});

test("packet respond --json lists spawned ticket ids", async () => {
  await withTempDir(async (dir) => {
    await seedSpec(dir);
    runCli(["packet", "new", "--project", dir, "--title", "Dark mode", "--json"]);
    const result = runCli(["packet", "respond", "PKT-0001", "--project", dir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.id, "PKT-0001");
    assert.equal(body.status, "responded");
    assert.deepEqual(body.ticketIds, ["TSK-0001"]);
    assert.equal(body.next, "legion-cli next");
  });
});

test("packet without subcommand tells the user new or respond", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["packet", "--project", dir]);
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /packet requires new or respond/);
    assert.doesNotMatch(normalize(result.stderr), /too many arguments/);
  });
});

test("packet new refuses before init", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["packet", "new", "--project", dir, "--title", "Dark mode"]);
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /until init/);
  });
});
