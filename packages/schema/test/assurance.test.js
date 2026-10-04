import assert from "node:assert/strict";
import test from "node:test";
import * as s from "../dist/index.js";

const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const at = "2026-10-02T12:00:00.000Z";
const token = "63188ab8-4d09-4b7e-893d-15d0b87e4af0";
const runtime = { hostSha256: hash, version: "1.0.0", abi: "legion-validator/v1", target: "x86_64-pc-windows-msvc", settingsDigest: hash, guard: "windows-job-committed", guardVerified: true };
const plan = {
  schemaVersion: s.SCHEMA_VERSION.assurancePlan, specId: "SPEC-1", acceptanceIds: ["AC-1"], taskIds: ["TASK-1"],
  security: { mode: "information-flow", sources: [{ id: "source", path: "data.json", classification: "sealed" }], sinks: [{ id: "model", origin: "https://example.com", classifications: ["workspace"] }], transformations: [{ id: "summarize", instruction: "Summarize the data" }], tasks: [{ taskId: "TASK-1", readPaths: ["data.json"], transformationIds: ["summarize"] }], externalCalls: [] },
  knowledge: [{ id: "price", statement: "Price remains 42", source: { path: "source.ts", selector: { kind: "variable", qualifiedName: "price" } }, acceptanceIds: ["AC-1"], taskIds: ["TASK-1"], dependsOn: [], checkIds: ["business-price"] }],
  validators: [{ id: "business-price", extensionRef: "extension:json-contract", extensionCheckId: "json-contract", componentSha256: hash, inputUnitIds: ["price"], inputFiles: ["data.json"], acceptanceIds: ["AC-1"], configuration: { assertions: [{ id: "price", predicate: { file: "data.json", pointer: "/price", op: "eq", expected: 42 } }] } }], delivery: { artifacts: [] },
};
const approval = { schemaVersion: s.SCHEMA_VERSION.assuranceApproval, approvalId: "approval/opaque", specId: "SPEC-1", planFingerprint: hash, manifestDigest: hash, approvedAt: at, nativeHost: runtime, baselineSources: [{ path: "data.json", sha256: hash }] };
const output = { schemaVersion: s.SCHEMA_VERSION.validatorOutput, checkId: "json-contract", status: "passed", observations: [{ id: "price", status: "passed", code: "matched" }] };
const check = { schemaVersion: s.SCHEMA_VERSION.checkEvidence, checkId: "business-price", extensionCheckId: "json-contract", approvalId: approval.approvalId, manifestDigest: hash, inputDigest: hash, reuseKey: hash, inputs: [{ kind: "file", path: "data.json", exists: true, mode: "100644", sha256: hash }], moduleSha256: hash, runtime, parserVersion: "5.8.3", configurationDigest: hash, result: "passed", output, reason: null, observationDigest: hash, executionId: "run-2", reusedFrom: null, recordedAt: at };
const execution = { schemaVersion: s.SCHEMA_VERSION.assuranceExecution, executionId: "run-2", approvalId: approval.approvalId, manifestDigest: hash, productFingerprint: hash, environmentFingerprint: hash, checks: [{ checkId: "business-price", receiptDigest: hash, executionId: "run-2", result: "passed", reuse: "executed" }], policyStatus: "enforced", traceStatus: "valid", status: "passed", blocker: null, recordedAt: at };
const program = { operations: [{ kind: "read", id: "input", path: "data.json" }, { kind: "derive", id: "summary", transformationId: "summarize", inputs: ["input"] }, { kind: "write", id: "publish", path: "summary.txt", value: "summary", expectedTargetDigest: null }, { kind: "finish", id: "finish" }] };
const identities = { promptFingerprint: hash, configurationFingerprint: hash, contractFingerprint: hash, sourceFingerprint: hash, jailFingerprint: hash, hostFingerprint: hash, approvalId: approval.approvalId, policyFingerprint: hash, provider: { endpoint: "https://example.com/v1", model: "local-fixture", profile: "fixture" } };
const label = { origins: ["source"], integrity: "untrusted", confidentiality: "sealed" };
const actionApproval = { schemaVersion: s.SCHEMA_VERSION.actionApproval, approvalId: approval.approvalId, runId: "run-1", actionId: "publish", programKind: "governed", authorityDigest: hash, programFingerprint: hash, actionKind: "write", policyFingerprint: hash, valueDigest: hash, sinkId: "model", requestDigest: hash, approvedAt: at, operatorId: "operator", reason: "Scoped review", state: "approved" };
const checkpoint = { schemaVersion: s.SCHEMA_VERSION.httpGovernedCheckpoint, runId: "run-1", bootstrapAuthorityDigest: hash, phase: "program", programAuthorityDigest: hash, programKind: "governed", programFingerprint: hash, identities, revision: 0, bootstrapProviderCalls: [], providerCalls: [], usage: { planner: { requests: 0, inputTokens: null, outputTokens: null, costUsd: null, tokenLowerBound: 0, tokenAccounting: "complete", costAccounting: "complete" }, quarantined: { requests: 0, inputTokens: null, outputTokens: null, costUsd: null, tokenLowerBound: 0, tokenAccounting: "complete", costAccounting: "complete" } }, program, candidateProgram: null, cursor: 2, values: [{ id: "input", digest: hash, bytes: 30, label, producer: { kind: "read", operationId: "input", path: "data.json", sourceDigest: hash }, retained: null }, { id: "summary", digest: hash, bytes: 20, label, producer: { kind: "derive", operationId: "summary", transformationId: "summarize", inputIds: ["input"], originalCallId: "derive-call" }, retained: null }], effects: [], status: "blocked", blocker: "approval-required", recordedAt: at };
const projection = { schemaVersion: s.SCHEMA_VERSION.governanceProjection, phase: "plan_ready", controlMode: "guarded", tasks: [{ id: "TASK-1", status: "ready", owner: null, writes: ["summary.txt"], checks: "not-run" }], approval: { id: approval.approvalId, freshness: "current" }, claim: { owner: null, liveness: "none" }, integration: "not-run", components: [], review: "not-run", acceptance: [{ id: "AC-1", status: "not-recorded", freshness: "unknown" }], sourceFingerprint: hash, evidenceFingerprint: null, ship: { confirmationId: null, previewFingerprint: null, confirmed: false, status: "none" } };
const begin = { schemaVersion: s.SCHEMA_VERSION.governanceFrame, approvalId: approval.approvalId, sequence: 0, previousDigest: null, digest: hash, modelDigest: hash, boundary: "begin", action: "approval-adopt", correlationId: "boundary-1", before: projection, after: null, outcome: "pending", explicitRetry: false, recordedAt: at };
const end = { ...begin, sequence: 1, previousDigest: hash, digest: otherHash, boundary: "end", after: projection, outcome: "success" };
const trace = { schemaVersion: s.SCHEMA_VERSION.governanceTrace, status: "valid", approvalId: approval.approvalId, modelDigest: hash, headDigest: otherHash, frames: [begin, end] };
const legacyTrace = { schemaVersion: s.SCHEMA_VERSION.governanceTrace, status: "not-adopted", frames: [] };
const product = { scope: "git-index", subjectDigest: hash, entries: [{ kind: "blob", path: "data.json", mode: "100644", sha256: hash, size: 30 }] };
const artifacts = { artifacts: [] };
const evidence = { approvalId: null, specId: null, manifestDigest: null, executionFingerprint: hash, environmentFingerprint: hash, mode: "not-adopted", checks: [], acceptance: [], policyDigest: null, modelDigest: null, sourceScope: "whole-working-product" };
const predicate = { schemaVersion: s.SCHEMA_VERSION.deliveryPredicate, confirmation: token, approval: null, spec: null, assuranceManifestDigest: null, subjectDigest: hash, executionDigest: hash, mode: "not-adopted", traceStatus: "not-adopted", modelDigest: null, policyDigest: null, identities: [], checks: [], acceptance: [], preparedAt: at };
const outcome = { schemaVersion: s.SCHEMA_VERSION.deliveryOutcome, confirmationId: "confirmation-1", preparedDigest: hash, confirmedSubjectDigest: hash, commit: { status: "not-requested" }, pullRequest: { status: "not-requested" }, recordedAt: at };
const prepared = { confirmationId: "confirmation-1", approvalId: null, captureMode: "legacy-bundle", preparedAt: at, executionFingerprint: hash, environmentFingerprint: hash, product, artifacts, evidence, trace: legacyTrace, predicate, tokenMapping: [{ token, localId: "confirmation-1", kind: "confirmation" }] };
const snapshot = { schemaVersion: s.SCHEMA_VERSION.deliverySnapshot, state: "complete", prepared, preparedDigest: hash, outcome, completedTrace: legacyTrace, sealedDigest: hash };
const manifest = { schemaVersion: s.SCHEMA_VERSION.deliveryManifest, confirmationId: "confirmation-1", approvalId: null, snapshotDigest: hash, executionFingerprint: hash, environmentFingerprint: hash, subjectDigest: hash, deliveredScope: "git-index", createdAt: at, members: ["artifacts.json", "evidence.json", "predicate.json", "product.json", "trace.json"].map((path) => ({ path, sha256: hash, size: 30 })) };
const trust = { schemaVersion: s.SCHEMA_VERSION.deliveryTrust, localKeys: [{ spkiPem: "-----BEGIN PUBLIC KEY-----\nZXhhbXBsZQ==\n-----END PUBLIC KEY-----\n", sha256: hash }], ci: null };
const fixtures = [
  [s.AssurancePlanSchema, plan], [s.AssuranceApprovalSchema, approval], [s.CheckEvidenceSchema, check], [s.AssuranceExecutionSchema, execution],
  [s.ComponentRequestSchema, { schemaVersion: s.SCHEMA_VERSION.componentRequest, abi: "legion-validator/v1", moduleSha256: hash, inputSha256: hash, componentBytes: 100, inputBytes: 200, limits: s.COMPONENT_LIMITS }],
  [s.ComponentInvocationSchema, { schemaVersion: s.SCHEMA_VERSION.componentInvocation, checks: [{ id: "json-contract", configuration: {}, files: ["data.json"] }] }],
  [s.ValidatorOutputSchema, output], [s.NativeHostManifestSchema, { schemaVersion: s.SCHEMA_VERSION.nativeHostManifest, version: "1.0.0", abi: "legion-validator/v1", scope: "local", hosts: [{ target: runtime.target, path: "native/host.exe", sha256: hash, size: 100 }] }],
  [s.ActionApprovalSchema, actionApproval], [s.FileProvenanceSchema, { schemaVersion: s.SCHEMA_VERSION.fileProvenance, approvalId: approval.approvalId, policyFingerprint: hash, files: [{ path: "summary.txt", sha256: hash, label, producer: { kind: "governed-action", runId: "run-1", actionId: "publish" }, recordedAt: at }] }],
  [s.HttpRunAuthoritySchema, { schemaVersion: s.SCHEMA_VERSION.httpRunAuthority, stage: "program", runId: "run-1", taskId: "TASK-1", identities, bootstrapAuthorityDigest: hash, plannerCallId: "planner", plannerResultDigest: hash, programKind: "governed", programFingerprint: hash, program, createdAt: at }], [s.HttpGovernedCheckpointSchema, checkpoint],
  [s.GovernanceProjectionSchema, projection], [s.GovernanceFrameSchema, begin], [s.GovernanceHeadSchema, { schemaVersion: s.SCHEMA_VERSION.governanceHead, approvalId: approval.approvalId, sequence: 1, digest: otherHash, status: "valid" }], [s.GovernanceTraceSchema, trace],
  [s.DeliverySnapshotSchema, snapshot], [s.DeliveryManifestSchema, manifest], [s.DeliveryTrustSchema, trust], [s.DeliveryPredicateSchema, predicate], [s.DeliveryOutcomeSchema, outcome],
  [s.DeliveryExportSchema, { schemaVersion: s.SCHEMA_VERSION.deliveryExport, snapshotId: "confirmation-1", snapshotDigest: hash, requestedOutput: "D:/export", attemptId: "attempt-1", attemptedAt: at, result: "exported", reason: null }],
];
const clone = (v) => structuredClone(v);
function rejects(schema, original, mutate) { const v = clone(original); mutate(v); assert.equal(schema.safeParse(v).success, false); }

test("new authority records reject unknown top-level authority and unsupported versions", () => {
  for (const [schema, value] of fixtures) {
    assert.deepEqual(schema.parse(value), value);
    rejects(schema, value, (v) => { v.extraAuthority = true; });
    rejects(schema, value, (v) => { v.schemaVersion = "unsupported/v2"; });
  }
});
test("assurance graph rejects ambiguous declarations, missing links and dependency cycles", () => {
  rejects(s.AssurancePlanSchema, plan, (v) => { v.security.sources.push({ id: "alias", path: "DATA.JSON", classification: "public" }); });
  rejects(s.AssurancePlanSchema, plan, (v) => { v.knowledge[0].dependsOn = ["price"]; });
  rejects(s.AssurancePlanSchema, plan, (v) => { v.knowledge[0].dependsOn = ["missing"]; });
  rejects(s.AssurancePlanSchema, plan, (v) => { v.knowledge[0].taskIds = ["unknown-task"]; });
  rejects(s.AssurancePlanSchema, plan, (v) => { v.validators[0].acceptanceIds = []; });
  rejects(s.AssurancePlanSchema, plan, (v) => { v.validators[0].inputUnitIds = ["unknown-unit"]; });
  rejects(s.AssurancePlanSchema, plan, (v) => { v.validators[0].inputFiles = ["../secret.json"]; });
  rejects(s.AssurancePlanSchema, plan, (v) => { v.security.tasks[0].transformationIds = ["unknown"]; });
  rejects(s.AssurancePlanSchema, plan, (v) => { v.validators[0].configuration.assertions[0].predicate.file = "undeclared.json"; });
  rejects(s.AssurancePlanSchema, plan, (v) => { v.security.externalCalls = [{ id: "call", taskIds: ["TASK-1"], tool: "mcp", sinkId: "model", authority: {}, dataPointers: ["/body", "/body/message"], effect: "http-mcp" }]; });
});
test("adoption without component checks needs no fabricated host; checked adoption binds its concrete host and all sources", () => {
  const noChecks = clone(plan); noChecks.validators = []; noChecks.knowledge = [];
  const noHost = { ...approval, nativeHost: null };
  s.validateAssuranceAdoption(s.AssurancePlanSchema.parse(noChecks), s.AssuranceApprovalSchema.parse(noHost));
  s.validateAssuranceAdoption(s.AssurancePlanSchema.parse(plan), s.AssuranceApprovalSchema.parse(approval));
  assert.throws(() => s.validateAssuranceAdoption(plan, noHost));
  assert.throws(() => s.validateAssuranceAdoption(noChecks, approval));
  assert.throws(() => s.validateAssuranceAdoption(plan, { ...approval, baselineSources: [] }));
});
test("JSON configurations reject cycles, excessive depth, nonfinite numbers and nonobject values before recursive validation", () => {
  assert.equal(s.AssuranceConfigurationSchema.safeParse([]).success, false);
  assert.equal(s.AssuranceConfigurationSchema.safeParse({ value: Infinity }).success, false);
  assert.equal(s.AssuranceConfigurationSchema.safeParse({ value: "\ud800" }).success, false);
  const cycle = {}; cycle.self = cycle;
  assert.equal(s.AssuranceConfigurationSchema.safeParse(cycle).success, false);
  let deep = 1; for (let i = 0; i < 10000; i++) deep = { child: deep };
  assert.equal(s.AssuranceConfigurationSchema.safeParse(deep).success, false);
  assert.equal(s.JsonContractConfigurationSchema.safeParse({ assertions: [{ id: "x", predicate: cycle }] }).success, false);
});
test("standalone invocation requires exact required checks and safe distinct actual paths", () => {
  const invocation = fixtures.find(([schema]) => schema === s.ComponentInvocationSchema)[1];
  const parsed = s.ComponentInvocationSchema.parse(invocation);
  s.validateComponentInvocation(parsed, ["json-contract"]);
  assert.throws(() => s.validateComponentInvocation(parsed, ["different"]));
  assert.throws(() => s.validateComponentInvocation(parsed, ["json-contract", "other"]));
  rejects(s.ComponentInvocationSchema, invocation, (v) => { v.checks[0].files = []; });
  rejects(s.ComponentInvocationSchema, invocation, (v) => { v.checks[0].files.push("DATA.JSON"); });
  rejects(s.ComponentInvocationSchema, invocation, (v) => { v.checks[0].files = ["file.json:stream"]; });
  rejects(s.ComponentInvocationSchema, invocation, (v) => { v.checks[0].files = ["GIT~1/config"]; });
  rejects(s.ComponentInvocationSchema, invocation, (v) => { v.checks[0].id = "../receipt"; });
  rejects(s.ComponentInvocationSchema, invocation, (v) => { v.checks[0].configuration = { huge: "x".repeat(1024 * 1024) }; });
});
test("component framing budgets and guest assertions cannot assert host availability or pass failed observations", () => {
  const request = fixtures.find(([schema]) => schema === s.ComponentRequestSchema)[1];
  rejects(s.ComponentRequestSchema, request, (v) => { v.inputBytes = 8 * 1024 * 1024 + 1; });
  rejects(s.ComponentRequestSchema, request, (v) => { v.componentBytes = 16 * 1024 * 1024 + 1; });
  rejects(s.ComponentRequestSchema, request, (v) => { v.limits.fuel++; });
  rejects(s.ValidatorOutputSchema, output, (v) => { v.status = "unavailable"; });
  rejects(s.ValidatorOutputSchema, output, (v) => { v.observations[0].status = "error"; });
  rejects(s.ValidatorOutputSchema, output, (v) => { v.observations.push(v.observations[0]); });
  rejects(s.ValidatorOutputSchema, output, (v) => { v.observations[0].detail = "é".repeat(2049); });
  rejects(s.ValidatorOutputSchema, output, (v) => { v.recommendations = [{ title: "ticket", command: "execute" }]; });
  const native = fixtures.find(([schema]) => schema === s.NativeHostManifestSchema)[1];
  rejects(s.NativeHostManifestSchema, native, (v) => { v.scope = "release"; });
});
test("JSON business predicate configuration rejects unsafe integers, invalid operand types and hidden authority", () => {
  const config = plan.validators[0].configuration;
  const valid = clone(config); valid.assertions[0].predicate.pointer = "/a~1b/~0name/0";
  assert.equal(s.JsonContractConfigurationSchema.safeParse(valid).success, true);
  rejects(s.JsonContractConfigurationSchema, config, (v) => { v.assertions[0].predicate.expected = 2 ** 53; });
  rejects(s.JsonContractConfigurationSchema, config, (v) => { v.assertions[0].predicate.op = "lt"; v.assertions[0].predicate.expected = "42"; });
  rejects(s.JsonContractConfigurationSchema, config, (v) => { v.assertions[0].predicate.op = "in"; });
  rejects(s.JsonContractConfigurationSchema, config, (v) => { v.assertions[0].predicate.pointer = "/bad~2escape"; });
  rejects(s.JsonContractConfigurationSchema, config, (v) => { v.assertions[0].predicate = { op: "all", children: [] }; });
  rejects(s.JsonContractConfigurationSchema, config, (v) => { v.assertions[0].predicate.command = "shell"; });
  rejects(s.JsonContractConfigurationSchema, config, (v) => { v.assertions.push(v.assertions[0]); });
  rejects(s.JsonContractConfigurationSchema, config, (v) => { for (let i = 0; i < 17; i++) v.assertions[0].predicate = { op: "not", child: v.assertions[0].predicate }; });
});
test("check receipts bind the extension output and allow reuse only from a prior passed execution", () => {
  assert.equal(s.CheckEvidenceSchema.safeParse({ ...check, reusedFrom: "run-1" }).success, true);
  rejects(s.CheckEvidenceSchema, check, (v) => { v.reusedFrom = v.executionId; });
  rejects(s.CheckEvidenceSchema, check, (v) => { v.output.checkId = "business-price"; });
  rejects(s.CheckEvidenceSchema, check, (v) => { v.result = "unavailable"; });
  rejects(s.CheckEvidenceSchema, check, (v) => { v.result = "failed"; v.output.status = "failed"; v.reusedFrom = "run-1"; });
  const unavailable = { ...check, result: "unavailable", inputDigest: null, output: null, observationDigest: null, reason: "Declared selector is missing" };
  assert.equal(s.CheckEvidenceSchema.safeParse(unavailable).success, true);
  rejects(s.CheckEvidenceSchema, unavailable, (v) => { v.reason = null; });
  rejects(s.CheckEvidenceSchema, unavailable, (v) => { v.reusedFrom = "run-1"; });
  rejects(s.CheckEvidenceSchema, check, (v) => { v.inputDigest = null; });
  rejects(s.CheckEvidenceSchema, check, (v) => { v.reason = "Guest cannot report host unavailability"; });
  rejects(s.CheckEvidenceSchema, unavailable, (v) => { v.reason = "\u{1F600}".repeat(1025); });
  rejects(s.AssuranceExecutionSchema, execution, (v) => { v.checks[0].result = "failed"; });
  rejects(s.AssuranceExecutionSchema, execution, (v) => { v.traceStatus = "incomplete"; });
  rejects(s.AssuranceExecutionSchema, execution, (v) => { v.status = "blocked"; });
});
test("frozen programs reject future data handles and checkpoint authority cannot invent completed effects", () => {
  rejects(s.GovernedProgramSchema, program, (v) => { v.operations[1].inputs = ["future"]; });
  rejects(s.GovernedProgramSchema, program, (v) => { v.operations[2].kind = "run_command"; });
  rejects(s.GovernedProgramSchema, program, (v) => { v.operations.push({ kind: "read", id: "late", path: "data.json" }); });
  rejects(s.HttpGovernedCheckpointSchema, checkpoint, (v) => { v.cursor = 99; });
  rejects(s.HttpGovernedCheckpointSchema, checkpoint, (v) => { v.values[0].id = "fabricated"; });
  rejects(s.HttpGovernedCheckpointSchema, checkpoint, (v) => { v.values[0].content = "sealed canary"; });
  rejects(s.HttpGovernedCheckpointSchema, checkpoint, (v) => { v.status = "complete"; });
  rejects(s.HttpGovernedCheckpointSchema, checkpoint, (v) => { v.effects = [{ actionId: "unknown", kind: "external-call", requestDigest: hash, state: "completed", approvalDigest: hash, resultDigest: hash }]; });
  rejects(s.ActionApprovalSchema, actionApproval, (v) => { v.reason = "  "; });
});
test("valid traces require contiguous chains and matching completed boundaries, while legacy cannot claim a trace", () => {
  rejects(s.GovernanceTraceSchema, trace, (v) => { v.frames[1].sequence = 2; });
  rejects(s.GovernanceTraceSchema, trace, (v) => { v.frames[1].previousDigest = otherHash; });
  rejects(s.GovernanceTraceSchema, trace, (v) => { v.frames[1].correlationId = "different"; });
  rejects(s.GovernanceTraceSchema, trace, (v) => { v.frames.pop(); v.headDigest = hash; });
  rejects(s.GovernanceFrameSchema, end, (v) => { v.after = null; });
  rejects(s.GovernanceFrameSchema, begin, (v) => { v.action = "unknown"; });
  rejects(s.GovernanceTraceSchema, legacyTrace, (v) => { v.frames = [begin]; });
  assert.equal(s.GovernanceTraceSchema.safeParse({ ...trace, status: "incomplete", frames: [begin], headDigest: hash }).success, true);
  assert.equal(s.GovernanceFrameSchema.safeParse({ ...end, outcome: "refused" }).success, true);
  rejects(s.GovernanceFrameSchema, end, (v) => { delete v.explicitRetry; });
  rejects(s.GovernanceFrameSchema, begin, (v) => { v.outcome = "refused"; });
  assert.deepEqual(["pending", "success", "failed", "incomplete", "refused"].map((outcome) => s.governanceOutcomeBlocks(outcome)), [false, false, true, true, false]);
});
test("governance epoch anchors are strict, versioned, non-empty documents registered for emission", () => {
  const epochs = { schemaVersion: s.SCHEMA_VERSION.governanceEpochs, epochs: [{ sequence: 0, approvalId: approval.approvalId, adopted: true, recordedAt: at, previousDigest: null, digest: hash }, { sequence: 1, approvalId: null, adopted: false, recordedAt: at, previousDigest: hash, digest: otherHash }] };
  assert.equal(s.SCHEMA_VERSION.governanceEpochs, "legion-cli-governance-epochs/v1");
  assert.equal(s.GovernanceEpochsSchema.safeParse(epochs).success, true);
  rejects(s.GovernanceEpochsSchema, epochs, (v) => { v.epochs = []; });
  rejects(s.GovernanceEpochsSchema, epochs, (v) => { v.epochs[0].extra = true; });
  rejects(s.GovernanceEpochsSchema, epochs, (v) => { v.epochs[1].digest = "not-a-digest"; });
  rejects(s.GovernanceEpochsSchema, epochs, (v) => { v.schemaVersion = "legion-cli-governance-epochs/v2"; });
  assert.ok(s.JSON_SCHEMA_FILES.includes("governance-epochs"));
});
test("delivery inventory and terminal outcome refuse changed subjects and ambiguous exported members", () => {
  rejects(s.DeliveryProductSchema, product, (v) => { v.entries[0].mode = "160000"; });
  rejects(s.DeliveryProductSchema, product, (v) => { v.scope = "host-native-product"; });
  rejects(s.DeliveryProductSchema, product, (v) => { v.entries.push({ ...v.entries[0], path: "DATA.JSON" }); });
  rejects(s.DeliverySnapshotSchema, snapshot, (v) => { v.outcome.confirmedSubjectDigest = otherHash; });
  rejects(s.DeliverySnapshotSchema, snapshot, (v) => { v.outcome.confirmationId = "different"; });
  rejects(s.DeliverySnapshotSchema, snapshot, (v) => { v.outcome.traceEndDigest = hash; });
  rejects(s.DeliveryManifestSchema, manifest, (v) => { v.members[0].path = "../private.json"; });
  rejects(s.DeliveryManifestSchema, manifest, (v) => { v.members[0].path = v.members[1].path; });
  rejects(s.DeliveryManifestSchema, manifest, (v) => { v.members[0].size = 64 * 1024 * 1024 + 1; });
  rejects(s.DeliveryOutcomeSchema, outcome, (v) => { v.pullRequest = { status: "created", number: 0 }; });
  rejects(s.DeliveryOutcomeSchema, outcome, (v) => { v.commit = { status: "verified", oid: hash.slice(0, 39) }; });
});
test("delivery evidence digests distinguish unknown from recorded failures and passes", () => {
  const local = { ...clone(evidence), acceptance: [{ id: "AC-1", status: "unknown", evidenceDigest: null, recordedAt: at }] };
  assert.equal(s.DeliveryEvidenceSchema.safeParse(local).success, true);
  for (const status of ["passed", "failed"]) {
    const known = { ...clone(evidence), acceptance: [{ id: "AC-1", status, evidenceDigest: hash, recordedAt: at }] };
    assert.equal(s.DeliveryEvidenceSchema.safeParse(known).success, true);
    rejects(s.DeliveryEvidenceSchema, known, (v) => { v.acceptance[0].evidenceDigest = null; });
  }
  rejects(s.DeliveryEvidenceSchema, local, (v) => { v.acceptance[0].evidenceDigest = hash; });

  const publicUnknown = { ...clone(predicate), identities: [{ token, kind: "acceptance", digest: null }], acceptance: [{ token, status: "unknown", evidenceDigest: null }] };
  assert.equal(s.DeliveryPredicateSchema.safeParse(publicUnknown).success, true);
  for (const status of ["passed", "failed"]) {
    const known = { ...clone(predicate), identities: [{ token, kind: "acceptance", digest: null }], acceptance: [{ token, status, evidenceDigest: hash }] };
    assert.equal(s.DeliveryPredicateSchema.safeParse(known).success, true);
    rejects(s.DeliveryPredicateSchema, known, (v) => { v.acceptance[0].evidenceDigest = null; });
  }
  rejects(s.DeliveryPredicateSchema, publicUnknown, (v) => { v.acceptance[0].evidenceDigest = hash; });
});

test("public predicates reject authored strings and trust requires externally supplied explicit pins", () => {
  rejects(s.DeliveryPredicateSchema, predicate, (v) => { v.confirmation = "private://authored-project"; });
  rejects(s.DeliveryPredicateSchema, predicate, (v) => { v.identities = [{ token, kind: "profile", digest: hash, name: "private-model" }]; });
  rejects(s.DeliveryPredicateSchema, predicate, (v) => { v.checks = [{ token, status: "passed", inputDigest: hash, resultDigest: hash }]; });
  rejects(s.DeliveryTrustSchema, trust, (v) => { v.localKeys = []; });
  rejects(s.DeliveryTrustSchema, trust, (v) => { v.localKeys[0].sha256 = "self-supplied-key-id"; });
  rejects(s.DeliveryTrustSchema, trust, (v) => { v.ci = { repository: "owner/repo", certificateSan: "https://github.com/owner/*", issuer: "https://token.actions.githubusercontent.com", signerWorkflow: "owner/repo/.github/workflows/delivery.yml", signerDigest: hash, sourceDigest: hash, trustedRootPath: "external/root.json", trustedRootSha256: hash, trustedRootCapturedAt: at }; });
});
test("native admission requires proven platform-appropriate guard metadata without guest-selected host paths", () => {
  const { hostSha256: _hash, ...probe } = runtime;
  assert.deepEqual(s.NativeHostProbeSchema.parse(probe), probe);
  rejects(s.NativeHostProbeSchema, probe, (v) => { v.guardVerified = false; });
  rejects(s.NativeHostProbeSchema, probe, (v) => { v.guard = "unix-address-space"; });
  rejects(s.NativeHostProbeSchema, probe, (v) => { v.path = "operator-selected-host.exe"; });
  rejects(s.NativeHostProbeSchema, probe, (v) => { v.version = "arbitrary-runtime"; });
});
test("guest packet binds unit records exactly and rejects undeclared raw source embedding in control documents", () => {
  const input = { abi: "legion-validator/v1", projectCheckId: "business-price", extensionCheckId: "json-contract", acceptanceIds: ["AC-1"], unitIds: ["price"], configuration: {}, files: [{ kind: "missing", path: "data.json" }], units: [{ unitId: "price", path: "source.ts", syntaxDigest: hash, syntaxProjection: ["variable", "price", 42] }] };
  assert.deepEqual(s.ComponentInputSchema.parse(input), input);
  rejects(s.ComponentInputSchema, input, (v) => { v.unitIds = []; });
  rejects(s.ComponentInputSchema, input, (v) => { v.files.push({ kind: "missing", path: "DATA.JSON" }); });
  rejects(s.ComponentInputSchema, input, (v) => { v.files[0].content = "hidden-source"; });
  rejects(s.ComponentInputSchema, input, (v) => { v.units[0].syntaxProjection = "x".repeat(8 * 1024 * 1024); });
  const invocation = fixtures.find(([schema]) => schema === s.ComponentInvocationSchema)[1];
  rejects(s.ComponentInvocationSchema, invocation, (v) => { v.checks[0].source = "embedded bytes"; });
});
test("checkpoint cursor cannot skip a completed write without its durable effect receipt", () => {
  const complete = { ...clone(checkpoint), cursor: 4, effects: [{ operationId: "publish", actionId: "publish", kind: "write", authority: { programKind: "governed", authorityDigest: hash, programFingerprint: hash }, sinkId: "model", requestDigest: hash, valueDigest: hash, state: "completed", approvalDigest: hash, outcome: { kind: "success", resultDigest: hash }, resultDigest: hash, responseDigest: null, responseBytes: null }], status: "complete", blocker: null };
  const parsed = s.HttpGovernedCheckpointSchema.safeParse(complete);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  rejects(s.HttpGovernedCheckpointSchema, complete, (v) => { v.effects = []; });
  rejects(s.HttpGovernedCheckpointSchema, complete, (v) => { v.effects[0].state = "uncertain"; v.effects[0].resultDigest = null; });
  rejects(s.AssuranceApprovalSchema, approval, (v) => { v.approvedAt = "2026-02-30T12:00:00.000Z"; });
});
