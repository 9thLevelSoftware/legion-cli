import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatMarkdownDocument } from "@9thlevelsoftware/legion-cli-persist";
import { WORKFLOW_STAGE_FIELDS } from "@9thlevelsoftware/legion-cli-schema";
import { writeWorkflowPreparation, preparationInputFingerprint } from "../dist/workflow-preparation.js";
import { isAllowedPath } from "../dist/contracts.js";
import { workflowFingerprint, WORKFLOW_APPROVAL_PATH, WORKFLOW_SPEC_APPROVAL_PATH } from "../dist/workflow.js";
import { withEngine, withFakeAdapter, initProject, makeSpec, makeTask, writeSpec, writeTask, patchState, passingVerificationCommand } from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
const review = { path: ".legion-cli/cache/runs/<id>/review.md", content: "# Review\n\nVerdict: PASS\n" };
const analysis = { path: ".legion-cli/cache/runs/<id>/analysis.json", content: JSON.stringify({ schemaVersion: "legion-cli-spec-challenge-analysis/v1", concerns: [] }) };

async function seedPreparation(store, dir, spec, methods = [{ id: "manual-check", kind: "manual", procedure: "Inspect the observable check-in response.", expectedObservation: "The requested check-in response appears." }], persist = true) {
  const source = "export const checkin = 'existing behavior';\n";
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/main.ts"), source);
  const inputs = [{ path: "src/main.ts", digest: createHash("sha256").update(source).digest("hex") }];
  const artifacts = [];
  for (const stage of ["context", "requirements"]) {
    const path = `.legion-cli/specs/${spec.id}/preparation/${stage}.md`;
    const body = `# ${stage}\n\nReviewed ${stage} for the bounded repair.\n`;
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), body);
    artifacts.push({ stage, path, digest: createHash("sha256").update(body).digest("hex"), inputs: stage === "context" ? inputs : [], fields: Object.fromEntries(WORKFLOW_STAGE_FIELDS[stage].map((field) => [field, field === "acceptanceIds" ? "AC-01" : "Bounded check-in repair; no unresolved changes."])) });
  }
  const record = {
    schemaVersion: "legion-cli-workflow-preparation/v1",
    assessment: { schemaVersion: "legion-cli-workflow-assessment/v1", policyVersion: 2, specId: spec.id, inputFingerprint: preparationInputFingerprint(inputs), unresolvedDecisions: [],
      stageDecisions: Object.keys(WORKFLOW_STAGE_FIELDS).map((stage) => ({ stage, decision: ["context", "requirements"].includes(stage) ? "required" : "not_applicable", rationale: "Bounded existing behavior repair with no change to this area.", evidenceRefs: ["assumption: bounded repair preserves this area"] })) },
    specArtifacts: artifacts, planArtifacts: [], acceptanceMappings: [{ criterionId: "AC-01", taskIds: ["TSK-0001"], methods }],
  };
  if (persist) await store.withLock(() => writeWorkflowPreparation(store, record));
  return record;
}

async function seedPolicy2(engine, store, dir, methods) {
  await initProject(engine, { workflowProfile: "focused" });
  const spec = makeSpec({ workflowPolicyVersion: 2, acceptance: [{ id: "AC-01", statement: "The repaired response is observable.", kind: "behavior", priority: "P1" }] });
  await writeSpec(store, spec);
  await patchState(store, { phase: "spec_draft", activeSpecId: spec.id });
  await seedPreparation(store, dir, spec, methods);
  await engine.prepareSpecChallenge(spec.id);
  await engine.approveSpec(spec.id, { id: "owner" });
  const task = makeTask({ priority: "P1", status: "done", contract: { verificationCommands: [passingVerificationCommand()] } });
  await writeTask(store, task);
  await mkdir(join(dir, ".legion-cli", "plans"), { recursive: true });
  await writeFile(join(dir, ".legion-cli", "plans", `${spec.id}.md`), "# Plan\n\nRepair the approved response.\n");
  await patchState(store, { phase: "plan_ready", lastReadiness: "PASS" });
  return { spec, task };
}

test("policy-2 spec refuses missing preparation without freezing or approving", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine, { workflowProfile: "focused" });
    const spec = makeSpec({ workflowPolicyVersion: 2 });
    await writeSpec(store, spec);
    await patchState(store, { phase: "spec_draft", activeSpecId: spec.id });
    await assert.rejects(() => engine.approveSpec(spec.id, { id: "owner" }), /preparation/i);
    assert.equal((await store.readSpec(spec.id)).data.status, "draft");
    assert.equal(await store.pathExists(WORKFLOW_SPEC_APPROVAL_PATH), false);
  });
});

test("policy-2 P1 scope binds preparation and requires current manual observation", async () => {
  await withFakeAdapter(async () => withEngine(async ({ engine, store, dir }) => {
    const { spec } = await seedPolicy2(engine, store, dir);
    const readyTask = await store.readTask("TSK-0001");
    await store.writeTask({ ...readyTask.data, status: "ready" }, readyTask.body);
    const approval = await engine.approvePlan({ id: "owner" });
    assert.equal(approval.preparationFingerprint.length, 64);
    assert.equal((await engine.readWorkflowPreparation()).blockers.length, 0);
    await mkdir(join(dir, "evidence"), { recursive: true });
    await writeFile(join(dir, "evidence", "observation.md"), "Observed the repaired check-in response under the approved procedure.\n");
    const execution = await engine.executeWorkflow();
    assert.equal(execution.status, "blocked", JSON.stringify(execution));
    assert.match(execution.blocker, /acceptance evidence pending: AC-01/);
    await assert.rejects(() => engine.recordAcceptance([{ id: "AC-01", status: "passed" }]), /observed|note/i);
    await assert.rejects(() => engine.recordAcceptance([{ id: "AC-01", status: "passed", note: "The check-in response appeared." }]), /evidence/i);
    const accepted = await engine.recordAcceptance([{ id: "AC-01", status: "passed", note: "The check-in response appeared.", evidenceRef: "evidence/observation.md" }]);
    assert.equal(accepted.entries[0].methodId, "manual-check");
    assert.equal(accepted.entries[0].evidenceDigest.length, 64);
    assert.equal((await engine.getWorkflowStatus()).stage, "ship");
    const frozen = await store.readSpec(spec.id);
    const artifact = join(dir, `.legion-cli/specs/${spec.id}/preparation/context.md`);
    await writeFile(artifact, `${await readFile(artifact, "utf8")}Changed context.\n`);
    assert.equal((await engine.getWorkflowStatus()).planApproval, "stale");
    await assert.rejects(() => engine.executeWorkflow(), /preparation|stale/i);
    assert.equal((await store.readSpec(spec.id)).data.status, frozen.data.status);
  }, { skillsDir, fakeArtifacts: [analysis, review] }));
});

test("missing policy-2 sidecar cannot downgrade approved scope and reads stay read-only", async () => {
  await withFakeAdapter(async () => withEngine(async ({ engine, store, dir }) => {
    const { spec } = await seedPolicy2(engine, store, dir);
    await engine.approvePlan();
    const receipt = await readFile(join(dir, WORKFLOW_APPROVAL_PATH), "utf8");
    await rm(join(dir, `.legion-cli/workflow/${spec.id}/preparation.yaml`));
    const status = await engine.getWorkflowStatus();
    assert.equal(status.planApproval, "stale");
    assert.match(status.blocker, /preparation/i);
    assert.equal(await readFile(join(dir, WORKFLOW_APPROVAL_PATH), "utf8"), receipt);
    assert.equal(await store.pathExists(`.legion-cli/workflow/${spec.id}/preparation.yaml`), false);
    await assert.rejects(() => engine.executeWorkflow(), /preparation/i);
  }, { skillsDir, fakeArtifacts: [analysis] }));
});

test("policy-2 reapproval preserves legitimate source baseline and refuses removed marker", async () => {
  await withFakeAdapter(async () => withEngine(async ({ engine, store, dir }) => {
    const { spec } = await seedPolicy2(engine, store, dir);
    const initial = await engine.approvePlan();
    await patchState(store, { phase: "executing" });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/main.ts"), "export const repaired = true;\n");
    const taskDoc = await store.readTask("TSK-0001");
    await store.writeTask({ ...taskDoc.data, contract: { ...taskDoc.data.contract, maxFilesTouched: 21 } }, taskDoc.body);
    const renewed = await engine.approvePlan();
    assert.notEqual(renewed.approvalId, initial.approvalId);
    assert.equal(renewed.preparationFingerprint, initial.preparationFingerprint);
    const frozen = await store.readSpec(spec.id);
    const { workflowPolicyVersion, ...downgraded } = frozen.data;
    await store.writeSpec({ ...downgraded, acceptance: downgraded.acceptance.map((criterion) => ({ ...criterion, priority: "P0" })) }, frozen.body);
    const legacyReadyTask = await store.readTask("TSK-0001");
    await store.writeTask({ ...legacyReadyTask.data, priority: "P0" }, legacyReadyTask.body);
    await assert.rejects(() => engine.approvePlan(), /policy marker.*removed/i);
    assert.equal((await engine.getWorkflowStatus()).planApproval, "stale");
  }, { skillsDir, fakeArtifacts: [analysis] }));
});

test("malformed canonical decisions cannot silently approve a policy-2 plan", async () => {
  await withFakeAdapter(async () => withEngine(async ({ engine, store, dir }) => {
    await seedPolicy2(engine, store, dir);
    await writeFile(join(dir, ".legion-cli/discuss/DISCUSS.md"), "---\nnot: [valid\n---\n");
    const preparation = await engine.readWorkflowPreparation();
    assert.match(preparation.blockers[0].message, /decisions.*read/i);
    await assert.rejects(() => engine.approvePlan(), /decisions.*read/i);
    assert.equal(await store.pathExists(WORKFLOW_APPROVAL_PATH), false);
  }, { skillsDir, fakeArtifacts: [analysis] }));
});

test("successful bounded generation promotes spec then plan without changing specification preparation", async () => {
  const generated = [];
  await withFakeAdapter(async () => withEngine(async ({ engine, store, dir }) => {
    await initProject(engine, { workflowProfile: "focused" });
    const spec = makeSpec({ workflowPolicyVersion: 2, acceptance: [{ id: "AC-01", statement: "The repaired behavior is visible.", kind: "behavior", priority: "P1" }] });
    await writeSpec(store, spec);
    await patchState(store, { phase: "spec_draft", activeSpecId: spec.id });
    const completeRecord = await seedPreparation(store, dir, spec, undefined, false);
    const specRecord = { ...completeRecord, acceptanceMappings: [] };
    generated.push({ path: ".legion-cli/cache/runs/<id>/preparation.json", content: JSON.stringify(specRecord) });
    for (const artifact of specRecord.specArtifacts) generated.push({ path: artifact.path, content: await readFile(join(dir, artifact.path), "utf8") });
    const prepared = await engine.prepareWorkflowSpecification(spec.id);
    assert.equal(prepared.blockers.length, 0);
    assert.equal(await store.pathExists(`.legion-cli/workflow/${spec.id}/preparation.yaml`), true);
    generated.splice(0, generated.length, analysis);
    await engine.prepareSpecChallenge(spec.id);
    await engine.approveSpec(spec.id, { id: "owner" });
    const task = makeTask({ priority: "P1", contract: { verificationCommands: [passingVerificationCommand()] } });
    const planOutputs = [
      { path: ".legion-cli/cache/runs/<id>/preparation.json", content: JSON.stringify(completeRecord) },
      { path: `.legion-cli/plans/${spec.id}.md`, content: "# Repair plan\n\nImplement the approved bounded repair.\n" },
      { path: `.legion-cli/tasks/${task.id}.md`, content: formatMarkdownDocument(task, "Implement the observable repair with the existing check.\n") },
    ];
    generated.splice(0, generated.length, ...planOutputs);
    assert.equal(await engine.plan(), "PASS", JSON.stringify(engine.getLastPlanReport()));
    assert.equal((await engine.readWorkflowPreparation()).specFingerprint, prepared.specFingerprint);
    await engine.configurePlanningStrategy({ kind: "outcomes", rationale: "Keep one observable repair outcome.", granularity: "balanced" });
    const strategy = { kind: "outcomes", rationale: "Keep one observable repair outcome.", granularity: "balanced", outcomes: [{ id: "repair", statement: "Deliver the repaired behavior.", acceptanceIds: ["AC-01"], taskIds: [task.id] }] };
    generated.splice(0, generated.length, ...planOutputs.map((output) => output.path.endsWith("preparation.json") ? { ...output, content: JSON.stringify({ ...completeRecord, strategy }) } : output));
    assert.equal(await engine.plan(), "PASS", JSON.stringify(engine.getLastPlanReport()));
    const approved = await engine.approvePlan();
    assert.equal(approved.taskIds[0], task.id);
    await assert.rejects(() => engine.plan(), /approved plan.*amend/i);
  }, { skillsDir, fakeArtifacts: generated }));
});

test("failed preparation generation restores the engine policy marker before refusing", async () => {
  const generated = [];
  await withFakeAdapter(async () => withEngine(async ({ engine, store }) => {
    await initProject(engine, { workflowProfile: "focused" });
    const spec = makeSpec({ workflowPolicyVersion: 2 });
    await writeSpec(store, spec);
    await patchState(store, { phase: "spec_draft", activeSpecId: spec.id });
    const { workflowPolicyVersion, ...unmarked } = spec;
    generated.push({ path: `.legion-cli/specs/${spec.id}/SPEC.md`, content: formatMarkdownDocument(unmarked, "Draft proposed by a failed agent.\n") });
    await assert.rejects(() => engine.prepareWorkflowSpecification(spec.id), /preparation.*failed/i);
    assert.equal((await store.readSpec(spec.id)).data.workflowPolicyVersion, 2);
    assert.equal((await store.readSpec(spec.id)).data.status, "draft");
    assert.equal(await store.pathExists(`.legion-cli/workflow/${spec.id}/preparation.yaml`), false);
    await assert.rejects(() => engine.approveSpec(spec.id, { id: "owner" }), /preparation/i);
  }, { skillsDir, fakeArtifacts: generated, fakeExitCode: 1 }));
});

test("plan rejects foreign task proposals before promoting any local task", async () => {
  const generated = [analysis];
  await withFakeAdapter(async () => withEngine(async ({ engine, store, dir }) => {
    const { spec } = await seedPolicy2(engine, store, dir);
    const original = await store.readTask("TSK-0001");
    const record = (await engine.readWorkflowPreparation()).record;
    const local = makeTask({ id: "TSK-0002", priority: "P1", status: "done", contract: { verificationCommands: [passingVerificationCommand()], filesAllowed: ["src/second.ts"], expectedArtifacts: ["src/second.ts"] } });
    const foreign = makeTask({ id: "TSK-9999", specId: "spec-other", contract: { verificationCommands: [passingVerificationCommand()] } });
    generated.splice(0, generated.length,
      { path: ".legion-cli/cache/runs/<id>/preparation.json", content: JSON.stringify(record) },
      { path: `.legion-cli/tasks/${local.id}.md`, content: formatMarkdownDocument(local, "Local proposed task.\n") },
      { path: `.legion-cli/tasks/${foreign.id}.md`, content: formatMarkdownDocument(foreign, "Foreign proposed task.\n") });
    assert.equal(await engine.plan(), "FAIL");
    assert.match(engine.getLastPlanReport().fails.join("; "), /foreign.*identity/i);
    assert.deepEqual(await store.readTask(original.data.id), original);
    assert.equal(await store.pathExists(`.legion-cli/tasks/${local.id}.md`), false);
    assert.equal(await store.pathExists(`.legion-cli/tasks/${foreign.id}.md`), false);
    assert.equal((await store.readSpec(spec.id)).data.workflowPolicyVersion, 2);
    assert.equal(isAllowedPath(`.legion-cli/tasks/${local.id}.md`, ["**", ".legion-cli/tasks/**"]), false, "task-contract broad roots never admit engine task writes");
  }, { skillsDir, fakeArtifacts: generated }));
});
