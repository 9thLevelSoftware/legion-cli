import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { canonicalJson } from "@9thlevelsoftware/legion-cli-persist";
import { assembleGovernedMcpArguments } from "@9thlevelsoftware/legion-cli-http";
import { createDurableGovernedHost } from "../dist/assurance-flow-host.js";
import { approveGovernedAction, buildApprovedHttpAssuranceContext, buildVerificationInformationFlow, joinLabels, namespacedOrigin, remoteResponseLabel } from "../dist/assurance-flow.js";
import { deriveBootstrapFingerprint, newApproval, persistProtectedActionApproval, recordOpaqueVerificationFileProvenance } from "../dist/assurance-flow-host.js";
function base32(bytes) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let accumulator = 0;
  let result = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function domainDigest(domain, value) {
  return sha256(`${domain}\0${canonicalJson(value)}`);
}

function durableContext(projectRoot, sourceBytes, consentRequired = false, taskContract = {}, policy = {}) {
  const digest = "d".repeat(64);
  const sourceDigest = sha256(sourceBytes);
  return {
    runId: "run-flow-durable",
    taskId: "task-flow-durable",
    identities: {
      promptFingerprint: digest,
      configurationFingerprint: digest,
      contractFingerprint: digest,
      sourceFingerprint: digest,
      jailFingerprint: digest,
      hostFingerprint: digest,
      approvalId: "approval-flow-durable",
      policyFingerprint: digest,
      provider: { endpoint: "https://example.test/v1", model: "fixture", profile: "default" },
    },
    manifestDigest: digest,
    plannerInput: {
      approvedMetadata: { task: { id: "task-flow-durable" } },
      label: { origins: ["file-approved"], integrity: "approved", confidentiality: "workspace" },
      taskContract,
    },
    policy: {
      sinks: [{ id: "planner", origin: "https://example.test/v1", classifications: consentRequired ? ["public"] : ["workspace"] }],
      sources: [{ id: "input", path: "src/input.txt", classification: "workspace" }],
      baselineSources: [{ path: "src/input.txt", sha256: sourceDigest }],
      task: { taskId: "task-flow-durable", readPaths: ["src/input.txt"], transformationIds: [] },
      transformations: [],
      ...policy,
    },
  };
}

async function makeDurableFixture(sourceText = "approved source\n", consentRequired = false, taskContract = {}, policy = {}, hostOptions = {}) {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "legion-assurance-flow-durable-"));
  const sourceBytes = new TextEncoder().encode(sourceText);
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src", "input.txt"), sourceBytes);
  const context = durableContext(projectRoot, sourceBytes, consentRequired, taskContract, policy);
  const store = { projectRoot };
  const host = await createDurableGovernedHost({
    store,
    withLock: async (callback) => callback(),
    resolveCurrentContext: async () => context,
    jailRoot: projectRoot,
    ...hostOptions,
  }, context);
  const state = await host.open(context, false);
  const runKey = sha256(`legion-cli-governed-run-path/v1\0${context.runId}`);
  const runDir = join(projectRoot, ".legion-cli", "audit", "http-governed", runKey);
  const checkpointPath = join(runDir, "http-governed-checkpoint.json");
  const authorityPath = join(runDir, "bootstrap-authority.json");
  return {
    projectRoot,
    sourceBytes,
    context,
    store,
    host,
    state,
    checkpointPath,
    authorityPath,
    cleanup: () => rm(projectRoot, { recursive: true, force: true }),
  };
}

async function freezeReadProgram(fixture, program = { operations: [{ kind: "read", id: "read-one", path: "src/input.txt" }, { kind: "finish", id: "finish" }] }) {
  const { context, host, state, authorityPath } = fixture;
  const bootstrap = JSON.parse(await readFile(authorityPath, "utf8"));
  const messages = [
    { role: "system", content: "Produce one strict governed JSON program. Only use the supplied approved metadata and contract. No tools or commands." },
    { role: "user", content: canonicalJson({ approvedMetadata: context.plannerInput.approvedMetadata, taskContract: context.plannerInput.taskContract }) },
  ];
  const requestBody = new TextEncoder().encode(JSON.stringify({
    model: context.identities.provider.model,
    messages,
    temperature: 0,
    stream: false,
  }));
  const bodyDigest = sha256(requestBody);
  const requestDigest = sha256(new TextEncoder().encode(canonicalJson({
    version: 1,
    endpoint: context.identities.provider.endpoint,
    model: context.identities.provider.model,
    profile: context.identities.provider.profile,
    bodyDigest,
  })));
  const intent = {
    kind: "provider",
    actionId: "planner-call",
    authority: {
      programKind: "bootstrap",
      authorityDigest: state.checkpoint.bootstrapAuthorityDigest,
      programFingerprint: deriveBootstrapFingerprint(context),
    },
    sinkId: "planner",
    requestDigest,
    valueDigest: sha256(new TextEncoder().encode(canonicalJson(messages))),
    inputs: [],
    role: "planner",
    purpose: { kind: "plan" },
    endpoint: context.identities.provider.endpoint,
    model: context.identities.provider.model,
    bodyDigest,
    requestBytes: requestBody.byteLength,
    requestBody,
    inputValues: [],
    label: context.plannerInput.label,
    usage: {
      requestCharge: 0,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      tokenLowerBound: 0,
      costUsd: null,
      tokenAccounting: "incomplete",
      costAccounting: "incomplete",
    },
  };
  const admission = await host.prepareEffect(state.revision, intent);
  assert.equal(admission.kind, "ready");
  const completed = await host.completeEffect(admission.permit, {
    outcome: { kind: "success", resultDigest: domainDigest("legion-cli-governed-program/v1", program) },
    providerUsage: { ...intent.usage, requestCharge: 1 },
    producedValue: null,
    producedBytes: null,
    candidateProgram: program,
    responseDigest: "e".repeat(64),
    responseBytes: 1,
  });
  assert.equal(bootstrap.programKind, "bootstrap");
  const frozen = await host.freezeProgram(completed.revision);
  assert.equal(frozen.checkpoint.phase, "program");
  assert.equal(frozen.checkpoint.programKind, "governed");
  assert.equal(frozen.checkpoint.programAuthorityDigest.length, 64);
  assert.deepEqual(frozen.checkpoint.providerCalls, []);
  assert.equal(frozen.checkpoint.bootstrapProviderCalls.length, 1);
  assert.equal(frozen.checkpoint.bootstrapProviderCalls[0].role, "planner");
  assert.equal(frozen.checkpoint.bootstrapProviderCalls[0].purpose.kind, "plan");
  assert.equal(frozen.checkpoint.bootstrapProviderCalls[0].authority.authorityDigest, frozen.checkpoint.bootstrapAuthorityDigest);
  assert.equal(frozen.checkpoint.bootstrapProviderCalls[0].authority.programKind, "bootstrap");
  assert.equal(frozen.checkpoint.usage.planner.requests, 1);
  assert.equal(frozen.checkpoint.usage.planner.tokenAccounting, "incomplete");
  assert.equal(frozen.checkpoint.usage.planner.costAccounting, "incomplete");
  return frozen;
}

function readValueFromEvidence(operation, evidence, content) {
  return {
    id: operation.id,
    digest: evidence.digest,
    bytes: evidence.bytes,
    label: evidence.label,
    producer: { kind: "read", operationId: operation.id, path: operation.path, sourceDigest: evidence.digest },
    retained: evidence.label.confidentiality === "sealed" ? null : { encoding: "utf8", content: new TextDecoder().decode(content) },
  };
}

function makePlannerIntent(fixture) {
  const { context, state } = fixture;
  const messages = [
    { role: "system", content: "Produce one strict governed JSON program. Only use the supplied approved metadata and contract. No tools or commands." },
    { role: "user", content: canonicalJson({ approvedMetadata: context.plannerInput.approvedMetadata, taskContract: context.plannerInput.taskContract }) },
  ];
  const requestBody = new TextEncoder().encode(JSON.stringify({
    model: context.identities.provider.model,
    messages,
    temperature: 0,
    stream: false,
  }));
  const bodyDigest = sha256(requestBody);
  const requestDigest = sha256(new TextEncoder().encode(canonicalJson({
    version: 1,
    endpoint: context.identities.provider.endpoint,
    model: context.identities.provider.model,
    profile: context.identities.provider.profile,
    bodyDigest,
  })));
  return {
    kind: "provider",
    actionId: "planner-call",
    authority: {
      programKind: "bootstrap",
      authorityDigest: state.checkpoint.bootstrapAuthorityDigest,
      programFingerprint: deriveBootstrapFingerprint(context),
    },
    sinkId: "planner",
    requestDigest,
    valueDigest: sha256(new TextEncoder().encode(canonicalJson(messages))),
    inputs: [],
    role: "planner",
    purpose: { kind: "plan" },
    endpoint: context.identities.provider.endpoint,
    model: context.identities.provider.model,
    bodyDigest,
    requestBytes: requestBody.byteLength,
    requestBody,
    inputValues: [],
    label: context.plannerInput.label,
    usage: {
      requestCharge: 0,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      tokenLowerBound: 0,
      costUsd: null,
      tokenAccounting: "incomplete",
      costAccounting: "incomplete",
    },
  };
}

test("namespaced provenance origins use the shared full-digest descriptor domains", () => {
  const cases = [
    ["file", { sourceId: "main", path: "src/main.ts" }],
    ["remote", { grantId: "external", authority: { endpoint: "https://example.test" }, endpoint: "https://example.test", model: "model", profile: "default" }],
    ["remote", { grantId: "mcp", transportFingerprint: "a".repeat(64), schemaFingerprint: "b".repeat(64), fixedAuthority: { tool: "lookup" } }],
  ];
  for (const [namespace, descriptor] of cases) {
    const digest = createHash("sha256").update(`legion-cli-${namespace}-origin/v1\0`).update(canonicalJson(descriptor)).digest();
    assert.equal(namespacedOrigin(namespace, descriptor), `${namespace}-${base32(digest)}`);
  }
});

test("remote response labels join inputs and control, then seal as untrusted", () => {
  const request = { origins: ["file-a", "file-b"], integrity: "approved", confidentiality: "public" };
  const control = { origins: ["file-policy"], integrity: "approved", confidentiality: "workspace" };
  const remote = namespacedOrigin("remote", { grantId: "g", endpoint: "https://example.test" });
  assert.deepEqual(remoteResponseLabel(request, control, remote), {
    origins: ["file-a", "file-b", "file-policy", remote].sort(),
    integrity: "untrusted",
    confidentiality: "sealed",
  });
  assert.deepEqual(joinLabels([request, control]), {
    origins: ["file-a", "file-b", "file-policy"],
    integrity: "approved",
    confidentiality: "workspace",
  });
});

test("durable host rejects forged bootstrap values and candidate programs in progress saves", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "legion-assurance-flow-"));
  try {
    const digest = "a".repeat(64);
    const context = {
      runId: "run-flow-test",
      taskId: "task-flow-test",
      identities: {
        promptFingerprint: digest,
        configurationFingerprint: digest,
        contractFingerprint: digest,
        sourceFingerprint: digest,
        jailFingerprint: digest,
        hostFingerprint: digest,
        approvalId: "approval-flow-test",
        policyFingerprint: digest,
        provider: { endpoint: "https://example.test/v1", model: "fixture", profile: "default" },
      },
      manifestDigest: digest,
      plannerInput: {
        approvedMetadata: {},
        label: { origins: ["file-approved"], integrity: "approved", confidentiality: "workspace" },
        taskContract: {},
      },
      policy: {},
    };
    const host = await createDurableGovernedHost({
      store: { projectRoot },
      withLock: async (callback) => callback(),
      resolveCurrentContext: async () => context,
      jailRoot: projectRoot,
    }, context);
    const state = await host.open(context, false);
    const forgedValue = {
      id: "invented",
      digest,
      bytes: 1,
      label: { origins: ["file-approved"], integrity: "approved", confidentiality: "workspace" },
      producer: { kind: "read", operationId: "invented", path: "src/file.txt", sourceDigest: digest },
      retained: { encoding: "utf8", value: "x" },
    };
    await assert.rejects(() => host.saveProgress(state.revision, { ...state.checkpoint, values: [forgedValue] }));
    await assert.rejects(() => host.saveProgress(state.revision, { ...state.checkpoint, candidateProgram: { operations: [] } }));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("approved builder allows only configured loopback HTTP and binds task acceptance scope", async () => {
  const digest = "b".repeat(64);
  const task = {
    id: "task-flow",
    specId: "spec-flow",
    title: "Scoped task",
    type: "feature",
    priority: "P2",
    contract: { filesAllowed: ["out.txt"], filesForbidden: [], expectedArtifacts: ["out.txt"], verificationCommands: [], maxFilesTouched: 1 },
  };
  const plan = {
    schemaVersion: "legion-cli-assurance-plan/v1",
    specId: "spec-flow",
    acceptanceIds: ["ac-one", "ac-two"],
    taskIds: ["task-flow"],
    security: {
      mode: "information-flow",
      sources: [
        { id: "source", path: "src/input.txt", classification: "workspace" },
        { id: "private-source", path: "src/private.txt", classification: "sealed" },
      ],
      sinks: [],
      transformations: [],
      tasks: [{ taskId: "task-flow", readPaths: ["src/input.txt"], transformationIds: [] }],
      externalCalls: [],
    },
    knowledge: [{ id: "unit", statement: "Scoped knowledge", source: { path: "src/input.txt" }, acceptanceIds: ["ac-one"], taskIds: ["task-flow"], dependsOn: [], checkIds: [] }],
    validators: [],
    delivery: { artifacts: [] },
  };
  const approval = {
    schemaVersion: "legion-cli-assurance-approval/v1",
    approvalId: "approval-flow",
    specId: "spec-flow",
    planFingerprint: digest,
    manifestDigest: digest,
    approvedAt: "2025-01-01T00:00:00.000Z",
    nativeHost: null,
    baselineSources: [
      { path: "src/input.txt", sha256: digest },
      { path: "src/private.txt", sha256: digest },
    ],
  };
  const spec = {
    id: "spec-flow",
    title: "Flow fixture",
    problem: "Fixture",
    acceptance: [
      { id: "ac-one", statement: "First", kind: "behavior" },
      { id: "ac-two", statement: "Unrelated", kind: "behavior" },
    ],
  };
  const options = (allowLoopback, configEndpoint, taskPlan = plan) => ({
    store: { projectRoot: "." },
    withLock: async (callback) => callback(),
    plan: taskPlan,
    approval,
    spec,
    task,
    runId: "run-flow-builder",
    skillId: "execute",
    config: { adapter: { http: { baseUrl: configEndpoint, allowLoopback } } },
    profile: "default",
    provider: { endpoint: "http://127.0.0.1:8080/v1", model: "fixture", profile: "default" },
    promptFingerprint: digest,
    configurationFingerprint: digest,
    contractFingerprint: digest,
    sourceFingerprint: digest,
    jailFingerprint: digest,
    jailRoot: ".",
    manifestDigest: digest,
    allowedWrites: ["out.txt"],
    filesForbidden: [],
    artifactPaths: ["out.txt"],
  });
  const context = await buildApprovedHttpAssuranceContext(options(true, "http://127.0.0.1:8080/v1"));
  assert.deepEqual(context.plannerInput.approvedMetadata.task.acceptanceIds, ["ac-one"]);
  assert.deepEqual(context.plannerInput.approvedMetadata.spec.acceptance.map((criterion) => criterion.id), ["ac-one"]);
  assert.deepEqual(context.plannerInput.taskContract.verificationCommands, []);
  assert.equal(canonicalJson(context.plannerInput.approvedMetadata).includes("Unrelated"), false);
  const flow = buildVerificationInformationFlow(plan, approval, task);
  assert.deepEqual(flow.label, {
    origins: [
      `file-${base32(createHash("sha256").update("legion-cli-file-origin/v1\0").update(canonicalJson({ sourceId: "source", path: "src/input.txt" })).digest())}`,
      `file-${base32(createHash("sha256").update("legion-cli-file-origin/v1\0").update(canonicalJson({ sourceId: "private-source", path: "src/private.txt" })).digest())}`,
      `file-${base32(createHash("sha256").update("legion-cli-file-origin/v1\0").update(canonicalJson({ sourceId: "unclassified-readable", path: "." })).digest())}`,
    ].sort(),
    integrity: "untrusted",
    confidentiality: "sealed",
  });
  assert.ok(flow.installedEnginePaths.length > 0);
  for (const name of ["typescript", "bindings"]) {
    assert.ok(flow.readOnlyEnginePaths.some((path) => basename(path) === name), `runtime closure includes ${name}`);
  }
  for (const path of flow.installedEnginePaths) assert.ok(flow.readOnlyEnginePaths.includes(path));
  await assert.rejects(() => buildApprovedHttpAssuranceContext(options(false, "http://127.0.0.1:8080/v1")));
  await assert.rejects(() => buildApprovedHttpAssuranceContext(options(true, "http://127.0.0.1:8081/v1")));
  const emptyScope = structuredClone(plan);
  emptyScope.knowledge = [];
  await assert.rejects(() => buildApprovedHttpAssuranceContext(options(true, "http://127.0.0.1:8080/v1", emptyScope)));
});

test("effect admission refuses non-approval blockers and completed runs", async () => {
  const fixture = await makeDurableFixture();
  try {
    const blocked = { ...fixture.state.checkpoint, status: "blocked", blocker: "invalid-output" };
    await writeFile(fixture.checkpointPath, JSON.stringify(blocked));
    const malformedIntent = { actionId: "new-action", requestDigest: "a".repeat(64), valueDigest: "b".repeat(64) };
    await assert.rejects(() => fixture.host.prepareEffect(fixture.state.revision, malformedIntent));
  } finally {
    await fixture.cleanup();
  }
  const completeFixture = await makeDurableFixture();
  try {
    let state = await freezeReadProgram(completeFixture);
    const operation = state.checkpoint.program.operations[state.checkpoint.cursor];
    const source = await completeFixture.host.readSource(operation.path);
    const value = readValueFromEvidence(operation, source.evidence, source.content);
    state = await completeFixture.host.saveProgress(state.revision, {
      ...state.checkpoint,
      cursor: 1,
      values: [value],
    });
    state = await completeFixture.host.saveProgress(state.revision, {
      ...state.checkpoint,
      cursor: 2,
      status: "complete",
      blocker: null,
    });
    const malformedIntent = { actionId: "new-action", requestDigest: "a".repeat(64), valueDigest: "b".repeat(64) };
    await assert.rejects(() => completeFixture.host.prepareEffect(state.revision, malformedIntent));
  } finally {
    await completeFixture.cleanup();
  }
});

test("approval resume preserves only the exact approved awaiting action", async () => {
  const fixture = await makeDurableFixture("approved source\n", true);
  try {
    const intent = makePlannerIntent(fixture);
    const blocked = await fixture.host.prepareEffect(fixture.state.revision, intent);
    assert.equal(blocked.kind, "blocked");
    assert.equal(blocked.code, "approval-required");
    const mismatched = { ...intent, actionId: "different-action" };
    await assert.rejects(() => fixture.host.prepareEffect(blocked.state.revision, mismatched), /approval-required/);
    const approved = newApproval({
      runId: fixture.context.runId,
      actionId: intent.actionId,
      programKind: intent.authority.programKind,
      authorityDigest: intent.authority.authorityDigest,
      programFingerprint: intent.authority.programFingerprint,
      actionKind: "provider",
      policyFingerprint: fixture.context.identities.policyFingerprint,
      valueDigest: intent.valueDigest,
      sinkId: intent.sinkId,
      requestDigest: intent.requestDigest,
      operatorId: "test-operator",
      reason: "Approve the exact planned request",
      state: "approved",
    });
    await persistProtectedActionApproval(fixture.store, approved);
    const resumed = await fixture.host.open(fixture.context, true);
    assert.equal(resumed.checkpoint.status, "blocked");
    assert.equal(resumed.checkpoint.blocker, "approval-required");
    const ready = await fixture.host.prepareEffect(resumed.revision, intent);
    assert.equal(ready.kind, "ready");
    assert.equal(ready.state.checkpoint.status, "running");
    assert.equal(ready.state.checkpoint.blocker, null);
  } finally {
    await fixture.cleanup();
  }
});

test("progress cannot clear a blocker or complete before every frozen operation succeeds", async () => {
  const blockedFixture = await makeDurableFixture();
  try {
    const state = await freezeReadProgram(blockedFixture);
    await writeFile(blockedFixture.checkpointPath, JSON.stringify({ ...state.checkpoint, status: "blocked", blocker: "invalid-output" }));
    await assert.rejects(() => blockedFixture.host.saveProgress(state.revision, {
      ...state.checkpoint,
      status: "running",
      blocker: null,
    }));
  } finally {
    await blockedFixture.cleanup();
  }
  const unfinishedFixture = await makeDurableFixture();
  try {
    const state = await freezeReadProgram(unfinishedFixture);
    await assert.rejects(() => unfinishedFixture.host.saveProgress(state.revision, {
      ...state.checkpoint,
      cursor: 2,
      status: "complete",
      blocker: null,
    }));
  } finally {
    await unfinishedFixture.cleanup();
  }
});

test("a source read receipt admits only its exact one-time value transition", async () => {
  const fixture = await makeDurableFixture();
  try {
    const state = await freezeReadProgram(fixture);
    const operation = state.checkpoint.program.operations[state.checkpoint.cursor];
    const source = await fixture.host.readSource(operation.path);
    const value = readValueFromEvidence(operation, source.evidence, source.content);
    const updated = await fixture.host.saveProgress(state.revision, {
      ...state.checkpoint,
      cursor: state.checkpoint.cursor + 1,
      values: [...state.checkpoint.values, value],
    });
    assert.equal(updated.checkpoint.cursor, 1);
    assert.deepEqual(updated.checkpoint.usage.planner, state.checkpoint.usage.planner);
    await assert.rejects(() => fixture.host.saveProgress(updated.revision, {
      ...updated.checkpoint,
      cursor: 2,
      status: "complete",
      blocker: null,
      values: [...updated.checkpoint.values, value],
    }));
  } finally {
    await fixture.cleanup();
  }
});

test("source receipts reject mutated values and source bytes changed after reading", async () => {
  const mutatedFixture = await makeDurableFixture();
  try {
    const state = await freezeReadProgram(mutatedFixture);
    const operation = state.checkpoint.program.operations[state.checkpoint.cursor];
    const source = await mutatedFixture.host.readSource(operation.path);
    const value = readValueFromEvidence(operation, source.evidence, source.content);
    value.retained.content = "tampered";
    await assert.rejects(() => mutatedFixture.host.saveProgress(state.revision, {
      ...state.checkpoint,
      cursor: 1,
      values: [value],
    }));
  } finally {
    await mutatedFixture.cleanup();
  }
  const staleFixture = await makeDurableFixture();
  try {
    const state = await freezeReadProgram(staleFixture);
    const operation = state.checkpoint.program.operations[state.checkpoint.cursor];
    const source = await staleFixture.host.readSource(operation.path);
    const value = readValueFromEvidence(operation, source.evidence, source.content);
    await writeFile(join(staleFixture.projectRoot, "src", "input.txt"), "changed source\n");
    await assert.rejects(() => staleFixture.host.saveProgress(state.revision, {
      ...state.checkpoint,
      cursor: 1,
      values: [value],
    }), /stale-authority/);
  } finally {
    await staleFixture.cleanup();
  }
});

function makeDeriveIntent(fixture, state, value, content) {
  const { context } = fixture;
  const operation = state.checkpoint.program.operations[state.checkpoint.cursor];
  const transformation = context.policy.transformations.find((entry) => entry.id === operation.transformationId);
  const evidence = { id: value.id, digest: value.digest, bytes: value.bytes, label: value.label };
  const messages = [
    { role: "system", content: "Produce only the requested governed transformation result. No tools or commands." },
    { role: "user", content: canonicalJson({ transformationId: operation.transformationId, instruction: transformation.instruction, inputs: [{ id: value.id, digest: value.digest, encoding: "utf8", content: new TextDecoder().decode(content) }] }) },
  ];
  const requestBody = new TextEncoder().encode(JSON.stringify({ model: context.identities.provider.model, messages, temperature: 0, stream: false }));
  const bodyDigest = sha256(requestBody);
  return {
    kind: "provider",
    actionId: "derive-call",
    authority: { programKind: "governed", authorityDigest: state.checkpoint.programAuthorityDigest, programFingerprint: state.checkpoint.programFingerprint },
    sinkId: "planner",
    requestDigest: sha256(new TextEncoder().encode(canonicalJson({
      version: 1,
      kind: "derive",
      endpoint: context.identities.provider.endpoint,
      model: context.identities.provider.model,
      profile: context.identities.provider.profile,
      operationId: operation.id,
      valueDigests: [value.digest],
      bodyDigest,
    }))),
    valueDigest: sha256(new TextEncoder().encode(canonicalJson(messages))),
    inputs: [evidence],
    role: "quarantined",
    purpose: { kind: "derive", operationId: operation.id },
    endpoint: context.identities.provider.endpoint,
    model: context.identities.provider.model,
    bodyDigest,
    requestBytes: requestBody.byteLength,
    requestBody,
    inputValues: [{ evidence, content }],
    label: joinLabels([context.plannerInput.label, value.label]),
    usage: { requestCharge: 0, inputTokens: null, outputTokens: null, totalTokens: null, tokenLowerBound: 0, costUsd: null, tokenAccounting: "incomplete", costAccounting: "incomplete" },
  };
}

test("source bytes changed after approval read as a sealed unexplained change until a new baseline is approved", async () => {
  const policy = { transformations: [{ id: "summarize", instruction: "Summarize the approved input" }] };
  const program = {
    operations: [
      { kind: "read", id: "read-one", path: "src/input.txt" },
      { kind: "derive", id: "derive-one", transformationId: "summarize", inputs: ["read-one"] },
      { kind: "finish", id: "finish" },
    ],
  };
  const sourceOrigin = namespacedOrigin("file", { sourceId: "input", path: "src/input.txt" });
  const changedFixture = await makeDurableFixture(undefined, false, {}, policy);
  try {
    await writeFile(join(changedFixture.projectRoot, "src", "input.txt"), "changed source\n");
    const frozen = await freezeReadProgram(changedFixture, program);
    const source = await changedFixture.host.readSource("src/input.txt");
    assert.deepEqual(source.evidence.label, {
      origins: [sourceOrigin, namespacedOrigin("file", { sourceId: "unexplained-change", path: "src/input.txt" })].sort(),
      integrity: "untrusted",
      confidentiality: "sealed",
    });
    const value = readValueFromEvidence(program.operations[0], source.evidence, source.content);
    const state = await changedFixture.host.saveProgress(frozen.revision, { ...frozen.checkpoint, cursor: 1, values: [value] });
    assert.deepEqual(state.checkpoint.values[0].label, source.evidence.label);
    assert.equal(state.checkpoint.values[0].retained, null);
    const admission = await changedFixture.host.prepareEffect(state.revision, makeDeriveIntent(changedFixture, state, state.checkpoint.values[0], source.content));
    assert.equal(admission.kind, "blocked");
    assert.equal(admission.code, "approval-required");
    assert.equal(admission.state.checkpoint.providerCalls.at(-1).state, "awaiting-approval");
    assert.equal(admission.state.checkpoint.providerCalls.at(-1).label.confidentiality, "sealed");
  } finally {
    await changedFixture.cleanup();
  }
  const reapprovedFixture = await makeDurableFixture("changed source\n", false, {}, policy);
  try {
    const frozen = await freezeReadProgram(reapprovedFixture, program);
    const source = await reapprovedFixture.host.readSource("src/input.txt");
    assert.deepEqual(source.evidence.label, { origins: [sourceOrigin], integrity: "untrusted", confidentiality: "workspace" });
    const state = await reapprovedFixture.host.saveProgress(frozen.revision, {
      ...frozen.checkpoint,
      cursor: 1,
      values: [readValueFromEvidence(program.operations[0], source.evidence, source.content)],
    });
    const admission = await reapprovedFixture.host.prepareEffect(state.revision, makeDeriveIntent(reapprovedFixture, state, state.checkpoint.values[0], source.content));
    assert.equal(admission.kind, "ready");
  } finally {
    await reapprovedFixture.cleanup();
  }
});

const REVIEW_ARTIFACT = ".legion-cli/cache/runs/run-flow-durable/review.md";
const reviewContract = { kind: "independent-review", artifact: REVIEW_ARTIFACT, allowedWrites: [REVIEW_ARTIFACT], artifactPaths: [] };
const reviewPolicy = { task: { taskId: "independent-review", readPaths: ["src/input.txt"], transformationIds: [] } };

async function stageReviewWrite(fixture, path) {
  const operation = { kind: "write", id: "write-notes", path, value: "read-one", expectedTargetDigest: null };
  const program = { operations: [{ kind: "read", id: "read-one", path: "src/input.txt" }, operation, { kind: "finish", id: "finish" }] };
  const frozen = await freezeReadProgram(fixture, program);
  const source = await fixture.host.readSource("src/input.txt");
  const state = await fixture.host.saveProgress(frozen.revision, { ...frozen.checkpoint, cursor: 1, values: [readValueFromEvidence(program.operations[0], source.evidence, source.content)] });
  const value = state.checkpoint.values[0];
  return {
    state,
    content: source.content,
    intent: {
      kind: "write",
      actionId: "write-notes",
      authority: { programKind: "governed", authorityDigest: state.checkpoint.programAuthorityDigest, programFingerprint: state.checkpoint.programFingerprint },
      operationId: operation.id,
      path,
      value: { id: value.id, digest: value.digest, label: value.label },
      valueDigest: value.digest,
      requestDigest: "c".repeat(64),
      sinkId: "writer",
      expectedTargetDigest: null,
    },
  };
}

test("a governed review writes a workspace value to its exact artifact without operator approval", async () => {
  const fixture = await makeDurableFixture(undefined, false, reviewContract, reviewPolicy);
  try {
    const { state, intent, content } = await stageReviewWrite(fixture, REVIEW_ARTIFACT);
    assert.equal(intent.value.label.confidentiality, "workspace");
    const ready = await fixture.host.prepareEffect(state.revision, intent);
    assert.equal(ready.kind, "ready");
    const effect = ready.state.checkpoint.effects.find((entry) => entry.actionId === intent.actionId);
    assert.equal(effect.state, "pending");
    assert.equal(effect.approvalDigest, null);
    await fixture.host.dispatchWrite(ready.permit, content);
    assert.deepEqual(new Uint8Array(await readFile(join(fixture.projectRoot, REVIEW_ARTIFACT))), new Uint8Array(content));
  } finally {
    await fixture.cleanup();
  }
});

test("a governed review refuses sealed artifact values and every other destination", async () => {
  const sealedFixture = await makeDurableFixture(undefined, false, reviewContract, reviewPolicy);
  try {
    await writeFile(join(sealedFixture.projectRoot, "src", "input.txt"), "unexplained review input\n");
    const { state, intent } = await stageReviewWrite(sealedFixture, REVIEW_ARTIFACT);
    assert.equal(intent.value.label.confidentiality, "sealed");
    await assert.rejects(() => sealedFixture.host.prepareEffect(state.revision, intent), /policy-denied/);
  } finally {
    await sealedFixture.cleanup();
  }
  const otherPath = ".legion-cli/cache/runs/run-flow-durable/x.md";
  const otherFixture = await makeDurableFixture(undefined, false, { ...reviewContract, allowedWrites: [REVIEW_ARTIFACT, otherPath] }, reviewPolicy);
  try {
    const { state, intent } = await stageReviewWrite(otherFixture, otherPath);
    await assert.rejects(() => otherFixture.host.prepareEffect(state.revision, intent), /policy-denied/);
    assert.equal(existsSync(join(otherFixture.projectRoot, otherPath)), false);
  } finally {
    await otherFixture.cleanup();
  }
});

test("a governed review context reads approved task inputs and expected artifacts only", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "legion-assurance-review-scope-"));
  try {
    const inputBytes = new TextEncoder().encode("approved review input\n");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(join(projectRoot, "src", "input.txt"), inputBytes);
    await writeFile(join(projectRoot, "src", "private.txt"), "private\n");
    await writeFile(join(projectRoot, "out.txt"), "task deliverable\n");
    const digest = "b".repeat(64);
    const plan = {
      schemaVersion: "legion-cli-assurance-plan/v1",
      specId: "spec-flow",
      acceptanceIds: ["ac-one"],
      taskIds: ["task-flow"],
      security: {
        mode: "information-flow",
        sources: [
          { id: "source", path: "src/input.txt", classification: "workspace" },
          { id: "private-source", path: "src/private.txt", classification: "sealed" },
        ],
        sinks: [],
        transformations: [{ id: "summarize", instruction: "Summarize" }],
        tasks: [{ taskId: "task-flow", readPaths: ["src/input.txt"], transformationIds: ["summarize"] }],
        externalCalls: [],
      },
      knowledge: [],
      validators: [],
      delivery: { artifacts: [] },
    };
    const approval = {
      schemaVersion: "legion-cli-assurance-approval/v1",
      approvalId: "approval-flow",
      specId: "spec-flow",
      planFingerprint: digest,
      manifestDigest: digest,
      approvedAt: "2025-01-01T00:00:00.000Z",
      nativeHost: null,
      baselineSources: [
        { path: "src/input.txt", sha256: sha256(inputBytes) },
        { path: "src/private.txt", sha256: sha256("private\n") },
      ],
    };
    const artifact = ".legion-cli/cache/runs/run-review-scope/review.md";
    const options = {
      store: { projectRoot },
      plan,
      approval,
      spec: { id: "spec-flow", title: "Flow fixture", problem: "Fixture", acceptance: [{ id: "ac-one", statement: "First", kind: "behavior" }] },
      task: null,
      runId: "run-review-scope",
      skillId: "review",
      config: { adapter: { http: { baseUrl: "http://127.0.0.1:8080/v1", allowLoopback: true } } },
      profile: "default",
      provider: { endpoint: "http://127.0.0.1:8080/v1", model: "fixture", profile: "default" },
      promptFingerprint: digest,
      configurationFingerprint: digest,
      contractFingerprint: digest,
      sourceFingerprint: digest,
      jailFingerprint: digest,
      jailRoot: projectRoot,
      manifestDigest: digest,
      allowedWrites: [artifact],
      filesForbidden: [],
      artifactPaths: [],
      reviewContract: {
        kind: "independent-review",
        artifact,
        acceptance: [{ id: "ac-one", statement: "First" }],
        tasks: [
          { id: "task-flow", title: "Scoped task", filesAllowed: ["out.txt"], filesForbidden: [], expectedArtifacts: ["out.txt"] },
          { id: "task-outside-plan", title: "Unplanned", filesAllowed: ["other.txt"], filesForbidden: [], expectedArtifacts: ["other.txt"] },
        ],
      },
    };
    const context = await buildApprovedHttpAssuranceContext(options);
    assert.deepEqual(context.policy.task, { taskId: "independent-review", readPaths: ["out.txt", "src/input.txt"], transformationIds: ["summarize"] });
    const host = await createDurableGovernedHost({ ...options, withLock: async (callback) => callback(), resolveCurrentContext: async () => context }, context);
    await host.open(context, false);
    const input = await host.readSource("src/input.txt");
    assert.deepEqual(input.evidence.label, { origins: [namespacedOrigin("file", { sourceId: "source", path: "src/input.txt" })], integrity: "untrusted", confidentiality: "workspace" });
    const deliverable = await host.readSource("out.txt");
    assert.equal(new TextDecoder().decode(deliverable.content), "task deliverable\n");
    assert.equal(deliverable.evidence.label.confidentiality, "sealed");
    assert.ok(deliverable.evidence.label.origins.includes(namespacedOrigin("file", { sourceId: "unclassified", path: "out.txt" })));
    await assert.rejects(() => host.readSource("src/private.txt"), /policy-denied/);
    await writeFile(join(projectRoot, "other.txt"), "not reviewable\n");
    await assert.rejects(() => host.readSource("other.txt"), /policy-denied/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("verification provenance hashes artifacts larger than source reads without buffering them", async () => {
  const fixture = await makeDurableFixture();
  try {
    let state = await freezeReadProgram(fixture);
    const operation = state.checkpoint.program.operations[state.checkpoint.cursor];
    const source = await fixture.host.readSource(operation.path);
    const value = readValueFromEvidence(operation, source.evidence, source.content);
    state = await fixture.host.saveProgress(state.revision, { ...state.checkpoint, cursor: 1, values: [value] });
    state = await fixture.host.saveProgress(state.revision, { ...state.checkpoint, cursor: 2, status: "complete", blocker: null });
    const path = "src/large-artifact.bin";
    const bytes = Buffer.alloc(1024 * 1024 + 1, 0x5a);
    await writeFile(join(fixture.projectRoot, path), bytes);
    const commandFingerprint = "f".repeat(64);
    await recordOpaqueVerificationFileProvenance({
      store: fixture.store,
      runId: fixture.context.runId,
      approvalId: fixture.context.identities.approvalId,
      taskId: fixture.context.taskId,
      checkId: `verify-${commandFingerprint.slice(0, 32)}`,
      commandFingerprint,
      inventory: { path, beforeDigest: null, afterDigest: sha256(bytes) },
      label: { origins: [], integrity: "untrusted", confidentiality: "workspace" },
    });
    const record = await readFile(join(fixture.projectRoot, ".legion-cli", "workflow", "file-provenance.yaml"), "utf8");
    assert.ok(record.includes(path));
    assert.ok(record.includes(sha256(bytes)));
  } finally {
    await fixture.cleanup();
  }
});

test("source reads refuse hardlinked protected control files aliased into public scope", async (t) => {
  const fixture = await makeDurableFixture();
  try {
    const aliasPath = join(fixture.projectRoot, "src", "public-alias.txt");
    const controlBytes = await readFile(fixture.checkpointPath);
    try {
      await link(fixture.checkpointPath, aliasPath);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
        t.skip("hard links are unavailable on this platform");
        return;
      }
      throw error;
    }
    const digest = sha256(controlBytes);
    fixture.context.policy.sources.push({ id: "public-alias", path: "src/public-alias.txt", classification: "public" });
    fixture.context.policy.baselineSources.push({ path: "src/public-alias.txt", sha256: digest });
    fixture.context.policy.task.readPaths.push("src/public-alias.txt");
    await assert.rejects(() => fixture.host.readSource("src/public-alias.txt"));
  } finally {
    await fixture.cleanup();
  }
});
test("approveGovernedAction requires the exact pending action and is single-use", async () => {
  const fixture = await makeDurableFixture(undefined, false, {
    allowedWrites: ["src/result.txt"],
    filesAllowed: ["src/result.txt"],
    filesForbidden: [],
    maxFilesTouched: 1,
  });
  try {
    const operation = { kind: "write", id: "write-approval", path: "src/result.txt", value: "read-one", expectedTargetDigest: null };
    const program = { operations: [{ kind: "read", id: "read-one", path: "src/input.txt" }, operation, { kind: "finish", id: "finish" }] };
    const frozen = await freezeReadProgram(fixture, program);
    const source = await fixture.host.readSource("src/input.txt");
    const state = await fixture.host.saveProgress(frozen.revision, {
      ...frozen.checkpoint,
      cursor: 1,
      values: [readValueFromEvidence(program.operations[0], source.evidence, source.content)],
    });
    const value = state.checkpoint.values[0];
    const intent = {
      kind: "write",
      actionId: operation.id,
      authority: {
        programKind: "governed",
        authorityDigest: state.checkpoint.programAuthorityDigest,
        programFingerprint: state.checkpoint.programFingerprint,
      },
      operationId: operation.id,
      path: operation.path,
      value: { id: value.id, digest: value.digest, label: value.label },
      valueDigest: value.digest,
      requestDigest: "c".repeat(64),
      sinkId: "writer",
      expectedTargetDigest: null,
    };
    const pending = await fixture.host.prepareEffect(state.revision, intent);
    assert.equal(pending.kind, "blocked");
    assert.equal(pending.code, "approval-required");
    const approve = (overrides = {}) => approveGovernedAction({
      store: fixture.store,
      withLock: async (callback) => callback(),
      resolveCurrentContext: async () => fixture.context,
      runId: fixture.context.runId,
      actionId: intent.actionId,
      valueDigest: intent.valueDigest,
      sinkId: intent.sinkId,
      operatorId: "fixture-operator",
      reason: "Approve this exact fixture write",
      ...overrides,
    });
    await assert.rejects(() => approve({ valueDigest: "0".repeat(64) }), /stale-authority/);
    const approval = await approve();
    assert.equal(approval.state, "approved");
    assert.equal(approval.actionId, intent.actionId);
    await assert.rejects(() => approve(), /stale-authority/);
  } finally {
    await fixture.cleanup();
  }
});

test("dispatchWrite refuses a target hardlinked to its protected checkpoint before mutation", async (t) => {
  const fixture = await makeDurableFixture(undefined, false, {
    allowedWrites: ["src/protected-alias.txt"],
    filesAllowed: ["src/protected-alias.txt"],
    filesForbidden: [],
    maxFilesTouched: 1,
  });
  try {
    const operation = { kind: "write", id: "write-one", path: "src/protected-alias.txt", value: "read-one", expectedTargetDigest: null };
    const program = { operations: [{ kind: "read", id: "read-one", path: "src/input.txt" }, operation, { kind: "finish", id: "finish" }] };
    const frozen = await freezeReadProgram(fixture, program);
    const source = await fixture.host.readSource("src/input.txt");
    const updated = await fixture.host.saveProgress(frozen.revision, {
      ...frozen.checkpoint,
      cursor: 1,
      values: [readValueFromEvidence(program.operations[0], source.evidence, source.content)],
    });
    const value = updated.checkpoint.values[0];
    const valueDigest = value.digest;
    const intent = {
      kind: "write",
      actionId: "write-hardlink",
      authority: {
        programKind: "governed",
        authorityDigest: updated.checkpoint.programAuthorityDigest,
        programFingerprint: updated.checkpoint.programFingerprint,
      },
      operationId: operation.id,
      path: operation.path,
      value: { id: value.id, digest: valueDigest, label: value.label },
      valueDigest,
      requestDigest: "a".repeat(64),
      sinkId: "writer",
      expectedTargetDigest: null,
    };
    const admission = await fixture.host.prepareEffect(updated.revision, intent);
    assert.equal(admission.kind, "blocked");
    const approval = newApproval({
      runId: fixture.context.runId,
      actionId: intent.actionId,
      programKind: intent.authority.programKind,
      authorityDigest: intent.authority.authorityDigest,
      programFingerprint: intent.authority.programFingerprint,
      actionKind: "write",
      policyFingerprint: fixture.context.identities.policyFingerprint,
      valueDigest,
      sinkId: intent.sinkId,
      requestDigest: intent.requestDigest,
      operatorId: "fixture-operator",
      reason: "Test governed write hardlink refusal",
      state: "approved",
    });
    await persistProtectedActionApproval(fixture.store, approval);
    const ready = await fixture.host.prepareEffect(admission.state.revision, intent);
    assert.equal(ready.kind, "ready");
    const aliasPath = join(fixture.projectRoot, operation.path);
    const protectedBytes = await readFile(fixture.checkpointPath);
    try {
      await link(fixture.checkpointPath, aliasPath);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
        t.skip("hard links are unavailable on this platform");
        return;
      }
      throw error;
    }
    await assert.rejects(() => fixture.host.dispatchWrite(ready.permit, new TextEncoder().encode("overwritten")));
    assert.deepEqual(await readFile(fixture.checkpointPath), protectedBytes);
  } finally {
    await fixture.cleanup();
  }
});

const MCP_INPUT_SCHEMA = {
  type: "object",
  properties: { account: { type: "string" }, query: { type: "string" } },
  required: ["account", "query"],
  additionalProperties: false,
};
const MCP_AUTHORITY = { account: "fixed-account" };

async function makeMcpFixture(pointer, sent) {
  const transport = { transport: "streamable-http", fingerprint: "a".repeat(64), schemaFingerprint: "b".repeat(64), fixedAuthority: MCP_AUTHORITY };
  const policy = {
    sinks: [
      { id: "planner", origin: "https://example.test/v1", classifications: ["workspace"] },
      { id: "mcp-sink", origin: "https://fixture.example/mcp", classifications: ["workspace"] },
    ],
    externalCalls: [{
      id: "lookup",
      taskIds: ["task-flow-durable"],
      tool: "fixture:lookup",
      sinkId: "mcp-sink",
      authority: MCP_AUTHORITY,
      dataPointers: [pointer],
      effect: "http-mcp",
      providerTarget: null,
      transport,
    }],
  };
  const descriptor = { grantId: "lookup", tool: "fixture:lookup", transport: "streamable-http", transportFingerprint: transport.fingerprint, schemaFingerprint: transport.schemaFingerprint, fixedAuthority: MCP_AUTHORITY };
  const fixture = await makeDurableFixture('"approved query"\n', false, {}, policy, {
    externalTools: [descriptor],
    assembleMcpArguments: (tool, data) => assembleGovernedMcpArguments(MCP_INPUT_SCHEMA, tool.fixedAuthority, data),
    dispatchMcp: async (_tool, args) => {
      sent.push(args);
      return { content: new TextEncoder().encode('{"ok":true}'), responseBytes: 11, responseDigest: "f".repeat(64) };
    },
  });
  const operation = { kind: "external-call", id: "mcp-call", grantId: "lookup", authority: MCP_AUTHORITY, data: [{ pointer, value: "read-one" }] };
  const program = { operations: [{ kind: "read", id: "read-one", path: "src/input.txt" }, operation, { kind: "finish", id: "finish" }] };
  const frozen = await freezeReadProgram(fixture, program);
  const source = await fixture.host.readSource("src/input.txt");
  const state = await fixture.host.saveProgress(frozen.revision, {
    ...frozen.checkpoint,
    cursor: 1,
    values: [readValueFromEvidence(program.operations[0], source.evidence, source.content)],
  });
  const value = state.checkpoint.values[0];
  const evidence = { id: value.id, digest: value.digest, bytes: value.bytes, label: value.label };
  const valueDigest = sha256(new TextEncoder().encode(canonicalJson({
    grantId: "lookup",
    authority: MCP_AUTHORITY,
    data: [{ pointer, value: { encoding: "utf8", content: new TextDecoder().decode(source.content) } }],
  })));
  const intentFor = (argumentsDigest) => ({
    kind: "http-mcp",
    actionId: "mcp-action",
    operationId: operation.id,
    authority: { programKind: "governed", authorityDigest: state.checkpoint.programAuthorityDigest, programFingerprint: state.checkpoint.programFingerprint },
    sinkId: "mcp-sink",
    requestDigest: sha256(new TextEncoder().encode(canonicalJson({
      version: 2,
      kind: "http-mcp",
      grantId: "lookup",
      sinkId: "mcp-sink",
      authority: MCP_AUTHORITY,
      transportFingerprint: transport.fingerprint,
      schemaFingerprint: transport.schemaFingerprint,
      dataPointers: [pointer],
      valueDigest,
      argumentsDigest,
    }))),
    valueDigest,
    inputs: [evidence],
    grantId: "lookup",
    transportFingerprint: transport.fingerprint,
    schemaFingerprint: transport.schemaFingerprint,
    fixedAuthority: MCP_AUTHORITY,
    data: [{ pointer, value: evidence, content: source.content }],
  });
  return { fixture, state, source, intentFor };
}

test("governed MCP dispatch sends the approved fixed authority and binds the final arguments into the request digest", async () => {
  const sent = [];
  const { fixture, state, source, intentFor } = await makeMcpFixture("/query", sent);
  try {
    const finalArguments = { account: "fixed-account", query: "approved query" };
    const argumentsDigest = sha256(new TextEncoder().encode(canonicalJson(finalArguments)));
    assert.equal(await fixture.host.mcpArgumentsDigest("lookup", [{ pointer: "/query", content: source.content }]), argumentsDigest);
    await assert.rejects(() => fixture.host.mcpArgumentsDigest("lookup", [{ pointer: "/account", content: source.content }]), /policy-denied/);
    await assert.rejects(() => fixture.host.prepareEffect(state.revision, intentFor("0".repeat(64))), /recovery-value-mismatch/);
    const intent = intentFor(argumentsDigest);
    const pending = await fixture.host.prepareEffect(state.revision, intent);
    assert.equal(pending.kind, "blocked");
    assert.equal(pending.code, "approval-required");
    await persistProtectedActionApproval(fixture.store, newApproval({
      runId: fixture.context.runId,
      actionId: intent.actionId,
      programKind: intent.authority.programKind,
      authorityDigest: intent.authority.authorityDigest,
      programFingerprint: intent.authority.programFingerprint,
      actionKind: "http-mcp",
      policyFingerprint: fixture.context.identities.policyFingerprint,
      valueDigest: intent.valueDigest,
      sinkId: intent.sinkId,
      requestDigest: intent.requestDigest,
      operatorId: "fixture-operator",
      reason: "Approve the exact governed MCP arguments",
      state: "approved",
    }));
    const ready = await fixture.host.prepareEffect(pending.state.revision, intent);
    assert.equal(ready.kind, "ready");
    assert.equal(sent.length, 0);
    const completion = await fixture.host.dispatchMcp(ready.permit, intent.data.map(({ pointer, content }) => ({ pointer, content })));
    assert.equal(completion.outcome.kind, "success");
    assert.deepEqual(sent, [finalArguments]);
  } finally {
    await fixture.cleanup();
  }
});

test("governed MCP admission refuses a data pointer that overlaps the approved fixed authority", async () => {
  const sent = [];
  const { fixture, state, intentFor } = await makeMcpFixture("/account", sent);
  try {
    await assert.rejects(() => fixture.host.prepareEffect(state.revision, intentFor("0".repeat(64))), /policy-denied/);
    assert.equal(sent.length, 0);
  } finally {
    await fixture.cleanup();
  }
});
