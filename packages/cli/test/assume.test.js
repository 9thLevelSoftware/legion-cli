import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { WIKI_INDEX_STORE_PATH } from "@9thlevelsoftware/legion-cli-wiki";

import { normalize, runCli, withTempDir } from "./helpers.js";

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

test("assume list/answer and index rebuild are off Layer 1", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.doesNotMatch(out, /assume list/);
  assert.doesNotMatch(out, /assume answer/);
  assert.doesNotMatch(out, /index rebuild/);
});

test("assume list prints open questions; answer confirms and rebuilds catalog", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const engine = createLegionEngine(dir);
    await engine.store.writeAssumption(makeAssumption(), "Need office wifi\n");
    await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
    const ingest = runCli(["ingest", "--project", dir, "--no-commit", "notes.md"]);
    assert.equal(ingest.status, 0, ingest.stderr);

    const listed = runCli(["assume", "list", "--project", dir]);
    assert.equal(listed.status, 0, listed.stderr);
    const listOut = normalize(listed.stdout);
    assert.match(listOut, /ASM-0001/);
    assert.match(listOut, /open/);
    assert.match(listOut, /blocking/);
    assert.match(listOut, /Need office wifi/);

    const jsonList = runCli(["assume", "list", "--project", dir, "--json"]);
    assert.equal(jsonList.status, 0, jsonList.stderr);
    const payload = JSON.parse(jsonList.stdout);
    assert.equal(payload.assumptions[0].id, "ASM-0001");
    assert.equal(payload.assumptions[0].status, "open");

    await writeFile(join(dir, ".legion-cli", "wiki", "index.md"), "spawn overwrote this\n", "utf8");
    const answered = runCli(["assume", "answer", "ASM-0001", "--project", dir, "--status", "confirmed"]);
    assert.equal(answered.status, 0, answered.stderr);
    assert.match(normalize(answered.stdout), /Confirmed ASM-0001/);
    assert.equal((await engine.store.readAssumption("ASM-0001")).data.status, "confirmed");
    const index = await engine.store.readWikiPage(WIKI_INDEX_STORE_PATH);
    assert.equal(index.data.title, "Wiki index");
    assert.match(index.body, /Catalog of compiled pages/);
  });
});

test("assume answer --status rejected writes rejected", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const engine = createLegionEngine(dir);
    await engine.store.writeAssumption(makeAssumption(), "Need office wifi\n");
    const result = runCli(["assume", "answer", "ASM-0001", "--project", dir, "--status", "rejected", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.id, "ASM-0001");
    assert.equal(payload.status, "rejected");
  });
});

test("index rebuild restores the engine catalog", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
    const ingest = runCli(["ingest", "--project", dir, "--no-commit", "notes.md"]);
    assert.equal(ingest.status, 0, ingest.stderr);
    await writeFile(join(dir, ".legion-cli", "wiki", "index.md"), "spawn overwrote this\n", "utf8");

    const result = runCli(["index", "rebuild", "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(normalize(result.stdout), /Rebuilt search index/);

    const engine = createLegionEngine(dir);
    const index = await engine.store.readWikiPage(WIKI_INDEX_STORE_PATH);
    assert.equal(index.data.title, "Wiki index");
    assert.equal(index.data.trust, "reviewed");
    assert.match(index.body, /\[\[ingested\/notes\]\]/);

    const json = runCli(["index", "rebuild", "--project", dir, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).ok, true);
  });
});
