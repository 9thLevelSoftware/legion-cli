import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, exportDeliveryBundle } from "../dist/index.js";
import { SCHEMA_VERSION } from "@9thlevelsoftware/legion-cli-schema";

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const digest = "a".repeat(64);
const at = "2026-01-01T00:00:00.000Z";
const confirmationId = "confirmation-1";

function completeSnapshot() {
  const approvalId = "approval-1";
  const modelDigest = "b".repeat(64);
  const projection = (confirmed, status, phase = "ready_to_ship") => ({
    schemaVersion: SCHEMA_VERSION.governanceProjection,
    phase,
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
    ship: { confirmationId: confirmed ? confirmationId : null, previewFingerprint: confirmed ? digest : null, confirmed, status },
  });
  const initial = projection(false, "none");
  const preparedShip = projection(false, "prepared");
  const confirmedShip = projection(true, "prepared");
  const completeShip = projection(true, "complete", "shipped");
  const frames = [];
  const appendAction = (action, before, after, correlationId) => {
    const begin = { schemaVersion: SCHEMA_VERSION.governanceFrame, approvalId, sequence: frames.length, previousDigest: frames.at(-1)?.digest ?? null, modelDigest, boundary: "begin", action, correlationId, before, after: null, outcome: "pending", explicitRetry: false, recordedAt: at };
    frames.push({ ...begin, digest: hash(`legion-cli-governance-frame-digest/v1\n${canonicalJson(begin)}`) });
    const end = { schemaVersion: SCHEMA_VERSION.governanceFrame, approvalId, sequence: frames.length, previousDigest: frames.at(-1).digest, modelDigest, boundary: "end", action, correlationId, before, after, outcome: "success", explicitRetry: false, recordedAt: at };
    frames.push({ ...end, digest: hash(`legion-cli-governance-frame-digest/v1\n${canonicalJson(end)}`) });
  };
  appendAction("ship-prepare", initial, preparedShip, "ship-prepare-correlation");
  appendAction("ship-confirm", preparedShip, confirmedShip, "ship-confirm-correlation");
  const preparedTrace = { schemaVersion: SCHEMA_VERSION.governanceTrace, status: "valid", approvalId, modelDigest, headDigest: frames.at(-1).digest, frames: [...frames] };
  appendAction("ship-complete", confirmedShip, completeShip, "ship-complete-correlation");
  const completedTrace = { ...preparedTrace, headDigest: frames.at(-1).digest, frames };
  const prepared = {
    confirmationId,
    approvalId,
    captureMode: "adopted",
    preparedAt: at,
    executionFingerprint: digest,
    environmentFingerprint: digest,
    product: { scope: "git-index", subjectDigest: digest, entries: [] },
    artifacts: { artifacts: [] },
    evidence: { approvalId, specId: null, manifestDigest: "c".repeat(64), executionFingerprint: digest, environmentFingerprint: digest, mode: "information-flow", checks: [], acceptance: [], policyDigest: null, modelDigest, sourceScope: "whole-working-product" },
    trace: preparedTrace,
    predicate: { schemaVersion: SCHEMA_VERSION.deliveryPredicate, confirmation: "00000000-0000-4000-8000-000000000001", approval: "00000000-0000-4000-8000-000000000002", spec: null, assuranceManifestDigest: "c".repeat(64), subjectDigest: digest, executionDigest: digest, mode: "information-flow", traceStatus: "valid", modelDigest, policyDigest: null, identities: [], checks: [], acceptance: [], preparedAt: at },
    tokenMapping: [{ token: "00000000-0000-4000-8000-000000000001", localId: confirmationId, kind: "confirmation" }, { token: "00000000-0000-4000-8000-000000000002", localId: approvalId, kind: "approval" }],
  };
  const preparedDigest = hash(`legion-cli/delivery-prepared/v1\0${canonicalJson(prepared)}`);
  const outcome = { schemaVersion: SCHEMA_VERSION.deliveryOutcome, confirmationId, preparedDigest, confirmedSubjectDigest: digest, commit: { status: "not-requested" }, pullRequest: { status: "not-requested" }, recordedAt: at, traceEndDigest: completedTrace.headDigest };
  const sealedDigest = hash(canonicalJson({ preparedDigest, outcome, completedTrace }));
  return { schemaVersion: SCHEMA_VERSION.deliverySnapshot, state: "complete", prepared, preparedDigest, outcome, completedTrace, sealedDigest };
}

function legacySnapshot() {
  const snapshot = completeSnapshot();
  const trace = { schemaVersion: SCHEMA_VERSION.governanceTrace, status: "not-adopted", frames: [] };
  const prepared = {
    ...snapshot.prepared,
    approvalId: null,
    captureMode: "legacy-bundle",
    evidence: {
      ...snapshot.prepared.evidence,
      approvalId: null,
      manifestDigest: null,
      mode: "not-adopted",
      policyDigest: null,
      modelDigest: null,
    },
    trace,
    predicate: {
      ...snapshot.prepared.predicate,
      approval: null,
      assuranceManifestDigest: null,
      mode: "not-adopted",
      traceStatus: "not-adopted",
      modelDigest: null,
      policyDigest: null,
    },
    tokenMapping: [snapshot.prepared.tokenMapping[0]],
  };
  const preparedDigest = hash(`legion-cli/delivery-prepared/v1\0${canonicalJson(prepared)}`);
  const outcome = { ...snapshot.outcome, preparedDigest };
  delete outcome.traceEndDigest;
  const sealedDigest = hash(canonicalJson({ preparedDigest, outcome, completedTrace: trace }));
  return { ...snapshot, prepared, preparedDigest, outcome, completedTrace: trace, sealedDigest };
}

test("exports a complete legacy snapshot with its valid not-adopted empty trace", async (t) => {
  const root = await temporaryDirectory(t);
  const destination = join(root, "bundle");
  const snapshot = legacySnapshot();
  await exportDeliveryBundle(snapshot, destination);
  assert.deepEqual(JSON.parse(await readFile(join(destination, "trace.json"), "utf8")), snapshot.completedTrace);
});

async function temporaryDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "delivery-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("exports exactly the canonical immutable snapshot bundle members", async (t) => {
  const root = await temporaryDirectory(t);
  const destination = join(root, "bundle");
  const snapshot = completeSnapshot();
  const result = await exportDeliveryBundle(snapshot, destination);
  assert.deepEqual((await readdir(destination)).sort(), ["artifacts.json", "evidence.json", "manifest.json", "predicate.json", "product.json", "trace.json"]);
  for (const name of ["artifacts.json", "evidence.json", "predicate.json", "product.json", "trace.json", "manifest.json"]) {
    const bytes = await readFile(join(destination, name));
    const text = bytes.toString("utf8");
    assert.equal(text, canonicalJson(JSON.parse(text)));
  }
  const manifestBytes = await readFile(join(destination, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.snapshotDigest, snapshot.sealedDigest);
  assert.equal(manifest.createdAt, snapshot.outcome.recordedAt);
  assert.deepEqual(manifest.members.map((member) => member.path), ["artifacts.json", "evidence.json", "predicate.json", "product.json", "trace.json"]);
  assert.deepEqual(JSON.parse(await readFile(join(destination, "trace.json"), "utf8")), snapshot.completedTrace);
  for (const member of manifest.members) {
    const bytes = await readFile(join(destination, member.path));
    assert.equal(member.sha256, hash(bytes.toString("utf8")));
    assert.equal(member.size, bytes.length);
  }
  assert.deepEqual(result, {
    manifestSha256: hash(manifestBytes.toString("utf8")),
    snapshotDigest: snapshot.sealedDigest,
    predicateSha256: hash((await readFile(join(destination, "predicate.json"))).toString("utf8")),
  });
});

test("refuses incomplete and inconsistent snapshots without creating a destination", async (t) => {
  const root = await temporaryDirectory(t);
  const destination = join(root, "bundle");
  const snapshot = completeSnapshot();
  await assert.rejects(exportDeliveryBundle({ ...snapshot, state: "prepared" }, destination));
  await assert.rejects(exportDeliveryBundle({ ...snapshot, sealedDigest: "f".repeat(64) }, destination));
  await assert.rejects(exportDeliveryBundle({ ...snapshot, prepared: { ...snapshot.prepared, confirmationId: "changed" } }, destination));
  const onlyConfirmed = snapshot.prepared.trace;
  const outcome = { ...snapshot.outcome, traceEndDigest: onlyConfirmed.headDigest };
  const missingShipComplete = { ...snapshot, outcome, completedTrace: onlyConfirmed };
  missingShipComplete.sealedDigest = hash(canonicalJson({ preparedDigest: snapshot.preparedDigest, outcome, completedTrace: onlyConfirmed }));
  await assert.rejects(exportDeliveryBundle(missingShipComplete, destination));
  const unrelatedShipComplete = {
    ...snapshot.completedTrace,
    frames: snapshot.completedTrace.frames.map((frame) =>
      frame.action === "ship-complete" && frame.boundary === "end"
        ? { ...frame, after: { ...frame.after, ship: { ...frame.after.ship, confirmationId: "another-confirmation" } } }
        : frame,
    ),
  };
  const unrelatedSnapshot = { ...snapshot, completedTrace: unrelatedShipComplete };
  unrelatedSnapshot.sealedDigest = hash(canonicalJson({ preparedDigest: snapshot.preparedDigest, outcome: snapshot.outcome, completedTrace: unrelatedShipComplete }));
  await assert.rejects(exportDeliveryBundle(unrelatedSnapshot, destination));
  await assert.rejects(readFile(destination));
});

test("refuses an existing destination and preserves its contents", async (t) => {
  const root = await temporaryDirectory(t);
  const destination = join(root, "bundle");
  await mkdir(destination);
  await writeFile(join(destination, "sentinel"), "keep");
  await assert.rejects(exportDeliveryBundle(completeSnapshot(), destination), /already exists/);
  assert.equal(await readFile(join(destination, "sentinel"), "utf8"), "keep");
});

test("concurrent exporters cannot replace a destination reserved by the other", async (t) => {
  const root = await temporaryDirectory(t);
  const destination = join(root, "bundle");
  const results = await Promise.allSettled([
    exportDeliveryBundle(completeSnapshot(), destination),
    exportDeliveryBundle(completeSnapshot(), destination),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.deepEqual((await readdir(destination)).sort(), ["artifacts.json", "evidence.json", "manifest.json", "predicate.json", "product.json", "trace.json"]);
  assert.deepEqual(await readdir(root), ["bundle"]);
});
