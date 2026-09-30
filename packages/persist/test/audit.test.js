import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AuditTamperError,
  appendAuditEvent,
  createLegionStore,
  persistWork,
  resetPersistWork,
  verifyAuditChain,
} from "../dist/index.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-audit-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const paths = (dir) => ({
  jsonl: join(dir, ".legion-cli", "audit", "events.jsonl"),
  chain: join(dir, ".legion-cli", "audit", "chain.json"),
});

function ev(i) {
  return {
    ts: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    type: "note",
    phase: "uninitialized",
    actor: "user",
    data: { i },
  };
}

async function appendMany(dir, n, from = 0) {
  for (let i = from; i < from + n; i++) await appendAuditEvent(dir, ev(i));
}

test("routine append hashes and reads a constant amount regardless of log length", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 5);
    resetPersistWork();
    await appendAuditEvent(dir, ev(100));
    const small = { lines: persistWork.auditLinesHashed, bytes: persistWork.auditBytesRead };
    await appendMany(dir, 200, 200);
    resetPersistWork();
    await appendAuditEvent(dir, ev(101));
    assert.equal(persistWork.auditLinesHashed, small.lines, "lines hashed must not grow with the log");
    assert.ok(persistWork.auditLinesHashed <= 2, `hashed ${persistWork.auditLinesHashed}`);
    assert.ok(persistWork.auditBytesRead <= small.bytes + 8, `bytes read grew: ${persistWork.auditBytesRead}`);
    const full = await verifyAuditChain(dir);
    assert.equal(full.length, 207);
  });
});

test("a kill between the event line and the chain write is healed, not tamper", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 3);
    const p = paths(dir);
    // Crash after appendFile, before chain.json: an extra whole line.
    await appendFile(p.jsonl, `${JSON.stringify(ev(50))}\n`, "utf8");
    await assert.doesNotReject(() => verifyAuditChain(dir, { allowExtend: true }));
    await appendAuditEvent(dir, ev(51));
    // Torn write: a partial line with no newline.
    await appendFile(p.jsonl, '{"schemaVersion":"legion-cli-audit/v1","ts"', "utf8");
    await appendAuditEvent(dir, ev(52));
    const state = await verifyAuditChain(dir); // strict full replay must pass now
    assert.equal(state.length, 7);
  });
});

test("a middle-line edit is caught by the full replay", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 6);
    const p = paths(dir);
    const lines = (await readFile(p.jsonl, "utf8")).split("\n");
    lines[2] = lines[2].replace('"i":2', '"i":9');
    await writeFile(p.jsonl, lines.join("\n"), "utf8");
    await assert.rejects(() => verifyAuditChain(dir, { allowExtend: true }), AuditTamperError);
    await assert.rejects(() => verifyAuditChain(dir), AuditTamperError);
  });
});

test("a truncated log (rewind) is tamper on the routine path", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 4);
    const p = paths(dir);
    const text = await readFile(p.jsonl, "utf8");
    await truncate(p.jsonl, Buffer.byteLength(text) - 20);
    await assert.rejects(() => appendAuditEvent(dir, ev(9)), AuditTamperError);
  });
});

test("an old-format chain.json (no byteOffset) triggers one full verify and is rewritten", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 5);
    const p = paths(dir);
    const cur = JSON.parse(await readFile(p.chain, "utf8"));
    await writeFile(p.chain, `${JSON.stringify({ lastDigest: cur.lastDigest, length: cur.length })}\n`, "utf8");
    resetPersistWork();
    await appendAuditEvent(dir, ev(70));
    assert.ok(persistWork.auditLinesHashed >= 5, "old format is fully verified once");
    const upgraded = JSON.parse(await readFile(p.chain, "utf8"));
    assert.equal(upgraded.length, 6);
    assert.equal(typeof upgraded.byteOffset, "number");
    resetPersistWork();
    await appendAuditEvent(dir, ev(71));
    assert.ok(persistWork.auditLinesHashed <= 2, "then routine appends are tail-only");
  });
});

test("an old-format chain over an edited log is still tamper on upgrade", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 5);
    const p = paths(dir);
    const cur = JSON.parse(await readFile(p.chain, "utf8"));
    await writeFile(p.chain, `${JSON.stringify({ lastDigest: cur.lastDigest, length: cur.length })}\n`, "utf8");
    const lines = (await readFile(p.jsonl, "utf8")).split("\n");
    lines[1] = lines[1].replace('"i":1', '"i":8');
    await writeFile(p.jsonl, lines.join("\n"), "utf8");
    await assert.rejects(() => appendAuditEvent(dir, ev(72)), AuditTamperError);
  });
});

test("a chain.json from a newer format is fully verified, never called tamper", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 4);
    const p = paths(dir);
    const cur = JSON.parse(await readFile(p.chain, "utf8"));
    await writeFile(p.chain, `${JSON.stringify({ ...cur, format: 99, byteOffset: 1, extra: "future" })}\n`, "utf8");
    resetPersistWork();
    await assert.doesNotReject(() => appendAuditEvent(dir, ev(80)));
    assert.ok(persistWork.auditLinesHashed >= 4, "unknown format falls back to a full verify");
    assert.equal((await verifyAuditChain(dir)).length, 5);
  });
});

test("an append refused by the lock is dropped with a stderr line, never written unlocked", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 2);
    const store = createLegionStore(dir);
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let entered;
    const inside = new Promise((r) => {
      entered = r;
    });
    const holder = store.withLock(async () => {
      entered();
      await gate;
    });
    await inside;
    const seen = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      seen.push(String(chunk));
      return true;
    };
    try {
      await appendAuditEvent(dir, ev(90));
    } finally {
      process.stderr.write = realWrite;
      release();
      await holder;
    }
    assert.ok(seen.some((s) => s.includes("audit event dropped")), `stderr: ${seen.join("|")}`);
    const lines = (await readFile(paths(dir).jsonl, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2, "event must not be written without the lock");
    assert.equal((await verifyAuditChain(dir)).length, 2);
  });
});
