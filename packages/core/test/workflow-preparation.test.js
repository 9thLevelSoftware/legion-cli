import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { WORKFLOW_STAGE_FIELDS } from "@9thlevelsoftware/legion-cli-schema";
import { bindPreparationArtifacts, inspectPreparationRecord, inspectWorkflowPreparation, preparationInputFingerprint, validateWorkflowPreparation, writeWorkflowPreparation } from "../dist/workflow-preparation.js";
import { makeSpec, makeTask, withEngine } from "./helpers.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const blankDigest = hash("");
function fixture() {
  const spec = makeSpec({ workflowPolicyVersion: 2, acceptance: [{ id: "AC-01", statement: "Export preserves record ordering", priority: "P1", kind: "behavior" }] });
  const task = makeTask({ priority: "P1" });
  const artifacts = ["context", "requirements"].map((stage) => ({ stage, path: `.legion-cli/specs/${spec.id}/preparation/${stage}.md`, digest: blankDigest, inputs: [], fields: Object.fromEntries(WORKFLOW_STAGE_FIELDS[stage].map((key) => [key, key === "acceptanceIds" ? "AC-01" : "Preserve the existing export contract."])) }));
  const record = {
    schemaVersion: "legion-cli-workflow-preparation/v1",
    assessment: { schemaVersion: "legion-cli-workflow-assessment/v1", policyVersion: 2, specId: spec.id, inputFingerprint: preparationInputFingerprint([]), unresolvedDecisions: [], stageDecisions: Object.keys(WORKFLOW_STAGE_FIELDS).map((stage) => ({ stage, decision: ["context", "requirements"].includes(stage) ? "required" : "not_applicable", rationale: "The bounded export correction preserves this area.", evidenceRefs: ["SPEC.md"] })) },
    specArtifacts: artifacts, planArtifacts: [], acceptanceMappings: [{ criterionId: "AC-01", taskIds: [task.id], methods: [{ id: "export-check", kind: "task_check", taskId: task.id, command: "pnpm test", expectedObservation: "Export ordering matches the existing contract" }] }],
  };
  return { record, context: { spec, gate: "plan", tasks: [task], verificationCommands: [] } };
}
function codes(result) { return result.blockers.map((blocker) => blocker.code); }
async function materialize(store, dir, record) {
  for (const artifact of [...record.specArtifacts, ...record.planArtifacts]) {
    await mkdir(dirname(join(dir, artifact.path)), { recursive: true });
    await writeFile(join(dir, artifact.path), `# ${artifact.stage}\nConcrete reviewed preparation.\n`);
  }
  return bindPreparationArtifacts(store, record);
}

test("policy is explicit, mandatory stages cannot be skipped, and P1-only scope is valid", () => {
  const { record, context } = fixture();
  assert.deepEqual(validateWorkflowPreparation(record, context).blockers, []);
  assert.ok(codes(validateWorkflowPreparation(null, context)).includes("missing"));
  assert.deepEqual(validateWorkflowPreparation(null, { ...context, spec: makeSpec() }).blockers, []);
  const skipped = structuredClone(record); skipped.assessment.stageDecisions[0].decision = "not_applicable";
  assert.ok(codes(validateWorkflowPreparation(skipped, context)).includes("mandatory"));
  const noFields = structuredClone(record); noFields.specArtifacts[0].fields = {};
  assert.ok(codes(validateWorkflowPreparation(noFields, context)).includes("missing_field"));
  const ungrounded = structuredClone(record); ungrounded.assessment.stageDecisions[2].evidenceRefs = ["missing-file.md"];
  assert.ok(codes(validateWorkflowPreparation(ungrounded, context)).includes("unbound_reference"));
  ungrounded.assessment.stageDecisions[2].evidenceRefs = ["assumption: No browser user interface is part of this export correction"];
  assert.deepEqual(validateWorkflowPreparation(ungrounded, context).blockers, []);
});

test("design changes affect plan identity while route, knowledge and human decisions affect spec identity", () => {
  const { record, context } = fixture();
  const before = validateWorkflowPreparation(record, context);
  const next = structuredClone(record); next.strategy = { kind: "outcomes", rationale: "One observable increment", outcomes: [{ id: "export", statement: "Export in stable order", acceptanceIds: ["AC-01"], taskIds: ["TSK-0001"] }] };
  const after = validateWorkflowPreparation(next, context);
  assert.equal(before.specFingerprint, after.specFingerprint);
  assert.notEqual(before.planFingerprint, after.planFingerprint);
  assert.ok(codes(validateWorkflowPreparation({ ...next, strategy: { ...next.strategy, outcomes: [] } }, context)).includes("empty_outcomes"));
  next.assessment.stageDecisions[2].rationale = "Changed applicability basis";
  assert.notEqual(before.specFingerprint, validateWorkflowPreparation(next, context).specFingerprint);
  const decision = { id: "D1", name: "Output order", question: "Which ordering?", kind: "preference", blocking: true, prerequisiteIds: [], evidence: [], options: [], resolution: { disposition: "answered", response: "Preserve existing order", resolvedAt: "2026-10-07" } };
  const resolved = validateWorkflowPreparation(record, { ...context, planningDecisions: [decision] });
  assert.notEqual(before.specFingerprint, resolved.specFingerprint);
  assert.equal(resolved.specFingerprint, validateWorkflowPreparation(record, { ...context, planningDecisions: [{ ...decision, resolution: { ...decision.resolution, resolvedAt: "later" } }] }).specFingerprint);
});

test("every criterion references its approved task/check and non-applicability cannot relax scope", () => {
  const { record, context } = fixture();
  const bad = structuredClone(record); bad.acceptanceMappings[0].methods[0].command = "echo unrelated";
  assert.ok(codes(validateWorkflowPreparation(bad, context)).includes("unknown_check"));
  bad.acceptanceMappings[0].notApplicableWhen = "Operator prefers to skip";
  assert.ok(codes(validateWorkflowPreparation(bad, context)).includes("scope_condition"));
  bad.acceptanceMappings = [];
  assert.ok(codes(validateWorkflowPreparation(bad, context)).includes("unmapped"));
  bad.acceptanceMappings = [record.acceptanceMappings[0], record.acceptanceMappings[0]];
  assert.ok(codes(validateWorkflowPreparation(bad, context)).includes("duplicate_mapping"));
  bad.acceptanceMappings = [{ ...record.acceptanceMappings[0], methods: [{ id: "external", kind: "external", expectedObservation: "Consumer migrated" }] }];
  assert.ok(codes(validateWorkflowPreparation(bad, context)).includes("missing_procedure"));
  bad.acceptanceMappings[0].methods = [{ id: "assurance", kind: "assurance", validatorId: "v1", expectedObservation: "Ordering preserved" }];
  assert.ok(codes(validateWorkflowPreparation(bad, context)).includes("unknown_validator"));
  assert.deepEqual(validateWorkflowPreparation(bad, { ...context, assuranceValidatorIds: ["v1"] }).blockers, []);
});

test("risk ordering requires dependencies and retirement needs existing prerequisite evidence", () => {
  const { record, context } = fixture();
  const other = makeTask({ id: "TSK-0002", contract: { filesAllowed: ["src/other.ts"] } });
  context.tasks.push(other);
  record.strategy = { kind: "risk-first", rationale: "Settle format support first", outcomes: [{ id: "export", statement: "Safe export", acceptanceIds: ["AC-01"], taskIds: context.tasks.map((task) => task.id) }], risk: { uncertainty: "Consumer can parse the existing format", probeTaskId: "TSK-0001", dependentTaskIds: [other.id] } };
  assert.ok(codes(validateWorkflowPreparation(record, context)).includes("risk_order"));
  other.blockedBy = ["TSK-0001"];
  assert.deepEqual(validateWorkflowPreparation(record, context).blockers, []);
  record.strategy = { ...record.strategy, kind: "expand-contract", risk: undefined, migration: { compatibility: "Old consumers continue", transition: "Confirm rollout", retirementTaskIds: [other.id], prerequisites: [] } };
  assert.ok(codes(validateWorkflowPreparation(record, context)).includes("retirement_evidence"));
  record.strategy.migration.retirementTaskIds = [];
  assert.deepEqual(validateWorkflowPreparation(record, context).blockers, []);
});

test("execution may evolve captured source while preparation and accepted knowledge stay bound", async () => {
  await withEngine(async ({ store, dir }) => {
    const { record, context } = fixture();
    await mkdir(join(dir, "src")); await writeFile(join(dir, "src", "export.py"), "old behavior");
    record.specArtifacts[0].inputs = [{ path: "src/export.py", digest: hash("old behavior") }];
    const bound = await materialize(store, dir, record);
    assert.deepEqual((await inspectPreparationRecord(store, bound, { ...context, checkSourceInputs: true })).blockers, []);
    await writeFile(join(dir, "src", "export.py"), "approved corrected behavior");
    assert.ok(codes(await inspectPreparationRecord(store, bound, { ...context, checkSourceInputs: true })).includes("stale_input"));
    assert.deepEqual((await inspectPreparationRecord(store, bound, { ...context, gate: "ship", checkSourceInputs: false })).blockers, []);
    await mkdir(join(dir, "docs")); await writeFile(join(dir, "docs", "contract.md"), "accepted knowledge");
    bound.knowledge = [{ path: "docs/contract.md", digest: hash("accepted knowledge") }];
    const identity = (await inspectPreparationRecord(store, bound, context)).specFingerprint;
    await writeFile(join(dir, "docs", "unreferenced.md"), "unrelated edits");
    assert.equal((await inspectPreparationRecord(store, bound, context)).specFingerprint, identity);
    await writeFile(join(dir, "docs", "contract.md"), "changed knowledge");
    assert.ok(codes(await inspectPreparationRecord(store, bound, { ...context, gate: "ship" })).includes("stale_input"));
    await writeFile(join(dir, bound.specArtifacts[0].path), "changed approved context");
    assert.equal((await inspectPreparationRecord(store, bound, context)).stages.find((stage) => stage.stage === "context").status, "stale");
  });
});

test("sidecars are engine-lock owned and malformed/missing records never fall back to old policy", async () => {
  await withEngine(async ({ store, dir }) => {
    const { record, context } = fixture();
    const bound = await materialize(store, dir, record);
    await assert.rejects(() => writeWorkflowPreparation(store, bound), /lock/);
    await store.withLock(() => writeWorkflowPreparation(store, bound));
    assert.deepEqual((await inspectWorkflowPreparation(store, context)).blockers, []);
    const path = `.legion-cli/workflow/${context.spec.id}/preparation.yaml`;
    await writeFile(join(dir, path), "schemaVersion: unknown\n");
    assert.ok(codes(await inspectWorkflowPreparation(store, context)).includes("invalid_record"));
  });
});

test("design consumes approved preparation and confidential inputs or frozen SPEC bytes are refused", () => {
  const { record, context } = fixture();
  record.assessment.stageDecisions.find((item) => item.stage === "architecture").decision = "required";
  record.planArtifacts = [{ stage: "architecture", path: `.legion-cli/plans/${context.spec.id}/architecture.md`, digest: blankDigest, inputs: [], fields: Object.fromEntries(WORKFLOW_STAGE_FIELDS.architecture.map((key) => [key, "Preserve the interface boundary."])) }];
  assert.ok(codes(validateWorkflowPreparation(record, context)).includes("missing_dependency"));
  record.planArtifacts[0].inputs = record.specArtifacts.map(({ path, digest }) => ({ path, digest }));
  assert.deepEqual(validateWorkflowPreparation(record, context).blockers, []);
  record.specArtifacts[0].inputs = [{ path: ".env", digest: blankDigest }, { path: `.legion-cli/specs/${context.spec.id}/SPEC.md`, digest: blankDigest }];
  const blocked = codes(validateWorkflowPreparation(record, context));
  assert.ok(blocked.includes("unsafe_input")); assert.ok(blocked.includes("authority_input"));
});

test("self-dependencies and cyclic design dependencies are rejected", () => {
  const { record, context } = fixture();
  record.specArtifacts[0].inputs = [{ path: record.specArtifacts[0].path, digest: record.specArtifacts[0].digest }];
  record.assessment.inputFingerprint = preparationInputFingerprint(record.specArtifacts.flatMap((artifact) => artifact.inputs));
  assert.ok(codes(validateWorkflowPreparation(record, context)).includes("cycle"));
  record.specArtifacts[0].inputs = [{ path: record.specArtifacts[1].path, digest: record.specArtifacts[1].digest }];
  record.specArtifacts[1].inputs = [{ path: record.specArtifacts[0].path, digest: record.specArtifacts[0].digest }];
  record.assessment.inputFingerprint = preparationInputFingerprint(record.specArtifacts.flatMap((artifact) => artifact.inputs));
  assert.ok(codes(validateWorkflowPreparation(record, context)).includes("cycle"));
});

test("reviewed knowledge policy also checks Windows case aliases", { skip: process.platform !== "win32" }, async () => {
  await withEngine(async ({ store, dir }) => {
    const { record, context } = fixture();
    const bound = await materialize(store, dir, record);
    const path = ".legion-cli/wiki/unsafe.md";
    const body = "---\nschemaVersion: legion-cli-wiki-page/v1\ntitle: Unsafe\ntrust: untrusted\nupdated: today\n---\nUntrusted reference.\n";
    await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), body);
    bound.knowledge = [{ path: ".LEGION-CLI/wiki/unsafe.md", digest: hash(body) }];
    assert.ok(codes(await inspectPreparationRecord(store, bound, context)).includes("unreviewed_knowledge"));
  });
});
