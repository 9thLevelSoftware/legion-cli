import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { normalize, runCli, withTempDir } from "./helpers.js";

function makeTask(overrides = {}) {
  const { contract, ...rest } = overrides;
  return {
    schemaVersion: "legion-cli-task/v1",
    id: "TSK-0001",
    title: "in/out button",
    status: "ready",
    type: "feature",
    priority: "P0",
    specId: "spec-checkin",
    blockedBy: [],
    blocks: [],
    assignee: "agent",
    notes: "",
    ...rest,
    contract: {
      filesAllowed: ["src/main.ts"],
      filesForbidden: [".git/**"],
      expectedArtifacts: ["src/main.ts"],
      verificationCommands: ["pnpm test"],
      maxFilesTouched: 20,
      ...contract,
    },
  };
}

test("garden reports orphans, duplicates, and stale untrusted without deleting", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    await writeFile(join(dir, "lonely.md"), "# Lonely Orphan\n\nNobody links here.\n", "utf8");
    await writeFile(join(dir, "check-in-notes.md"), "# Check-in notes\n\nFirst copy.\n", "utf8");
    await writeFile(join(dir, "checkin-notes.md"), "# Check in notes\n\nSecond copy.\n", "utf8");
    const ingest = runCli([
      "ingest",
      "--project",
      dir,
      "--no-commit",
      "lonely.md",
      "check-in-notes.md",
      "checkin-notes.md",
    ]);
    assert.equal(ingest.status, 0, ingest.stderr);

    const result = runCli(["garden", "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    const out = normalize(result.stdout);
    assert.match(out, /report only/);
    assert.match(out, /Orphans/);
    assert.match(out, /Likely duplicates/);
    assert.match(out, /Check-in notes/);
    assert.match(out, /Stale untrusted/);
    assert.match(out, /Lonely Orphan/);
    assert.match(out, /nothing deleted/);

    await access(join(dir, ".legion-cli", "wiki", "ingested", "lonely.md"));
    await access(join(dir, ".legion-cli", "wiki", "ingested", "check-in-notes.md"));
    await access(join(dir, ".legion-cli", "wiki", "ingested", "checkin-notes.md"));
    await access(join(dir, ".legion-cli", "wiki", "index.md"));
    await access(join(dir, ".legion-cli", "wiki", "topics.yaml"));

    const json = runCli(["garden", "--project", dir, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.deleted, false);
    assert.equal(
      payload.orphans.some((page) => page.title === "Lonely Orphan"),
      false,
      "engine catalog [[wikilinks]] give ingested pages inbound links",
    );
    assert.ok(payload.staleUntrusted.some((page) => page.title === "Lonely Orphan"));
    assert.ok(payload.duplicates.length >= 1);
  });
});

test("garden refuses until init", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["garden", "--project", dir]);
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /init/);
  });
});

test("context compact rewrites done tasks and skips in_progress siblings", async () => {
  await withTempDir(async (dir) => {
    const engine = createLegionEngine(dir);
    await engine.init({ name: "Checkin", adapter: "fake" });
    await engine.store.writeTask(
      makeTask({ status: "done" }),
      "# agent log\n\nVerbose spawn output that should drop.\n",
    );
    await engine.store.writeTask(
      makeTask({
        id: "TSK-0002",
        status: "todo",
        contract: { filesAllowed: ["src/board.ts"], expectedArtifacts: ["src/board.ts"] },
      }),
      "Todo body must remain.\n",
    );
    await engine.store.writeTask(
      makeTask({
        id: "TSK-0003",
        status: "done",
        specId: "spec-other",
        contract: { filesAllowed: ["src/other.ts"], expectedArtifacts: ["src/other.ts"] },
      }),
      "Other spec done log.\n",
    );
    await engine.store.writeTask(
      makeTask({
        id: "TSK-0004",
        status: "in_progress",
        specId: "spec-other",
        contract: { filesAllowed: ["src/running.ts"], expectedArtifacts: ["src/running.ts"] },
      }),
      "Running.\n",
    );

    const result = runCli(["context", "compact", "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    const out = normalize(result.stdout);
    assert.match(out, /Compacted 1 task/);
    assert.match(out, /TSK-0001/);
    assert.match(out, /Skipped \(in_progress sibling\)/);
    assert.match(out, /TSK-0003/);
    assert.match(out, /\.legion-cli\/audit\//);

    const compacted = await engine.store.readTask("TSK-0001");
    assert.equal(compacted.data.status, "compacted");
    assert.match(compacted.body, /\.legion-cli\/audit\//);
    assert.doesNotMatch(compacted.body, /Verbose spawn output/);

    const todo = await engine.store.readTask("TSK-0002");
    assert.equal(todo.data.status, "todo");
    assert.match(todo.body, /Todo body must remain/);

    const skipped = await engine.store.readTask("TSK-0003");
    assert.equal(skipped.data.status, "done");
    assert.match(skipped.body, /Other spec done log/);
  });
});

test("unknown compact is not parsed as status", () => {
  const result = runCli(["compact"]);
  assert.equal(result.status, 1);
  assert.match(normalize(result.stderr), /unknown command 'compact'/);
  assert.doesNotMatch(normalize(result.stdout), /phase:/);
});

test("help --all lists garden and context compact", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /Shipped adjacent/);
  assert.match(out, /garden/);
  assert.match(out, /context compact/);
  assert.doesNotMatch(out, /v1 commands:/);
});

test("context compact refuses until init", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["context", "compact", "--project", dir]);
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /init/);
  });
});

test("context compact json includes skipped in_progress siblings", async () => {
  await withTempDir(async (dir) => {
    const engine = createLegionEngine(dir);
    await engine.init({ name: "Checkin", adapter: "fake" });
    await engine.store.writeTask(makeTask({ status: "done" }), "Done log.\n");
    await engine.store.writeTask(
      makeTask({
        id: "TSK-0002",
        status: "in_progress",
        contract: { filesAllowed: ["src/board.ts"], expectedArtifacts: ["src/board.ts"] },
      }),
      "Running.\n",
    );
    const result = runCli(["context", "compact", "--project", dir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.compacted, []);
    assert.equal(payload.skipped[0].id, "TSK-0001");
    assert.equal(payload.skipped[0].reason, "in_progress sibling");
    const body = await readFile(join(dir, ".legion-cli", "tasks", "TSK-0001.md"), "utf8");
    assert.match(body, /Done log/);
  });
});
