import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { WORKFLOW_STAGE_FIELDS } from "@9thlevelsoftware/legion-cli-schema";
import { findSkillsDir, LegionEngine } from "../dist/index.js";
import { readWorkflowPreparation, writeWorkflowPreparation, preparationInputFingerprint, projectChallengeAcceptanceReferences } from "../dist/workflow-preparation.js";
import { workflowFingerprint } from "../dist/workflow.js";
import { initProject, makeSpec, patchState, withEngine, withFakeAdapter, writeSpec } from "./helpers.js";

const skillsDir = findSkillsDir();
const manualReview = { measurableSuccess: "Show a preserved check-in response after a retry.", failureHandling: "Preserve the pending action when the request fails.", compatibilityAndScope: "Keep the existing authentication interface compatible.", acknowledgement: "I acknowledge" };
const hash = (text) => createHash("sha256").update(text).digest("hex");
const artifact = (name, value) => ({ path: `.legion-cli/cache/runs/<id>/${name}.json`, content: JSON.stringify(value) });

async function seed(engine, store, dir) {
  await initProject(engine, { workflowProfile: "focused" });
  const spec = makeSpec({ workflowPolicyVersion: 2 });
  await writeSpec(store, spec);
  await patchState(store, { phase: "spec_draft", activeSpecId: spec.id });
  const source = "export const checkin = 'existing';\n";
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/main.ts"), source);
  const inputs = [{ path: "src/main.ts", digest: hash(source) }];
  const specArtifacts = [];
  for (const stage of ["context", "requirements"]) {
    const path = `.legion-cli/specs/${spec.id}/preparation/${stage}.md`;
    const body = `# ${stage}\n\nReviewed the existing bounded repair.\n`;
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), body);
    specArtifacts.push({ stage, path, digest: hash(body), inputs: stage === "context" ? inputs : [], fields: Object.fromEntries(WORKFLOW_STAGE_FIELDS[stage].map((field) => [field, field === "acceptanceIds" ? spec.acceptance.map((criterion) => criterion.id).join(", ") : "Preserve the existing bounded behavior and its interface."])) });
  }
  const record = { schemaVersion: "legion-cli-workflow-preparation/v1", assessment: { schemaVersion: "legion-cli-workflow-assessment/v1", policyVersion: 2, specId: spec.id, inputFingerprint: preparationInputFingerprint(inputs), unresolvedDecisions: [], stageDecisions: Object.keys(WORKFLOW_STAGE_FIELDS).map((stage) => ({ stage, decision: ["context", "requirements"].includes(stage) ? "required" : "not_applicable", rationale: "Existing bounded repair preserves this area.", evidenceRefs: ["assumption: bounded repair preserves this area"] })) }, specArtifacts, planArtifacts: [], acceptanceMappings: [] };
  await store.withLock(() => writeWorkflowPreparation(store, record));
  return { spec, record };
}

async function runs(dir) { return (await readdir(join(dir, ".legion-cli/cache/runs"))).sort(); }
async function assertProjectionOnly(store, dir, spec, before) {
  const after = await readWorkflowPreparation(store, spec.id);
  const originalIndex = before.specArtifacts.find((item) => item.stage === "requirements").fields.acceptanceIds;
  const undo = { ...after, specArtifacts: after.specArtifacts.map((item) => item.stage === "requirements" ? { ...item, fields: { ...item.fields, acceptanceIds: originalIndex } } : item) };
  assert.deepEqual(undo, before, "projection changes only the acceptance reference index");
  const draft = await store.readSpec(spec.id);
  const ids = after.specArtifacts.find((item) => item.stage === "requirements").fields.acceptanceIds.split(/[\s,;]+/);
  assert.deepEqual(ids, draft.data.acceptance.map((criterion) => criterion.id));
  for (const item of after.specArtifacts) assert.equal(hash(await readFile(join(dir, item.path), "utf8")), item.digest);
  assert.deepEqual(after.acceptanceMappings, before.acceptanceMappings, "new criteria receive no guessed plan mapping");
  return after;
}

test("manual challenge extends only requirements references and remains current for approval", async () => {
  await withFakeAdapter(async () => withEngine(async ({ engine, store, dir }) => {
    const { spec, record } = await seed(engine, store, dir);
    const prepared = await engine.prepareSpecChallenge(spec.id);
    assert.equal(prepared.status, "manual_required");
    const completed = await engine.finalizeSpecChallenge(spec.id, { manualReview });
    assert.equal(completed.status, "complete");
    const projected = await assertProjectionOnly(store, dir, spec, record);
    assert.equal(completed.receipt.application.preparation.baseFingerprint, workflowFingerprint(record));
    assert.equal(completed.receipt.application.preparation.expectedFingerprint, workflowFingerprint(projected));
    assert.equal(completed.receipt.contextFingerprint, prepared.receipt.contextFingerprint);
    const beforeRuns = await runs(dir);
    assert.equal((await engine.prepareSpecChallenge(spec.id)).status, "complete");
    assert.deepEqual(await runs(dir), beforeRuns, "index projection never starts another challenge");
    await engine.approveSpec(spec.id, { id: "owner" });
    assert.equal((await store.readSpec(spec.id)).data.status, "frozen");
  }, { skillsDir }));
});

test("automated acceptance synthesis projects its exact applied criterion once", async () => {
  const outputs = [artifact("analysis", { schemaVersion: "legion-cli-spec-challenge-analysis/v1", concerns: [{ question: "How is retry success observed?", why: "Retry success needs an observable contract.", evidence: [{ kind: "assumption", claim: "Retry observation is unspecified." }] }] })];
  await withFakeAdapter(async () => withEngine(async ({ engine, store, dir }) => {
    const { spec, record } = await seed(engine, store, dir);
    await engine.prepareSpecChallenge(spec.id);
    const response = "Show the preserved check-in response when retry succeeds.";
    await engine.recordSpecChallengeResolution(spec.id, "C-01", { disposition: "answered", response });
    outputs.splice(0, outputs.length, artifact("synthesis", { schemaVersion: "legion-cli-spec-challenge-synthesis/v1", changes: [{ section: "acceptance", statement: response, rationale: "Records the owner's exact success observation.", concernIds: ["C-01"], kind: "behavior", priority: "P1" }] }));
    const completed = await engine.finalizeSpecChallenge(spec.id);
    assert.equal(completed.status, "complete");
    assert.equal(completed.changes[0].appliedId, "AC-CH-01");
    await assertProjectionOnly(store, dir, spec, record);
    const beforeRuns = await runs(dir);
    assert.equal((await engine.finalizeSpecChallenge(spec.id)).status, "complete");
    assert.deepEqual(await runs(dir), beforeRuns);
    assert.equal((await store.readSpec(spec.id)).data.acceptance.filter((item) => item.id === "AC-CH-01").length, 1);
  }, { skillsDir, fakeArtifacts: outputs }));
});

for (const recoveryState of ["base", "expected"]) {
  test(`preparation entry recovers interrupted challenge with exact ${recoveryState} sidecar without generation`, async () => {
    await withFakeAdapter(async () => withEngine(async ({ engine, store, dir }) => {
      const { spec, record } = await seed(engine, store, dir);
      await engine.prepareSpecChallenge(spec.id);
      const crashing = new LegionEngine(dir, undefined, { skillsDir, fakeAfterChallengeDraftWrite: async () => { throw new Error("fault after draft write"); } });
      await assert.rejects(() => crashing.finalizeSpecChallenge(spec.id, { manualReview }), /fault after draft write/);
      const pending = (await crashing.readSpecChallenge(spec.id)).receipt;
      assert.ok(pending.application.preparation);
      assert.equal(workflowFingerprint(await readWorkflowPreparation(store, spec.id)), pending.application.preparation.baseFingerprint);
      if (recoveryState === "expected") {
        const projected = projectChallengeAcceptanceReferences(record, pending.application.baseSpec, pending.application.spec, pending.application.changes);
        await store.withLock(() => writeWorkflowPreparation(store, projected));
      }
      const beforeRuns = await runs(dir);
      const restarted = new LegionEngine(dir, undefined, { skillsDir });
      assert.equal((await restarted.prepareWorkflowSpecification(spec.id)).blockers.length, 0);
      assert.equal((await restarted.readSpecChallenge(spec.id)).status, "complete");
      assert.deepEqual(await runs(dir), beforeRuns, "recovery cannot launch preparation or challenge adapters");
      await assertProjectionOnly(store, dir, spec, record);
      assert.equal((await store.readSpec(spec.id)).data.acceptance.filter((item) => item.id === "AC-CH-01").length, 1);
      await restarted.approveSpec(spec.id, { id: "owner" });
    }, { skillsDir }));
  });
}

test("pending challenge refuses unrelated sidecar edits and preserves the checkpoint", async () => {
  await withFakeAdapter(async () => withEngine(async ({ engine, store, dir }) => {
    const { spec, record } = await seed(engine, store, dir);
    await engine.prepareSpecChallenge(spec.id);
    const crashing = new LegionEngine(dir, undefined, { skillsDir, fakeAfterChallengeDraftWrite: async () => { throw new Error("fault after draft write"); } });
    await assert.rejects(() => crashing.finalizeSpecChallenge(spec.id, { manualReview }), /fault after draft write/);
    const pending = await crashing.readSpecChallenge(spec.id);
    const changed = { ...record, specArtifacts: record.specArtifacts.map((item) => item.stage === "context" ? { ...item, fields: { ...item.fields, constraints: "Unrelated changed constraints." } } : item) };
    await store.withLock(() => writeWorkflowPreparation(store, changed));
    const beforeRuns = await runs(dir);
    const restarted = new LegionEngine(dir, undefined, { skillsDir });
    await assert.rejects(() => restarted.prepareWorkflowSpecification(spec.id), /preparation changed after.*checkpoint/i);
    assert.deepEqual(await readWorkflowPreparation(store, spec.id), changed);
    assert.deepEqual((await restarted.readSpecChallenge(spec.id)).receipt, pending.receipt);
    assert.deepEqual(await runs(dir), beforeRuns);
  }, { skillsDir }));
});

for (const stale of ["artifact", "source", "unknown reference"]) {
  test(`challenge refuses ${stale} before checkpoint or specification write`, async () => {
    await withFakeAdapter(async () => withEngine(async ({ engine, store, dir }) => {
      const { spec, record } = await seed(engine, store, dir);
      await engine.prepareSpecChallenge(spec.id);
      const beforeSpec = await store.readSpec(spec.id);
      if (stale === "unknown reference") {
        const invalid = { ...record, specArtifacts: record.specArtifacts.map((item) => item.stage === "requirements" ? { ...item, fields: { ...item.fields, acceptanceIds: `${item.fields.acceptanceIds} AC-ARBITRARY` } } : item) };
        await store.withLock(() => writeWorkflowPreparation(store, invalid));
      } else {
        const path = stale === "artifact" ? record.specArtifacts[1].path : "src/main.ts";
        await writeFile(join(dir, path), "Unrelated changed bytes.\n");
      }
      await assert.rejects(() => engine.finalizeSpecChallenge(spec.id, { manualReview }), stale === "unknown reference" ? /Unknown requirements acceptance reference AC-ARBITRARY/ : /stale/i);
      assert.deepEqual(await store.readSpec(spec.id), beforeSpec);
      assert.equal((await engine.readSpecChallenge(spec.id)).receipt.application, null);
    }, { skillsDir }));
  });
}
