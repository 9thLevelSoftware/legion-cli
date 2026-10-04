import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLegionStore, canonicalJson, deliverySnapshotDirectory, prepareDeliverySnapshot, completeDeliverySnapshot, abortDeliverySnapshot, readDeliveryOutcome, readDeliverySnapshot, recordDeliveryOutcome, recordDeliveryExportAttempt, readDeliveryExportAttempts } from "../dist/index.js";
import { SCHEMA_VERSION } from "@9thlevelsoftware/legion-cli-schema";

const confirmationId = "confirmation opaque/id";
const approvalId = "approval opaque/id";
const token = "00000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);
const at = "2026-01-01T00:00:00.000Z";
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const notAdopted = { schemaVersion: SCHEMA_VERSION.governanceTrace, status: "not-adopted", frames: [] };

function prepared(id = confirmationId) {
  return {
    confirmationId: id,
    approvalId: null,
    captureMode: "legacy-bundle",
    preparedAt: at,
    executionFingerprint: hash,
    environmentFingerprint: hash,
    product: { scope: "git-index", subjectDigest: hash, entries: [] },
    artifacts: { artifacts: [] },
    evidence: { approvalId: null, specId: null, manifestDigest: null, executionFingerprint: hash, environmentFingerprint: hash, mode: "not-adopted", checks: [], acceptance: [], policyDigest: null, modelDigest: null, sourceScope: "whole-working-product" },
    trace: notAdopted,
    predicate: { schemaVersion: SCHEMA_VERSION.deliveryPredicate, confirmation: token, approval: null, spec: null, assuranceManifestDigest: null, subjectDigest: hash, executionDigest: hash, mode: "not-adopted", traceStatus: "not-adopted", modelDigest: null, policyDigest: null, identities: [], checks: [], acceptance: [], preparedAt: at },
    tokenMapping: [],
  };
}
function outcome(id, preparedDigest, traceEndDigest) {
  return { schemaVersion: SCHEMA_VERSION.deliveryOutcome, confirmationId: id, preparedDigest, confirmedSubjectDigest: hash, commit: { status: "not-requested" }, pullRequest: { status: "not-requested" }, recordedAt: at, ...(traceEndDigest ? { traceEndDigest } : {}) };
}
async function withStore(t) {
  const root = await mkdtemp(join(tmpdir(), "delivery-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: createLegionStore(root) };
}
async function locked(store, callback) {
  return store.withLock(() => callback({ assertLockOwned() { assert.equal(store.holdsLock(), true); } }));
}
function recordDir(root, id = confirmationId) { return join(root, ...deliverySnapshotDirectory(id).split("/")); }
function terminalOutcome(id, preparedDigest) { return outcome(id, preparedDigest); }

function adoptedFacts(id = confirmationId) {
  const modelDigest = "b".repeat(64);
  const projection = {
    schemaVersion: SCHEMA_VERSION.governanceProjection, phase: "initialized", controlMode: "guarded", tasks: [],
    approval: { id: approvalId, freshness: "current" }, claim: { owner: null, liveness: "none" }, integration: "not-run", components: [], review: "not-run", acceptance: [], sourceFingerprint: null, evidenceFingerprint: null,
    ship: { confirmationId: null, previewFingerprint: null, confirmed: false, status: "none" },
  };
  const frameDigest = (frame) => digest(`legion-cli-governance-frame-digest/v1\n${canonicalJson(frame)}`);
  const begin = { schemaVersion: SCHEMA_VERSION.governanceFrame, approvalId, sequence: 0, previousDigest: null, modelDigest, boundary: "begin", action: "task-start", correlationId: "correlation-1", before: projection, after: null, outcome: "pending", explicitRetry: false, recordedAt: at };
  const first = { ...begin, digest: frameDigest(begin) };
  const end = { schemaVersion: SCHEMA_VERSION.governanceFrame, approvalId, sequence: 1, previousDigest: first.digest, modelDigest, boundary: "end", action: "task-start", correlationId: "correlation-1", before: projection, after: projection, outcome: "success", explicitRetry: false, recordedAt: "2026-01-01T00:00:01.000Z" };
  const last = { ...end, digest: frameDigest(end) };
  const trace = { schemaVersion: SCHEMA_VERSION.governanceTrace, status: "valid", approvalId, modelDigest, headDigest: last.digest, frames: [first, last] };
  return {
    trace,
    prepared: {
      ...prepared(id), approvalId, captureMode: "adopted", trace,
      evidence: { ...prepared(id).evidence, approvalId, manifestDigest: "c".repeat(64), mode: "information-flow", modelDigest },
      predicate: { ...prepared(id).predicate, approval: "00000000-0000-4000-8000-000000000002", assuranceManifestDigest: "c".repeat(64), mode: "information-flow", traceStatus: "valid", modelDigest },
      tokenMapping: [{ token: "00000000-0000-4000-8000-000000000002", localId: approvalId, kind: "approval" }],
    },
  };
}

test("prepared snapshots persist one immutable record with a stable versioned digest", async (t) => {
  const { root, store } = await withStore(t);
  const facts = prepared();
  const expectedDigest = digest(`legion-cli/delivery-prepared/v1\0${canonicalJson(facts)}`);
  await assert.rejects(prepareDeliverySnapshot(store, facts, { assertLockOwned() {} }));
  const actualDigest = await locked(store, (lock) => prepareDeliverySnapshot(store, facts, lock));
  assert.equal(actualDigest, expectedDigest);
  assert.deepEqual(await readDeliverySnapshot(store, confirmationId), { schemaVersion: SCHEMA_VERSION.deliverySnapshot, state: "prepared", prepared: facts, preparedDigest: expectedDigest });
  assert.deepEqual((await readdir(recordDir(root))).sort(), ["prepared.json"]);
  const changed = { ...facts, preparedAt: "2026-01-02T00:00:00.000Z" };
  await assert.rejects(locked(store, (lock) => prepareDeliverySnapshot(store, changed, lock)));
});

test("immutable record publication never overwrites a competing target", async (t) => {
  const { root, store } = await withStore(t);
  const target = join(recordDir(root), "prepared.json");
  const preserved = "concurrent record\n";
  let lockChecks = 0;
  const lock = {
    assertLockOwned() {
      lockChecks += 1;
      if (lockChecks === 2) writeFileSync(target, preserved, "utf8");
    },
  };

  await assert.rejects(store.withLock(() => prepareDeliverySnapshot(store, prepared(), lock)));
  assert.equal(await readFile(target, "utf8"), preserved);
});

test("durable outcomes remain immutable while snapshot finalization is pending", async (t) => {
  const { root, store } = await withStore(t);
  const preparedDigest = await locked(store, (lock) => prepareDeliverySnapshot(store, prepared(), lock));
  const recorded = terminalOutcome(confirmationId, preparedDigest);
  assert.equal(await readDeliveryOutcome(store, confirmationId), null);

  const first = await locked(store, (lock) => recordDeliveryOutcome(store, confirmationId, recorded, lock));
  const outcomePath = join(recordDir(root), "outcome.yaml");
  const bytes = await readFile(outcomePath, "utf8");
  assert.equal(bytes, `${canonicalJson(recorded)}\n`);
  assert.deepEqual(first, recorded);
  assert.deepEqual(await readDeliveryOutcome(store, confirmationId), recorded);
  assert.equal((await readDeliverySnapshot(store, confirmationId)).state, "prepared");
  assert.deepEqual((await readdir(recordDir(root))).sort(), ["outcome.yaml", "prepared.json"]);

  await locked(store, (lock) => recordDeliveryOutcome(store, confirmationId, recorded, lock));
  assert.equal(await readFile(outcomePath, "utf8"), bytes);
  await assert.rejects(locked(store, (lock) => recordDeliveryOutcome(store, confirmationId, { ...recorded, recordedAt: "2026-01-02T00:00:00.000Z" }, lock)));
  await assert.rejects(locked(store, (lock) => completeDeliverySnapshot(store, confirmationId, { ...recorded, recordedAt: "2026-01-02T00:00:00.000Z" }, notAdopted, lock)));
  await assert.rejects(locked(store, (lock) => recordDeliveryOutcome(store, confirmationId, { ...recorded, preparedDigest: "b".repeat(64) }, lock)));
  await assert.rejects(locked(store, (lock) => recordDeliveryOutcome(store, confirmationId, { ...recorded, confirmedSubjectDigest: "b".repeat(64) }, lock)));
  await assert.rejects(locked(store, (lock) => recordDeliveryOutcome(store, `${confirmationId}-other`, recorded, lock)));
  await assert.rejects(locked(store, (lock) => abortDeliverySnapshot(store, confirmationId, at, "rollback", null, lock)));
  assert.deepEqual((await readdir(recordDir(root))).sort(), ["outcome.yaml", "prepared.json"]);
});

test("malformed outcomes and outcome-terminal mismatches are refused", async (t) => {
  const malformed = await withStore(t);
  const preparedDigest = await locked(malformed.store, (lock) => prepareDeliverySnapshot(malformed.store, prepared(), lock));
  const validOutcome = terminalOutcome(confirmationId, preparedDigest);
  const outcomePath = join(recordDir(malformed.root), "outcome.yaml");
  await writeFile(outcomePath, `${canonicalJson({ ...validOutcome, unexpected: true })}\n`);
  await assert.rejects(readDeliveryOutcome(malformed.store, confirmationId));
  await assert.rejects(readDeliverySnapshot(malformed.store, confirmationId));
  await writeFile(outcomePath, `${canonicalJson({ ...validOutcome, confirmationId: "different-confirmation" })}\n`);
  await assert.rejects(readDeliveryOutcome(malformed.store, confirmationId));

  const inconsistent = await withStore(t);
  const secondPreparedDigest = await locked(inconsistent.store, (lock) => prepareDeliverySnapshot(inconsistent.store, prepared(), lock));
  const completed = await locked(inconsistent.store, (lock) => completeDeliverySnapshot(inconsistent.store, confirmationId, terminalOutcome(confirmationId, secondPreparedDigest), notAdopted, lock));
  const changedOutcome = { ...completed.outcome, recordedAt: "2026-01-02T00:00:00.000Z" };
  const changedComplete = {
    ...completed,
    outcome: changedOutcome,
    sealedDigest: digest(canonicalJson({ preparedDigest: completed.preparedDigest, outcome: changedOutcome, completedTrace: completed.completedTrace })),
  };
  await writeFile(join(recordDir(inconsistent.root), "complete.json"), `${canonicalJson(changedComplete)}\n`);
  await assert.rejects(readDeliveryOutcome(inconsistent.store, confirmationId));
  await assert.rejects(readDeliverySnapshot(inconsistent.store, confirmationId));
});

test("legacy snapshots can complete once and bind the not-adopted trace", async (t) => {
  const { root, store } = await withStore(t);
  const preparedDigest = await locked(store, (lock) => prepareDeliverySnapshot(store, prepared(), lock));
  const completed = await locked(store, (lock) => completeDeliverySnapshot(store, confirmationId, terminalOutcome(confirmationId, preparedDigest), notAdopted, lock));
  assert.equal(completed.state, "complete");
  assert.deepEqual(completed.completedTrace, notAdopted);
  assert.deepEqual(await readDeliverySnapshot(store, confirmationId), completed);
  assert.deepEqual(await readDeliveryOutcome(store, confirmationId), completed.outcome);
  assert.equal(await readFile(join(recordDir(root), "outcome.yaml"), "utf8"), `${canonicalJson(completed.outcome)}\n`);
  assert.deepEqual((await readdir(recordDir(root))).sort(), ["complete.json", "outcome.yaml", "prepared.json"]);
  await assert.rejects(locked(store, (lock) => completeDeliverySnapshot(store, confirmationId, terminalOutcome(confirmationId, preparedDigest), notAdopted, lock)));
  await assert.rejects(locked(store, (lock) => abortDeliverySnapshot(store, confirmationId, at, "rollback", null, lock)));
});

test("aborted snapshots are a single immutable terminal record", async (t) => {
  const { root, store } = await withStore(t);
  await locked(store, (lock) => prepareDeliverySnapshot(store, prepared(), lock));
  const aborted = await locked(store, (lock) => abortDeliverySnapshot(store, confirmationId, at, "capture-failed", null, lock));
  assert.equal(aborted.state, "aborted");
  assert.deepEqual(await readDeliverySnapshot(store, confirmationId), aborted);
  assert.deepEqual((await readdir(recordDir(root))).sort(), ["aborted.json", "prepared.json"]);
  await assert.rejects(locked(store, (lock) => abortDeliverySnapshot(store, confirmationId, at, "rollback", null, lock)));
  await assert.rejects(locked(store, (lock) => completeDeliverySnapshot(store, confirmationId, terminalOutcome(confirmationId, aborted.preparedDigest), notAdopted, lock)));
});

test("tampered prepared facts and two terminal records are refused", async (t) => {
  const { root, store } = await withStore(t);
  const preparedDigest = await locked(store, (lock) => prepareDeliverySnapshot(store, prepared(), lock));
  const complete = await locked(store, (lock) => completeDeliverySnapshot(store, confirmationId, terminalOutcome(confirmationId, preparedDigest), notAdopted, lock));
  const aborted = { schemaVersion: SCHEMA_VERSION.deliverySnapshot, state: "aborted", prepared: complete.prepared, preparedDigest, abortedAt: at, reason: "rollback", survivingCommit: null };
  await writeFile(join(recordDir(root), "aborted.json"), `${canonicalJson(aborted)}\n`);
  await assert.rejects(readDeliverySnapshot(store, confirmationId));

  const other = await withStore(t);
  await locked(other.store, (lock) => prepareDeliverySnapshot(other.store, prepared(), lock));
  const target = join(recordDir(other.root), "prepared.json");
  const tampered = JSON.parse(await readFile(target, "utf8"));
  tampered.prepared.preparedAt = "2026-01-02T00:00:00.000Z";
  await writeFile(target, `${canonicalJson(tampered)}\n`);
  await assert.rejects(readDeliverySnapshot(other.store, confirmationId));
});

test("snapshot files reached through a symlink are refused", async (t) => {
  const { root, store } = await withStore(t);
  const preparedDigest = await locked(store, (lock) => prepareDeliverySnapshot(store, prepared(), lock));
  const target = join(root, "outside.json");
  await writeFile(target, `${canonicalJson({ schemaVersion: SCHEMA_VERSION.deliverySnapshot, state: "prepared", prepared: prepared(), preparedDigest })}\n`);
  const path = join(recordDir(root), "prepared.json");
  await rm(path);
  try {
    await symlink(target, path, "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Windows host does not permit unprivileged file symlinks");
      return;
    }
    throw error;
  }
  await assert.rejects(readDeliverySnapshot(store, confirmationId));
});

test("delivery outcome symlink paths are refused for reads and writes", async (t) => {
  const { root, store } = await withStore(t);
  const preparedDigest = await locked(store, (lock) => prepareDeliverySnapshot(store, prepared(), lock));
  const outcomeRecord = terminalOutcome(confirmationId, preparedDigest);
  const target = join(root, "outside-outcome.yaml");
  await writeFile(target, `${canonicalJson(outcomeRecord)}\n`);
  const path = join(recordDir(root), "outcome.yaml");
  try {
    await symlink(target, path, "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Windows host does not permit unprivileged file symlinks");
      return;
    }
    throw error;
  }
  await assert.rejects(readDeliveryOutcome(store, confirmationId));
  await assert.rejects(locked(store, (lock) => recordDeliveryOutcome(store, confirmationId, outcomeRecord, lock)));
});

test("export attempts are separate append-only records and never alter snapshots", async (t) => {
  const { root, store } = await withStore(t);
  const preparedDigest = await locked(store, (lock) => prepareDeliverySnapshot(store, prepared(), lock));
  const failed = { schemaVersion: SCHEMA_VERSION.deliveryExport, snapshotId: confirmationId, snapshotDigest: preparedDigest, requestedOutput: "bundle.tar", attemptId: "attempt-failed", attemptedAt: at, result: "failed", reason: "output unavailable" };
  const exported = { ...failed, attemptId: "attempt-exported", attemptedAt: "2026-01-01T00:00:01.000Z", result: "exported", reason: null };
  await locked(store, (lock) => recordDeliveryExportAttempt(store, failed, lock));
  await locked(store, (lock) => recordDeliveryExportAttempt(store, exported, lock));
  assert.deepEqual(await readDeliveryExportAttempts(store, confirmationId), [failed, exported]);
  await assert.rejects(locked(store, (lock) => recordDeliveryExportAttempt(store, failed, lock)));
  assert.deepEqual((await readdir(recordDir(root))).sort(), ["prepared.json"]);
  assert.equal((await readDeliverySnapshot(store, confirmationId)).state, "prepared");
  assert.notEqual(deliverySnapshotDirectory(confirmationId).split("/").at(-1), confirmationId);
});

test("adopted completion requires the frozen valid trace and current head", async (t) => {
  const { store } = await withStore(t);
  const facts = adoptedFacts();
  const preparedDigest = await locked(store, (lock) => prepareDeliverySnapshot(store, facts.prepared, lock));
  const stale = { ...facts.trace, headDigest: "d".repeat(64) };
  await assert.rejects(locked(store, (lock) => completeDeliverySnapshot(store, confirmationId, outcome(confirmationId, preparedDigest, stale.headDigest), stale, lock)));
  const completedOutcome = outcome(confirmationId, preparedDigest, facts.trace.headDigest);
  await locked(store, (lock) => recordDeliveryOutcome(store, confirmationId, completedOutcome, lock));
  assert.deepEqual(await readDeliveryOutcome(store, confirmationId), completedOutcome);
  assert.equal((await readDeliverySnapshot(store, confirmationId)).state, "prepared");
  const completed = await locked(store, (lock) => completeDeliverySnapshot(store, confirmationId, completedOutcome, facts.trace, lock));
  assert.equal(completed.state, "complete");
});
