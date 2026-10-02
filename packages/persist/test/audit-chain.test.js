import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AuditTamperError,
  appendAuditEvent,
  assertAuditChainUsable,
  healAuditChain,
  legionPaths,
  openEngineCommand,
  persistWork,
  readAuditEvents,
  rebaselineAuditChain,
  resetPersistWork,
  restoreEngineState,
  verifyAuditChain,
} from "../dist/index.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-chain-"));
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

const REMEDY = /rebaseline-audit/;

async function editMiddleLine(dir) {
  const lines = (await readFile(paths(dir).jsonl, "utf8")).split(/\r?\n/);
  lines[1] = lines[1].replace(/"i":\d+/, '"i":999');
  await writeFile(paths(dir).jsonl, lines.join("\n"), "utf8");
}

test("a corrupt, empty or wrongly shaped chain.json is a tamper error with the remedy, never a raw SyntaxError", async () => {
  for (const bad of ["{not json", "", "{}", '{"lastDigest":1,"length":"x"}']) {
    await withTempDir(async (dir) => {
      await appendMany(dir, 3);
      await writeFile(paths(dir).chain, bad, "utf8");
      for (const op of [
        () => appendAuditEvent(dir, ev(9)),
        () => verifyAuditChain(dir, { allowExtend: true }),
        () => healAuditChain(dir),
        () => assertAuditChainUsable(dir),
      ]) {
        await assert.rejects(
          op,
          (err) => err instanceof AuditTamperError && /chain\.json/.test(err.message) && REMEDY.test(err.message),
        );
      }
    });
  }
});

test("deleting or resetting chain.json does not launder an edited middle line", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 5);
    await editMiddleLine(dir);
    await rm(paths(dir).chain);
    for (const op of [
      () => verifyAuditChain(dir, { allowExtend: true }),
      () => healAuditChain(dir),
      () => appendAuditEvent(dir, ev(9)),
      () => assertAuditChainUsable(dir),
    ]) {
      await assert.rejects(op, (err) => err instanceof AuditTamperError && REMEDY.test(err.message));
    }
    await writeFile(paths(dir).chain, `${JSON.stringify({ lastDigest: "0".repeat(64), length: 0 })}\n`, "utf8");
    await assert.rejects(() => verifyAuditChain(dir, { allowExtend: true }), AuditTamperError);
  });
});

test("a brand-new project and a first-event crash (one line, no chain) are still fine", async () => {
  await withTempDir(async (dir) => {
    await assert.doesNotReject(() => verifyAuditChain(dir, { allowExtend: true }));
    await appendMany(dir, 1);
    await rm(paths(dir).chain);
    await assert.doesNotReject(() => healAuditChain(dir));
    assert.equal((await verifyAuditChain(dir)).length, 1);
  });
});

test("rebaselineAuditChain re-chains the log, records audit_rebaselined, and unblocks appends", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 5);
    await editMiddleLine(dir);
    await rm(paths(dir).chain);
    const result = await rebaselineAuditChain(dir, { phase: "uninitialized", ts: "2026-02-01T00:00:00.000Z" });
    assert.equal(result.lines, 5);
    assert.equal(result.previous, null);
    await appendAuditEvent(dir, ev(50));
    const marker = (await readAuditEvents(dir)).find((e) => e.type === "audit_rebaselined");
    assert.ok(marker, "rebaseline is recorded in the log");
    assert.equal(marker.data.lines, 5);
    assert.equal((await verifyAuditChain(dir)).length, 7);
  });
});

test("rebaseline replaces a corrupt chain.json", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 3);
    await writeFile(paths(dir).chain, "{oops", "utf8");
    const result = await rebaselineAuditChain(dir, { phase: "uninitialized", ts: "2026-02-01T00:00:00.000Z" });
    assert.equal(result.lines, 3);
    await assert.doesNotReject(() => verifyAuditChain(dir));
  });
});

test("an append between the chain read and the log read is not a false rewind", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 3);
    const state = await verifyAuditChain(dir, {
      allowExtend: true,
      afterChainRead: async () => {
        await appendAuditEvent(dir, ev(77)); // a locked append landing mid-verify
      },
    });
    assert.equal(state.length, 4);
    assert.equal((await verifyAuditChain(dir)).length, 4);
  });
});

test("an explicit format:1 chain with a byteOffset is not trusted: full verify, rewritten as format 2", async () => {
  await withTempDir(async (dir) => {
    await appendMany(dir, 4);
    const cur = JSON.parse(await readFile(paths(dir).chain, "utf8"));
    await writeFile(paths(dir).chain, `${JSON.stringify({ ...cur, format: 1, byteOffset: 3 })}\n`, "utf8");
    resetPersistWork();
    await appendAuditEvent(dir, ev(60));
    assert.ok(persistWork.auditLinesHashed >= 4);
    const after = JSON.parse(await readFile(paths(dir).chain, "utf8"));
    assert.equal(after.format, 2);
    assert.equal(after.length, 5);
  });
});

test("restoreEngineState heals a crash gap in the audit chain instead of calling it tamper", async () => {
  await withTempDir(async (dir) => {
    const tasks = legionPaths(dir).tasksDir;
    await mkdir(tasks, { recursive: true });
    await writeFile(join(tasks, "TSK-0001.md"), "ready\n", "utf8");
    await appendMany(dir, 2);
    await openEngineCommand(dir, "cmd-gap");
    await appendFile(paths(dir).jsonl, `${JSON.stringify(ev(40))}\n`, "utf8"); // line without chain write
    await assert.rejects(() => verifyAuditChain(dir), AuditTamperError);
    await assert.doesNotReject(() => restoreEngineState(dir, "cmd-gap", { agentAlive: false, jailWritable: false }));
    assert.equal((await verifyAuditChain(dir)).length, 3, "chain.json was rewritten to cover the line");
  });
});
