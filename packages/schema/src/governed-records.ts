import { createHash } from "node:crypto";
import { z } from "zod";
import { SCHEMA_VERSION } from "./versions.js";
import { normalizePathKey } from "./paths.js";
import { AssuranceConfigurationSchema, AssuranceIdSchema, AssuranceIdsSchema, AssurancePathSchema, AssuranceSha256Schema, OpaqueIdSchema, UtcTimestampSchema, boundedRecord, uniqueBy } from "./assurance-primitives.js";
import { ProvenanceLabelSchema } from "./assurance.js";

export const GovernedOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("read"), id: AssuranceIdSchema, path: AssurancePathSchema }),
  z.strictObject({ kind: z.literal("derive"), id: AssuranceIdSchema, transformationId: AssuranceIdSchema, inputs: AssuranceIdsSchema.refine((v) => v.length > 0) }),
  z.strictObject({ kind: z.literal("write"), id: AssuranceIdSchema, path: AssurancePathSchema, value: AssuranceIdSchema, expectedTargetDigest: AssuranceSha256Schema.nullable() }),
  z.strictObject({ kind: z.literal("external-call"), id: AssuranceIdSchema, grantId: AssuranceIdSchema, authority: AssuranceConfigurationSchema, data: z.array(z.strictObject({ pointer: z.string().regex(/^(?:\/(?:[^~]|~[01])*)+$/).max(4096), value: AssuranceIdSchema })).max(256) }),
  z.strictObject({ kind: z.literal("finish"), id: AssuranceIdSchema }),
]);
export const GovernedProgramSchema = boundedRecord(z.strictObject({ operations: z.array(GovernedOperationSchema).min(1).max(256) }).superRefine((v, ctx) => {
  uniqueBy(v.operations, (x) => x.id, ctx);
  const values = new Set<string>();
  v.operations.forEach((op, i) => {
    const refs = op.kind === "derive" ? op.inputs : op.kind === "write" ? [op.value] : op.kind === "external-call" ? op.data.map((x) => x.value) : [];
    if (refs.some((id) => !values.has(id))) ctx.addIssue({ code: "custom", message: "Program references a missing or future value", path: ["operations", i] });
    if (op.kind === "read" || op.kind === "derive" || op.kind === "external-call") values.add(op.id);
    if (op.kind === "finish" && i !== v.operations.length - 1) ctx.addIssue({ code: "custom", message: "finish must be last" });
    if (op.kind === "external-call") {
      uniqueBy(op.data, (x) => x.pointer, ctx);
      if (op.data.some((x, j) => op.data.some((y, k) => j !== k && x.pointer.startsWith(`${y.pointer}/`)))) ctx.addIssue({ code: "custom", message: "Overlapping data pointers" });
    }
  });
  if (v.operations.at(-1)?.kind !== "finish") ctx.addIssue({ code: "custom", message: "Program must finish" });
}), 1024 * 1024);
export type GovernedProgram = z.infer<typeof GovernedProgramSchema>;

export const ActionApprovalSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.actionApproval), approvalId: OpaqueIdSchema, runId: OpaqueIdSchema, actionId: AssuranceIdSchema,
  programKind: z.enum(["bootstrap", "governed"]), authorityDigest: AssuranceSha256Schema, programFingerprint: AssuranceSha256Schema,
  actionKind: z.enum(["provider", "write", "http-mcp"]), policyFingerprint: AssuranceSha256Schema, valueDigest: AssuranceSha256Schema,
  sinkId: AssuranceIdSchema, requestDigest: AssuranceSha256Schema, approvedAt: UtcTimestampSchema,
  operatorId: OpaqueIdSchema, reason: z.string().min(1).max(4096).refine((v) => v.trim().length > 0), state: z.enum(["approved", "reserved", "consumed", "uncertain"]),
}), 16 * 1024);
export type ActionApproval = z.infer<typeof ActionApprovalSchema>;
const FileProducerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("governed-action"), runId: OpaqueIdSchema, actionId: AssuranceIdSchema }),
  z.strictObject({ kind: z.literal("verification"), runId: OpaqueIdSchema, checkIds: AssuranceIdsSchema.refine((ids) => ids.length > 0), commandFingerprint: AssuranceSha256Schema }),
]);
export const FileProvenanceSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.fileProvenance), approvalId: OpaqueIdSchema, policyFingerprint: AssuranceSha256Schema,
  files: z.array(z.strictObject({ path: AssurancePathSchema, sha256: AssuranceSha256Schema, label: ProvenanceLabelSchema, producer: FileProducerSchema, recordedAt: UtcTimestampSchema })).max(16384),
}).superRefine((v, ctx) => uniqueBy(v.files, (x) => normalizePathKey(x.path), ctx)), 64 * 1024 * 1024);
export type FileProvenance = z.infer<typeof FileProvenanceSchema>;

const IdentitiesSchema = z.strictObject({
  promptFingerprint: AssuranceSha256Schema, configurationFingerprint: AssuranceSha256Schema, contractFingerprint: AssuranceSha256Schema,
  sourceFingerprint: AssuranceSha256Schema, jailFingerprint: AssuranceSha256Schema, hostFingerprint: AssuranceSha256Schema,
  approvalId: OpaqueIdSchema, policyFingerprint: AssuranceSha256Schema,
  provider: z.strictObject({ endpoint: z.string().url().max(4096), model: z.string().min(1).max(256), profile: OpaqueIdSchema }),
});
const AuthorityBindingSchema = z.strictObject({ programKind: z.enum(["bootstrap", "governed"]), authorityDigest: AssuranceSha256Schema, programFingerprint: AssuranceSha256Schema });
const UsageSchema = z.strictObject({
  requestCharge: z.union([z.literal(0), z.literal(1)]), inputTokens: z.number().int().safe().nonnegative().nullable(),
  outputTokens: z.number().int().safe().nonnegative().nullable(), totalTokens: z.number().int().safe().nonnegative().nullable(),
  tokenLowerBound: z.number().int().safe().nonnegative(), costUsd: z.number().finite().nonnegative().nullable(),
  tokenAccounting: z.enum(["complete", "incomplete"]), costAccounting: z.enum(["complete", "incomplete"]),
}).superRefine((u, ctx) => {
  if (u.totalTokens !== null && u.inputTokens !== null && u.outputTokens !== null && u.totalTokens < u.inputTokens + u.outputTokens) ctx.addIssue({ code: "custom", message: "Total usage is below reported token usage" });
  if (u.tokenLowerBound < Math.max(u.inputTokens ?? 0, u.outputTokens ?? 0, u.totalTokens ?? 0)) ctx.addIssue({ code: "custom", message: "Token lower bound is below reported usage" });
  if (u.tokenAccounting === "complete" && (u.inputTokens === null || u.outputTokens === null || u.totalTokens === null)) ctx.addIssue({ code: "custom", message: "Complete token accounting requires all token totals" });
  if (u.costAccounting === "complete" && u.costUsd === null) ctx.addIssue({ code: "custom", message: "Complete cost accounting requires a cost" });
});
export const ProviderUsageReceiptSchema = UsageSchema;
export type ProviderUsageReceipt = z.infer<typeof ProviderUsageReceiptSchema>;
const FailureCodeSchema = z.enum(["approval-required", "policy-denied", "stale-authority", "target-conflict", "budget-exceeded", "resource-limit", "invalid-program", "invalid-output", "transport-failure", "uncertain-effect", "missing-sealed-value", "recovery-value-mismatch"]);
const OutcomeSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("success"), resultDigest: AssuranceSha256Schema }), z.strictObject({ kind: z.literal("failure"), code: FailureCodeSchema })]);
const ValueProducerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("read"), operationId: AssuranceIdSchema, path: AssurancePathSchema, sourceDigest: AssuranceSha256Schema }),
  z.strictObject({ kind: z.literal("derive"), operationId: AssuranceIdSchema, transformationId: AssuranceIdSchema, inputIds: AssuranceIdsSchema, originalCallId: AssuranceIdSchema }),
  z.strictObject({ kind: z.literal("external-call"), operationId: AssuranceIdSchema, actionId: AssuranceIdSchema }),
]);
const RetainedValueSchema = z.discriminatedUnion("encoding", [z.strictObject({ encoding: z.literal("utf8"), content: z.string().max(1024 * 1024) }), z.strictObject({ encoding: z.literal("base64"), content: z.string().max(2 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) })]).nullable();
const ValueSchema = z.strictObject({ id: AssuranceIdSchema, digest: AssuranceSha256Schema, bytes: z.number().int().safe().min(0).max(1024 * 1024), label: ProvenanceLabelSchema, producer: ValueProducerSchema, retained: RetainedValueSchema }).superRefine((value, ctx) => {
  if (value.retained === null) return;
  if (value.label.confidentiality === "sealed") ctx.addIssue({ code: "custom", message: "Sealed values cannot be retained" });
  const bytes = value.retained.encoding === "utf8" ? new TextEncoder().encode(value.retained.content) : Buffer.from(value.retained.content, "base64");
  if (bytes.byteLength !== value.bytes) ctx.addIssue({ code: "custom", message: "Retained value byte count mismatch" });
  if (createHash("sha256").update(bytes).digest("hex") !== value.digest) ctx.addIssue({ code: "custom", message: "Retained value digest mismatch" });
});
const ProviderPurposeSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("plan") }), z.strictObject({ kind: z.literal("derive"), operationId: AssuranceIdSchema }), z.strictObject({ kind: z.literal("rederive"), operationId: AssuranceIdSchema, originalCallId: AssuranceIdSchema }), z.strictObject({ kind: z.literal("external-call"), operationId: AssuranceIdSchema, grantId: AssuranceIdSchema })]);
export const GovernedValueRecordSchema = ValueSchema;
export type GovernedValueRecord = z.infer<typeof GovernedValueRecordSchema>;
const ProviderCallSchema = z.strictObject({
  actionId: AssuranceIdSchema, sequence: z.number().int().safe().positive(), authority: AuthorityBindingSchema,
  role: z.enum(["planner", "quarantined"]), purpose: ProviderPurposeSchema, sinkId: AssuranceIdSchema,
  bodyDigest: AssuranceSha256Schema, requestDigest: AssuranceSha256Schema, requestBytes: z.number().int().safe().min(1).max(8 * 1024 * 1024),
  valueDigest: AssuranceSha256Schema, label: ProvenanceLabelSchema, inputs: z.array(z.strictObject({ id: AssuranceIdSchema, digest: AssuranceSha256Schema, bytes: z.number().int().safe().nonnegative(), label: ProvenanceLabelSchema })).max(256),
  state: z.enum(["awaiting-approval", "pending", "completed", "uncertain"]), approvalDigest: AssuranceSha256Schema.nullable(),
  outcome: OutcomeSchema.nullable(), responseDigest: AssuranceSha256Schema.nullable(), responseBytes: z.number().int().safe().min(0).max(8 * 1024 * 1024).nullable(), usage: UsageSchema,
}).superRefine((call, ctx) => {
  if ((call.state === "awaiting-approval") !== (call.usage.requestCharge === 0)) ctx.addIssue({ code: "custom", message: "Only awaiting approval is uncharged" });
  if ((call.responseDigest === null) !== (call.responseBytes === null)) ctx.addIssue({ code: "custom", message: "Response digest and byte count must be recorded together" });
  if ((call.state === "completed") !== (call.outcome !== null)) ctx.addIssue({ code: "custom", message: "Completed call needs one outcome" });
  if (call.state !== "completed" && call.outcome !== null) ctx.addIssue({ code: "custom", message: "Nonterminal call cannot have outcome" });
  if (call.state !== "completed" && call.responseDigest !== null) ctx.addIssue({ code: "custom", message: "Nonterminal call cannot have a response receipt" });
  if (call.state === "awaiting-approval" && call.approvalDigest !== null) ctx.addIssue({ code: "custom", message: "Awaiting approval cannot have a reserved approval digest" });
  if (call.state === "completed" && call.outcome?.kind === "success" && (call.responseDigest === null || call.responseBytes === null || call.responseBytes === 0)) ctx.addIssue({ code: "custom", message: "Successful provider call requires nonempty captured response evidence" });
  if (call.state === "completed" && call.outcome?.kind === "failure" && call.responseDigest === null && call.outcome.code !== "transport-failure") ctx.addIssue({ code: "custom", message: "Only transport failure may omit response evidence" });
});

export const HttpRunAuthoritySchema = boundedRecord(z.discriminatedUnion("stage", [
  z.strictObject({ schemaVersion: z.literal(SCHEMA_VERSION.httpRunAuthority), stage: z.literal("bootstrap"), runId: OpaqueIdSchema, taskId: OpaqueIdSchema, identities: IdentitiesSchema, manifestDigest: AssuranceSha256Schema, plannerInputDigest: AssuranceSha256Schema, programKind: z.literal("bootstrap"), programFingerprint: AssuranceSha256Schema, createdAt: UtcTimestampSchema }),
  z.strictObject({ schemaVersion: z.literal(SCHEMA_VERSION.httpRunAuthority), stage: z.literal("program"), runId: OpaqueIdSchema, taskId: OpaqueIdSchema, identities: IdentitiesSchema, bootstrapAuthorityDigest: AssuranceSha256Schema, plannerCallId: AssuranceIdSchema, plannerResultDigest: AssuranceSha256Schema, programKind: z.literal("governed"), programFingerprint: AssuranceSha256Schema, program: GovernedProgramSchema, createdAt: UtcTimestampSchema }),
]), 2 * 1024 * 1024);
export type HttpRunAuthority = z.infer<typeof HttpRunAuthoritySchema>;

const OperationEffectSchema = z.strictObject({
  operationId: AssuranceIdSchema, actionId: AssuranceIdSchema, kind: z.enum(["write", "external-call"]),
  authority: AuthorityBindingSchema, sinkId: AssuranceIdSchema, requestDigest: AssuranceSha256Schema, valueDigest: AssuranceSha256Schema,
  state: z.enum(["awaiting-approval", "pending", "completed", "uncertain"]), approvalDigest: AssuranceSha256Schema.nullable(),
  outcome: OutcomeSchema.nullable(), resultDigest: AssuranceSha256Schema.nullable(),
  responseDigest: AssuranceSha256Schema.nullable(), responseBytes: z.number().int().safe().min(0).max(8 * 1024 * 1024).nullable(),
}).superRefine((e, ctx) => {
  if ((e.state === "completed") !== (e.outcome !== null)) ctx.addIssue({ code: "custom", message: "Completed effect requires an outcome" });
  if ((e.responseDigest === null) !== (e.responseBytes === null)) ctx.addIssue({ code: "custom", message: "Effect response digest and byte count must be recorded together" });
  if (e.state === "awaiting-approval" && (e.approvalDigest !== null || e.outcome !== null || e.resultDigest !== null || e.responseDigest !== null)) ctx.addIssue({ code: "custom", message: "Awaiting approval is an unreserved, undispatched exact proposal" });
  if ((e.state === "pending" || e.state === "uncertain") && e.outcome !== null) ctx.addIssue({ code: "custom", message: "Unresolved effect cannot have an outcome" });
  if (e.state !== "completed" && e.responseDigest !== null) ctx.addIssue({ code: "custom", message: "Uncompleted effect cannot have a response receipt" });
  if (e.kind === "write" && e.responseDigest !== null) ctx.addIssue({ code: "custom", message: "Write effects cannot carry transport response receipts" });
  if (e.kind === "external-call" && e.state === "completed" && e.outcome?.kind === "success" && (e.responseDigest === null || e.responseBytes === null || e.responseBytes === 0)) ctx.addIssue({ code: "custom", message: "Successful MCP effect requires nonempty raw response evidence" });
  if (e.outcome?.kind === "success" && e.resultDigest === null) ctx.addIssue({ code: "custom", message: "Successful effect requires result digest" });
  if (e.outcome?.kind === "failure" && e.resultDigest !== null) ctx.addIssue({ code: "custom", message: "Failed effect cannot have result digest" });
});
const RoleUsageSchema = z.strictObject({ requests: z.number().int().safe().nonnegative(), inputTokens: z.number().int().safe().nonnegative().nullable(), outputTokens: z.number().int().safe().nonnegative().nullable(), costUsd: z.number().finite().nonnegative().nullable(), tokenLowerBound: z.number().int().safe().nonnegative(), tokenAccounting: z.enum(["complete", "incomplete"]), costAccounting: z.enum(["complete", "incomplete"]) });
const CheckpointBase = {
  schemaVersion: z.literal(SCHEMA_VERSION.httpGovernedCheckpoint), runId: OpaqueIdSchema, bootstrapAuthorityDigest: AssuranceSha256Schema,
  identities: IdentitiesSchema, revision: z.number().int().safe().nonnegative(), providerCalls: z.array(ProviderCallSchema).max(4096),
  usage: z.strictObject({ planner: RoleUsageSchema, quarantined: RoleUsageSchema }), status: z.enum(["running", "blocked", "complete"]),
  blocker: FailureCodeSchema.nullable(), recordedAt: UtcTimestampSchema,
};
const ProgramCheckpointBase = {
  ...CheckpointBase,
  bootstrapProviderCalls: z.array(ProviderCallSchema).max(4096),
};
export const HttpGovernedCheckpointSchema = boundedRecord(z.discriminatedUnion("phase", [
  z.strictObject({ ...CheckpointBase, phase: z.literal("bootstrap"), programAuthorityDigest: z.null(), candidateProgram: GovernedProgramSchema.nullable(), cursor: z.literal(0), values: z.array(ValueSchema).max(0), effects: z.array(OperationEffectSchema).max(0) }),
  z.strictObject({ ...ProgramCheckpointBase, phase: z.literal("program"), programAuthorityDigest: AssuranceSha256Schema, programKind: z.literal("governed"), programFingerprint: AssuranceSha256Schema, program: GovernedProgramSchema, candidateProgram: GovernedProgramSchema.nullable(), cursor: z.number().int().safe().min(0).max(256), values: z.array(ValueSchema).max(256), effects: z.array(OperationEffectSchema).max(256) }),
]).superRefine((v, ctx) => {
  const bootstrapCalls = v.phase === "program" ? v.bootstrapProviderCalls : [];
  const allCalls = [...bootstrapCalls, ...v.providerCalls];
  if (allCalls.length > 4096) ctx.addIssue({ code: "custom", message: "Provider call ledger exceeds 4096 entries" });
  allCalls.forEach((call, index) => {
    if (call.sequence !== index + 1) ctx.addIssue({ code: "custom", message: "Provider call sequence must be strictly increasing and contiguous" });
  });
  uniqueBy(allCalls, (x) => x.actionId, ctx);
  const actionIds = new Set(allCalls.map((x) => x.actionId));
  uniqueBy(v.effects, (x) => x.actionId, ctx);
  if (v.effects.some((x) => actionIds.has(x.actionId))) ctx.addIssue({ code: "custom", message: "Action IDs must be globally unique" });
  if (v.phase === "bootstrap" && v.providerCalls.some((x) => x.role !== "planner" || x.purpose.kind !== "plan" || x.authority.programKind !== "bootstrap" || x.authority.authorityDigest !== v.bootstrapAuthorityDigest || x.inputs.length !== 0)) ctx.addIssue({ code: "custom", message: "Bootstrap accepts only input-free planner calls bound to bootstrap authority" });
  if (v.phase === "program" && v.bootstrapProviderCalls.some((x) => x.role !== "planner" || x.purpose.kind !== "plan" || x.authority.programKind !== "bootstrap" || x.authority.authorityDigest !== v.bootstrapAuthorityDigest || x.inputs.length !== 0 || x.state === "pending" || x.state === "awaiting-approval" || x.state === "uncertain")) ctx.addIssue({ code: "custom", message: "Historical planner calls must be resolved and bound to bootstrap authority" });
  if (v.phase === "program" && v.providerCalls.some((x) => x.role !== "quarantined" || x.purpose.kind === "plan" || x.authority.programKind !== "governed" || x.authority.authorityDigest !== v.programAuthorityDigest || x.authority.programFingerprint !== v.programFingerprint)) ctx.addIssue({ code: "custom", message: "Program-phase provider calls require matching governed authority" });
  if (v.phase === "program" && v.providerCalls.some((x) => {
    const purpose = x.purpose;
    if (purpose.kind !== "external-call") return false;
    const operation = v.program.operations.find((op) => op.id === purpose.operationId);
    return !operation || operation.kind !== "external-call" || operation.grantId !== purpose.grantId ||
      JSON.stringify(x.inputs.map((input) => input.id)) !== JSON.stringify(operation.data.map((entry) => entry.value));
  })) ctx.addIssue({ code: "custom", message: "Provider external-call ledger entry must bind its exact frozen grant and data values" });
  if (v.phase === "program") {
    for (const call of v.providerCalls) {
      const purpose = call.purpose;
      if (purpose.kind === "derive" || purpose.kind === "rederive") {
        const operation = v.program.operations.find((op) => op.id === purpose.operationId);
        if (!operation || operation.kind !== "derive") ctx.addIssue({ code: "custom", message: "Provider derive call must bind a frozen derive operation" });
        else if (JSON.stringify(call.inputs.map((input) => input.id)) !== JSON.stringify(operation.inputs)) ctx.addIssue({ code: "custom", message: "Provider derive inputs must match the frozen operation" });
        if (purpose.kind === "rederive") {
          const original = v.providerCalls.find((candidate) => candidate.actionId === purpose.originalCallId);
          const originalPurpose = original?.purpose;
          if (!original || original.state !== "completed" || original.outcome?.kind !== "success" || originalPurpose?.kind !== "derive" || originalPurpose.operationId !== purpose.operationId) ctx.addIssue({ code: "custom", message: "Re-derive must reference its exact completed original call" });
          if (call.state === "completed" && call.outcome?.kind === "success" && original?.outcome?.kind === "success" && call.outcome.resultDigest !== original.outcome.resultDigest) ctx.addIssue({ code: "custom", message: "Re-derive output differs from original output" });
        }
      }
    }
  }
  if (v.phase === "program") {
    if (v.cursor > v.program.operations.length) ctx.addIssue({ code: "custom", message: "Cursor exceeds program" });
    const ids = new Set<string>();
    if (v.values.reduce((n, x) => n + x.bytes, 0) > 64 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "Value vault exceeds 64 MiB" });
    v.values.forEach((value) => {
      if (ids.has(value.id)) ctx.addIssue({ code: "custom", message: "Duplicate value id" }); ids.add(value.id);
      const producer = value.producer;
      const producerIndex = v.program.operations.findIndex((op) => op.id === producer.operationId);
      const op = v.program.operations[producerIndex];
      if (producerIndex < 0 || producerIndex >= v.cursor || !op || op.kind !== producer.kind) ctx.addIssue({ code: "custom", message: "Value has no executed matching producer" });
      if (producer.kind === "external-call" && !(
        v.effects.some((e) => e.operationId === producer.operationId && e.actionId === producer.actionId && e.state === "completed" && e.outcome?.kind === "success") ||
        v.providerCalls.some((call) => {
          const purpose = call.purpose;
          return call.actionId === producer.actionId && purpose.kind === "external-call" && purpose.operationId === producer.operationId && call.state === "completed" && call.outcome?.kind === "success";
        })
      )) ctx.addIssue({ code: "custom", message: "External value lacks completed successful provider or MCP effect" });
      if (producer.kind === "read" || producer.kind === "derive") {
        if (value.retained === null && value.bytes === 0) return;
      }
      if (value.retained && value.label.confidentiality === "sealed") ctx.addIssue({ code: "custom", message: "Sealed values cannot be retained" });
    });
    v.effects.forEach((effect) => {
      const index = v.program.operations.findIndex((op) => op.id === effect.operationId && op.kind === effect.kind);
      if (index < 0 || (effect.state === "completed" && effect.outcome?.kind === "success" ? index >= v.cursor : index !== v.cursor)) ctx.addIssue({ code: "custom", message: "Effect absent from executed/pending frozen program position" });
      if (effect.state === "completed" && effect.outcome?.kind === "success" && effect.resultDigest === null) ctx.addIssue({ code: "custom", message: "Successful effect requires result digest" });
      if (effect.state === "awaiting-approval" && (effect.approvalDigest !== null || effect.outcome !== null || effect.resultDigest !== null)) ctx.addIssue({ code: "custom", message: "Awaiting approval must retain an exact unreserved intent" });
      const operation = v.program.operations[index];
      if (effect.state === "awaiting-approval" && (!operation || (operation.kind !== "write" && operation.kind !== "external-call"))) ctx.addIssue({ code: "custom", message: "Awaiting approval must bind the current frozen effect operation" });
    });
    v.program.operations.slice(0, v.cursor).forEach((op) => {
      if (op.kind === "write" && !v.effects.some((effect) => effect.operationId === op.id && effect.state === "completed" && effect.outcome?.kind === "success")) ctx.addIssue({ code: "custom", message: "Executed write lacks successful completion" });
      if (op.kind === "external-call" && !((v.effects.some((effect) => effect.operationId === op.id && effect.state === "completed" && effect.outcome?.kind === "success")) || v.providerCalls.some((call) => call.purpose.kind === "external-call" && call.purpose.operationId === op.id && call.state === "completed" && call.outcome?.kind === "success"))) ctx.addIssue({ code: "custom", message: "Executed external call lacks successful completion" });
      if ((op.kind === "read" || op.kind === "derive" || op.kind === "external-call") && !v.values.some((value) => value.id === op.id)) ctx.addIssue({ code: "custom", message: "Executed value producer lacks value record" });
    });
    if (v.providerCalls.filter((x) => x.state === "awaiting-approval" || x.state === "pending" || x.state === "uncertain").length + v.effects.filter((x) => x.state === "awaiting-approval" || x.state === "pending" || x.state === "uncertain").length > 1) ctx.addIssue({ code: "custom", message: "Only one unresolved effect is allowed" });
  }
  for (const role of ["planner", "quarantined"] as const) {
    const calls = allCalls.filter((call) => call.role === role);
    const aggregate = v.usage[role];
    const lower = calls.reduce((n, x) => n + x.usage.tokenLowerBound, 0);
    const input = calls.length > 0 && calls.every((x) => x.usage.inputTokens !== null) ? calls.reduce((n, x) => n + x.usage.inputTokens!, 0) : null;
    const output = calls.length > 0 && calls.every((x) => x.usage.outputTokens !== null) ? calls.reduce((n, x) => n + x.usage.outputTokens!, 0) : null;
    const cost = calls.length > 0 && calls.every((x) => x.usage.costAccounting === "complete" && x.usage.costUsd !== null) ? calls.reduce((n, x) => n + x.usage.costUsd!, 0) : null;
    if (aggregate.requests !== calls.reduce((n, x) => n + x.usage.requestCharge, 0)) ctx.addIssue({ code: "custom", message: "Provider request aggregate differs from ledger" });
    if (aggregate.tokenLowerBound !== lower) ctx.addIssue({ code: "custom", message: "Provider token lower bound differs from ledger" });
    if (aggregate.inputTokens !== input || aggregate.outputTokens !== output || aggregate.costUsd !== cost) ctx.addIssue({ code: "custom", message: "Provider usage sums differ from ledger" });
    if (aggregate.tokenAccounting !== (calls.some((x) => x.usage.tokenAccounting === "incomplete") ? "incomplete" : "complete")) ctx.addIssue({ code: "custom", message: "Token incompleteness cannot be cleared or invented" });
    if (aggregate.costAccounting !== (calls.some((x) => x.usage.costAccounting === "incomplete") ? "incomplete" : "complete")) ctx.addIssue({ code: "custom", message: "Cost incompleteness cannot be cleared or invented" });
  }
  if (v.status === "complete" && (v.phase !== "program" || v.cursor !== v.program.operations.length || v.effects.some((x) => x.state !== "completed" || x.outcome?.kind !== "success") || v.providerCalls.some((x) => x.state !== "completed" || x.outcome?.kind !== "success") || v.blocker !== null)) ctx.addIssue({ code: "custom", message: "Incomplete effects cannot complete a run" });
  if (v.status === "blocked" && v.blocker === null) ctx.addIssue({ code: "custom", message: "Blocked run requires blocker" });
}), 80 * 1024 * 1024);
export type HttpGovernedCheckpoint = z.infer<typeof HttpGovernedCheckpointSchema>;
