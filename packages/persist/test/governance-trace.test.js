import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendGovernanceBegin,
  appendGovernanceEnd,
  appendGovernanceEpoch,
  canonicalJson,
  createLegionStore,
  GovernanceEpochError,
  governanceTraceDirectory,
  inspectGovernanceTrace,
  readGovernanceEpochs,
  readGovernanceTrace,
  reconcileGovernanceTrace,
} from "../dist/index.js";

const approvalId = "approval opaque/id";
const modelDigest = "a".repeat(64);
const lock = { assertLockOwned() {} };
const projection = {
  schemaVersion: "legion-cli-governance-projection/v1",
  phase: "initialized",
  controlMode: "guarded",
  tasks: [],
  approval: { id: approvalId, freshness: "current" },
  claim: { owner: null, liveness: "none" },
  integration: "not-run",
  components: [],
  review: "not-run",
  acceptance: [],
  sourceFingerprint: null,
  evidenceFingerprint: null,
  ship: { confirmationId: null, previewFingerprint: null, confirmed: false, status: "none" },
};

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-governance-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function begin(store, id = approvalId) {
  return appendGovernanceBegin(store, { approvalId: id, modelDigest, correlationId: "corr-1", action: "task-start", before: projection, recordedAt: "2026-01-01T00:00:00.000Z" }, lock);
}
async function end(store, id = approvalId) {
  return appendGovernanceEnd(store, { approvalId: id, modelDigest, correlationId: "corr-1", action: "task-start", after: projection, outcome: "success", recordedAt: "2026-01-01T00:00:01.000Z" }, lock);
}
function segmentPath(root, id = approvalId) { return join(root, ...governanceTraceDirectory(id).split("/")); }

test("writes and reads a schema-backed begin/end chain in order", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await begin(store);
    assert.equal((await readGovernanceTrace(store, approvalId, modelDigest)).status, "incomplete");
    await end(store);
    const trace = await readGovernanceTrace(store, approvalId, modelDigest);
    assert.equal(trace.status, "valid");
    assert.deepEqual(trace.frames.map((f) => f.boundary), ["begin", "end"]);
    assert.equal(Object.isFrozen(trace), true);
    assert.equal(Object.isFrozen(trace.frames[0]), true);
  });
});

test("digest tampering and sequence gaps fail closed", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await begin(store); await end(store);
    const dir = segmentPath(root);
    const file = join(dir, "0.json");
    const frame = JSON.parse(await readFile(file, "utf8"));
    frame.action = "undo";
    await writeFile(file, JSON.stringify(frame));
    assert.equal((await readGovernanceTrace(store, approvalId, modelDigest)).status, "invalid");
  });
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await begin(store);
    const dir = segmentPath(root);
    await rm(join(dir, "0.json"));
    await writeFile(join(dir, "1.json"), "{}");
    assert.equal((await readGovernanceTrace(store, approvalId, modelDigest)).status, "invalid");
  });
});

test("reconciles exactly one valid orphan frame beyond a stale head", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await begin(store);
    const dir = segmentPath(root);
    const staleHead = await readFile(join(dir, "head.json"), "utf8");
    await end(store);
    await writeFile(join(dir, "head.json"), staleHead);
    assert.equal((await readGovernanceTrace(store, approvalId, modelDigest)).status, "invalid");
    const reconciled = await reconcileGovernanceTrace(store, approvalId, modelDigest, lock);
    assert.equal(reconciled.status, "valid");
    assert.equal(reconciled.frames.length, 2);
  });
});

test("reconciles a complete persisted trace and rejects an unexpected orphan", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await begin(store);
    await end(store);
    const dir = segmentPath(root);
    const complete = await reconcileGovernanceTrace(store, approvalId, modelDigest, lock);
    assert.equal(complete.status, "valid");
    assert.equal(complete.frames.length, 2);
    const head = JSON.parse(await readFile(join(dir, "head.json"), "utf8"));
    await writeFile(join(dir, "2.json"), JSON.stringify({ ...head, sequence: 2 }));
    assert.equal((await reconcileGovernanceTrace(store, approvalId, modelDigest, lock)).status, "invalid");
  });
});

test("head-ahead, missing frame, and unexpected extra orphans are invalid", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await begin(store);
    const dir = segmentPath(root);
    const head = JSON.parse(await readFile(join(dir, "head.json"), "utf8"));
    head.sequence = 9;
    await writeFile(join(dir, "head.json"), JSON.stringify(head));
    assert.equal((await readGovernanceTrace(store, approvalId, modelDigest)).status, "invalid");
  });
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await begin(store);
    await rm(join(segmentPath(root), "0.json"));
    assert.equal((await readGovernanceTrace(store, approvalId, modelDigest)).status, "invalid");
  });
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await begin(store);
    const dir = segmentPath(root);
    const head = JSON.parse(await readFile(join(dir, "head.json"), "utf8"));
    await writeFile(join(dir, "2.json"), JSON.stringify({ ...head, sequence: 2 }));
    assert.equal((await readGovernanceTrace(store, approvalId, modelDigest)).status, "invalid");
    assert.equal((await reconcileGovernanceTrace(store, approvalId, modelDigest, lock)).status, "invalid");
  });
});

test("multiple persisted frames beyond the stale head are not reconciled", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await begin(store);
    const dir = segmentPath(root);
    await writeFile(join(dir, "1.json"), "{}");
    await writeFile(join(dir, "2.json"), "{}");
    assert.equal((await reconcileGovernanceTrace(store, approvalId, modelDigest, lock)).status, "invalid");
  });
});

test("an interrupted begin remains incomplete and IDs only determine hashed directory names", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await begin(store);
    const trace = await readGovernanceTrace(store, approvalId, modelDigest);
    assert.equal(trace.status, "incomplete");
    assert.equal(trace.frames.length, 1);
    const expected = createHash("sha256").update(approvalId).digest("hex");
    assert.equal(governanceTraceDirectory(approvalId), `.legion-cli/audit/governance/${expected}`);
    assert.equal((await readdir(join(root, ".legion-cli", "audit", "governance")))[0], expected);
    assert.equal((await readFile(join(segmentPath(root), "0.json"), "utf8")).includes(approvalId), true);
  });
});

test("a new approval epoch uses its own segment and preserves the old incomplete history", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await begin(store, "epoch-one");
    await begin(store, "epoch-two");
    assert.equal((await readGovernanceTrace(store, "epoch-one", modelDigest)).status, "incomplete");
    assert.equal((await readGovernanceTrace(store, "epoch-two", modelDigest)).status, "incomplete");
    assert.notEqual(governanceTraceDirectory("epoch-one"), governanceTraceDirectory("epoch-two"));
    assert.equal((await readdir(join(root, ".legion-cli", "audit", "governance"))).length, 2);
  });
});

const previewA = "c".repeat(64);
const previewB = "d".repeat(64);
const task = (id, status, writes = [`src/${id}.ts`]) => ({ id, status, owner: null, writes, checks: "not-run" });
const state = (patch) => ({ ...structuredClone(projection), ...structuredClone(patch) });
let correlation = 0;
/** One real begin/end boundary through the persist writer. */
async function step(store, action, before, after, opts = {}) {
  const correlationId = `step-${++correlation}`;
  await appendGovernanceBegin(store, { approvalId, modelDigest, correlationId, action, before, recordedAt: "2026-01-01T00:00:00.000Z", explicitRetry: opts.explicitRetry }, lock);
  return appendGovernanceEnd(store, { approvalId, modelDigest, correlationId, action, after, outcome: opts.outcome ?? "success", recordedAt: "2026-01-01T00:00:01.000Z", explicitRetry: opts.explicitRetry }, lock);
}
async function inspect(store) { return inspectGovernanceTrace(store, approvalId, modelDigest); }

// A realistic adopted lifecycle: refusal without effect, an explicit retry, a confirmed ship.
const planned = state({ phase: "plan_ready", tasks: [task("T1", "ready"), task("T2", "ready")], acceptance: [{ id: "AC-1", status: "not-recorded", freshness: "unknown" }] });
const started = state({ ...planned, phase: "executing", tasks: [task("T1", "in_progress"), task("T2", "in_progress")] });
const verifying = state({ ...started, tasks: [task("T1", "verifying"), task("T2", "verifying")] });
const completed = state({ ...started, tasks: [task("T1", "done"), task("T2", "done")] });
const integrating = state({ ...completed, integration: "running" });
const integrationFailed = state({ ...completed, integration: "failed" });
const integrated = state({ ...completed, integration: "passed" });
const reviewing = state({ ...integrated, review: "running" });
const reviewed = state({ ...integrated, review: "passed" });
const accepted = state({ ...reviewed, acceptance: [{ id: "AC-1", status: "passed", freshness: "current" }] });
const prepared = state({ ...accepted, ship: { confirmationId: "confirm-1", previewFingerprint: previewA, confirmed: false, status: "prepared" } });
const shipped = state({ ...prepared, phase: "shipped", ship: { confirmationId: "confirm-1", previewFingerprint: previewA, confirmed: true, status: "complete" } });

async function writeValidLifecycle(store) {
  await step(store, "approval-adopt", planned, planned);
  await step(store, "amend-inputs", planned, planned, { outcome: "refused" });
  await step(store, "task-start", planned, started);
  await step(store, "task-verify", started, verifying);
  await step(store, "task-complete", verifying, completed);
  await step(store, "integration-start", completed, integrating);
  await step(store, "integration-complete", integrating, integrationFailed);
  await step(store, "integration-start", integrationFailed, integrating, { explicitRetry: true });
  await step(store, "integration-complete", integrating, integrated);
  await step(store, "review-start", integrated, reviewing);
  await step(store, "review-complete", reviewing, reviewed);
  await step(store, "acceptance-record", reviewed, accepted);
  await step(store, "ship-prepare", accepted, prepared);
  await step(store, "ship-confirm", prepared, shipped);
  await step(store, "ship-complete", shipped, shipped);
}

test("a lawful adopted lifecycle with a no-effect refusal and an explicit retry has zero violations", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await writeValidLifecycle(store);
    const { trace, violations } = await inspect(store);
    assert.deepEqual(violations, []);
    assert.equal(trace.status, "valid");
    assert.equal(trace.frames.length, 30);
    assert.equal(trace.frames[3].outcome, "refused");
    assert.deepEqual(trace.frames.filter((f) => f.explicitRetry).map((f) => [f.sequence, f.boundary]), [[14, "begin"], [15, "end"]]);
    assert.equal((await readGovernanceTrace(store, approvalId, modelDigest)).status, "valid");
    assert.equal(Object.isFrozen(violations), true);
  });
});

const semanticCorruptions = [
  ["advisory-execution", async (store) => {
    const active = state({ phase: "executing", tasks: [task("T1", "in_progress")] });
    await step(store, "recover", active, { ...active, controlMode: "advisory" });
  }],
  ["advisory-execution", async (store) => {
    const advisory = state({ phase: "executing", controlMode: "advisory", tasks: [task("T1", "ready")] });
    await step(store, "task-start", advisory, { ...advisory, controlMode: "guarded", tasks: [task("T1", "in_progress")] });
  }],
  ["duplicate-claim", async (store) => {
    const claimed = state({ claim: { owner: "worker-1", liveness: "live" } });
    await step(store, "claim-acquire", claimed, { ...claimed, claim: { owner: "worker-2", liveness: "live" } });
  }],
  ["overlapping-active-writes", async (store) => {
    const before = state({ phase: "executing", tasks: [task("T0", "in_progress", ["src/model"]), task("T2", "ready", ["src/model/child.ts"])] });
    await step(store, "task-start", before, { ...before, tasks: [task("T0", "in_progress", ["src/model"]), task("T2", "in_progress", ["src/model/child.ts"])] });
  }],
  ["completion-without-checks", async (store) => {
    const ready = state({ phase: "ready_to_ship", integration: "not-run", review: "passed" });
    await step(store, "ship-complete", ready, { ...ready, phase: "shipped", ship: { ...ready.ship, status: "complete" } });
  }],
  ["stale-authority-use", async (store) => {
    const stale = state({ ...reviewed, approval: { id: approvalId, freshness: "stale" } });
    await step(store, "acceptance-record", stale, { ...stale, acceptance: [{ id: "AC-1", status: "passed", freshness: "current" }] });
  }],
  ["implicit-retry", async (store) => {
    await step(store, "integration-start", integrationFailed, integrating);
  }],
  ["preview-mismatch", async (store) => {
    await step(store, "ship-prepare", accepted, prepared);
    await step(store, "ship-confirm", prepared, { ...prepared, ship: { confirmationId: "confirm-1", previewFingerprint: previewB, confirmed: true, status: "prepared" } });
  }],
  ["rollback-claims-delivery", async (store) => {
    await step(store, "ship-rollback", prepared, { ...prepared, ship: { ...prepared.ship, status: "complete" } });
  }],
  ["illegal-phase-transition", async (store) => {
    await step(store, "amend-inputs", projection, { ...projection, phase: "executing" });
  }],
  ["illegal-task-transition", async (store) => {
    const blocked = state({ phase: "executing", tasks: [task("T1", "blocked")] });
    await step(store, "unblock", blocked, { ...blocked, tasks: [task("T1", "done")] });
  }],
  ["refused-changed-state", async (store) => {
    const before = state({ phase: "plan_ready", tasks: [task("T1", "ready")] });
    await step(store, "amend-inputs", before, { ...before, tasks: [task("T1", "ready", ["src/other.ts"])] }, { outcome: "refused" });
  }],
];

for (const [code, corrupt] of semanticCorruptions) {
  test(`a writer-produced chain with ${code} is invalid with exactly that code`, async () => {
    await withTempDir(async (root) => {
      const store = createLegionStore(root);
      await step(store, "approval-adopt", projection, projection);
      await corrupt(store);
      const { trace, violations } = await inspect(store);
      assert.equal(trace.status, "invalid");
      assert.ok(violations.length > 0);
      assert.deepEqual([...new Set(violations.map((v) => v.code))], [code]);
      assert.equal(violations.every((v) => v.sequence === trace.frames.length - 1 && typeof v.detail === "string" && v.detail.length > 0), true);
      assert.equal((await readGovernanceTrace(store, approvalId, modelDigest)).status, "invalid");
      assert.equal((await reconcileGovernanceTrace(store, approvalId, modelDigest, lock)).status, "invalid");
      await assert.rejects(appendGovernanceBegin(store, { approvalId, modelDigest, correlationId: "after-violation", action: "task-start", before: projection, recordedAt: "2026-01-01T00:00:02.000Z" }, lock), /not a valid appendable segment/);
    });
  });
}

test("task completion that skips verification is a completion violation", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await step(store, "task-complete", started, { ...started, tasks: [task("T1", "done"), task("T2", "in_progress")] });
    const { trace, violations } = await inspect(store);
    assert.equal(trace.status, "invalid");
    assert.deepEqual(violations.map((v) => v.code).sort(), ["completion-without-checks", "illegal-task-transition"]);
  });
});

test("task-start may start an eligible todo task through ready; no other action may skip ready", async () => {
  const todo = state({ ...planned, tasks: [task("T1", "todo"), task("T2", "ready")] });
  const running = state({ ...todo, phase: "executing", tasks: [task("T1", "in_progress"), task("T2", "ready")] });
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await step(store, "task-start", todo, running);
    const { trace, violations } = await inspect(store);
    assert.deepEqual(violations, []);
    assert.equal(trace.status, "valid");
  });
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await step(store, "unblock", todo, running);
    assert.deepEqual((await inspect(store)).violations.map((v) => v.code), ["illegal-task-transition"]);
  });
});

test("ship-confirm or ship-complete without a prepared preview is a preview mismatch once the trace prepares ships", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await step(store, "ship-confirm", prepared, { ...prepared, ship: { ...prepared.ship, confirmed: true } });
    assert.deepEqual((await inspect(store)).violations.map((v) => v.code), ["preview-mismatch"]);
  });
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await step(store, "ship-complete", shipped, shipped);
    assert.deepEqual((await inspect(store)).violations, [], "legacy unconfirmed ship-complete without any ship-prepare is exempt");
  });
});

test("a reconciled orphan end frame that violates the model stays invalid and the stale head is not advanced", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await step(store, "approval-adopt", projection, projection);
    await appendGovernanceBegin(store, { approvalId, modelDigest, correlationId: "orphan", action: "integration-start", before: integrationFailed, recordedAt: "2026-01-01T00:00:00.000Z" }, lock);
    const dir = segmentPath(root);
    const staleHead = await readFile(join(dir, "head.json"), "utf8");
    await appendGovernanceEnd(store, { approvalId, modelDigest, correlationId: "orphan", action: "integration-start", after: integrating, outcome: "success", recordedAt: "2026-01-01T00:00:01.000Z" }, lock);
    await writeFile(join(dir, "head.json"), staleHead);
    assert.equal((await reconcileGovernanceTrace(store, approvalId, modelDigest, lock)).status, "invalid");
    assert.equal(await readFile(join(dir, "head.json"), "utf8"), staleHead);
  });
});

test("fault seams run after the durable frame and after the durable head, in order", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    const dir = segmentPath(root);
    const seen = [];
    const faults = {
      afterFrame: async () => { seen.push(["frame", (await readdir(dir)).sort()]); },
      afterHead: async () => { seen.push(["head", JSON.parse(await readFile(join(dir, "head.json"), "utf8")).sequence]); },
    };
    await appendGovernanceBegin(store, { approvalId, modelDigest, correlationId: "seam", action: "task-start", before: projection, recordedAt: "2026-01-01T00:00:00.000Z" }, lock, faults);
    await appendGovernanceEnd(store, { approvalId, modelDigest, correlationId: "seam", action: "task-start", after: projection, outcome: "success", recordedAt: "2026-01-01T00:00:01.000Z" }, lock, faults);
    assert.deepEqual(seen, [["frame", ["0.json"]], ["head", 0], ["frame", ["0.json", "1.json", "head.json"]], ["head", 1]]);
  });
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    await appendGovernanceBegin(store, { approvalId, modelDigest, correlationId: "crash", action: "task-start", before: projection, recordedAt: "2026-01-01T00:00:00.000Z" }, lock);
    const crash = new Error("simulated crash after end frame");
    await assert.rejects(appendGovernanceEnd(store, { approvalId, modelDigest, correlationId: "crash", action: "task-start", after: projection, outcome: "success", recordedAt: "2026-01-01T00:00:01.000Z" }, lock, { afterFrame: async () => { throw crash; } }), (err) => err === crash);
    assert.equal((await readGovernanceTrace(store, approvalId, modelDigest)).status, "invalid");
    assert.equal((await reconcileGovernanceTrace(store, approvalId, modelDigest, lock)).status, "valid");
  });
});

const epochPath = (root) => join(root, ".legion-cli", "audit", "governance", "epochs.json");
const epochDigest = (entry) => createHash("sha256").update(`legion-cli-governance-epoch/v1\n${canonicalJson(entry)}`, "utf8").digest("hex");

test("governance epochs are absent until recorded, then digest-chained per the anchor formula", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    assert.equal(await readGovernanceEpochs(store), null);
    const first = await appendGovernanceEpoch(store, { approvalId: "epoch-one", adopted: true, recordedAt: "2026-01-01T00:00:00.000Z" }, lock);
    await appendGovernanceEpoch(store, { approvalId: "epoch-two", adopted: true, recordedAt: "2026-01-01T00:00:01.000Z" }, lock);
    await appendGovernanceEpoch(store, { approvalId: null, adopted: false, recordedAt: "2026-01-01T00:00:02.000Z" }, lock);
    const anchor = await readGovernanceEpochs(store);
    assert.equal(anchor.schemaVersion, "legion-cli-governance-epochs/v1");
    assert.deepEqual(anchor.epochs.map((e) => [e.sequence, e.approvalId, e.adopted]), [[0, "epoch-one", true], [1, "epoch-two", true], [2, null, false]]);
    assert.deepEqual(anchor.epochs[0], first);
    anchor.epochs.forEach((entry, i) => {
      const { digest, ...unsigned } = entry;
      assert.equal(entry.previousDigest, i ? anchor.epochs[i - 1].digest : null);
      assert.equal(digest, epochDigest(unsigned));
    });
    assert.equal(Object.isFrozen(anchor.epochs[0]), true);
    assert.equal(await readFile(epochPath(root), "utf8"), `${canonicalJson(anchor)}\n`);
  });
});

test("malformed governance epoch anchors throw GovernanceEpochError and are never extended", async () => {
  const tamperings = [
    (doc) => { doc.epochs[1].digest = "e".repeat(64); },
    (doc) => { doc.epochs[1].previousDigest = "e".repeat(64); },
    (doc) => { doc.epochs[1].sequence = 2; },
    (doc) => { doc.epochs[0].adopted = false; },
    (doc) => { doc.epochs.reverse(); },
    (doc) => { doc.epochs[0].extra = true; },
    (doc) => { doc.epochs = []; },
  ];
  for (const tamper of tamperings) {
    await withTempDir(async (root) => {
      const store = createLegionStore(root);
      await appendGovernanceEpoch(store, { approvalId: "epoch-one", adopted: true, recordedAt: "2026-01-01T00:00:00.000Z" }, lock);
      await appendGovernanceEpoch(store, { approvalId: "epoch-two", adopted: true, recordedAt: "2026-01-01T00:00:01.000Z" }, lock);
      const doc = JSON.parse(await readFile(epochPath(root), "utf8"));
      tamper(doc);
      const bytes = JSON.stringify(doc);
      await writeFile(epochPath(root), bytes);
      await assert.rejects(readGovernanceEpochs(store), GovernanceEpochError);
      await assert.rejects(appendGovernanceEpoch(store, { approvalId: "epoch-three", adopted: true, recordedAt: "2026-01-01T00:00:02.000Z" }, lock), GovernanceEpochError);
      assert.equal(await readFile(epochPath(root), "utf8"), bytes);
    });
  }
  for (const bytes of ["", "{", '{"schemaVersion":"legion-cli-governance-epochs/v1","schemaVersion":"x","epochs":[]}']) {
    await withTempDir(async (root) => {
      const store = createLegionStore(root);
      await mkdir(join(root, ".legion-cli", "audit", "governance"), { recursive: true });
      await writeFile(epochPath(root), bytes);
      await assert.rejects(readGovernanceEpochs(store), GovernanceEpochError);
    });
  }
});

test("appending a governance epoch requires lock ownership before any write", async () => {
  await withTempDir(async (root) => {
    const store = createLegionStore(root);
    const unowned = { assertLockOwned() { throw new Error("Engine lock is not owned"); } };
    await assert.rejects(appendGovernanceEpoch(store, { approvalId: "epoch-one", adopted: true, recordedAt: "2026-01-01T00:00:00.000Z" }, unowned), /Engine lock is not owned/);
    assert.equal(await readGovernanceEpochs(store), null);
    await assert.rejects(appendGovernanceEpoch(store, { approvalId: "epoch-one", adopted: true, recordedAt: "not a timestamp" }, lock), TypeError);
    assert.equal(await readGovernanceEpochs(store), null);
  });
});
