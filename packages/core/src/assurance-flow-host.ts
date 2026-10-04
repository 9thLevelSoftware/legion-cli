import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  ActionApprovalSchema,
  FileProvenanceSchema,
  ProvenanceLabelSchema,
  GovernedProgramSchema,
  GovernedValueRecordSchema,
  HttpGovernedCheckpointSchema,
  HttpRunAuthoritySchema,
  SCHEMA_VERSION,
  type ActionApproval,
  type FileProvenance,
  type GovernedValueRecord,
  type HttpGovernedCheckpoint,
  type HttpRunAuthority,
  type ProvenanceLabel,
} from "@9thlevelsoftware/legion-cli-schema";
import {
  assertAgentPathAllowed,
  assertNoLinkInPath,
  atomicWriteFile,
  canonicalJson,
  formatYamlDocument,
  parseStrictJson,
  toFsPath,
  toStorePath,
} from "@9thlevelsoftware/legion-cli-persist";
import type { LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { isAlias, isCollection, parseDocument } from "yaml";
import { normalizePathKey } from "@9thlevelsoftware/legion-cli-schema";
import type {
  ApprovedHttpAssuranceContext,
  EffectCompletion,
  EffectIntent,
  GovernedEffectHost,
  GovernedPermit,
  GovernedState,
  ProviderUsageReceipt,
  ValueEvidence,
} from "@9thlevelsoftware/legion-cli-http";
import { isImplicitForbidden, matchesGlob } from "./contracts.js";
import {
  canonicalDigest,
  joinLabels,
  labelProductBytes,
  namespacedOrigin,
  remoteResponseLabel,
  sha256,
} from "./assurance-flow-labels.js";
import type { ProductBytesLabelInput } from "./assurance-flow-labels.js";

const ROOT = ".legion-cli/audit/http-governed";
const CHECKPOINT_FILE = "http-governed-checkpoint.json";
const MAX_CHECKPOINT_BYTES = 80 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_FILE_PROVENANCE_BYTES = 64 * 1024 * 1024;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const ZERO_ROLE_USAGE = {
  requests: 0,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  tokenLowerBound: 0,
  tokenAccounting: "complete" as const,
  costAccounting: "complete" as const,
};

type BridgeOptions = {
  store: LegionStore;
  withLock: <T>(callback: () => Promise<T>) => Promise<T>;
  resolveCurrentContext: () => Promise<ApprovedHttpAssuranceContext>;
  jailRoot: string;
  externalTools?: readonly {
    grantId: string;
    transport: "sse" | "streamable-http";
    transportFingerprint: string;
    schemaFingerprint: string;
    fixedAuthority: Readonly<Record<string, unknown>>;
    tool: string;
  }[];
  /** Builds the exact final tool arguments (fixed authority plus data at declared pointers); throws when they cannot be assembled. */
  assembleMcpArguments?: (
    descriptor: NonNullable<BridgeOptions["externalTools"]>[number],
    data: readonly { pointer: string; content: Uint8Array }[],
  ) => Record<string, unknown>;
  dispatchMcp?: (
    descriptor: NonNullable<BridgeOptions["externalTools"]>[number],
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) => Promise<
    | { content: Uint8Array; responseBytes: number; responseDigest: string }
    | { failureCode: "transport-failure"; responseBytes: number; responseDigest: string }
  >;
};

type AnchorBinding = { bootstrap: HttpRunAuthority & { stage: "bootstrap" }; final: (HttpRunAuthority & { stage: "program" }) | null };

function runDirectory(projectRoot: string, runId: string): string {
  const key = sha256(`legion-cli-governed-run-path/v1\0${runId}`);
  return join(projectRoot, ROOT, key);
}

function recordPath(projectRoot: string, runId: string, file: string): string {
  return join(runDirectory(projectRoot, runId), file);
}

async function readBoundedBytes(absPath: string, root: string, maximum: number): Promise<Buffer> {
  await assertNoLinkInPath(absPath, { root });
  const handle = await open(absPath, fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum) throw new Error("governed record exceeds its size bound");
    const bytes = Buffer.alloc(before.size);
    let length = 0;
    while (length < bytes.byteLength) {
      const read = await handle.read(bytes, length, bytes.byteLength - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(absPath);
    if (length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || pathAfter.isSymbolicLink() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino) {
      throw new Error("governed record changed while being read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function digestBoundedFile(absPath: string, root: string, maximum: number): Promise<string> {
  await assertNoLinkInPath(absPath, { root });
  const pathBefore = await lstat(absPath, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.nlink !== 1n || pathBefore.size > BigInt(maximum)) throw new Error("verification output exceeds its size bound or has an unsafe identity");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(absPath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino ||
        before.size !== pathBefore.size || before.mtimeNs !== pathBefore.mtimeNs) throw new Error("verification output identity changed");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximum) throw new Error("verification output exceeds its size bound");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(absPath, { bigint: true });
    if (total !== Number(before.size) || !after.isFile() || after.nlink !== 1n ||
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.nlink !== after.nlink ||
        !pathAfter.isFile() || pathAfter.nlink !== 1n || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino ||
        pathAfter.size !== after.size || pathAfter.mtimeNs !== after.mtimeNs) throw new Error("verification output changed while being read");
    await assertNoLinkInPath(absPath, { root });
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function readProtectedBytes(absPath: string, root: string, maximum: number): Promise<Buffer> {
  const before = await lstat(absPath, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) throw new Error("protected governed record has an unsafe file identity");
  const bytes = await readBoundedBytes(absPath, root, maximum);
  const after = await lstat(absPath, { bigint: true });
  if (!after.isFile() || after.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    throw new Error("protected governed record changed while being read");
  }
  return bytes;
}
async function readJson(absPath: string, root: string, maximum: number): Promise<unknown> {
  return parseStrictJson(await readProtectedBytes(absPath, root, maximum), { maxBytes: maximum, maxDepth: 32 });
}

async function readBoundedUtf8(absPath: string, root: string, maximum: number): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readProtectedBytes(absPath, root, maximum));
}
function parseSafeYaml(text: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true, strict: true, version: "1.2" });
  if (document.errors.length || document.warnings.length) throw new Error("invalid governed YAML record");
  const pending: unknown[] = [document.contents];
  while (pending.length > 0) {
    const node = pending.pop();
    if (isAlias(node)) throw new Error("governed YAML aliases are not permitted");
    if (isCollection(node)) {
      for (const item of node.items) {
        if (item && typeof item === "object" && "key" in item && "value" in item) {
          pending.push(item.key, item.value);
        } else pending.push(item);
      }
    }
  }
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  canonicalJson(value);
  return value;
}

async function writeImmutable(absPath: string, root: string, value: unknown): Promise<void> {
  const body = `${canonicalJson(value)}\n`;
  await assertNoLinkInPath(absPath, { root });
  await ensureSafeDirectory(root, dirname(absPath));
  await assertNoLinkInPath(absPath, { root });
  const handle = await open(absPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0), 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
}

async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  const relativePath = relative(root, directory).replaceAll("\\", "/");
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("/")) throw new Error("policy-denied");
  let current = root;
  for (const component of relativePath.split("/").filter(Boolean)) {
    current = join(current, component);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertNoLinkInPath(current, { root });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("policy-denied");
  }
}

async function safeReadState(projectRoot: string, runId: string): Promise<GovernedState> {
  const path = recordPath(projectRoot, runId, CHECKPOINT_FILE);
  const parsed = HttpGovernedCheckpointSchema.parse(await readJson(path, projectRoot, MAX_CHECKPOINT_BYTES));
  if (parsed.runId !== runId || !Number.isSafeInteger(parsed.revision)) throw new Error("stale-authority");
  return { revision: parsed.revision, checkpoint: parsed };
}

async function loadAnchors(projectRoot: string, runId: string): Promise<AnchorBinding> {
  const bootstrap = HttpRunAuthoritySchema.parse(await readJson(recordPath(projectRoot, runId, "bootstrap-authority.json"), projectRoot, 2 * 1024 * 1024));
  if (bootstrap.stage !== "bootstrap" || bootstrap.runId !== runId) throw new Error("stale-authority");
  const finalPath = recordPath(projectRoot, runId, "run-authority.json");
  let final: AnchorBinding["final"] = null;
  try {
    const value = HttpRunAuthoritySchema.parse(await readJson(finalPath, projectRoot, 2 * 1024 * 1024));
    if (value.stage !== "program" || value.runId !== runId) throw new Error("stale-authority");
    final = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { bootstrap, final };
}

function authorityDigest(authority: HttpRunAuthority): string {
  return canonicalDigest("legion-cli-http-authority-record/v1", authority);
}

function identitiesWithoutProgram(context: ApprovedHttpAssuranceContext) {
  return {
    promptFingerprint: context.identities.promptFingerprint,
    configurationFingerprint: context.identities.configurationFingerprint,
    contractFingerprint: context.identities.contractFingerprint,
    sourceFingerprint: context.identities.sourceFingerprint,
    jailFingerprint: context.identities.jailFingerprint,
    hostFingerprint: context.identities.hostFingerprint,
    approvalId: context.identities.approvalId,
    policyFingerprint: context.identities.policyFingerprint,
    provider: context.identities.provider,
  };
}

function sameContext(authority: HttpRunAuthority, context: ApprovedHttpAssuranceContext): boolean {
  return authority.runId === context.runId && authority.taskId === context.taskId &&
    canonicalJson(authority.identities) === canonicalJson(identitiesWithoutProgram(context));
}

function persistedCheckpoint(projectRoot: string, checkpoint: HttpGovernedCheckpoint): Promise<void> {
  const path = recordPath(projectRoot, checkpoint.runId, CHECKPOINT_FILE);
  return atomicWriteFile(path, `${canonicalJson(HttpGovernedCheckpointSchema.parse(checkpoint))}\n`, { root: projectRoot });
}

function usageWithCharge(receipt: ProviderUsageReceipt): ProviderUsageReceipt {
  return {
    ...receipt,
    requestCharge: 1,
    tokenAccounting: receipt.inputTokens === null || receipt.outputTokens === null || receipt.totalTokens === null ? "incomplete" : receipt.tokenAccounting,
    costAccounting: receipt.costUsd === null ? "incomplete" : receipt.costAccounting,
  };
}

function reconcileRoleUsage(
  calls: HttpGovernedCheckpoint["providerCalls"],
  role: "planner" | "quarantined",
  bootstrapCalls: HttpGovernedCheckpoint["providerCalls"] = [],
) {
  const records = [...bootstrapCalls, ...calls].filter((call) => call.role === role);
  if (records.length === 0) return { ...ZERO_ROLE_USAGE };
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let tokenLowerBound = 0;
  let tokensComplete = true;
  let costsComplete = true;
  let inputKnown = true;
  let outputKnown = true;
  let costKnown = true;
  for (const call of records) {
    tokenLowerBound += call.usage.tokenLowerBound;
    if (call.usage.inputTokens === null) inputKnown = false; else inputTokens += call.usage.inputTokens;
    if (call.usage.outputTokens === null) outputKnown = false; else outputTokens += call.usage.outputTokens;
    if (call.usage.costUsd === null) costKnown = false; else costUsd += call.usage.costUsd;
    if (call.usage.tokenAccounting !== "complete") tokensComplete = false;
    if (call.usage.costAccounting !== "complete") costsComplete = false;
  }
  return {
    requests: records.reduce((sum, call) => sum + call.usage.requestCharge, 0),
    inputTokens: inputKnown ? inputTokens : null,
    outputTokens: outputKnown ? outputTokens : null,
    costUsd: costKnown ? costUsd : null,
    tokenLowerBound,
    tokenAccounting: tokensComplete ? "complete" as const : "incomplete" as const,
    costAccounting: costsComplete ? "complete" as const : "incomplete" as const,
  };
}
function reconcileCheckpointUsage(
  checkpoint: HttpGovernedCheckpoint,
  calls: HttpGovernedCheckpoint["providerCalls"],
) {
  const bootstrapCalls = checkpoint.phase === "program" ? checkpoint.bootstrapProviderCalls : [];
  return {
    planner: reconcileRoleUsage(calls, "planner", bootstrapCalls),
    quarantined: reconcileRoleUsage(calls, "quarantined", bootstrapCalls),
  };
}

function inputLabel(inputs: readonly ValueEvidence[], control: ProvenanceLabel): ProvenanceLabel {
  return joinLabels([...inputs.map((input) => input.label), control]);
}

export function deriveBootstrapFingerprint(context: ApprovedHttpAssuranceContext): string {
  return canonicalDigest("legion-cli-governed-bootstrap-recipe/v1", {
    recipe: "approved-metadata-to-frozen-program/v1",
    runId: context.runId,
    taskId: context.taskId,
    identities: context.identities,
    manifestDigest: context.manifestDigest,
    plannerInput: context.plannerInput,
    policy: context.policy,
  });
}


function checkpointAuthority(checkpoint: HttpGovernedCheckpoint, anchors: AnchorBinding): string {
  const bootstrapDigest = authorityDigest(anchors.bootstrap);
  if (checkpoint.bootstrapAuthorityDigest !== bootstrapDigest) throw new Error("stale-authority");
  const bootstrapCalls = checkpoint.phase === "program" ? checkpoint.bootstrapProviderCalls : checkpoint.providerCalls;
  if (bootstrapCalls.some((call) => call.authority.programKind !== "bootstrap" ||
      call.authority.authorityDigest !== bootstrapDigest ||
      call.authority.programFingerprint !== anchors.bootstrap.programFingerprint)) throw new Error("stale-authority");
  if (checkpoint.phase === "bootstrap") {
    if (checkpoint.programAuthorityDigest !== null) throw new Error("stale-authority");
    return bootstrapDigest;
  }
  if (!anchors.final || checkpoint.programAuthorityDigest !== authorityDigest(anchors.final) ||
      checkpoint.programFingerprint !== anchors.final.programFingerprint ||
      canonicalJson(checkpoint.program) !== canonicalJson(anchors.final.program) ||
      anchors.final.bootstrapAuthorityDigest !== bootstrapDigest) throw new Error("stale-authority");
  return checkpoint.programAuthorityDigest;
}

function pendingPermit(actionId: string, revision: number, requestDigest: string): GovernedPermit {
  return Object.freeze({ actionId, pendingRevision: revision, requestDigest });
}

function requireCurrentRevision(state: GovernedState, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected !== state.revision) throw new Error("stale-authority");
}

function consumeOrReserveApproval(approval: ActionApproval, intent: EffectIntent, context: ApprovedHttpAssuranceContext, authority: { programKind: "bootstrap" | "governed"; programFingerprint: string; authorityDigest: string }): ActionApproval {
  if (approval.state !== "approved" || approval.runId !== context.runId || approval.actionId !== intent.actionId ||
      approval.programKind !== authority.programKind || approval.programFingerprint !== authority.programFingerprint ||
      approval.authorityDigest !== authority.authorityDigest || approval.policyFingerprint !== context.identities.policyFingerprint ||
      approval.requestDigest !== intent.requestDigest || approval.valueDigest !== intent.valueDigest || approval.sinkId !== intent.sinkId) throw new Error("approval-required");
  return { ...approval, state: "reserved" };
}

function valueAt(checkpoint: HttpGovernedCheckpoint, id: string): HttpGovernedCheckpoint["values"][number] {
  if (checkpoint.phase !== "program") throw new Error("stale-authority");
  const value = checkpoint.values.find((entry) => entry.id === id);
  if (!value) throw new Error("policy-denied");
  return value;
}

function operationAt(checkpoint: HttpGovernedCheckpoint, operationId: string) {
  if (checkpoint.phase !== "program") throw new Error("stale-authority");
  const operation = checkpoint.program.operations.find((entry) => entry.id === operationId);
  if (!operation) throw new Error("stale-authority");
  return operation;
}


const SOURCE_CLASSIFICATIONS: Record<string, true> = { public: true, workspace: true, sealed: true };

function productLabelPolicy(context: ApprovedHttpAssuranceContext): Pick<ProductBytesLabelInput, "policySources" | "baselineSources"> {
  const policy = context.policy as Record<string, unknown>;
  if (!Array.isArray(policy.sources) || !Array.isArray(policy.baselineSources)) throw new Error("policy-denied");
  const policySources = policy.sources.map((entry: unknown) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    if (typeof record.id !== "string" || typeof record.path !== "string" || typeof record.classification !== "string" || SOURCE_CLASSIFICATIONS[record.classification] !== true) throw new Error("policy-denied");
    return { id: record.id, path: record.path, classification: record.classification as ProvenanceLabel["confidentiality"] };
  });
  const baselineSources = policy.baselineSources.map((entry: unknown) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    if (typeof record.path !== "string" || (record.sha256 !== null && typeof record.sha256 !== "string")) throw new Error("policy-denied");
    return { path: record.path, sha256: record.sha256 as string | null };
  });
  return { policySources, baselineSources };
}

export async function readFileProvenance(projectRoot: string): Promise<FileProvenance | null> {
  const provenancePath = toFsPath(projectRoot, ".legion-cli/workflow/file-provenance.yaml");
  try {
    await assertNoLinkInPath(provenancePath, { root: projectRoot });
    return FileProvenanceSchema.parse(parseSafeYaml(await readBoundedUtf8(provenancePath, projectRoot, 64 * 1024 * 1024)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

function exactEvidence(left: ValueEvidence, right: ValueEvidence): boolean {
  return left.id === right.id && left.digest === right.digest && left.bytes === right.bytes && canonicalJson(left.label) === canonicalJson(right.label);
}

function exactUtf8(bytes: Uint8Array): string | null {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const roundTrip = new TextEncoder().encode(value);
    return roundTrip.byteLength === bytes.byteLength && roundTrip.every((byte, index) => byte === bytes[index]) ? value : null;
  } catch {
    return null;
  }
}

function valueEnvelope(evidence: ValueEvidence, bytes: Uint8Array): Record<string, string> {
  const text = exactUtf8(bytes);
  return text === null
    ? { id: evidence.id, digest: evidence.digest, encoding: "base64", content: Buffer.from(bytes).toString("base64") }
    : { id: evidence.id, digest: evidence.digest, encoding: "utf8", content: text };
}

function retainedValue(bytes: Uint8Array): { encoding: "utf8" | "base64"; content: string } {
  const text = exactUtf8(bytes);
  return text === null
    ? { encoding: "base64", content: Buffer.from(bytes).toString("base64") }
    : { encoding: "utf8", content: text };
}

function providerMessages(intent: Extract<EffectIntent, { kind: "provider" }>, context: ApprovedHttpAssuranceContext, checkpoint: HttpGovernedCheckpoint): unknown[] {
  if (intent.purpose.kind === "plan") {
    if (checkpoint.phase !== "bootstrap") throw new Error("stale-authority");
    return [
      { role: "system", content: "Produce one strict governed JSON program. Only use the supplied approved metadata and contract. No tools or commands." },
      { role: "user", content: canonicalJson({ approvedMetadata: context.plannerInput.approvedMetadata, taskContract: context.plannerInput.taskContract }) },
    ];
  }
  if (checkpoint.phase !== "program") throw new Error("stale-authority");
  const operationId = intent.purpose.operationId;
  const operation = checkpoint.program.operations.find((candidate) => candidate.id === operationId);
  const values = intent.inputValues.map(({ evidence, content }) => {
    const declared = intent.inputs.find((input) => input.id === evidence.id);
    if (!declared || !exactEvidence(evidence, declared) || sha256(content) !== evidence.digest || content.byteLength !== evidence.bytes) throw new Error("recovery-value-mismatch");
    const retained = checkpoint.values.find((value) => value.id === evidence.id);
    if (!retained || retained.digest !== evidence.digest || retained.bytes !== evidence.bytes || canonicalJson(retained.label) !== canonicalJson(evidence.label)) throw new Error("stale-authority");
    return { evidence, content };
  });
  const supplied = new Map(values.map(({ evidence, content }) => [evidence.id, { evidence, content }] as const));
  if (intent.purpose.kind === "external-call") {
    if (!operation || operation.kind !== "external-call" || operation.grantId !== intent.purpose.grantId) throw new Error("policy-denied");
    const grant = intent.externalGrant;
    if (operation.id !== intent.purpose.operationId || !grant || grant.operationId !== operation.id || grant.grantId !== operation.grantId ||
        canonicalJson(grant.authority) !== canonicalJson(operation.authority) ||
        values.length !== operation.data.length || canonicalJson(grant.dataPointers) !== canonicalJson(operation.data.map((entry) => entry.pointer))) throw new Error("policy-denied");
    const data = operation.data.map(({ pointer, value }) => {
      const input = supplied.get(value);
      if (!input) throw new Error("policy-denied");
      const text = exactUtf8(input.content);
      return { pointer, value: text === null ? { encoding: "base64", content: Buffer.from(input.content).toString("base64") } : { encoding: "utf8", content: text } };
    });
    return [
      { role: "system", content: "Return only the opaque response for this approved external call. No tools or commands." },
      { role: "user", content: canonicalJson({ grantId: operation.grantId, authority: operation.authority, data }) },
    ];
  }
  if (!operation || operation.kind !== "derive" || operation.id !== operationId || values.length !== operation.inputs.length) throw new Error("policy-denied");
  const transformations = (context.policy as Record<string, unknown>).transformations;
  if (!Array.isArray(transformations)) throw new Error("policy-denied");
  const transformation = transformations.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === operation.transformationId) as Record<string, unknown> | undefined;
  if (!transformation || typeof transformation.instruction !== "string") throw new Error("policy-denied");
  const inputs = operation.inputs.map((id) => {
    const input = supplied.get(id);
    if (!input) throw new Error("policy-denied");
    const value = valueEnvelope(input.evidence, input.content);
    return { id, digest: input.evidence.digest, encoding: value.encoding, content: value.content };
  });
  return [
    { role: "system", content: "Produce only the requested governed transformation result. No tools or commands." },
    { role: "user", content: canonicalJson({ transformationId: operation.transformationId, instruction: transformation.instruction, inputs }) },
  ];
}

function expectedProviderBody(intent: Extract<EffectIntent, { kind: "provider" }>, context: ApprovedHttpAssuranceContext, checkpoint: HttpGovernedCheckpoint): Uint8Array {
  const expected = new TextEncoder().encode(JSON.stringify({
    model: context.identities.provider.model,
    messages: providerMessages(intent, context, checkpoint),
    temperature: 0,
    stream: false,
  }));
  if (expected.byteLength > 8 * 1024 * 1024 || expected.byteLength !== intent.requestBody.byteLength ||
      expected.some((byte, index) => byte !== intent.requestBody[index]) || sha256(intent.requestBody) !== intent.bodyDigest ||
      intent.requestBytes !== intent.requestBody.byteLength) throw new Error("recovery-value-mismatch");
  return expected;
}

function expectedProviderRequestDigest(intent: Extract<EffectIntent, { kind: "provider" }>, context: ApprovedHttpAssuranceContext): string {
  if (intent.purpose.kind === "plan") {
    return sha256(new TextEncoder().encode(canonicalJson({
      version: 1,
      endpoint: context.identities.provider.endpoint,
      model: context.identities.provider.model,
      profile: context.identities.provider.profile,
      bodyDigest: intent.bodyDigest,
    })));
  }
  if (intent.purpose.kind === "external-call") {
    const external = intent.externalGrant;
    if (!external) throw new Error("policy-denied");
    return sha256(new TextEncoder().encode(canonicalJson({
      version: 1,
      kind: "external-call-provider",
      endpoint: context.identities.provider.endpoint,
      model: context.identities.provider.model,
      profile: context.identities.provider.profile,
      grantId: external.grantId,
      sinkId: external.sinkId,
      authority: external.authority,
      pointers: [...external.dataPointers],
      bodyDigest: intent.bodyDigest,
    })));
  }
  return sha256(new TextEncoder().encode(canonicalJson({
    version: 1,
    kind: intent.purpose.kind,
    endpoint: context.identities.provider.endpoint,
    model: context.identities.provider.model,
    profile: context.identities.provider.profile,
    operationId: intent.purpose.operationId,
    valueDigests: intent.inputs.map((input) => input.digest),
    bodyDigest: intent.bodyDigest,
  })));
}

function expectedProviderValueDigest(intent: Extract<EffectIntent, { kind: "provider" }>, messages: unknown[]): string {
  if (intent.purpose.kind === "external-call") {
    const parsed = JSON.parse(String((messages[1] as Record<string, unknown>).content)) as Record<string, unknown>;
    return sha256(new TextEncoder().encode(canonicalJson(parsed)));
  }
  return sha256(new TextEncoder().encode(canonicalJson(messages)));
}
function providerConsentRequired(intent: Extract<EffectIntent, { kind: "provider" }>, context: ApprovedHttpAssuranceContext): boolean {
  const policy = context.policy as Record<string, unknown>;
  const sinks = policy.sinks;
  if (!Array.isArray(sinks)) throw new Error("policy-denied");
  const sink = sinks.find((entry) => entry && typeof entry === "object" && (
    (entry as Record<string, unknown>).id === intent.sinkId ||
    (intent.sinkId === "planner" && typeof (entry as Record<string, unknown>).origin === "string" &&
      new URL(String((entry as Record<string, unknown>).origin)).href.replace(/\/$/, "") === new URL(context.identities.provider.endpoint).href.replace(/\/$/, ""))
  )) as Record<string, unknown> | undefined;
  if (!sink || !Array.isArray(sink.classifications)) throw new Error("policy-denied");
  return !sink.classifications.includes(intent.label.confidentiality);
}

function validateProviderIntent(intent: Extract<EffectIntent, { kind: "provider" }>, context: ApprovedHttpAssuranceContext, checkpoint: HttpGovernedCheckpoint): boolean {
  if (intent.endpoint !== context.identities.provider.endpoint || intent.model !== context.identities.provider.model ||
      intent.requestBytes < 1 || intent.requestBytes > 8 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(intent.bodyDigest) || !/^[a-f0-9]{64}$/.test(intent.requestDigest)) throw new Error("policy-denied");
  const messages = providerMessages(intent, context, checkpoint);
  expectedProviderBody(intent, context, checkpoint);
  if (expectedProviderValueDigest(intent, messages) !== intent.valueDigest ||
      expectedProviderRequestDigest(intent, context) !== intent.requestDigest) throw new Error("recovery-value-mismatch");
  if (canonicalJson(intent.label) !== canonicalJson(joinLabels([context.plannerInput.label, ...intent.inputs.map((entry) => entry.label)]))) throw new Error("recovery-value-mismatch");
  const purpose = intent.purpose;
  if (purpose.kind === "plan") {
    if (checkpoint.phase !== "bootstrap" || intent.role !== "planner" || intent.externalGrant || intent.inputs.length !== 0 || intent.sinkId !== "planner") throw new Error("policy-denied");
  } else if (checkpoint.phase !== "program" || intent.role !== "quarantined") {
    throw new Error("policy-denied");
  } else if (purpose.kind === "external-call") {
    const operation = checkpoint.program.operations.find((entry) => entry.id === purpose.operationId);
    const descriptor = intent.externalGrant;
    const grants = (context.policy as Record<string, unknown>).externalCalls;
    const grantId = purpose.grantId;
    const grant = Array.isArray(grants)
      ? grants.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).id === grantId) as Record<string, unknown> | undefined
      : undefined;
    if (!operation || operation.kind !== "external-call" || operation.grantId !== purpose.grantId ||
        !descriptor || descriptor.operationId !== operation.id || descriptor.grantId !== operation.grantId ||
        !grant || grant.effect !== "provider" || grant.sinkId !== descriptor.sinkId ||
        canonicalJson(grant.authority) !== canonicalJson(operation.authority) ||
        canonicalJson(descriptor.authority) !== canonicalJson(operation.authority) ||
        canonicalJson(grant.dataPointers) !== canonicalJson(operation.data.map((entry) => entry.pointer)) ||
        canonicalJson(descriptor.dataPointers) !== canonicalJson(operation.data.map((entry) => entry.pointer)) ||
        intent.sinkId !== grant.sinkId ||
        canonicalJson(intent.inputs.map((entry) => entry.id)) !== canonicalJson(operation.data.map((entry) => entry.value))) throw new Error("policy-denied");
    const target = grant.providerTarget;
    if (!target || typeof target !== "object" || (target as Record<string, unknown>).endpoint !== context.identities.provider.endpoint ||
        (target as Record<string, unknown>).model !== context.identities.provider.model ||
        (target as Record<string, unknown>).profile !== context.identities.provider.profile) throw new Error("policy-denied");
  } else {
    const operation = checkpoint.program.operations.find((entry) => entry.id === purpose.operationId);
    if (!operation || operation.kind !== "derive" || operation.id !== purpose.operationId ||
        canonicalJson(intent.inputs.map((entry) => entry.id)) !== canonicalJson(operation.inputs) || intent.externalGrant) throw new Error("policy-denied");
  }
  return providerConsentRequired(intent, context);
}

type McpDescriptor = NonNullable<BridgeOptions["externalTools"]>[number];

function assembleMcpRequest(
  options: Pick<BridgeOptions, "assembleMcpArguments">,
  descriptor: McpDescriptor,
  data: readonly { pointer: string; content: Uint8Array }[],
): { args: Record<string, unknown>; argumentsDigest: string } {
  if (!options.assembleMcpArguments) throw new Error("policy-denied");
  let args: Record<string, unknown>;
  try {
    args = options.assembleMcpArguments(descriptor, data.map(({ pointer, content }) => ({ pointer, content: Uint8Array.from(content) })));
  } catch {
    throw new Error("policy-denied");
  }
  return { args, argumentsDigest: sha256(new TextEncoder().encode(canonicalJson(args))) };
}

function validateMcpIntent(
  intent: Extract<EffectIntent, { kind: "http-mcp" }>,
  context: ApprovedHttpAssuranceContext,
  checkpoint: HttpGovernedCheckpoint,
  options: Pick<BridgeOptions, "externalTools" | "assembleMcpArguments">,
): { descriptor: McpDescriptor; args: Record<string, unknown> } {
  if (checkpoint.phase !== "program") throw new Error("policy-denied");
  const operation = operationAt(checkpoint, intent.operationId);
  const grants = (context.policy as Record<string, unknown>).externalCalls;
  const grant = Array.isArray(grants)
    ? grants.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).id === intent.grantId) as Record<string, unknown> | undefined
    : undefined;
  const descriptor = options.externalTools?.find((entry) => entry.grantId === intent.grantId);
  if (operation.kind !== "external-call") throw new Error("policy-denied");
  const pointers = operation.data.map((entry) => entry.pointer);
  if (operation.grantId !== intent.grantId || !grant || grant.effect !== "http-mcp" ||
      !Array.isArray(grant.taskIds) || !grant.taskIds.includes(context.taskId) || grant.sinkId !== intent.sinkId ||
      canonicalJson(grant.authority) !== canonicalJson(operation.authority) ||
      canonicalJson(grant.dataPointers) !== canonicalJson(pointers) ||
      !descriptor || descriptor.transport !== "streamable-http" ||
      descriptor.tool !== grant.tool || descriptor.transportFingerprint !== intent.transportFingerprint ||
      descriptor.schemaFingerprint !== intent.schemaFingerprint ||
      canonicalJson(descriptor.fixedAuthority) !== canonicalJson(intent.fixedAuthority) ||
      canonicalJson(intent.fixedAuthority) !== canonicalJson(operation.authority)) throw new Error("policy-denied");
  const projectedTransport = grant.transport;
  if (!projectedTransport || typeof projectedTransport !== "object" ||
      (projectedTransport as Record<string, unknown>).transport !== descriptor.transport ||
      (projectedTransport as Record<string, unknown>).fingerprint !== descriptor.transportFingerprint ||
      (projectedTransport as Record<string, unknown>).schemaFingerprint !== descriptor.schemaFingerprint ||
      canonicalJson((projectedTransport as Record<string, unknown>).fixedAuthority) !== canonicalJson(descriptor.fixedAuthority) ||
      intent.data.length !== operation.data.length || intent.inputs.length !== operation.data.length ||
      canonicalJson(intent.data.map((entry) => entry.pointer)) !== canonicalJson(pointers) ||
      canonicalJson(intent.data.map((entry) => entry.value.id)) !== canonicalJson(operation.data.map((entry) => entry.value)) ||
      canonicalJson(intent.inputs.map((entry) => entry.id)) !== canonicalJson(operation.data.map((entry) => entry.value))) throw new Error("policy-denied");
  for (let index = 0; index < operation.data.length; index += 1) {
    const declared = operation.data[index]!;
    const supplied = intent.data[index]!;
    const stored = valueAt(checkpoint, declared.value);
    if (supplied.pointer !== declared.pointer || !exactEvidence(supplied.value, {
      id: stored.id, digest: stored.digest, bytes: stored.bytes, label: stored.label,
    }) || !exactEvidence(intent.inputs[index]!, supplied.value) ||
        supplied.content.byteLength !== stored.bytes || sha256(supplied.content) !== stored.digest) throw new Error("recovery-value-mismatch");
  }
  const packet = {
    grantId: operation.grantId,
    authority: operation.authority,
    data: intent.data.map(({ pointer, content }) => ({ pointer, value: retainedValue(content) })),
  };
  if (sha256(new TextEncoder().encode(canonicalJson(packet))) !== intent.valueDigest) throw new Error("recovery-value-mismatch");
  const { args, argumentsDigest } = assembleMcpRequest(options, descriptor, intent.data);
  if (sha256(new TextEncoder().encode(canonicalJson({
        version: 2,
        kind: "http-mcp",
        grantId: operation.grantId,
        sinkId: intent.sinkId,
        authority: operation.authority,
        transportFingerprint: descriptor.transportFingerprint,
        schemaFingerprint: descriptor.schemaFingerprint,
        dataPointers: pointers,
        valueDigest: intent.valueDigest,
        argumentsDigest,
      }))) !== intent.requestDigest) throw new Error("recovery-value-mismatch");
  return { descriptor, args };
}

export async function createDurableGovernedHost(
  options: BridgeOptions,
  context: ApprovedHttpAssuranceContext,
): Promise<GovernedEffectHost> {
  let sourceReceipt: { revision: number; operationId: string; path: string; evidence: { id: string; digest: string; bytes: number; label: ProvenanceLabel }; content: Uint8Array } | null = null;
  let permitSecret: { permit: GovernedPermit; intent: EffectIntent } | null = null;
  const projectRoot = options.store.projectRoot;

  async function readCheckpoint() {
    return safeReadState(projectRoot, context.runId);
  }

  async function verifyCurrentContext(): Promise<void> {
    const current = await options.resolveCurrentContext();
    if (canonicalJson(current) !== canonicalJson(context)) throw new Error("stale-authority");
  }

  async function update(expectedRevision: number, next: HttpGovernedCheckpoint): Promise<GovernedState> {
    const state = await readCheckpoint();
    requireCurrentRevision(state, expectedRevision);
    if (canonicalJson(next.identities) !== canonicalJson(state.checkpoint.identities) || next.runId !== context.runId ||
        next.bootstrapAuthorityDigest !== state.checkpoint.bootstrapAuthorityDigest) throw new Error("stale-authority");
    const validated = HttpGovernedCheckpointSchema.parse({ ...next, revision: state.revision + 1, recordedAt: new Date().toISOString() });
    const anchors = await loadAnchors(projectRoot, context.runId);
    checkpointAuthority(validated, anchors);
    await persistedCheckpoint(projectRoot, validated);
    return { revision: validated.revision, checkpoint: validated };
  }


  async function approvalPath(actionId: string): Promise<string> {
    if (!ID.test(actionId)) throw new Error("policy-denied");
    return toFsPath(projectRoot, `.legion-cli/workflow/action-approvals/${actionId}.yaml`);
  }

  async function readActionApproval(actionId: string): Promise<ActionApproval | null> {
    const path = await approvalPath(actionId);
    try {
      await assertNoLinkInPath(path, { root: projectRoot });
      const raw = await readBoundedUtf8(path, projectRoot, 16 * 1024);
      return ActionApprovalSchema.parse(parseSafeYaml(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }


  async function listActionApprovals(): Promise<ActionApproval[]> {
    const directory = toFsPath(projectRoot, ".legion-cli/workflow/action-approvals");
    let entries;
    try {
      await assertNoLinkInPath(directory, { root: projectRoot });
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (entries.length > 4096) throw new Error("resource-limit");
    entries.sort((left, right) => left.name.localeCompare(right.name));
    let totalBytes = 0;
    const approvals: ActionApproval[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const actionId = entry.name.endsWith(".yaml") ? entry.name.slice(0, -5) : "";
      if (!ID.test(actionId) || !entry.isFile()) throw new Error("stale-authority");
      const path = join(directory, entry.name);
      const info = await lstat(path, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.size > 16n * 1024n) throw new Error("stale-authority");
      totalBytes += Number(info.size);
      if (totalBytes > 64 * 1024 * 1024) throw new Error("resource-limit");
      const approval = ActionApprovalSchema.parse(parseSafeYaml(await readBoundedUtf8(path, projectRoot, 16 * 1024)));
      if (approval.actionId !== actionId) throw new Error("stale-authority");
      approvals.push(approval);
    }
    return approvals;
  }
  async function writeActionApproval(approval: ActionApproval): Promise<void> {
    const path = await approvalPath(approval.actionId);
    await atomicWriteFile(path, formatYamlDocument(ActionApprovalSchema.parse(approval)), { root: projectRoot });
  }

  async function consumeCompletedApproval(intent: EffectIntent, previous: HttpGovernedCheckpoint, completed: HttpGovernedCheckpoint): Promise<void> {
    const prior = intent.kind === "provider"
      ? previous.providerCalls.find((call) => call.actionId === intent.actionId)
      : previous.effects.find((effect) => effect.actionId === intent.actionId);
    if (!prior?.approvalDigest) return;
    const terminal = intent.kind === "provider"
      ? completed.providerCalls.find((call) => call.actionId === intent.actionId)?.state === "completed"
      : completed.effects.find((effect) => effect.actionId === intent.actionId)?.state === "completed";
    if (!terminal) throw new Error("stale-authority");
    const approval = await readActionApproval(intent.actionId);
    if (!approval || approval.state !== "reserved" ||
        canonicalDigest("legion-cli-action-approval/v1", { ...approval, state: "approved" }) !== prior.approvalDigest) throw new Error("stale-authority");
    await writeActionApproval({ ...approval, state: "consumed" });
  }

  async function markReservedApprovalUncertain(actionId: string, approvalDigest: string | null): Promise<void> {
    if (!approvalDigest) return;
    const approval = await readActionApproval(actionId);
    if (!approval || approval.state !== "reserved" ||
        canonicalDigest("legion-cli-action-approval/v1", { ...approval, state: "approved" }) !== approvalDigest) throw new Error("stale-authority");
    await writeActionApproval({ ...approval, state: "uncertain" });
  }

  async function repairInterruptedState(state: GovernedState): Promise<GovernedState> {
    const checkpoint = state.checkpoint;
    const pendingCalls = checkpoint.providerCalls.filter((call) => call.state === "pending");
    const pendingEffects = checkpoint.effects.filter((effect) => effect.state === "pending");
    let current = state;
    if (pendingCalls.length || pendingEffects.length) {
      const calls = checkpoint.providerCalls.map((call) => call.state === "pending" ? { ...call, state: "uncertain" as const, outcome: null } : call);
      const effects = checkpoint.effects.map((effect) => effect.state === "pending" ? { ...effect, state: "uncertain" as const, outcome: null } : effect);
      current = await update(state.revision, { ...checkpoint, providerCalls: calls, effects, status: "blocked", blocker: "uncertain-effect" });
    }
    const approvalRecords = await listActionApprovals();
    const approvalById = new Map(approvalRecords.map((approval) => [approval.actionId, approval]));
    const ledger = [
      ...current.checkpoint.providerCalls.map((call) => ({ actionId: call.actionId, approvalDigest: call.approvalDigest, state: call.state })),
      ...current.checkpoint.effects.map((effect) => ({ actionId: effect.actionId, approvalDigest: effect.approvalDigest, state: effect.state })),
    ];
    const ledgerById = new Map(ledger.map((entry) => [entry.actionId, entry]));
    for (const entry of ledger) {
      if (!entry.approvalDigest) {
        if (entry.state === "awaiting-approval") {
          const approval = approvalById.get(entry.actionId);
          const call = current.checkpoint.providerCalls.find((candidate) => candidate.actionId === entry.actionId);
          const effect = current.checkpoint.effects.find((candidate) => candidate.actionId === entry.actionId);
          const proposal = call ?? effect;
          const actionKind = call ? "provider" : effect?.kind === "write" ? "write" : effect ? "http-mcp" : null;
          if (approval && approval.state !== "approved") throw new Error("stale-authority");
          if (approval?.state === "approved" &&
              (!proposal || !actionKind || approval.runId !== context.runId || approval.actionId !== entry.actionId ||
               approval.programKind !== proposal.authority.programKind || approval.authorityDigest !== proposal.authority.authorityDigest ||
               approval.programFingerprint !== proposal.authority.programFingerprint ||
               approval.policyFingerprint !== current.checkpoint.identities.policyFingerprint ||
               approval.actionKind !== actionKind || approval.valueDigest !== proposal.valueDigest ||
               approval.sinkId !== proposal.sinkId || approval.requestDigest !== proposal.requestDigest)) throw new Error("stale-authority");
        }
        continue;
      }
      const approval = approvalById.get(entry.actionId);
      if (!approval || canonicalDigest("legion-cli-action-approval/v1", { ...approval, state: "approved" }) !== entry.approvalDigest) throw new Error("stale-authority");
      if (approval.state === "reserved") {
        const state = entry.state === "completed" ? "consumed" : entry.state === "awaiting-approval" ? "approved" : "uncertain";
        await writeActionApproval({ ...approval, state });
      } else if (!((entry.state === "completed" && approval.state === "consumed") ||
                   (entry.state === "uncertain" && approval.state === "uncertain"))) throw new Error("stale-authority");
    }
    for (const approval of approvalRecords) {
      if (approval.runId !== context.runId || approval.state !== "reserved") continue;
      const entry = ledgerById.get(approval.actionId);
      if (!entry || (entry.state === "awaiting-approval" && entry.approvalDigest === null)) {
        await writeActionApproval({ ...approval, state: "approved" });
      } else if (!entry.approvalDigest ||
                 canonicalDigest("legion-cli-action-approval/v1", { ...approval, state: "approved" }) !== entry.approvalDigest) {
        throw new Error("stale-authority");
      }
    }
    return current;
  }
  const host: GovernedEffectHost = {
    async open(openContext, resume) {
      if (canonicalJson(openContext) !== canonicalJson(context)) throw new Error("stale-authority");
      return options.withLock(async () => {
        await verifyCurrentContext();
        const dir = runDirectory(projectRoot, context.runId);
        const bootstrapPath = join(dir, "bootstrap-authority.json");
        let bootstrap: (HttpRunAuthority & { stage: "bootstrap" }) | null = null;
        try {
          const loaded = HttpRunAuthoritySchema.parse(await readJson(bootstrapPath, projectRoot, 2 * 1024 * 1024));
          if (loaded.stage !== "bootstrap") throw new Error("stale-authority");
          bootstrap = loaded;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!bootstrap) {
          if (resume) throw new Error("stale-authority");
          const plannerInputDigest = canonicalDigest("legion-cli-http-planner-input/v1", context.plannerInput);
          const record = HttpRunAuthoritySchema.parse({
            schemaVersion: SCHEMA_VERSION.httpRunAuthority,
            stage: "bootstrap",
            runId: context.runId,
            taskId: context.taskId,
            identities: identitiesWithoutProgram(context),
            manifestDigest: context.manifestDigest,
            plannerInputDigest,
            programKind: "bootstrap",
            programFingerprint: deriveBootstrapFingerprint(context),
            createdAt: new Date().toISOString(),
          }) as HttpRunAuthority & { stage: "bootstrap" };
          await writeImmutable(bootstrapPath, projectRoot, record);
          bootstrap = record;
        } else if (!sameContext(bootstrap, context) || bootstrap.manifestDigest !== context.manifestDigest ||
                   bootstrap.plannerInputDigest !== canonicalDigest("legion-cli-http-planner-input/v1", context.plannerInput) ||
                   bootstrap.programFingerprint !== deriveBootstrapFingerprint(context)) {
          throw new Error("stale-authority");
        }
        if (!bootstrap) throw new Error("stale-authority");
        const checkpointPath = recordPath(projectRoot, context.runId, CHECKPOINT_FILE);
        let checkpoint: HttpGovernedCheckpoint | null = null;
        try { checkpoint = HttpGovernedCheckpointSchema.parse(await readJson(checkpointPath, projectRoot, MAX_CHECKPOINT_BYTES)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const anchorState = await loadAnchors(projectRoot, context.runId);
        if (checkpoint) {
          if (!resume || !sameContext(anchorState.bootstrap, context)) throw new Error("stale-authority");
          checkpointAuthority(checkpoint, anchorState);
          return repairInterruptedState({ revision: checkpoint.revision, checkpoint });
        }
        if (resume) throw new Error("stale-authority");
        const initial = HttpGovernedCheckpointSchema.parse({
          schemaVersion: SCHEMA_VERSION.httpGovernedCheckpoint,
          phase: "bootstrap",
          runId: context.runId,
          bootstrapAuthorityDigest: authorityDigest(bootstrap),
          programAuthorityDigest: null,
          identities: identitiesWithoutProgram(context),
          revision: 0,
          providerCalls: [],
          usage: { planner: ZERO_ROLE_USAGE, quarantined: ZERO_ROLE_USAGE },
          status: "running",
          blocker: null,
          recordedAt: new Date().toISOString(),
          candidateProgram: null,
          cursor: 0,
          values: [],
          effects: [],
        });
        await persistedCheckpoint(projectRoot, initial);
        return { revision: 0, checkpoint: initial };
      });
    },

    async saveProgress(expectedRevision, next) {
      return options.withLock(async () => {
        const current = await readCheckpoint();
        await verifyCurrentContext();
        requireCurrentRevision(current, expectedRevision);
        const previous = current.checkpoint;
        if (previous.status !== "running" || previous.blocker !== null) throw new Error("policy-denied");
        if (canonicalJson(previous.providerCalls) !== canonicalJson(next.providerCalls) ||
            canonicalJson(previous.effects) !== canonicalJson(next.effects) ||
            canonicalJson(previous.usage) !== canonicalJson(next.usage) ||
            previous.phase !== next.phase ||
            previous.bootstrapAuthorityDigest !== next.bootstrapAuthorityDigest ||
            previous.programAuthorityDigest !== next.programAuthorityDigest) throw new Error("policy-denied");
        const invariantNext = {
          ...next,
          candidateProgram: previous.candidateProgram,
          cursor: previous.cursor,
          values: previous.values,
          status: previous.status,
          blocker: previous.blocker,
          recordedAt: previous.recordedAt,
          revision: previous.revision,
        };
        if (canonicalJson(invariantNext) !== canonicalJson(previous)) throw new Error("policy-denied");
        const operations = previous.phase === "program" ? previous.program.operations : [];
        const operation = operations[previous.cursor];
        const valuesUnchanged = canonicalJson(previous.values) === canonicalJson(next.values);
        const candidateUnchanged = canonicalJson(previous.candidateProgram) === canonicalJson(next.candidateProgram);
        if (!candidateUnchanged) {
          const latestPlan = [...previous.providerCalls].reverse().find((call) => call.purpose.kind === "plan");
          if (previous.phase !== "bootstrap" || previous.candidateProgram !== null || !next.candidateProgram ||
              !latestPlan || latestPlan.state !== "completed" || !latestPlan.outcome ||
              latestPlan.outcome.kind !== "success" ||
              latestPlan.outcome.resultDigest !== canonicalDigest("legion-cli-governed-program/v1", GovernedProgramSchema.parse(next.candidateProgram))) {
            throw new Error("policy-denied");
          }
        }
        let validReadAdvance = false;
        if (!valuesUnchanged) {
          const receipt = sourceReceipt;
          const appended = next.values.slice(previous.values.length);
          if (previous.phase !== "program" || operation?.kind !== "read" || next.values.length !== previous.values.length + 1 ||
              canonicalJson(next.values.slice(0, previous.values.length)) !== canonicalJson(previous.values) ||
              next.cursor !== previous.cursor + 1 || !receipt || receipt.revision !== current.revision ||
              receipt.operationId !== operation.id || receipt.path !== operation.path ||
              sha256(receipt.content) !== receipt.evidence.digest || receipt.content.byteLength !== receipt.evidence.bytes) throw new Error("policy-denied");
          const expectedValue = GovernedValueRecordSchema.parse({
            id: operation.id,
            digest: receipt.evidence.digest,
            bytes: receipt.evidence.bytes,
            label: receipt.evidence.label,
            producer: { kind: "read", operationId: operation.id, path: operation.path, sourceDigest: receipt.evidence.digest },
            retained: receipt.evidence.label.confidentiality === "sealed" ? null : retainedValue(receipt.content),
          });
          if (canonicalJson(appended[0]) !== canonicalJson(expectedValue) ||
              previous.values.reduce((sum, value) => sum + value.bytes, expectedValue.bytes) > 64 * 1024 * 1024) throw new Error("policy-denied");
          const sourcePath = resolve(projectRoot, operation.path);
          await assertAgentPathAllowed(projectRoot, operation.path);
          const currentBytes = await readBoundedBytes(sourcePath, projectRoot, MAX_SOURCE_BYTES);
          await assertAgentPathAllowed(projectRoot, operation.path);
          if (sha256(currentBytes) !== receipt.evidence.digest || currentBytes.byteLength !== receipt.evidence.bytes) throw new Error("stale-authority");
          const checkedLabel = labelProductBytes({
            ...productLabelPolicy(context),
            generated: (await readFileProvenance(projectRoot))?.files.find((entry) => normalizePathKey(entry.path) === normalizePathKey(operation.path)),
            path: operation.path,
            digest: receipt.evidence.digest,
          });
          if (canonicalJson(checkedLabel) !== canonicalJson(receipt.evidence.label)) throw new Error("stale-authority");
          validReadAdvance = true;
        }
        const finishing = previous.phase === "program" && operation?.kind === "finish" &&
          previous.cursor === operations.length - 1 && next.cursor === operations.length &&
          next.status === "complete" && next.blocker === null;
        if (next.cursor !== previous.cursor && !validReadAdvance && !finishing) throw new Error("policy-denied");
        if (next.status !== previous.status || next.blocker !== previous.blocker) {
          if (!finishing || previous.status !== "running" || previous.blocker !== null ||
              !previous.providerCalls.every((call) => call.state === "completed" && call.outcome?.kind === "success") ||
              !previous.effects.every((effect) => effect.state === "completed" && effect.outcome?.kind === "success") ||
              !operations.every((entry) => {
                if (entry.kind === "finish") return true;
                const value = previous.values.find((candidate) => candidate.id === entry.id);
                if (entry.kind === "read") return value?.producer.kind === "read" && value.producer.operationId === entry.id;
                if (entry.kind === "derive") return value?.producer.kind === "derive" && value.producer.operationId === entry.id &&
                  previous.providerCalls.some((call) => {
                    const outcome = call.outcome;
                    return call.purpose.kind === "derive" && call.purpose.operationId === entry.id &&
                      call.state === "completed" && outcome?.kind === "success" && outcome.resultDigest === value.digest;
                  });
                return previous.effects.some((effect) => effect.operationId === entry.id && effect.state === "completed" && effect.outcome?.kind === "success");
              })) throw new Error("policy-denied");
        }
        if (!valuesUnchanged && !validReadAdvance) throw new Error("policy-denied");
        const updated = await update(expectedRevision, next);
        if (validReadAdvance) sourceReceipt = null;
        return updated;
      });
    },

    async prepareEffect(expectedRevision, intent) {
      return options.withLock(async () => {
        const state = await readCheckpoint();
        await verifyCurrentContext();
        requireCurrentRevision(state, expectedRevision);
        const { checkpoint } = state;
        const approvalResume = checkpoint.status === "blocked" && checkpoint.blocker === "approval-required";
        if (checkpoint.status !== "running" && !approvalResume) throw new Error("policy-denied");
        const waitingIds = [
          ...checkpoint.providerCalls.filter((call) => call.state === "awaiting-approval").map((call) => call.actionId),
          ...checkpoint.effects.filter((effect) => effect.state === "awaiting-approval").map((effect) => effect.actionId),
        ];
        if (approvalResume && !waitingIds.includes(intent.actionId)) throw new Error("approval-required");
        const anchors = await loadAnchors(projectRoot, context.runId);
        const digest = checkpointAuthority(checkpoint, anchors);
        if (!ID.test(intent.actionId) || !/^[a-f0-9]{64}$/.test(intent.requestDigest) || !/^[a-f0-9]{64}$/.test(intent.valueDigest)) throw new Error("policy-denied");
        const authority = checkpoint.phase === "bootstrap"
          ? { programKind: "bootstrap" as const, authorityDigest: digest, programFingerprint: anchors.bootstrap.programFingerprint }
          : { programKind: "governed" as const, authorityDigest: digest, programFingerprint: checkpoint.programFingerprint };
        if (canonicalJson(intent.authority) !== canonicalJson(authority)) throw new Error("stale-authority");
        if (checkpoint.providerCalls.some((call) => call.state === "pending" || call.state === "uncertain") || checkpoint.effects.some((effect) => effect.state === "pending" || effect.state === "uncertain")) throw new Error("uncertain-effect");
        if (intent.kind === "provider") {
          if (checkpoint.effects.some((effect) => effect.actionId === intent.actionId)) throw new Error("stale-authority");
          const consentRequired = validateProviderIntent(intent, context, checkpoint);
          const matching = checkpoint.providerCalls.find((call) => call.actionId === intent.actionId);
          if (matching && (matching.state !== "awaiting-approval" || matching.requestDigest !== intent.requestDigest ||
              matching.valueDigest !== intent.valueDigest || matching.bodyDigest !== intent.bodyDigest ||
              matching.requestBytes !== intent.requestBytes || canonicalJson(matching.authority) !== canonicalJson(authority) ||
              canonicalJson(matching.purpose) !== canonicalJson(intent.purpose) || matching.sinkId !== intent.sinkId ||
              canonicalJson(matching.inputs) !== canonicalJson(intent.inputs))) throw new Error("stale-authority");
          if (!matching && (checkpoint.providerCalls.some((call) => call.state === "awaiting-approval") || checkpoint.effects.some((effect) => effect.state === "awaiting-approval"))) throw new Error("approval-required");
          const priorApproval = await readActionApproval(intent.actionId);
          if (consentRequired && (!priorApproval || priorApproval.state !== "approved")) {
            const awaiting = matching ?? {
              actionId: intent.actionId,
              sequence: (checkpoint.phase === "program" ? checkpoint.bootstrapProviderCalls.length : 0) + checkpoint.providerCalls.length + 1,
              authority,
              role: intent.role,
              purpose: intent.purpose,
              sinkId: intent.sinkId,
              bodyDigest: intent.bodyDigest,
              requestDigest: intent.requestDigest,
              requestBytes: intent.requestBytes,
              valueDigest: intent.valueDigest,
              label: joinLabels([context.plannerInput.label, ...intent.inputs.map((entry) => entry.label)]),
              inputs: [...intent.inputs],
              state: "awaiting-approval" as const,
              approvalDigest: null,
              outcome: null,
              responseDigest: null,
              responseBytes: null,
              usage: intent.usage,
            };
            const calls = matching ? checkpoint.providerCalls : [...checkpoint.providerCalls, awaiting];
            const blocked = await update(expectedRevision, {
              ...checkpoint,
              providerCalls: calls,
              usage: reconcileCheckpointUsage(checkpoint, calls),
              status: "blocked",
              blocker: "approval-required",
            });
            return { kind: "blocked" as const, code: "approval-required" as const, state: blocked };
          }
          let approvalDigest: string | null = null;
          if (priorApproval) {
            const approvedRecord = ActionApprovalSchema.parse({ ...priorApproval, state: "approved" });
            const reserved = consumeOrReserveApproval(approvedRecord, intent, context, authority);
            approvalDigest = canonicalDigest("legion-cli-action-approval/v1", approvedRecord);
            await writeActionApproval(reserved);
          } else if (consentRequired) {
            throw new Error("approval-required");
          }
          const call = {
            actionId: intent.actionId,
            sequence: matching?.sequence ?? (checkpoint.phase === "program" ? checkpoint.bootstrapProviderCalls.length : 0) + checkpoint.providerCalls.length + 1,
            authority,
            role: intent.role,
            purpose: intent.purpose,
            sinkId: intent.sinkId,
            bodyDigest: intent.bodyDigest,
            requestDigest: intent.requestDigest,
            requestBytes: intent.requestBytes,
            valueDigest: intent.valueDigest,
            label: joinLabels([context.plannerInput.label, ...intent.inputs.map((entry) => entry.label)]),
            inputs: [...intent.inputs],
            state: "pending" as const,
            approvalDigest,
            outcome: null,
            responseDigest: null,
            responseBytes: null,
            usage: usageWithCharge(intent.usage),
          };
          const calls = matching
            ? checkpoint.providerCalls.map((entry) => entry.actionId === intent.actionId ? call : entry)
            : [...checkpoint.providerCalls, call];
          const updated = await update(expectedRevision, {
            ...checkpoint,
            providerCalls: calls,
            usage: reconcileCheckpointUsage(checkpoint, calls),
            status: "running",
            blocker: null,
          });
          const permit = pendingPermit(intent.actionId, updated.revision, intent.requestDigest);
          permitSecret = { permit, intent: structuredClone(intent) };
          return { kind: "ready" as const, permit, state: updated };
        }
        if (checkpoint.phase !== "program" || checkpoint.cursor >= checkpoint.program.operations.length) throw new Error("policy-denied");
        const operation = checkpoint.program.operations[checkpoint.cursor];
        if (operation.id !== intent.operationId) throw new Error("stale-authority");
        if (checkpoint.providerCalls.some((call) => call.actionId === intent.actionId)) throw new Error("stale-authority");
        let reviewArtifactWrite = false;
        if (intent.kind === "write") {
          if (operation.kind !== "write") throw new Error("stale-authority");
          const value = valueAt(checkpoint, intent.value.id);
          const contract = context.plannerInput.taskContract as Record<string, unknown>;
          const allowed = Array.isArray(contract.allowedWrites) ? contract.allowedWrites.filter((entry): entry is string => typeof entry === "string") : [];
          const filesAllowed = Array.isArray(contract.filesAllowed) ? contract.filesAllowed.filter((entry): entry is string => typeof entry === "string") : [];
          const forbidden = Array.isArray(contract.filesForbidden) ? contract.filesForbidden.filter((entry): entry is string => typeof entry === "string") : [];
          const path = toStorePath(intent.path);
          if (operation.id !== intent.operationId || operation.value !== intent.value.id || value.digest !== intent.valueDigest ||
              canonicalJson(value.label) !== canonicalJson(intent.value.label) || !path || path !== operation.path ||
              !allowed.some((pattern) => matchesGlob(pattern, path)) || forbidden.some((pattern) => matchesGlob(pattern, path))) throw new Error("policy-denied");
          if (contract.kind === "independent-review") {
            // The review artifact is a fixed engine-owned workspace destination: only that exact path, never sealed values, no consent path.
            const artifact = typeof contract.artifact === "string" ? toStorePath(contract.artifact) : null;
            if (!artifact || path !== artifact || value.label.confidentiality === "sealed") throw new Error("policy-denied");
            reviewArtifactWrite = true;
          } else if (isImplicitForbidden(path) || !filesAllowed.some((pattern) => matchesGlob(pattern, path))) throw new Error("policy-denied");
          const maxFiles = contract.maxFilesTouched;
          const distinctWrites = new Set(checkpoint.effects.filter((effect) => effect.kind === "write" && effect.outcome?.kind === "success")
            .map((effect) => {
              const priorOperation = operationAt(checkpoint, effect.operationId);
              if (priorOperation.kind !== "write") throw new Error("policy-denied");
              return priorOperation.path;
            }));
          if (typeof maxFiles === "number" && distinctWrites.size >= maxFiles && !distinctWrites.has(path)) throw new Error("resource-limit");
        } else {
          if (operation.kind !== "external-call" || operation.id !== intent.operationId) throw new Error("stale-authority");
          validateMcpIntent(intent, context, checkpoint, options);
        }
        const effectKind = intent.kind === "write" ? "write" as const : "external-call" as const;
        const priorEffect = checkpoint.effects.find((effect) => effect.actionId === intent.actionId);
        if (priorEffect && (priorEffect.state !== "awaiting-approval" || priorEffect.operationId !== intent.operationId ||
            priorEffect.kind !== effectKind || priorEffect.sinkId !== intent.sinkId ||
            priorEffect.requestDigest !== intent.requestDigest || priorEffect.valueDigest !== intent.valueDigest ||
            canonicalJson(priorEffect.authority) !== canonicalJson(authority))) throw new Error("stale-authority");
        if (!priorEffect && checkpoint.effects.some((effect) => effect.state === "awaiting-approval")) throw new Error("approval-required");
        if (reviewArtifactWrite && priorEffect) throw new Error("stale-authority");
        const approval = reviewArtifactWrite ? null : await readActionApproval(intent.actionId);
        if (!reviewArtifactWrite && !approval) {
          const awaiting = priorEffect ?? {
            operationId: intent.operationId,
            actionId: intent.actionId,
            kind: effectKind,
            authority,
            sinkId: intent.sinkId,
            requestDigest: intent.requestDigest,
            valueDigest: intent.valueDigest,
            state: "awaiting-approval" as const,
            approvalDigest: null,
            outcome: null,
            resultDigest: null,
            responseDigest: null,
            responseBytes: null,
          };
          const effects = priorEffect ? checkpoint.effects : [...checkpoint.effects, awaiting];
          const blocked = await update(expectedRevision, { ...checkpoint, effects, status: "blocked", blocker: "approval-required" });
          return { kind: "blocked" as const, code: "approval-required" as const, state: blocked };
        }
        let approvalDigest: string | null = null;
        if (approval) {
          const approvedRecord = ActionApprovalSchema.parse({ ...approval, state: "approved" });
          await writeActionApproval(consumeOrReserveApproval(approvedRecord, intent, context, authority));
          approvalDigest = canonicalDigest("legion-cli-action-approval/v1", approvedRecord);
        }
        const effect = {
          operationId: intent.operationId,
          actionId: intent.actionId,
          kind: effectKind,
          authority,
          sinkId: intent.sinkId,
          requestDigest: intent.requestDigest,
          valueDigest: intent.valueDigest,
          state: "pending" as const,
          approvalDigest,
          outcome: null,
          resultDigest: null,
          responseDigest: null,
          responseBytes: null,
        };
        const effects = priorEffect
          ? checkpoint.effects.map((entry) => entry.actionId === intent.actionId ? effect : entry)
          : [...checkpoint.effects, effect];
        const updated = await update(expectedRevision, { ...checkpoint, effects, status: "running", blocker: null });
        const permit = pendingPermit(intent.actionId, updated.revision, intent.requestDigest);
        permitSecret = { permit, intent: structuredClone(intent) };
        return { kind: "ready" as const, permit, state: updated };
      });
    },

    async completeEffect(permit, completion) {
      return options.withLock(async () => {
        const currentPermit = permitSecret;
        if (!currentPermit || canonicalJson(currentPermit.permit) !== canonicalJson(permit) || permit.requestDigest !== currentPermit.intent.requestDigest) throw new Error("stale-authority");
        await verifyCurrentContext();
        const state = await readCheckpoint();
        if (state.revision !== permit.pendingRevision) throw new Error("stale-authority");
        const checkpoint = state.checkpoint;
        const next = await completeReserved(checkpoint, currentPermit.intent, completion);
        const updated = await update(state.revision, next);
        await consumeCompletedApproval(currentPermit.intent, checkpoint, updated.checkpoint);
        permitSecret = null;
        return updated;
      });
    },

    async markUncertain(permit, code) {
      return options.withLock(async () => {
        const currentPermit = permitSecret;
        if (!currentPermit || canonicalJson(currentPermit.permit) !== canonicalJson(permit)) throw new Error("stale-authority");
        await verifyCurrentContext();
        const state = await readCheckpoint();
        if (state.revision !== permit.pendingRevision) throw new Error("stale-authority");
        const checkpoint = state.checkpoint;
        const calls = checkpoint.providerCalls.map((call) => call.actionId === permit.actionId ? { ...call, state: "uncertain" as const, outcome: null } : call);
        const effects = checkpoint.effects.map((effect) => effect.actionId === permit.actionId ? { ...effect, state: "uncertain" as const, outcome: null } : effect);
        const next = { ...checkpoint, providerCalls: calls, effects, status: "blocked" as const, blocker: code };
        const updated = await update(state.revision, next);
        const call = checkpoint.providerCalls.find((entry) => entry.actionId === permit.actionId);
        const effect = checkpoint.effects.find((entry) => entry.actionId === permit.actionId);
        await markReservedApprovalUncertain(permit.actionId, call?.approvalDigest ?? effect?.approvalDigest ?? null);
        permitSecret = null;
        return updated;
      });
    },

    async freezeProgram(expectedRevision) {
      return options.withLock(async () => {
        await verifyCurrentContext();
        const state = await readCheckpoint();
        requireCurrentRevision(state, expectedRevision);
        const checkpoint = state.checkpoint;
        if (checkpoint.phase !== "bootstrap" || !checkpoint.candidateProgram) throw new Error("invalid-program");
        const planner = checkpoint.providerCalls.filter((call) => call.role === "planner" && call.state === "completed" && call.outcome?.kind === "success").at(-1);
        if (!planner || !planner.outcome || planner.outcome.kind !== "success") throw new Error("stale-authority");
        const plannerResultDigest = planner.outcome.resultDigest;
        const fingerprint = canonicalDigest("legion-cli-governed-program/v1", checkpoint.candidateProgram);
        const anchors = await loadAnchors(projectRoot, context.runId);
        if (anchors.final) {
          if (anchors.final.plannerCallId !== planner.actionId || anchors.final.plannerResultDigest !== plannerResultDigest ||
              anchors.final.programFingerprint !== fingerprint || canonicalJson(anchors.final.program) !== canonicalJson(checkpoint.candidateProgram)) throw new Error("stale-authority");
        } else {
          const record = HttpRunAuthoritySchema.parse({
            schemaVersion: SCHEMA_VERSION.httpRunAuthority,
            stage: "program",
            runId: context.runId,
            taskId: context.taskId,
            identities: identitiesWithoutProgram(context),
            bootstrapAuthorityDigest: authorityDigest(anchors.bootstrap),
            plannerCallId: planner.actionId,
            plannerResultDigest,
            programKind: "governed",
            programFingerprint: fingerprint,
            program: checkpoint.candidateProgram,
            createdAt: new Date().toISOString(),
          }) as HttpRunAuthority & { stage: "program" };
          await writeImmutable(recordPath(projectRoot, context.runId, "run-authority.json"), projectRoot, record);
        }
        const finalAnchor = (await loadAnchors(projectRoot, context.runId)).final;
        if (!finalAnchor) throw new Error("stale-authority");
        const next = {
          ...checkpoint,
          phase: "program" as const,
          programAuthorityDigest: authorityDigest(finalAnchor),
          programKind: "governed" as const,
          programFingerprint: finalAnchor.programFingerprint,
          program: finalAnchor.program,
          bootstrapProviderCalls: checkpoint.providerCalls,
          providerCalls: [],
          usage: checkpoint.usage,
          cursor: 0,
          values: [],
          effects: [],
        };
        return update(state.revision, next);
      });
    },

    async readSource(path, signal) {
      return options.withLock(async () => {
        await verifyCurrentContext();
      sourceReceipt = null;
      const readState = await readCheckpoint();
      const operation = readState.checkpoint.phase === "program" ? readState.checkpoint.program.operations[readState.checkpoint.cursor] : null;
      if (signal?.aborted) throw signal.reason;
      const { policySources, baselineSources } = productLabelPolicy(context);
      const policy = policySources.find((entry) => normalizePathKey(entry.path) === normalizePathKey(path));
      const task = (context.policy as Record<string, unknown>).task;
      const taskRecord = task && typeof task === "object" && !Array.isArray(task) ? task as Record<string, unknown> : null;
      const readPaths = taskRecord?.readPaths;
      if (!Array.isArray(readPaths) || !readPaths.some((readPath: unknown) => typeof readPath === "string" && normalizePathKey(readPath) === normalizePathKey(path))) throw new Error("policy-denied");
      await assertAgentPathAllowed(projectRoot, path);
      const abs = resolve(projectRoot, path);
      await assertNoLinkInPath(abs, { root: projectRoot });
      const sourceBefore = await lstat(abs, { bigint: true });
      if (!sourceBefore.isFile() || sourceBefore.nlink !== 1n) throw new Error("policy-denied");
      const content = await readBoundedBytes(abs, projectRoot, MAX_SOURCE_BYTES);
      const sourceAfter = await lstat(abs, { bigint: true });
      if (!sourceAfter.isFile() || sourceAfter.nlink !== 1n || sourceBefore.dev !== sourceAfter.dev ||
          sourceBefore.ino !== sourceAfter.ino || sourceBefore.size !== sourceAfter.size ||
          sourceBefore.mtimeNs !== sourceAfter.mtimeNs) throw new Error("stale-authority");
      await assertAgentPathAllowed(projectRoot, path);
      const bytes = new Uint8Array(content);
      const digest = sha256(bytes);
      const generated = (await readFileProvenance(projectRoot))?.files.find((entry) => normalizePathKey(entry.path) === normalizePathKey(path));
      const label = labelProductBytes({ policySources, baselineSources, generated, path, digest });
      const evidence = { id: policy?.id ?? "unclassified", digest, bytes: bytes.byteLength, label };
      if (operation?.kind === "read" && operation.path === path) sourceReceipt = {
        revision: readState.revision,
        operationId: operation.id,
        path,
        evidence,
        content: Uint8Array.from(bytes),
      };
      return { content: bytes, evidence };
      });
    },

    async dispatchWrite(permit, contents, signal) {
      if (signal?.aborted) throw signal.reason;
      const pending = permitSecret;
      if (!pending || canonicalJson(pending.permit) !== canonicalJson(permit) || pending.intent.kind !== "write") throw new Error("stale-authority");
      const intent = pending.intent;
      const exactContents = Uint8Array.from(contents);
      if (exactContents.byteLength > MAX_SOURCE_BYTES || sha256(exactContents) !== intent.valueDigest) throw new Error("recovery-value-mismatch");
      const resultDigest = sha256(exactContents);
      try {
        await options.withLock(async () => {
          await verifyCurrentContext();
          const state = await readCheckpoint();
          if (state.revision !== permit.pendingRevision || !state.checkpoint.effects.some((effect) => effect.actionId === permit.actionId && effect.state === "pending")) throw new Error("stale-authority");
          if (signal?.aborted) throw signal.reason;
          const root = resolve(options.jailRoot);
          const target = resolve(root, intent.path);
          const rel = toStorePath(intent.path);
          await assertAgentPathAllowed(root, rel);
          await assertNoLinkInPath(target, { root });
          const beforeDigest = await digestOptional(target, root);
          if (beforeDigest !== intent.expectedTargetDigest) throw new Error("target-conflict");
          await ensureSafeDirectory(root, dirname(target));
          await assertAgentPathAllowed(root, rel);
          await assertNoLinkInPath(target, { root });
          if (await digestOptional(target, root) !== intent.expectedTargetDigest) throw new Error("target-conflict");
          const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
          if (beforeDigest === null) {
            const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
            try {
              const opened = await handle.stat({ bigint: true });
              const named = await lstat(target, { bigint: true });
              if (!opened.isFile() || opened.nlink !== 1n || named.nlink !== 1n || named.isSymbolicLink() ||
                  opened.dev !== named.dev || opened.ino !== named.ino) throw new Error("target-conflict");
              await assertAgentPathAllowed(root, rel);
              await handle.writeFile(exactContents);
              await handle.sync();
              const afterWrite = await lstat(target, { bigint: true });
              if (afterWrite.nlink !== 1n || afterWrite.isSymbolicLink() || afterWrite.dev !== opened.dev || afterWrite.ino !== opened.ino) throw new Error("target-conflict");
            } finally {
              await handle.close();
            }
          } else {
            const handle = await open(target, fsConstants.O_RDWR | noFollow);
            try {
              const opened = await handle.stat({ bigint: true });
              const named = await lstat(target, { bigint: true });
              if (!opened.isFile() || opened.nlink !== 1n || named.nlink !== 1n || named.isSymbolicLink() ||
                  opened.dev !== named.dev || opened.ino !== named.ino ||
                  sha256(await readBoundedBytes(target, root, MAX_SOURCE_BYTES)) !== intent.expectedTargetDigest) throw new Error("target-conflict");
              const afterRead = await lstat(target, { bigint: true });
              if (afterRead.nlink !== 1n || afterRead.isSymbolicLink() || afterRead.dev !== opened.dev || afterRead.ino !== opened.ino) throw new Error("target-conflict");
              await assertAgentPathAllowed(root, rel);
              await handle.truncate(0);
              await handle.writeFile(exactContents);
              await handle.sync();
              const afterWrite = await lstat(target, { bigint: true });
              if (afterWrite.nlink !== 1n || afterWrite.isSymbolicLink() || afterWrite.dev !== opened.dev || afterWrite.ino !== opened.ino) throw new Error("target-conflict");
            } finally {
              await handle.close();
            }
          }
          await assertAgentPathAllowed(root, rel);
          const finalIdentity = await lstat(target, { bigint: true });
          if (!finalIdentity.isFile() || finalIdentity.nlink !== 1n) throw new Error("target-conflict");
          await assertNoLinkInPath(target, { root });
          if (await digestOptional(target, root) !== resultDigest) throw new Error("target-conflict");
        });
      } catch (error) {
        try { await host.markUncertain(permit, "uncertain-effect"); } catch {}
        throw error;
      }
      const completion: EffectCompletion = { outcome: { kind: "success", resultDigest }, providerUsage: null, producedValue: null, producedBytes: null, candidateProgram: null, responseDigest: null, responseBytes: null };
      const completed = await host.completeEffect(permit, completion);
      if (resolve(options.jailRoot) === resolve(options.store.projectRoot)) {
        await options.withLock(async () => recordGovernedFileProvenance({
          store: options.store,
          approvalId: completed.checkpoint.identities.approvalId,
          runId: context.runId,
          actionId: permit.actionId,
          projectRelativePath: intent.path,
          bytes: exactContents,
        }));
      }
      return completion;
    },

    async mcpArgumentsDigest(grantId, data) {
      const descriptor = options.externalTools?.find((entry) => entry.grantId === grantId);
      if (!descriptor) throw new Error("policy-denied");
      return assembleMcpRequest(options, descriptor, data).argumentsDigest;
    },

    async dispatchMcp(permit, data, signal) {
      if (signal?.aborted) throw signal.reason;
      const pending = permitSecret;
      if (!pending || canonicalJson(pending.permit) !== canonicalJson(permit) || pending.intent.kind !== "http-mcp") throw new Error("stale-authority");
      const intent = pending.intent;
      if (!options.dispatchMcp) throw new Error("policy-denied");
      const admitted = await options.withLock(async () => {
        await verifyCurrentContext();
        const state = await readCheckpoint();
        if (state.revision !== permit.pendingRevision) throw new Error("stale-authority");
        const { descriptor, args } = validateMcpIntent(intent, context, state.checkpoint, options);
        if (data.length !== intent.data.length) throw new Error("policy-denied");
        for (let index = 0; index < data.length; index += 1) {
          const supplied = data[index]!;
          const admittedData = intent.data[index]!;
          if (supplied.pointer !== admittedData.pointer || supplied.content.byteLength !== admittedData.content.byteLength ||
              supplied.content.some((byte, offset) => byte !== admittedData.content[offset])) throw new Error("recovery-value-mismatch");
        }
        return { descriptor, args, checkpoint: state.checkpoint };
      });
      const { descriptor, args } = admitted;
      try {
        const result = await options.dispatchMcp(descriptor, structuredClone(args), signal);
        if ("failureCode" in result) {
          if (result.failureCode !== "transport-failure" || result.responseBytes <= 0 || result.responseBytes > 8 * 1024 * 1024 ||
              !/^[a-f0-9]{64}$/.test(result.responseDigest)) throw new Error("resource-limit");
          const completion: EffectCompletion = {
            outcome: { kind: "failure", code: result.failureCode },
            providerUsage: null,
            producedValue: null,
            producedBytes: null,
            candidateProgram: null,
            responseDigest: result.responseDigest,
            responseBytes: result.responseBytes,
          };
          await host.completeEffect(permit, completion);
          return completion;
        }
        if (result.content.byteLength > MAX_SOURCE_BYTES || result.responseBytes < 1 || result.responseBytes > 8 * 1024 * 1024 ||
            !/^[a-f0-9]{64}$/.test(result.responseDigest)) throw new Error("resource-limit");
        const digest = sha256(result.content);
        const checkpoint = admitted.checkpoint;
        const requestLabel = joinLabels([context.plannerInput.label, ...intent.data.map((item) => valueAt(checkpoint, item.value.id).label)]);
        const label = remoteResponseLabel(requestLabel, context.plannerInput.label, namespacedOrigin("remote", {
          grantId: descriptor.grantId,
          transportFingerprint: descriptor.transportFingerprint,
          schemaFingerprint: descriptor.schemaFingerprint,
          fixedAuthority: descriptor.fixedAuthority,
        }));
        const operation = operationAt(checkpoint, intent.operationId);
        if (operation.kind !== "external-call") throw new Error("stale-authority");
        const producedValue = GovernedValueRecordSchema.parse({
          id: operation.id,
          digest,
          bytes: result.content.byteLength,
          label,
          producer: { kind: "external-call", operationId: operation.id, actionId: intent.actionId },
          retained: null,
        });
        const completion: EffectCompletion = {
          outcome: { kind: "success", resultDigest: digest },
          providerUsage: null,
          producedValue,
          producedBytes: Uint8Array.from(result.content),
          candidateProgram: null,
          responseDigest: result.responseDigest,
          responseBytes: result.responseBytes,
        };
        await host.completeEffect(permit, completion);
        return completion;
      } catch {
        await host.markUncertain(permit, "uncertain-effect");
        throw new Error("uncertain-effect");
      }
    },
  };

  async function completeReserved(checkpoint: HttpGovernedCheckpoint, intent: EffectIntent, completion: EffectCompletion): Promise<HttpGovernedCheckpoint> {
    if (intent.kind === "provider") {
      const previous = checkpoint.providerCalls.find((call) => call.actionId === intent.actionId);
      if (!previous || previous.state !== "pending" || previous.requestDigest !== intent.requestDigest) throw new Error("stale-authority");
      if (!completion.providerUsage || completion.providerUsage.requestCharge !== 1) throw new Error("uncertain-effect");
      const providerUsage = usageWithCharge(completion.providerUsage);
      if (completion.responseBytes === null || completion.responseBytes < 0 || completion.responseBytes > 8 * 1024 * 1024 ||
          !completion.responseDigest || !/^[a-f0-9]{64}$/.test(completion.responseDigest)) throw new Error("uncertain-effect");
      if (completion.outcome.kind === "failure") {
        if (completion.candidateProgram !== null || completion.producedValue !== null || completion.producedBytes !== null) throw new Error("invalid-output");
      }
      let candidateProgram = checkpoint.phase === "bootstrap" ? checkpoint.candidateProgram : null;
      let values = checkpoint.phase === "program" ? checkpoint.values : [];
      let cursor = checkpoint.phase === "program" ? checkpoint.cursor : 0;
      const purpose = intent.purpose;
      if (completion.outcome.kind === "success") {
        if (purpose.kind === "plan") {
          if (checkpoint.phase !== "bootstrap" || !completion.candidateProgram || completion.producedValue || completion.producedBytes ||
              completion.outcome.resultDigest !== canonicalDigest("legion-cli-governed-program/v1", GovernedProgramSchema.parse(completion.candidateProgram))) throw new Error("invalid-program");
          candidateProgram = GovernedProgramSchema.parse(completion.candidateProgram);
        } else {
          if (checkpoint.phase !== "program" || !completion.producedBytes || completion.producedBytes.byteLength > MAX_SOURCE_BYTES ||
              sha256(completion.producedBytes) !== completion.outcome.resultDigest || completion.candidateProgram !== null) throw new Error("recovery-value-mismatch");
          const operation = checkpoint.program.operations.find((entry) => entry.id === purpose.operationId);
          if (!operation) throw new Error("stale-authority");
          let expectedLabel: ProvenanceLabel;
          if (purpose.kind === "external-call") {
            if (operation.kind !== "external-call" || operation.grantId !== purpose.grantId) throw new Error("stale-authority");
            expectedLabel = remoteResponseLabel(joinLabels([context.plannerInput.label, ...intent.inputs.map((input) => input.label)]), context.plannerInput.label,
              namespacedOrigin("remote", { grantId: operation.grantId, authority: operation.authority, endpoint: context.identities.provider.endpoint, model: context.identities.provider.model, profile: context.identities.provider.profile }));
          } else {
            if (operation.kind !== "derive") throw new Error("stale-authority");
            expectedLabel = { ...joinLabels([context.plannerInput.label, ...intent.inputs.map((input) => input.label)]), integrity: "untrusted" };
          }
          if (purpose.kind === "rederive") {
            const originalCallId = purpose.originalCallId;
            const original = checkpoint.providerCalls.find((call) => call.actionId === originalCallId);
            const existing = values.find((value) => value.id === operation.id);
            if (operation.kind !== "derive" || !original || original.state !== "completed" || !original.outcome ||
                original.outcome.kind !== "success" || original.outcome.resultDigest !== existing?.digest ||
                original.purpose.kind !== "derive" || original.purpose.operationId !== operation.id || !existing ||
                completion.producedValue !== null || completion.producedBytes.byteLength !== existing.bytes ||
                sha256(completion.producedBytes) !== existing.digest || canonicalJson(existing.label) !== canonicalJson(expectedLabel)) {
              throw new Error("recovery-value-mismatch");
            }
          } else {
            if (!completion.producedValue || completion.producedBytes.byteLength !== completion.producedValue.bytes ||
                sha256(completion.producedBytes) !== completion.producedValue.digest ||
                completion.outcome.resultDigest !== completion.producedValue.digest) throw new Error("recovery-value-mismatch");
            let producer: GovernedValueRecord["producer"];
            if (purpose.kind === "external-call") {
              if (operation.kind !== "external-call") throw new Error("stale-authority");
              producer = { kind: "external-call", operationId: operation.id, actionId: intent.actionId };
            } else {
              if (operation.kind !== "derive") throw new Error("stale-authority");
              producer = { kind: "derive", operationId: operation.id, transformationId: operation.transformationId, inputIds: [...operation.inputs], originalCallId: intent.actionId };
            }
            const retained = expectedLabel.confidentiality === "sealed" ? null : retainedValue(completion.producedBytes);
            const produced = GovernedValueRecordSchema.parse({
              id: operation.id,
              digest: sha256(completion.producedBytes),
              bytes: completion.producedBytes.byteLength,
              label: expectedLabel,
              producer,
              retained,
            });
            if (canonicalJson(produced) !== canonicalJson(completion.producedValue)) throw new Error("recovery-value-mismatch");
            values = [...values, produced];
            cursor = checkpoint.cursor + 1;
          }
        }
      }
      const call = {
        ...previous,
        state: "completed" as const,
        outcome: completion.outcome,
        responseDigest: completion.responseDigest,
        responseBytes: completion.responseBytes,
        usage: providerUsage,
      };
      const calls = checkpoint.providerCalls.map((entry) => entry.actionId === call.actionId ? call : entry);
      return HttpGovernedCheckpointSchema.parse({
        ...checkpoint,
        providerCalls: calls,
        usage: reconcileCheckpointUsage(checkpoint, calls),
        ...(checkpoint.phase === "bootstrap" ? { candidateProgram, status: completion.outcome.kind === "success" ? checkpoint.status : "blocked", blocker: completion.outcome.kind === "failure" ? completion.outcome.code : checkpoint.blocker } : {
          values,
          cursor,
          status: completion.outcome.kind === "success" ? checkpoint.status : "blocked",
          blocker: completion.outcome.kind === "failure" ? completion.outcome.code : checkpoint.blocker,
        }),
      });
    }
    const effect = checkpoint.effects.find((entry) => entry.actionId === intent.actionId);
    if (!effect || effect.state !== "pending" || effect.requestDigest !== intent.requestDigest) throw new Error("stale-authority");
    if ((completion.responseDigest === null) !== (completion.responseBytes === null) ||
        (completion.responseDigest !== null && !/^[a-f0-9]{64}$/.test(completion.responseDigest)) ||
        (completion.responseBytes !== null && (completion.responseBytes < 0 || completion.responseBytes > 8 * 1024 * 1024)) ||
        (effect.kind === "write" && completion.responseDigest !== null)) throw new Error("recovery-value-mismatch");
    const operation = operationAt(checkpoint, effect.operationId);
    let values = checkpoint.values;
    if (completion.outcome.kind === "success" && effect.kind === "write") {
      if (completion.producedValue !== null || completion.producedBytes !== null || completion.candidateProgram !== null ||
          completion.responseDigest !== null || completion.responseBytes !== null || completion.outcome.resultDigest !== intent.valueDigest) throw new Error("recovery-value-mismatch");
    } else if (completion.outcome.kind === "success") {
      if (intent.kind !== "http-mcp" || operation.kind !== "external-call") throw new Error("recovery-value-mismatch");
      validateMcpIntent(intent, context, checkpoint, options);
      if (!completion.producedValue || !completion.producedBytes || completion.candidateProgram !== null ||
          completion.producedBytes.byteLength > MAX_SOURCE_BYTES ||
          sha256(completion.producedBytes) !== completion.outcome.resultDigest ||
          !completion.responseDigest || !/^[a-f0-9]{64}$/.test(completion.responseDigest) ||
          completion.responseBytes === null || completion.responseBytes <= 0 || completion.responseBytes > 8 * 1024 * 1024) throw new Error("recovery-value-mismatch");
      const requestLabel = joinLabels([context.plannerInput.label, ...intent.data.map((item) => valueAt(checkpoint, item.value.id).label)]);
      const label = remoteResponseLabel(requestLabel, context.plannerInput.label, namespacedOrigin("remote", {
        grantId: intent.grantId,
        transportFingerprint: intent.transportFingerprint,
        schemaFingerprint: intent.schemaFingerprint,
        fixedAuthority: intent.fixedAuthority,
      }));
      const produced = GovernedValueRecordSchema.parse({
        id: operation.id,
        digest: completion.outcome.resultDigest,
        bytes: completion.producedBytes.byteLength,
        label,
        producer: { kind: "external-call", operationId: operation.id, actionId: intent.actionId },
        retained: null,
      });
      if (canonicalJson(produced) !== canonicalJson(completion.producedValue)) throw new Error("recovery-value-mismatch");
      values = [...values, produced];
    }
    const effects = checkpoint.effects.map((entry) => entry.actionId === effect.actionId ? {
      ...entry,
      state: "completed" as const,
      outcome: completion.outcome,
      resultDigest: completion.outcome.kind === "success" ? completion.outcome.resultDigest : null,
      responseDigest: completion.responseDigest,
      responseBytes: completion.responseBytes,
    } : entry);
    const cursor = completion.outcome.kind === "success" ? checkpoint.cursor + 1 : checkpoint.cursor;
    const next = { ...checkpoint, effects, cursor, values, status: completion.outcome.kind === "success" ? checkpoint.status : "blocked" as const, blocker: completion.outcome.kind === "failure" ? completion.outcome.code : checkpoint.blocker };
    return HttpGovernedCheckpointSchema.parse(next);
  }
  return host;
}

async function digestOptional(path: string, root: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error("policy-denied");
    return sha256(await readBoundedBytes(path, root, MAX_SOURCE_BYTES));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readProtectedActionApproval(store: LegionStore, actionId: string): Promise<ActionApproval | null> {
  if (!ID.test(actionId)) throw new Error("policy-denied");
  const path = toFsPath(store.projectRoot, `.legion-cli/workflow/action-approvals/${actionId}.yaml`);
  try {
    await assertNoLinkInPath(path, { root: store.projectRoot });
    return ActionApprovalSchema.parse(parseSafeYaml(await readBoundedUtf8(path, store.projectRoot, 16 * 1024)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function persistProtectedActionApproval(store: LegionStore, approval: ActionApproval): Promise<void> {
  const path = toFsPath(store.projectRoot, `.legion-cli/workflow/action-approvals/${approval.actionId}.yaml`);
  await atomicWriteFile(path, formatYamlDocument(ActionApprovalSchema.parse(approval)), { root: store.projectRoot });
}

export async function inspectProtectedGovernedRun(
  store: LegionStore,
  runId: string,
  context?: ApprovedHttpAssuranceContext,
  taskId?: string,
  manifestDigest?: string,
): Promise<GovernedState | null> {
  if (!ID.test(runId)) throw new Error("policy-denied");
  try {
    const state = await safeReadState(store.projectRoot, runId);
    const anchors = await loadAnchors(store.projectRoot, runId);
    checkpointAuthority(state.checkpoint, anchors);
    if (context && !sameContext(anchors.bootstrap, context)) throw new Error("stale-authority");
    if (taskId && anchors.bootstrap.taskId !== taskId) throw new Error("stale-authority");
    if (manifestDigest && anchors.bootstrap.manifestDigest !== manifestDigest) throw new Error("stale-authority");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function recordOpaqueVerificationFileProvenance(options: {
  store: LegionStore;
  runId: string;
  approvalId: string;
  taskId: string;
  checkId: string;
  commandFingerprint: string;
  inventory: { path: string; beforeDigest: string | null; afterDigest: string };
  label: ProvenanceLabel;
}): Promise<void> {
  const state = await inspectProtectedGovernedRun(options.store, options.runId, undefined, options.taskId);
  if (!state || state.checkpoint.phase !== "program" || state.checkpoint.status !== "complete" ||
      state.checkpoint.identities.approvalId !== options.approvalId) throw new Error("stale-authority");
  const path = toStorePath(options.inventory.path);
  if (!path || path !== options.inventory.path || options.inventory.path.includes("\\") ||
      options.inventory.beforeDigest === options.inventory.afterDigest ||
      (options.inventory.beforeDigest !== null && !/^[a-f0-9]{64}$/.test(options.inventory.beforeDigest)) ||
      !/^[a-f0-9]{64}$/.test(options.inventory.afterDigest) ||
      !/^[a-f0-9]{64}$/.test(options.commandFingerprint) ||
      options.checkId !== `verify-${options.commandFingerprint.slice(0, 32)}` ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(options.checkId)) throw new Error("policy-denied");
  const label = ProvenanceLabelSchema.parse(options.label);
  if (label.integrity !== "untrusted") throw new Error("policy-denied");
  const absolutePath = toFsPath(options.store.projectRoot, path);
  await assertAgentPathAllowed(options.store.projectRoot, path);
  await assertNoLinkInPath(absolutePath, { root: options.store.projectRoot });
  if (await digestBoundedFile(absolutePath, options.store.projectRoot, MAX_FILE_PROVENANCE_BYTES) !== options.inventory.afterDigest) {
    throw new Error("stale-authority");
  }
  await assertAgentPathAllowed(options.store.projectRoot, path);
  const provenancePath = toFsPath(options.store.projectRoot, ".legion-cli/workflow/file-provenance.yaml");
  let prior: FileProvenance | null = null;
  try {
    await assertNoLinkInPath(provenancePath, { root: options.store.projectRoot });
    prior = FileProvenanceSchema.parse(parseSafeYaml(await readBoundedUtf8(provenancePath, options.store.projectRoot, 64 * 1024 * 1024)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const existing = prior?.files.find((entry) => normalizePathKey(entry.path) === normalizePathKey(path));
  const joinedLabel = existing ? joinLabels([existing.label, label]) : label;
  const verificationFile = {
    path,
    sha256: options.inventory.afterDigest,
    label: joinedLabel,
    producer: {
      kind: "verification",
      runId: options.runId,
      checkIds: [options.checkId],
      commandFingerprint: options.commandFingerprint,
    },
    recordedAt: new Date().toISOString(),
  };
  const files: unknown[] = [
    ...(prior?.files.filter((entry) => normalizePathKey(entry.path) !== normalizePathKey(path)) ?? []),
    verificationFile,
  ];
  const record = FileProvenanceSchema.parse({
    schemaVersion: SCHEMA_VERSION.fileProvenance,
    approvalId: options.approvalId,
    policyFingerprint: state.checkpoint.identities.policyFingerprint,
    files,
  });
  await atomicWriteFile(provenancePath, formatYamlDocument(record), { root: options.store.projectRoot });
}

export async function recordGovernedFileProvenance(options: {
  store: LegionStore;
  approvalId: string;
  runId: string;
  actionId: string;
  projectRelativePath: string;
  bytes: Uint8Array;
}): Promise<void> {
  const state = await inspectProtectedGovernedRun(options.store, options.runId);
  if (!state || state.checkpoint.phase !== "program" || state.checkpoint.identities.approvalId !== options.approvalId) throw new Error("stale-authority");
  const effect = state.checkpoint.effects.find((entry) => entry.actionId === options.actionId && entry.kind === "write" && entry.state === "completed" && entry.outcome?.kind === "success");
  if (!effect) throw new Error("policy-denied");
  const operation = state.checkpoint.program.operations.find((entry) => entry.id === effect.operationId);
  if (!operation || operation.kind !== "write" || normalizePathKey(operation.path) !== normalizePathKey(options.projectRelativePath) || effect.resultDigest !== sha256(options.bytes)) throw new Error("recovery-value-mismatch");
  const inputValue = state.checkpoint.values.find((value) => value.id === operation.value);
  if (!inputValue || inputValue.digest !== effect.valueDigest) throw new Error("stale-authority");

  const path = options.projectRelativePath.replaceAll("\\", "/");
  await assertAgentPathAllowed(options.store.projectRoot, path);
  const absPath = toFsPath(options.store.projectRoot, path);
  await assertNoLinkInPath(absPath, { root: options.store.projectRoot });
  if (options.bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("resource-limit");
  const actual = await readBoundedBytes(absPath, options.store.projectRoot, MAX_SOURCE_BYTES);
  if (sha256(actual) !== sha256(options.bytes)) throw new Error("recovery-value-mismatch");

  const provenancePath = toFsPath(options.store.projectRoot, ".legion-cli/workflow/file-provenance.yaml");
  let prior: FileProvenance | null = null;
  try {
    await assertNoLinkInPath(provenancePath, { root: options.store.projectRoot });
    prior = FileProvenanceSchema.parse(parseSafeYaml(await readBoundedUtf8(provenancePath, options.store.projectRoot, 64 * 1024 * 1024)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const existing = prior?.files.find((entry) => normalizePathKey(entry.path) === normalizePathKey(path));
  const label = existing ? joinLabels([existing.label, inputValue.label]) : inputValue.label;
  const file: FileProvenance["files"][number] = {
    path,
    sha256: sha256(options.bytes),
    label,
    producer: { kind: "governed-action", runId: options.runId, actionId: options.actionId },
    recordedAt: new Date().toISOString(),
  };
  const files = [...(prior?.files.filter((entry) => normalizePathKey(entry.path) !== normalizePathKey(path)) ?? []), file];
  const record = FileProvenanceSchema.parse({
    schemaVersion: SCHEMA_VERSION.fileProvenance,
    approvalId: options.approvalId,
    policyFingerprint: state.checkpoint.identities.policyFingerprint,
    files,
  });
  await atomicWriteFile(provenancePath, formatYamlDocument(record), { root: options.store.projectRoot });
}

export function newApproval(action: Omit<ActionApproval, "schemaVersion" | "approvalId" | "approvedAt">): ActionApproval {
  return ActionApprovalSchema.parse({
    ...action,
    schemaVersion: SCHEMA_VERSION.actionApproval,
    approvalId: randomUUID().toLowerCase(),
    approvedAt: new Date().toISOString(),
  });
}
