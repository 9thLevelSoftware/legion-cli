import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  SCHEMA_VERSION, SpecSchema, SpecApprovalReceiptSchema, PlanApprovalReceiptSchema,
  IntentAnswersFileSchema, IntentSourceProposalSchema, IntentSourceBindingSchema,
  WorkflowAssessmentSchema, WorkflowPreparationSchema, PreparationArtifactSchema, PreparationInputSchema,
  AssistanceSessionSchema, GuidanceModeSchema, PlanningDecisionSchema, DesignComparisonSchema,
  PlanningStrategySchema, TestingMethodSchema, legionJsonSchemas,
} from "../dist/index.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const digest = "a".repeat(64);
const mapped = { personas: ["operators"], problem: "deployment recovery is unreliable", mustBeTrue: ["rollback preserves compatibility"], mustNotChange: ["public API"], outOfScope: ["UI rewrite"], happyPath: "deploy, check health, roll back", screens: ["CLI"] };
const source = { path: "C:/briefs/requirements.md", digest, format: "markdown", provenance: "local-file", importedAt: "2026-10-07T12:00:00.000Z" };
const assessment = { schemaVersion: "legion-cli-workflow-assessment/v1", policyVersion: 2, specId: "spec-deploy", inputFingerprint: digest, stageDecisions: [{ stage: "context", decision: "required", rationale: "capture preservation constraints", evidenceRefs: ["src/deploy.ts"] }], unresolvedDecisions: [] };
const artifact = { stage: "context", path: ".legion-cli/specs/spec-deploy/preparation/context.md", digest, inputs: [{ path: "src/deploy.ts", digest }], fields: { goal: "reliable rollback", affectedPaths: "src/deploy.ts", constraints: "retain public API", assumptions: "none" } };
const session = { schemaVersion: "legion-cli-assistance/v1", sessionId: "session-first", specId: null, guidance: "balanced", paused: true, cursor: { stage: "intent", round: 0 }, decisionIds: [], comparisonIds: [] };
const decision = { id: "D-API", name: "API compatibility", question: "Which compatibility boundary must remain?", kind: "design", blocking: true, prerequisiteIds: [], evidence: [{ kind: "assumption", statement: "Existing clients may depend on the API" }], options: [{ id: "keep", label: "Keep API", consequence: "Existing clients continue working" }] };
const alternative = (id, behavior) => ({ id, name: id, behavior, usageExample: "deploy --safe", constraints: ["public API"], failureImplications: ["rollback must remain available"], testingApproach: "exercise rollback with an existing client", tradeoffs: ["compatibility maintenance"] });
const comparison = { id: "cmp-api", decisionId: "D-API", stageId: "architecture", alternatives: [alternative("adapter", "preserve API via adapter"), alternative("version", "add an explicit versioned API")] };
const strategy = { kind: "outcomes", rationale: "deliver an observable recovery result", outcomes: [{ id: "OUT-1", statement: "Rollback preserves existing clients", acceptanceIds: ["AC-01"], taskIds: ["TSK-001"] }] };
const method = { taskId: "TSK-001", method: "regression-first", behavior: "rollback maintains compatibility", testInterface: "existing API client", limitations: ["provider rollout remains external"] };
const preparation = { schemaVersion: "legion-cli-workflow-preparation/v1", assessment, specArtifacts: [artifact], planArtifacts: [], acceptanceMappings: [{ criterionId: "AC-01", taskIds: ["TSK-001"], methods: [{ id: "api-client", kind: "task_check", taskId: "TSK-001", command: "node test-client.js", expectedObservation: "existing client completes rollback" }] }] };

test("legacy specification, intent and approval records do not gain policy or assistance defaults", () => {
  const spec = JSON.parse(readFileSync(join(pkgRoot, "test/snapshots/SPEC.json"), "utf8"));
  assert.deepEqual(SpecSchema.parse(spec), spec);
  assert.equal(Object.hasOwn(SpecSchema.parse(spec), "workflowPolicyVersion"), false);
  const intent = { schemaVersion: SCHEMA_VERSION.intentAnswers, rounds: [], mapped };
  assert.deepEqual(IntentAnswersFileSchema.parse(intent), intent);
  for (const field of ["source", "importedMissing", "importedConflicts", "importedSuggestions"]) assert.equal(Object.hasOwn(IntentAnswersFileSchema.parse(intent), field), false);
  const specApproval = { schemaVersion: SCHEMA_VERSION.specApproval, specId: spec.id, specFingerprint: digest, approvedAt: "now", approvedBy: "user" };
  assert.deepEqual(SpecApprovalReceiptSchema.parse(specApproval), specApproval);
  const planApproval = { schemaVersion: SCHEMA_VERSION.planApproval, specId: spec.id, approvedAt: "now", approvedBy: "user", planFingerprint: digest, approvalId: "plan-first", specFingerprint: digest, taskFingerprint: digest, configFingerprint: digest, taskIds: ["TSK-001"], acceptanceIds: ["AC-01"], verificationCommands: ["node test-client.js"] };
  assert.deepEqual(PlanApprovalReceiptSchema.parse(planApproval), planApproval);
  assert.equal(SpecSchema.safeParse({ ...spec, workflowPolicyVersion: 1 }).success, false);
  assert.equal(SpecSchema.parse({ ...spec, workflowPolicyVersion: 2 }).workflowPolicyVersion, 2);
  assert.equal(Object.hasOwn(WorkflowPreparationSchema.parse(preparation), "strategy"), false);
  assert.equal(Object.hasOwn(WorkflowPreparationSchema.parse(preparation), "comparisons"), false);
});

test("assistance sessions represent progress before allocation and preserve display-only choices", () => {
  for (const guidance of ["guided", "balanced", "direct"]) {
    assert.equal(GuidanceModeSchema.parse(guidance), guidance);
    assert.deepEqual(AssistanceSessionSchema.parse({ ...session, guidance }), { ...session, guidance });
  }
  const allocated = { ...session, specId: "spec-deploy", paused: false, cursor: { stage: "explore", questionId: "D-API", round: 1 }, decisionIds: ["D-API"], comparisonIds: ["cmp-api"] };
  assert.deepEqual(AssistanceSessionSchema.parse(allocated), allocated);
  assert.equal(AssistanceSessionSchema.safeParse({ ...session, cursor: { stage: "intent", round: -1 } }).success, false);
  assert.equal(AssistanceSessionSchema.safeParse({ ...session, approved: true }).success, false);
  assert.equal(GuidanceModeSchema.safeParse("autonomous").success, false);
});

test("local import schema preserves provenance and proposals without manufacturing interview history", () => {
  assert.deepEqual(IntentSourceBindingSchema.parse(source), source);
  const proposal = { mapped, inferredSuggestions: ["consider dry-run preview"], missingSlots: ["failureLines"], conflictingSlots: ["mustBeTrue"], failureLines: [], blockingLines: [] };
  assert.deepEqual(IntentSourceProposalSchema.parse(proposal), proposal);
  const imported = { schemaVersion: SCHEMA_VERSION.intentAnswers, rounds: [], mapped, source, importedMissing: proposal.missingSlots, importedConflicts: proposal.conflictingSlots, importedSuggestions: proposal.inferredSuggestions };
  assert.deepEqual(IntentAnswersFileSchema.parse(imported), imported);
  assert.equal(IntentSourceProposalSchema.safeParse({ ...proposal, approved: true }).success, false);
  assert.equal(IntentSourceBindingSchema.safeParse({ ...source, provenance: "trusted-instructions" }).success, false);
  assert.equal(IntentSourceBindingSchema.safeParse({ ...source, format: "pdf" }).success, false);
  assert.equal(IntentSourceBindingSchema.safeParse({ ...source, digest: "not-a-digest" }).success, false);
});

test("planning decisions carry source kinds and exact human resolution vocabulary", () => {
  assert.deepEqual(PlanningDecisionSchema.parse(decision), decision);
  for (const kind of ["preference", "fact", "scope", "design"]) assert.equal(PlanningDecisionSchema.parse({ ...decision, kind }).kind, kind);
  for (const kind of ["observation", "assumption", "user_report", "verified_execution"]) {
    assert.equal(PlanningDecisionSchema.parse({ ...decision, evidence: [{ path: "docs/architecture.md", digest, kind, statement: "reported behavior" }] }).evidence[0].kind, kind);
  }
  for (const disposition of ["answered", "deferred", "out_of_scope"]) {
    const resolution = { disposition, response: "human rationale", selectedOptionId: "keep", resolvedAt: "2026-10-07T12:00:00.000Z" };
    assert.deepEqual(PlanningDecisionSchema.parse({ ...decision, resolution }).resolution, resolution);
  }
  assert.equal(PlanningDecisionSchema.safeParse({ ...decision, resolution: { disposition: "dismissed", response: "old challenge vocabulary", resolvedAt: "now" } }).success, false);
  assert.equal(PlanningDecisionSchema.safeParse({ ...decision, resolution: { disposition: "answered", response: "", resolvedAt: "now" } }).success, false);
});

test("comparison schema requires exactly two complete alternatives and keeps selection optional", () => {
  assert.deepEqual(DesignComparisonSchema.parse(comparison), comparison);
  assert.equal(Object.hasOwn(DesignComparisonSchema.parse(comparison), "selectedOptionId"), false);
  for (const alternatives of [[], [comparison.alternatives[0]], [...comparison.alternatives, comparison.alternatives[0]]]) assert.equal(DesignComparisonSchema.safeParse({ ...comparison, alternatives }).success, false);
  assert.equal(DesignComparisonSchema.safeParse({ ...comparison, alternatives: [{ ...comparison.alternatives[0], testingApproach: "" }, comparison.alternatives[1]] }).success, false);
  assert.equal(DesignComparisonSchema.safeParse({ ...comparison, stageId: "execute" }).success, false);
});

test("strategies and testing methods preserve executable references without new scheduler fields", () => {
  for (const kind of ["outcomes", "risk-first", "expand-contract", "custom"]) assert.equal(PlanningStrategySchema.parse({ ...strategy, kind }).kind, kind);
  for (const testing of ["test-first", "regression-first", "existing-checks"]) assert.equal(TestingMethodSchema.parse({ ...method, method: testing }).method, testing);
  // A choice can be saved before decomposition; the plan gate requires coverage.
  assert.equal(PlanningStrategySchema.safeParse({ ...strategy, outcomes: [] }).success, true);
  assert.equal(PlanningStrategySchema.safeParse({ ...strategy, outcomes: [{ ...strategy.outcomes[0], taskIds: [] }] }).success, false);
  assert.equal(TestingMethodSchema.safeParse({ ...method, method: "retry-until-green" }).success, false);
  assert.equal(WorkflowPreparationSchema.safeParse({ ...preparation, strategy, testingMethods: [method], comparisons: [comparison], knowledge: [{ path: "docs/architecture.md", digest }] }).success, true);
  assert.equal(WorkflowPreparationSchema.safeParse({ ...preparation, scheduler: {} }).success, false);
});

test("preparation references reject unsafe concrete paths and all versioned records fail closed", () => {
  for (const path of ["../secrets.txt", "/absolute/file", "C:/drive/file", "src\\file.ts", "src/*.ts", ".git/config", "src/../file.ts", "src/file.ts:stream", "GIT~1/config"]) {
    assert.equal(PreparationInputSchema.safeParse({ path, digest }).success, false, path);
    assert.equal(PreparationArtifactSchema.safeParse({ ...artifact, path }).success, false, path);
    assert.equal(PlanningDecisionSchema.safeParse({ ...decision, evidence: [{ kind: "observation", path, statement: "observed" }] }).success, false, path);
  }
  for (const [schema, record] of [[WorkflowAssessmentSchema, assessment], [WorkflowPreparationSchema, preparation], [AssistanceSessionSchema, session]]) assert.equal(schema.safeParse({ ...record, schemaVersion: "future/v99" }).success, false);
  assert.equal(WorkflowAssessmentSchema.safeParse({ ...assessment, policyVersion: 3 }).success, false);
});

test("new emitted JSON contracts match runtime fixtures and bounded failure cases", () => {
  const fixtures = {
    "workflow-assessment": assessment, "workflow-preparation": preparation, assistance: session,
    "planning-decision": decision, "design-comparison": comparison,
    "intent-source-proposal": { mapped, inferredSuggestions: [], missingSlots: [], conflictingSlots: [], failureLines: [], blockingLines: [] },
  };
  const schemas = legionJsonSchemas();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const [name, fixture] of Object.entries(fixtures)) {
    const emitted = JSON.parse(readFileSync(join(pkgRoot, "json", `${name}.json`), "utf8"));
    assert.deepEqual(emitted, schemas[name], name);
    const validate = ajv.compile(emitted);
    assert.equal(validate(fixture), true, `${name}: ${JSON.stringify(validate.errors)}`);
    if (Object.hasOwn(fixture, "schemaVersion")) assert.equal(validate({ ...fixture, schemaVersion: "future/v99" }), false, name);
    if (name === "design-comparison") assert.equal(validate({ ...fixture, alternatives: [fixture.alternatives[0]] }), false);
    if (name === "workflow-preparation") assert.equal(validate({ ...fixture, specArtifacts: [{ ...artifact, path: "../file" }] }), false);
  }
});
