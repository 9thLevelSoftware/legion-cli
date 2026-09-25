import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  A007_FILE_COUNT,
  A007_STEP_BUDGET_MS,
  A007_TOLERANCE,
  appendAuditEvent,
  evaluateA007Gate,
  listTaskFiles,
  persistWork,
  readAuditCursor,
  readAuditDelta,
  readAuditEvents,
  readMarkdownFile,
  resetPersistWork,
  retainAuditDayFiles,
} from "../dist/index.js";
import { TaskSchema } from "@9thlevelsoftware/legion-cli-schema";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-scale-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const INVALID_TASK = `---
schemaVersion: legion-cli-task/v1
id: TSK-0099
title: broken
status: Ready
type: feature
priority: P0
specId: spec-checkin
blockedBy: []
blocks: []
contract:
  filesAllowed:
    - src/main.ts
  filesForbidden:
    - .git/**
  expectedArtifacts:
    - src/main.ts
  verificationCommands:
    - pnpm test
assignee: agent
notes: ""
---

body
`;

test("F-025 invalid markdown parses once (not a 5-attempt retry storm)", async () => {
  await withTempDir(async (dir) => {
    const abs = join(dir, ".legion-cli", "tasks", "TSK-0099.md");
    await mkdir(join(dir, ".legion-cli", "tasks"), { recursive: true });
    await writeFile(abs, INVALID_TASK, "utf8");
    resetPersistWork();
    await listTaskFiles(dir);
    assert.equal(
      persistWork.parseAttempts,
      1,
      `parse attempts per invalid file must be 1, got ${persistWork.parseAttempts}`,
    );
  });
});

test("F-025 readMarkdownFile of an invalid file is one parse attempt", async () => {
  await withTempDir(async (dir) => {
    const abs = join(dir, ".legion-cli", "tasks", "TSK-0099.md");
    await mkdir(join(dir, ".legion-cli", "tasks"), { recursive: true });
    await writeFile(abs, INVALID_TASK, "utf8");
    resetPersistWork();
    await assert.rejects(() => readMarkdownFile(abs, ".legion-cli/tasks/TSK-0099.md", TaskSchema));
    assert.equal(persistWork.parseAttempts, 1);
  });
});

test("F-067 audit tail read is incremental (bytes << file size)", async () => {
  await withTempDir(async (dir) => {
    const n = 400;
    for (let i = 0; i < n; i += 1) {
      await appendAuditEvent(dir, {
        ts: `2026-03-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        type: "execute",
        phase: "executing",
        actor: "user",
        data: { i },
      });
    }
    const jsonl = join(dir, ".legion-cli", "audit", "events.jsonl");
    const size = (await stat(jsonl)).size;
    resetPersistWork();
    const events = await readAuditEvents(dir, { cap: 20 });
    assert.equal(events.length, 20);
    assert.ok(
      persistWork.auditBytesRead < size,
      `tail read ${persistWork.auditBytesRead} should be < full size ${size}`,
    );
    assert.ok(
      persistWork.auditBytesRead < size / 2,
      `tail read ${persistWork.auditBytesRead} should be well under half of ${size}`,
    );
  });
});

test("F-067 a single event on a new day still prunes old day shards", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".legion-cli", "audit"), { recursive: true });
    const oldDay = join(dir, ".legion-cli", "audit", "2020-01-01.md");
    await writeFile(oldDay, "# 2020-01-01\n\n- old\n", "utf8");
    await appendAuditEvent(dir, {
      ts: "2026-03-15T00:00:00.000Z",
      type: "execute",
      phase: "executing",
      actor: "user",
      data: { n: 1 },
    });
    await assert.rejects(() => stat(oldDay), { code: "ENOENT" });
    assert.equal((await stat(join(dir, ".legion-cli", "audit", "2026-03-15.md"))).isFile(), true);
  });
});

test("F-067 audit delta returns only new events and retention drops old day files", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".legion-cli", "audit"), { recursive: true });
    await appendAuditEvent(dir, {
      ts: "2026-01-01T00:00:00.000Z",
      type: "execute",
      phase: "executing",
      actor: "user",
      data: { n: 1 },
    });
    const cursor = await readAuditCursor(dir);
    await appendAuditEvent(dir, {
      ts: "2026-01-01T00:00:01.000Z",
      type: "qa",
      phase: "executing",
      actor: "user",
      data: { n: 2 },
    });
    const delta = await readAuditDelta(dir, cursor);
    assert.equal(delta.unchanged, false);
    assert.equal(delta.events.length, 1);
    assert.equal(delta.events[0].type, "qa");

    const oldDay = join(dir, ".legion-cli", "audit", "2020-01-01.md");
    await writeFile(oldDay, "# 2020-01-01\n\n- old\n", "utf8");
    const keptDay = join(dir, ".legion-cli", "audit", "2026-01-01.md");
    const removed = await retainAuditDayFiles(dir, Date.parse("2026-01-20T00:00:00.000Z"));
    assert.ok(removed >= 1);
    await assert.rejects(() => stat(oldDay), { code: "ENOENT" });
    assert.equal((await stat(keptDay)).isFile(), true);
  });
});

test("F-075 A-007 gate fails on zero measurements or budget exceeded", () => {
  const zero = evaluateA007Gate([]);
  assert.equal(zero.ok, false);
  assert.match(zero.reason ?? "", /zero measurements/);

  const over = evaluateA007Gate([{ step: "status", ms: A007_STEP_BUDGET_MS * A007_TOLERANCE + 1 }]);
  assert.equal(over.ok, false);
  assert.match(over.reason ?? "", /budget exceeded/);

  const ok = evaluateA007Gate([{ step: "status", ms: 12 }]);
  assert.equal(ok.ok, true);
});

test("A-007 50k wall-clock gate", { skip: process.env.LEGION_A007_GATE !== "1" }, async () => {
  await withTempDir(async (dir) => {
    const n = A007_FILE_COUNT;
    const src = join(dir, "src");
    await mkdir(src, { recursive: true });
    const body = "export const x = 1;\n";
    const batch = 256;
    for (let i = 0; i < n; i += batch) {
      const jobs = [];
      const end = Math.min(n, i + batch);
      for (let j = i; j < end; j += 1) jobs.push(writeFile(join(src, `f${j}.ts`), body));
      await Promise.all(jobs);
    }
    const lines = [];
    for (let i = 0; i < n; i += 1) {
      lines.push(
        JSON.stringify({
          schemaVersion: "legion-cli-audit/v1",
          ts: "2026-06-01T00:00:00.000Z",
          type: "execute",
          phase: "executing",
          actor: "user",
          data: { i },
        }),
      );
    }
    await mkdir(join(dir, ".legion-cli", "audit"), { recursive: true });
    await writeFile(join(dir, ".legion-cli", "audit", "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
    resetPersistWork();
    const t0 = Date.now();
    const events = await readAuditEvents(dir, { cap: 200 });
    const auditMs = Date.now() - t0;
    assert.equal(events.length, 200);
    const measurements = [{ step: "readAuditEvents-tail", ms: auditMs, files: n }];
    const gate = evaluateA007Gate(measurements);
    assert.equal(gate.ok, true, gate.reason ?? "A-007 gate failed");
    process.stdout.write(`A007_MEASUREMENTS ${JSON.stringify(measurements)}\n`);
  });
});

