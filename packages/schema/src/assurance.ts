import { z } from "zod";
import { normalizePathKey } from "./paths.js";
import { SCHEMA_VERSION } from "./versions.js";
import { AssuranceConfigurationSchema, AssuranceDetailSchema, AssuranceIdSchema, AssuranceIdsSchema, AssurancePathSchema, AssurancePathsSchema, AssuranceSha256Schema, JsonPointerSchema, OpaqueIdSchema, OpaqueIdsSchema, UtcTimestampSchema, boundedRecord, uniqueBy } from "./assurance-primitives.js";
import { ComponentRuntimeIdentitySchema, JsonContractConfigurationSchema, KnowledgeSelectorSchema, ValidatorOutputSchema, jsonContractFiles } from "./component.js";

export const ConfidentialitySchema = z.enum(["public", "workspace", "sealed"]);
export const ProvenanceLabelSchema = z.strictObject({ origins: AssuranceIdsSchema, integrity: z.enum(["approved", "untrusted"]), confidentiality: ConfidentialitySchema });
export type ProvenanceLabel = z.infer<typeof ProvenanceLabelSchema>;
export const AssurancePlanSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.assurancePlan), specId: OpaqueIdSchema,
  acceptanceIds: OpaqueIdsSchema, taskIds: OpaqueIdsSchema,
  security: z.strictObject({
    mode: z.enum(["information-flow", "adapter-default"]),
    sources: z.array(z.strictObject({ id: AssuranceIdSchema, path: AssurancePathSchema, classification: ConfidentialitySchema })).max(256),
    sinks: z.array(z.strictObject({ id: AssuranceIdSchema, origin: z.string().url().max(4096), classifications: z.array(ConfidentialitySchema).min(1).max(3) })).max(256),
    transformations: z.array(z.strictObject({ id: AssuranceIdSchema, instruction: z.string().min(1).max(16384) })).max(256),
    tasks: z.array(z.strictObject({ taskId: OpaqueIdSchema, readPaths: AssurancePathsSchema, transformationIds: AssuranceIdsSchema })).max(256),
    externalCalls: z.array(z.strictObject({ id: AssuranceIdSchema, taskIds: OpaqueIdsSchema, tool: z.string().min(1).max(256), sinkId: AssuranceIdSchema, authority: AssuranceConfigurationSchema, dataPointers: z.array(JsonPointerSchema).max(256), effect: z.enum(["provider", "http-mcp"]) })).max(256),
  }),
  knowledge: z.array(z.strictObject({
    id: AssuranceIdSchema, statement: z.string().min(1).max(16384), source: z.strictObject({ path: AssurancePathSchema, selector: KnowledgeSelectorSchema.optional() }),
    acceptanceIds: OpaqueIdsSchema.refine((v) => v.length > 0), taskIds: OpaqueIdsSchema, dependsOn: AssuranceIdsSchema, checkIds: AssuranceIdsSchema,
  })).max(256),
  validators: z.array(z.strictObject({
    id: AssuranceIdSchema, extensionRef: z.string().regex(/^extension:[a-z][a-z0-9-]{0,63}$/), extensionCheckId: AssuranceIdSchema,
    componentSha256: AssuranceSha256Schema, inputUnitIds: AssuranceIdsSchema, inputFiles: AssurancePathsSchema,
    acceptanceIds: OpaqueIdsSchema.refine((v) => v.length > 0), configuration: AssuranceConfigurationSchema,
  })).max(256),
  delivery: z.strictObject({ artifacts: z.array(z.strictObject({ name: AssuranceIdSchema, path: AssurancePathSchema })).max(256) }),
}).superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  uniqueBy(v.security.sources, (x) => x.id, ctx, ["security", "sources"]);
  uniqueBy(v.security.sources, (x) => normalizePathKey(x.path), ctx, ["security", "sources"]);
  uniqueBy(v.security.sinks, (x) => x.id, ctx, ["security", "sinks"]);
  v.security.sinks.forEach((x) => uniqueBy(x.classifications, String, ctx));
  uniqueBy(v.security.transformations, (x) => x.id, ctx);
  uniqueBy(v.security.tasks, (x) => x.taskId, ctx);
  uniqueBy(v.security.externalCalls, (x) => x.id, ctx);
  uniqueBy(v.knowledge, (x) => x.id, ctx, ["knowledge"]);
  uniqueBy(v.validators, (x) => x.id, ctx, ["validators"]);
  uniqueBy(v.delivery.artifacts, (x) => x.name, ctx);
  uniqueBy(v.delivery.artifacts, (x) => normalizePathKey(x.path), ctx);
  const units = new Map(v.knowledge.map((x) => [x.id, x]));
  const checks = new Set(v.validators.map((x) => x.id));
  const transformations = new Set(v.security.transformations.map((x) => x.id));
  const sinks = new Set(v.security.sinks.map((x) => x.id));
  const refs = (ids: readonly string[], declared: readonly string[], name: string) => { if (ids.some((id) => !declared.includes(id))) issue(`Undeclared ${name}`); };
  v.security.tasks.forEach((x) => {
    refs([x.taskId], v.taskIds, "task");
    if (x.transformationIds.some((id) => !transformations.has(id))) issue("Undeclared transformation");
  });
  if (v.security.mode === "information-flow" && v.taskIds.some((id) => !v.security.tasks.some((x) => x.taskId === id))) issue("Every governed task requires an explicit read/transformation contract");
  v.security.externalCalls.forEach((x) => {
    refs(x.taskIds, v.taskIds, "external-call task");
    if (!sinks.has(x.sinkId)) issue("Undeclared sink");
    uniqueBy(x.dataPointers, String, ctx);
    if (x.dataPointers.some((p, i) => x.dataPointers.some((q, j) => i !== j && (p === q || p.startsWith(`${q}/`))))) issue("Overlapping data pointers");
    if (x.dataPointers.includes("")) issue("Root request cannot be a data-only pointer");
  });
  v.knowledge.forEach((x) => {
    refs(x.acceptanceIds, v.acceptanceIds, "knowledge acceptance"); refs(x.taskIds, v.taskIds, "knowledge task");
    if (x.dependsOn.some((id) => !units.has(id))) issue("Undeclared knowledge dependency");
    if (x.checkIds.some((id) => !checks.has(id))) issue("Undeclared knowledge check");
    x.checkIds.forEach((id) => { if (!v.validators.find((c) => c.id === id)?.inputUnitIds.includes(x.id)) issue("Knowledge/check link must be reciprocal"); });
  });
  const active = new Set<string>(); const done = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) { issue("Cyclic knowledge dependency"); return; }
    if (done.has(id)) return;
    active.add(id); units.get(id)?.dependsOn.forEach(visit); active.delete(id); done.add(id);
  }
  v.knowledge.forEach((x) => visit(x.id));
  v.validators.forEach((x) => {
    refs(x.acceptanceIds, v.acceptanceIds, "validator acceptance");
    if (x.inputUnitIds.some((id) => !units.has(id))) issue("Undeclared validator unit");
    x.inputUnitIds.forEach((id) => { if (!units.get(id)?.checkIds.includes(x.id)) issue("Check/knowledge link must be reciprocal"); });
    if (x.extensionRef === "extension:json-contract") {
      if (x.extensionCheckId !== "json-contract") issue("JSON contract requires its declared check ID");
      const config = JsonContractConfigurationSchema.safeParse(x.configuration);
      if (!config.success) issue("Invalid JSON-contract configuration");
      else if (config.data.assertions.flatMap((a) => jsonContractFiles(a.predicate)).some((path) => !x.inputFiles.includes(path))) issue("Predicate file is not a declared raw input");
    }
  });
}), 8 * 1024 * 1024);
export type AssurancePlan = z.infer<typeof AssurancePlanSchema>;
export const AssuranceApprovalSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.assuranceApproval), approvalId: OpaqueIdSchema, specId: OpaqueIdSchema,
  planFingerprint: AssuranceSha256Schema, manifestDigest: AssuranceSha256Schema, approvedAt: UtcTimestampSchema,
  nativeHost: ComponentRuntimeIdentitySchema.nullable(),
  baselineSources: z.array(z.strictObject({ path: AssurancePathSchema, sha256: AssuranceSha256Schema.nullable() })).max(256),
}).superRefine((v, ctx) => uniqueBy(v.baselineSources, (x) => normalizePathKey(x.path), ctx)), 1024 * 1024);
export type AssuranceApproval = z.infer<typeof AssuranceApprovalSchema>;
export function validateAssuranceAdoption(plan: AssurancePlan, approval: AssuranceApproval): void {
  if (plan.specId !== approval.specId) throw new Error("Assurance spec identity mismatch");
  if ((plan.validators.length === 0) !== (approval.nativeHost === null)) throw new Error("Native host identity required exactly when validators are declared");
  if (approval.baselineSources.length !== plan.security.sources.length || plan.security.sources.some((x) => !approval.baselineSources.some((b) => b.path === x.path))) throw new Error("Baseline must bind every declared source");
}
export const CheckInputIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), path: AssurancePathSchema, exists: z.literal(true), mode: z.string().min(1).max(32), sha256: AssuranceSha256Schema }),
  z.strictObject({ kind: z.literal("missing"), path: AssurancePathSchema, exists: z.literal(false) }),
  z.strictObject({ kind: z.literal("unit"), unitId: AssuranceIdSchema, path: AssurancePathSchema, mode: z.string().min(1).max(32), syntaxDigest: AssuranceSha256Schema, observedFileDigest: AssuranceSha256Schema, selector: KnowledgeSelectorSchema.optional() }),
]);
export const CheckEvidenceSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.checkEvidence), checkId: AssuranceIdSchema, approvalId: OpaqueIdSchema,
  extensionCheckId: AssuranceIdSchema,
  manifestDigest: AssuranceSha256Schema, inputDigest: AssuranceSha256Schema.nullable(), reuseKey: AssuranceSha256Schema,
  inputs: z.array(CheckInputIdentitySchema).max(512), moduleSha256: AssuranceSha256Schema,
  runtime: ComponentRuntimeIdentitySchema, parserVersion: z.string().min(1).max(128).nullable(), configurationDigest: AssuranceSha256Schema,
  result: z.enum(["passed", "failed", "unavailable"]), output: ValidatorOutputSchema.nullable(),
  reason: AssuranceDetailSchema.min(1).nullable(),
  observationDigest: AssuranceSha256Schema.nullable(), executionId: OpaqueIdSchema, reusedFrom: OpaqueIdSchema.nullable(), recordedAt: UtcTimestampSchema,
  observationLabel: ProvenanceLabelSchema.optional(),
}).superRefine((v, ctx) => {
  uniqueBy(v.inputs, (x) => x.kind === "unit" ? `unit:${x.unitId}` : `file:${normalizePathKey(x.path)}`, ctx);
  if (v.reusedFrom !== null && (v.result !== "passed" || v.reusedFrom === v.executionId)) ctx.addIssue({ code: "custom", message: "Only a prior passed execution may be reused" });
  if (v.result === "unavailable" ? v.output !== null || v.observationDigest !== null : v.output === null || v.output.status !== v.result || v.observationDigest === null) ctx.addIssue({ code: "custom", message: "Result/output identity mismatch" });
  if (v.result !== "unavailable" && v.inputDigest === null) ctx.addIssue({ code: "custom", message: "An executed validator result requires the admitted packet digest" });
  if ((v.result === "unavailable") !== (v.reason !== null)) ctx.addIssue({ code: "custom", message: "A host-unavailable result requires its diagnostic; executed results use observations" });
  if (v.output !== null && v.output.checkId !== v.extensionCheckId) ctx.addIssue({ code: "custom", message: "Module output must name the approved extension check" });
}), 4 * 1024 * 1024);
export type CheckEvidence = z.infer<typeof CheckEvidenceSchema>;
export const AssuranceExecutionSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.assuranceExecution), executionId: OpaqueIdSchema, approvalId: OpaqueIdSchema, manifestDigest: AssuranceSha256Schema,
  productFingerprint: AssuranceSha256Schema, environmentFingerprint: AssuranceSha256Schema,
  checks: z.array(z.strictObject({ checkId: AssuranceIdSchema, receiptDigest: AssuranceSha256Schema, executionId: OpaqueIdSchema, result: z.enum(["passed", "failed", "unavailable"]), reuse: z.enum(["executed", "reused"]) })).max(256),
  policyStatus: z.enum(["enforced", "not-enforced", "blocked"]), traceStatus: z.enum(["valid", "incomplete", "invalid"]),
  status: z.enum(["passed", "blocked"]), blocker: z.string().min(1).max(4096).nullable(), recordedAt: UtcTimestampSchema,
}).superRefine((v, ctx) => {
  uniqueBy(v.checks, (x) => x.checkId, ctx);
  if (v.status === "passed" && (v.checks.some((x) => x.result !== "passed") || v.traceStatus !== "valid" || v.policyStatus === "blocked" || v.blocker !== null)) ctx.addIssue({ code: "custom", message: "Passed execution has unmet gates" });
  if (v.status === "blocked" && v.blocker === null) ctx.addIssue({ code: "custom", message: "Blocked execution requires a concrete blocker" });
}), 1024 * 1024);
export type AssuranceExecution = z.infer<typeof AssuranceExecutionSchema>;
