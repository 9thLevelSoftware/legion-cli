import assert from "node:assert/strict";
import test from "node:test";
import * as s from "../dist/index.js";

const hash = "a".repeat(64);
const at = "2026-10-03T12:00:00.000Z";
const label = { origins: ["file-origin"], integrity: "approved", confidentiality: "workspace" };
const identities = {
  promptFingerprint: hash, configurationFingerprint: hash, contractFingerprint: hash, sourceFingerprint: hash,
  jailFingerprint: hash, hostFingerprint: hash, approvalId: "approval-1", policyFingerprint: hash,
  provider: { endpoint: "https://provider.example/v1", model: "fixture", profile: "profile" },
};
const usage = { requestCharge: 1, inputTokens: 2, outputTokens: 3, totalTokens: 5, tokenLowerBound: 5, costUsd: null, tokenAccounting: "complete", costAccounting: "incomplete" };
const roleUsage = { requests: 0, inputTokens: null, outputTokens: null, costUsd: null, tokenLowerBound: 0, tokenAccounting: "complete", costAccounting: "complete" };
const operationUsage = { planner: structuredClone(roleUsage), quarantined: structuredClone(roleUsage) };
const program = { operations: [{ kind: "read", id: "input", path: "input.txt" }, { kind: "write", id: "publish", path: "output.txt", value: "input", expectedTargetDigest: null }, { kind: "finish", id: "finish" }] };
const checkpoint = {
  schemaVersion: s.SCHEMA_VERSION.httpGovernedCheckpoint, phase: "program", runId: "run-1", bootstrapAuthorityDigest: hash,
  programAuthorityDigest: hash, programKind: "governed", programFingerprint: hash, identities, program, candidateProgram: null,
  revision: 4, bootstrapProviderCalls: [], providerCalls: [], usage: structuredClone(operationUsage), cursor: 1,
  values: [{ id: "input", digest: hash, bytes: 0, label, producer: { kind: "read", operationId: "input", path: "input.txt", sourceDigest: hash }, retained: null }],
  effects: [], status: "blocked", blocker: "approval-required", recordedAt: at,
};
const approval = {
  schemaVersion: s.SCHEMA_VERSION.actionApproval, approvalId: "approval-1", runId: "run-1", actionId: "action-1",
  programKind: "governed", authorityDigest: hash, programFingerprint: hash, actionKind: "write", policyFingerprint: hash,
  valueDigest: hash, sinkId: "sink-1", requestDigest: hash, approvedAt: at, operatorId: "operator-1", reason: "exact target reviewed", state: "approved",
};
const providerCall = {
  actionId: "action-2", sequence: 1, authority: { programKind: "governed", authorityDigest: hash, programFingerprint: hash },
  role: "quarantined", purpose: { kind: "derive", operationId: "transform-result" }, sinkId: "profile", bodyDigest: hash,
  requestDigest: hash, requestBytes: 10, valueDigest: hash, label, inputs: [{ id: "input", digest: hash, bytes: 0, label }], state: "pending", approvalDigest: null,
  outcome: null, responseDigest: null, responseBytes: null,
  usage: { requestCharge: 1, inputTokens: null, outputTokens: null, totalTokens: null, tokenLowerBound: 0, costUsd: null, tokenAccounting: "incomplete", costAccounting: "incomplete" },
};

function validCallCheckpoint(call = providerCall) {
  const value = structuredClone(checkpoint);
  value.program = { operations: [
    { kind: "read", id: "input", path: "input.txt" },
    { kind: "write", id: "publish", path: "output.txt", value: "input", expectedTargetDigest: null },
    { kind: "derive", id: "transform-result", transformationId: "transform", inputs: ["input"] },
    { kind: "finish", id: "finish" },
  ] };
  value.cursor = 2;
  value.providerCalls = [call];
  value.effects = [{ operationId: "publish", actionId: "action-3", kind: "write", authority: providerCall.authority, sinkId: "sink-1", requestDigest: hash, valueDigest: hash, state: "completed", approvalDigest: null, outcome: { kind: "success", resultDigest: hash }, resultDigest: hash, responseDigest: null, responseBytes: null }];
  value.usage.quarantined = { requests: call.usage.requestCharge, inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens, costUsd: call.usage.costAccounting === "complete" ? call.usage.costUsd : null, tokenLowerBound: call.usage.tokenLowerBound, tokenAccounting: call.usage.tokenAccounting, costAccounting: call.usage.costAccounting };
  return value;
}

test("action approval requires independent program authority binding and action kind", () => {
  assert.equal(s.ActionApprovalSchema.safeParse(approval).success, true);
  for (const field of ["programKind", "authorityDigest", "programFingerprint", "actionKind"]) {
    const bad = { ...approval };
    delete bad[field];
    assert.equal(s.ActionApprovalSchema.safeParse(bad).success, false, field);
  }
  assert.equal(s.ActionApprovalSchema.safeParse({ ...approval, extra: true }).success, false);
});

test("file provenance binds exact bytes to an explicit action or verification producer", () => {
  const base = {
    schemaVersion: s.SCHEMA_VERSION.fileProvenance,
    approvalId: "approval-1",
    policyFingerprint: hash,
    files: [{ path: "output.json", sha256: hash, label, producer: { kind: "governed-action", runId: "run-1", actionId: "action-1" }, recordedAt: at }],
  };
  assert.equal(s.FileProvenanceSchema.safeParse(base).success, true);
  assert.equal(s.FileProvenanceSchema.safeParse({ ...base, files: [{ ...base.files[0], producer: { kind: "verification", runId: "run-1", checkIds: ["check-1"], commandFingerprint: hash } }] }).success, true);
  assert.equal(s.FileProvenanceSchema.safeParse({ ...base, files: [{ ...base.files[0], producer: { kind: "verification", runId: "run-1", checkIds: [], commandFingerprint: hash } }] }).success, false);
  assert.equal(s.FileProvenanceSchema.safeParse({ ...base, files: [{ ...base.files[0], producer: { ...base.files[0].producer, actionId: "action-1", unexpected: true } }] }).success, false);
});

test("checkpoint requires exact phase and globally unique action IDs", () => {
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(checkpoint).success, true);
  const duplicate = validCallCheckpoint();
  duplicate.effects = [{ operationId: "publish", actionId: "action-2", kind: "write", authority: providerCall.authority, sinkId: "sink-1", requestDigest: hash, valueDigest: hash, state: "completed", approvalDigest: null, outcome: { kind: "success", resultDigest: hash }, resultDigest: hash, responseDigest: null, responseBytes: null }];
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(duplicate).success, false);
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse({ ...checkpoint, phase: "bootstrap", programAuthorityDigest: hash }).success, false);
});

test("awaiting approval is a durable undispatched effect at the current cursor", () => {
  const awaiting = structuredClone(checkpoint);
  awaiting.effects = [{ operationId: "publish", actionId: "action-1", kind: "write", authority: { programKind: "governed", authorityDigest: hash, programFingerprint: hash }, sinkId: "sink-1", requestDigest: hash, valueDigest: hash, state: "awaiting-approval", approvalDigest: null, outcome: null, resultDigest: null, responseDigest: null, responseBytes: null }];
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(awaiting).success, true);
  awaiting.effects[0].approvalDigest = hash;
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(awaiting).success, false);
  awaiting.effects[0].approvalDigest = null;
  awaiting.effects[0].state = "pending";
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(awaiting).success, true);
  awaiting.effects[0].state = "completed";
  awaiting.effects[0].outcome = { kind: "success", resultDigest: hash };
  awaiting.effects[0].resultDigest = hash;
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(awaiting).success, false, "completed success cannot sit at cursor");
});

test("provider ledger charges pending calls and preserves usage monotonicity", () => {
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(validCallCheckpoint()).success, true);
  const freePending = validCallCheckpoint({ ...providerCall, usage: { ...providerCall.usage, requestCharge: 0 } });
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(freePending).success, false);
  const lowerUsage = validCallCheckpoint({ ...providerCall, usage: { ...providerCall.usage, inputTokens: 2, outputTokens: 3, totalTokens: 5, tokenLowerBound: 3, tokenAccounting: "complete" } });
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(lowerUsage).success, false);
});
test("program checkpoints retain a separately validated bootstrap ledger and aggregate its usage", () => {
  const historical = {
    ...providerCall,
    actionId: "bootstrap-plan",
    sequence: 1,
    authority: { programKind: "bootstrap", authorityDigest: hash, programFingerprint: hash },
    role: "planner",
    purpose: { kind: "plan" },
    inputs: [],
    state: "completed",
    outcome: { kind: "success", resultDigest: hash },
    responseDigest: hash,
    responseBytes: 1,
    usage,
  };
  const value = validCallCheckpoint({ ...providerCall, sequence: 2 });
  value.bootstrapProviderCalls = [historical];
  value.usage.planner = {
    requests: 1,
    inputTokens: 2,
    outputTokens: 3,
    costUsd: null,
    tokenLowerBound: 5,
    tokenAccounting: "complete",
    costAccounting: "incomplete",
  };
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(value).success, true);
  const wrongAuthority = structuredClone(value);
  wrongAuthority.bootstrapProviderCalls[0].authority.authorityDigest = "b".repeat(64);
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(wrongAuthority).success, false);
  const wrongSequence = structuredClone(value);
  wrongSequence.providerCalls[0].sequence = 1;
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(wrongSequence).success, false);
  const droppedAccounting = structuredClone(value);
  droppedAccounting.usage.planner.requests = 0;
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(droppedAccounting).success, false);
  const duplicateAction = structuredClone(value);
  duplicateAction.bootstrapProviderCalls[0].actionId = duplicateAction.providerCalls[0].actionId;
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(duplicateAction).success, false);
  const unresolvedHistory = structuredClone(value);
  unresolvedHistory.bootstrapProviderCalls[0].state = "pending";
  unresolvedHistory.bootstrapProviderCalls[0].outcome = null;
  unresolvedHistory.bootstrapProviderCalls[0].responseDigest = null;
  unresolvedHistory.bootstrapProviderCalls[0].responseBytes = null;
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(unresolvedHistory).success, false);
});

test("provider completion requires paired positive response evidence and failure receipts", () => {
  const success = { ...providerCall, state: "completed", outcome: { kind: "success", resultDigest: hash }, responseDigest: hash, responseBytes: 1, approvalDigest: hash, usage };
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(validCallCheckpoint(success)).success, true);
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(validCallCheckpoint({ ...success, approvalDigest: null })).success, true);
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(validCallCheckpoint({ ...success, responseDigest: null, responseBytes: null })).success, false);
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(validCallCheckpoint({ ...success, responseBytes: 0 })).success, false);
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(validCallCheckpoint({ ...success, responseBytes: null })).success, false);
  const approvedPending = { ...providerCall, approvalDigest: hash };
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(validCallCheckpoint(approvedPending)).success, true);
  const approvedAwaiting = { ...providerCall, state: "awaiting-approval", approvalDigest: hash, usage: { ...providerCall.usage, requestCharge: 0 } };
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(validCallCheckpoint(approvedAwaiting)).success, false);
  const unreceivedTransportFailure = { ...providerCall, state: "completed", outcome: { kind: "failure", code: "transport-failure" }, responseDigest: null, responseBytes: null };
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(validCallCheckpoint(unreceivedTransportFailure)).success, true);
  const unreceivedInvalidOutput = { ...unreceivedTransportFailure, outcome: { kind: "failure", code: "invalid-output" } };
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(validCallCheckpoint(unreceivedInvalidOutput)).success, false);
});

test("stage and provider ledger role usage remain consistent", () => {
  const bootstrap = {
    schemaVersion: s.SCHEMA_VERSION.httpGovernedCheckpoint, phase: "bootstrap", runId: "run-1",
    bootstrapAuthorityDigest: hash, programAuthorityDigest: null, identities, revision: 4,
    providerCalls: [{ ...providerCall, role: "planner", purpose: { kind: "plan" }, authority: { ...providerCall.authority, programKind: "bootstrap" }, inputs: [] }],
    usage: {
      planner: { requests: 1, inputTokens: null, outputTokens: null, costUsd: null, tokenLowerBound: 0, tokenAccounting: "incomplete", costAccounting: "incomplete" },
      quarantined: structuredClone(roleUsage),
    },
    status: "blocked", blocker: "approval-required", recordedAt: at, candidateProgram: null, cursor: 0, values: [], effects: [],
  };
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(bootstrap).success, true);
  const wrongBootstrapRole = structuredClone(bootstrap);
  wrongBootstrapRole.providerCalls[0].role = "quarantined";
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(wrongBootstrapRole).success, false);
  const wrongProgramRole = validCallCheckpoint({ ...providerCall, role: "planner", purpose: { kind: "plan" }, inputs: [] });
  wrongProgramRole.usage.planner = { requests: 1, inputTokens: null, outputTokens: null, costUsd: null, tokenLowerBound: 0, tokenAccounting: "incomplete", costAccounting: "incomplete" };
  wrongProgramRole.usage.quarantined = structuredClone(roleUsage);
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(wrongProgramRole).success, false);
});

test("program rejects future references and admits external-call values only after successful completion", () => {
  const future = { operations: [{ kind: "write", id: "write", path: "out", value: "later", expectedTargetDigest: null }, { kind: "read", id: "later", path: "in" }, { kind: "finish", id: "finish" }] };
  assert.equal(s.GovernedProgramSchema.safeParse(future).success, false);
  const external = { operations: [{ kind: "external-call", id: "remote", grantId: "grant", authority: {}, data: [] }, { kind: "write", id: "write", path: "out", value: "remote", expectedTargetDigest: null }, { kind: "finish", id: "finish" }] };
  assert.equal(s.GovernedProgramSchema.safeParse(external).success, true);
  const withExternal = structuredClone(checkpoint);
  withExternal.program = external;
  withExternal.cursor = 1;
  withExternal.values = [{ id: "remote", digest: hash, bytes: 0, label: { origins: ["remote-origin"], integrity: "untrusted", confidentiality: "sealed" }, producer: { kind: "external-call", operationId: "remote", actionId: "action-3" }, retained: null }];
  withExternal.effects = [];
  withExternal.providerCalls = [{ ...providerCall, actionId: "action-3", purpose: { kind: "external-call", operationId: "remote", grantId: "grant" }, inputs: [], state: "completed", outcome: { kind: "success", resultDigest: hash }, responseDigest: hash, responseBytes: 1, usage }];
  withExternal.usage.quarantined = { requests: 1, inputTokens: 2, outputTokens: 3, costUsd: null, tokenLowerBound: 5, tokenAccounting: "complete", costAccounting: "incomplete" };
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(withExternal).success, true);
  const mcpEffect = structuredClone(withExternal);
  mcpEffect.providerCalls = [];
  mcpEffect.usage.quarantined = structuredClone(roleUsage);
  mcpEffect.effects = [{ operationId: "remote", actionId: "action-3", kind: "external-call", authority: providerCall.authority, sinkId: "sink-1", requestDigest: hash, valueDigest: hash, state: "completed", approvalDigest: null, outcome: { kind: "success", resultDigest: hash }, resultDigest: hash, responseDigest: hash, responseBytes: 1 }];
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(mcpEffect).success, true);
  mcpEffect.effects[0].responseDigest = null;
  mcpEffect.effects[0].responseBytes = null;
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(mcpEffect).success, false);
  withExternal.providerCalls[0].purpose.grantId = "other";
  assert.equal(s.HttpGovernedCheckpointSchema.safeParse(withExternal).success, false);
});

test("authority is an immutable bootstrap/program discriminated union", () => {
  const bootstrap = { schemaVersion: s.SCHEMA_VERSION.httpRunAuthority, stage: "bootstrap", runId: "run-1", taskId: "task-1", identities, manifestDigest: hash, plannerInputDigest: hash, programKind: "bootstrap", programFingerprint: hash, createdAt: at };
  const programAnchor = { schemaVersion: s.SCHEMA_VERSION.httpRunAuthority, stage: "program", runId: "run-1", taskId: "task-1", identities, bootstrapAuthorityDigest: hash, plannerCallId: "action-2", plannerResultDigest: hash, programKind: "governed", programFingerprint: hash, program, createdAt: at };
  assert.equal(s.HttpRunAuthoritySchema.safeParse(bootstrap).success, true);
  assert.equal(s.HttpRunAuthoritySchema.safeParse(programAnchor).success, true);
  assert.equal(s.HttpRunAuthoritySchema.safeParse({ ...bootstrap, program }).success, false);
});
