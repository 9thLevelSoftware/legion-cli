import { z } from "zod";
import { SCHEMA_VERSION } from "./versions.js";
import { normalizePathKey } from "./paths.js";
import { AssuranceIdSchema, AssurancePathSchema, AssuranceSha256Schema, OpaqueIdSchema, UtcTimestampSchema, boundedRecord, uniqueBy } from "./assurance-primitives.js";
import { GovernanceTraceSchema } from "./governance-records.js";

export const GitOidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const SizeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ProductDescriptorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("blob"), path: AssurancePathSchema, mode: z.enum(["100644", "100755", "120000"]), sha256: AssuranceSha256Schema, size: SizeSchema }),
  z.strictObject({ kind: z.literal("gitlink"), path: AssurancePathSchema, mode: z.literal("160000"), oid: GitOidSchema, scope: z.literal("referenced-commit-only") }),
  z.strictObject({ kind: z.literal("native-file"), path: AssurancePathSchema, mode: z.string().regex(/^native:[0-7]{3,6}$/), sha256: AssuranceSha256Schema, size: SizeSchema }),
]);
export type ProductDescriptor = z.infer<typeof ProductDescriptorSchema>;
export const DeliveryProductSchema = boundedRecord(z.strictObject({
  scope: z.enum(["git-index", "host-native-product"]), subjectDigest: AssuranceSha256Schema,
  entries: z.array(ProductDescriptorSchema).max(1000000),
}).superRefine((v, ctx) => {
  uniqueBy(v.entries, (x) => normalizePathKey(x.path), ctx);
  if (v.entries.some((x) => (v.scope === "host-native-product") !== (x.kind === "native-file"))) ctx.addIssue({ code: "custom", message: "Inventory descriptor/scope mismatch" });
  if (v.entries.some((x, i) => i > 0 && v.entries[i - 1]!.path >= x.path)) ctx.addIssue({ code: "custom", message: "Inventory must be sorted by path" });
}), 64 * 1024 * 1024);
export type DeliveryProduct = z.infer<typeof DeliveryProductSchema>;
export const DeliveryArtifactsSchema = boundedRecord(z.strictObject({ artifacts: z.array(z.strictObject({ name: AssuranceIdSchema, path: AssurancePathSchema, sha256: AssuranceSha256Schema, size: SizeSchema })).max(256) }).superRefine((v, ctx) => {
  uniqueBy(v.artifacts, (x) => x.name, ctx); uniqueBy(v.artifacts, (x) => normalizePathKey(x.path), ctx);
}), 64 * 1024 * 1024);
export type DeliveryArtifacts = z.infer<typeof DeliveryArtifactsSchema>;
export const DeliveryEvidenceSchema = boundedRecord(z.strictObject({
  approvalId: OpaqueIdSchema.nullable(), specId: OpaqueIdSchema.nullable(), manifestDigest: AssuranceSha256Schema.nullable(),
  executionFingerprint: AssuranceSha256Schema, environmentFingerprint: AssuranceSha256Schema,
  mode: z.enum(["not-adopted", "information-flow", "adapter-default"]),
  checks: z.array(z.strictObject({ id: OpaqueIdSchema, status: z.enum(["passed", "failed", "unavailable"]), inputDigest: AssuranceSha256Schema.nullable(),
    observationDigest: AssuranceSha256Schema.nullable(), executionId: OpaqueIdSchema.nullable(), reusedFrom: OpaqueIdSchema.nullable(),
    trustTier: z.enum(["component-closed-input", "hardened-argv", "host-allowlist"]), moduleDigest: AssuranceSha256Schema.nullable(), runtimeDigest: AssuranceSha256Schema.nullable(), recordedAt: UtcTimestampSchema,
  }).superRefine((check, ctx) => {
    if (check.status !== "unavailable" && (check.inputDigest === null || check.observationDigest === null || check.executionId === null)) ctx.addIssue({ code: "custom", message: "Executed delivery evidence requires actual input, result, and execution identities" });
    if (check.reusedFrom !== null && (check.status !== "passed" || check.executionId === null || check.reusedFrom === check.executionId)) ctx.addIssue({ code: "custom", message: "Only a prior passed execution may be reused" });
  })).max(512),
  acceptance: z.array(z.strictObject({ id: OpaqueIdSchema, status: z.enum(["passed", "failed", "unknown"]), evidenceDigest: AssuranceSha256Schema.nullable(), recordedAt: UtcTimestampSchema })).max(256),
  policyDigest: AssuranceSha256Schema.nullable(), modelDigest: AssuranceSha256Schema.nullable(),
  sourceScope: z.enum(["whole-working-product", "declared-component-inputs"]),
}).superRefine((v, ctx) => {
  uniqueBy(v.checks, (x) => x.id, ctx); uniqueBy(v.acceptance, (x) => x.id, ctx);
  if (v.mode !== "not-adopted" && (v.approvalId === null || v.manifestDigest === null || v.modelDigest === null)) ctx.addIssue({ code: "custom", message: "Adopted evidence requires approval/manifest/model identity" });
  if (v.checks.some((x) => x.reusedFrom !== null && x.status !== "passed")) ctx.addIssue({ code: "custom", message: "Only passed evidence may be reused" });
  v.acceptance.forEach((x, i) => {
    if ((x.status === "unknown") !== (x.evidenceDigest === null)) ctx.addIssue({ code: "custom", path: ["acceptance", i, "evidenceDigest"], message: "Acceptance digest must reflect recorded evidence" });
  });
}), 64 * 1024 * 1024);
export type DeliveryEvidence = z.infer<typeof DeliveryEvidenceSchema>;
export const PublicTokenSchema = z.string().uuid();
export const DeliveryPredicateSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.deliveryPredicate), confirmation: PublicTokenSchema, approval: PublicTokenSchema.nullable(), spec: PublicTokenSchema.nullable(),
  assuranceManifestDigest: AssuranceSha256Schema.nullable(), subjectDigest: AssuranceSha256Schema, executionDigest: AssuranceSha256Schema,
  mode: z.enum(["not-adopted", "information-flow", "adapter-default"]), traceStatus: z.enum(["valid", "not-adopted"]),
  modelDigest: AssuranceSha256Schema.nullable(), policyDigest: AssuranceSha256Schema.nullable(),
  identities: z.array(z.strictObject({ token: PublicTokenSchema, kind: z.enum(["task", "acceptance", "check", "profile", "model", "host"]), digest: AssuranceSha256Schema.nullable() })).max(1024),
  checks: z.array(z.strictObject({ token: PublicTokenSchema, status: z.enum(["passed", "failed", "unavailable"]), inputDigest: AssuranceSha256Schema.nullable(), resultDigest: AssuranceSha256Schema.nullable() })).max(512),
  acceptance: z.array(z.strictObject({ token: PublicTokenSchema, status: z.enum(["passed", "failed", "unknown"]), evidenceDigest: AssuranceSha256Schema.nullable() })).max(256),
  preparedAt: UtcTimestampSchema,
}).superRefine((v, ctx) => {
  uniqueBy(v.identities, (x) => x.token, ctx); uniqueBy(v.checks, (x) => x.token, ctx); uniqueBy(v.acceptance, (x) => x.token, ctx);
  v.checks.forEach((x) => {
    if (!v.identities.some((i) => i.token === x.token && i.kind === "check")) ctx.addIssue({ code: "custom", message: "Public check token undeclared" });
    if (x.status !== "unavailable" && (x.inputDigest === null || x.resultDigest === null)) ctx.addIssue({ code: "custom", message: "Executed public check evidence requires input and result digests" });
  });
  v.acceptance.forEach((x) => {
    if (!v.identities.some((i) => i.token === x.token && i.kind === "acceptance")) ctx.addIssue({ code: "custom", message: "Public acceptance token undeclared" });
    if ((x.status === "unknown") !== (x.evidenceDigest === null)) ctx.addIssue({ code: "custom", message: "Public acceptance digest must reflect recorded evidence" });
  });
}), 64 * 1024 * 1024);
export type DeliveryPredicate = z.infer<typeof DeliveryPredicateSchema>;
export const DeliveryOutcomeSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.deliveryOutcome), confirmationId: OpaqueIdSchema, preparedDigest: AssuranceSha256Schema, confirmedSubjectDigest: AssuranceSha256Schema,
  commit: z.discriminatedUnion("status", [z.strictObject({ status: z.literal("not-requested") }), z.strictObject({ status: z.literal("verified"), oid: GitOidSchema })]),
  pullRequest: z.discriminatedUnion("status", [z.strictObject({ status: z.literal("not-requested") }), z.strictObject({ status: z.literal("created"), number: z.number().int().positive() })]),
  recordedAt: UtcTimestampSchema, traceEndDigest: AssuranceSha256Schema.optional(),
}), 16 * 1024);
export type DeliveryOutcome = z.infer<typeof DeliveryOutcomeSchema>;
const PreparedDeliverySchema = z.strictObject({
  confirmationId: OpaqueIdSchema, approvalId: OpaqueIdSchema.nullable(), captureMode: z.enum(["adopted", "legacy-bundle"]),
  preparedAt: UtcTimestampSchema, executionFingerprint: AssuranceSha256Schema, environmentFingerprint: AssuranceSha256Schema,
  product: DeliveryProductSchema, artifacts: DeliveryArtifactsSchema, evidence: DeliveryEvidenceSchema, trace: GovernanceTraceSchema, predicate: DeliveryPredicateSchema,
  tokenMapping: z.array(z.strictObject({ token: PublicTokenSchema, localId: OpaqueIdSchema, kind: z.enum(["confirmation", "approval", "spec", "task", "acceptance", "check", "profile", "model", "host"]) })).max(1024),
}).superRefine((v, ctx) => {
  uniqueBy(v.tokenMapping, (x) => x.token, ctx); uniqueBy(v.tokenMapping, (x) => `${x.kind}:${x.localId}`, ctx);
  if (v.captureMode === "adopted" ? v.approvalId === null || v.trace.status !== "valid" : v.trace.status !== "not-adopted") ctx.addIssue({ code: "custom", message: "Snapshot capture/trace mismatch" });
  if (v.approvalId !== v.evidence.approvalId || v.executionFingerprint !== v.evidence.executionFingerprint || v.product.subjectDigest !== v.predicate.subjectDigest) ctx.addIssue({ code: "custom", message: "Frozen evidence identity mismatch" });
});
const SnapshotCommon = { schemaVersion: z.literal(SCHEMA_VERSION.deliverySnapshot), prepared: PreparedDeliverySchema, preparedDigest: AssuranceSha256Schema };
export const DeliverySnapshotSchema = boundedRecord(z.discriminatedUnion("state", [
  z.strictObject({ ...SnapshotCommon, state: z.literal("prepared") }),
  z.strictObject({ ...SnapshotCommon, state: z.literal("complete"), outcome: DeliveryOutcomeSchema, completedTrace: GovernanceTraceSchema, sealedDigest: AssuranceSha256Schema }),
  z.strictObject({ ...SnapshotCommon, state: z.literal("aborted"), abortedAt: UtcTimestampSchema, reason: z.enum(["subject-changed", "commit-failed", "pr-failed", "rollback", "trace-incomplete", "capture-failed"]), survivingCommit: GitOidSchema.nullable() }),
]).superRefine((v, ctx) => {
  if (v.state !== "complete") return;
  if (v.outcome.confirmationId !== v.prepared.confirmationId || v.outcome.preparedDigest !== v.preparedDigest || v.outcome.confirmedSubjectDigest !== v.prepared.product.subjectDigest) ctx.addIssue({ code: "custom", message: "Terminal outcome does not match immutable prepared snapshot" });
  if (v.prepared.captureMode === "adopted") {
    const completedTrace = v.completedTrace;
    if (v.outcome.traceEndDigest === undefined || completedTrace.status !== "valid" || v.outcome.traceEndDigest !== completedTrace.headDigest || v.prepared.trace.status !== "valid" || v.prepared.trace.frames.some((f, i) => completedTrace.frames[i]?.digest !== f.digest)) ctx.addIssue({ code: "custom", message: "Adopted outcome requires matching frozen trace completion" });
  } else if (v.completedTrace.status !== "not-adopted" || v.outcome.traceEndDigest !== undefined) ctx.addIssue({ code: "custom", message: "Legacy capture must not assert trace validation" });
}), 256 * 1024 * 1024);
export type DeliverySnapshot = z.infer<typeof DeliverySnapshotSchema>;
export const DeliveryMemberNameSchema = z.enum(["product.json", "artifacts.json", "evidence.json", "trace.json", "predicate.json"]);
export const DeliveryManifestSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.deliveryManifest), confirmationId: OpaqueIdSchema, approvalId: OpaqueIdSchema.nullable(), snapshotDigest: AssuranceSha256Schema,
  executionFingerprint: AssuranceSha256Schema, environmentFingerprint: AssuranceSha256Schema, subjectDigest: AssuranceSha256Schema,
  deliveredScope: z.enum(["git-index", "host-native-product"]), createdAt: UtcTimestampSchema,
  members: z.array(z.strictObject({ path: DeliveryMemberNameSchema, sha256: AssuranceSha256Schema, size: z.number().int().nonnegative().max(64 * 1024 * 1024) })).length(5),
}).superRefine((v, ctx) => {
  uniqueBy(v.members, (x) => x.path, ctx);
  if (v.members.reduce((n, x) => n + x.size, 0) > 256 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "Bundle exceeds 256 MiB" });
  if (v.members.some((x, i) => i > 0 && v.members[i - 1]!.path >= x.path)) ctx.addIssue({ code: "custom", message: "Members must be sorted" });
}), 1024 * 1024);
export type DeliveryManifest = z.infer<typeof DeliveryManifestSchema>;
export const DeliveryTrustSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.deliveryTrust),
  localKeys: z.array(z.strictObject({ spkiPem: z.string().min(1).max(16384).regex(/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/), sha256: AssuranceSha256Schema })).max(256),
  ci: z.strictObject({ repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/), certificateSan: z.string().url().max(4096), issuer: z.literal("https://token.actions.githubusercontent.com"),
    signerWorkflow: z.string().min(1).max(4096), signerDigest: GitOidSchema, sourceDigest: GitOidSchema,
    trustedRootPath: z.string().min(1).max(4096), trustedRootSha256: AssuranceSha256Schema, trustedRootCapturedAt: UtcTimestampSchema,
  }).nullable(),
}).superRefine((v, ctx) => {
  uniqueBy(v.localKeys, (x) => x.sha256, ctx);
  if (!v.localKeys.length && v.ci === null) ctx.addIssue({ code: "custom", message: "Trust policy must pin an external trust root" });
  if (v.ci && /[\u0000-\u001f*]/.test(v.ci.certificateSan)) ctx.addIssue({ code: "custom", message: "Certificate SAN must be exact, not a pattern" });
}), 1024 * 1024);
export type DeliveryTrust = z.infer<typeof DeliveryTrustSchema>;
export const DeliveryExportSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.deliveryExport), snapshotId: OpaqueIdSchema, snapshotDigest: AssuranceSha256Schema,
  requestedOutput: z.string().min(1).max(4096), attemptId: OpaqueIdSchema, attemptedAt: UtcTimestampSchema,
  result: z.enum(["exported", "failed"]), reason: z.string().min(1).max(4096).nullable(),
}).superRefine((v, ctx) => { if ((v.result === "failed") !== (v.reason !== null)) ctx.addIssue({ code: "custom", message: "Export result/reason mismatch" }); }), 16 * 1024);
export type DeliveryExport = z.infer<typeof DeliveryExportSchema>;
export const DsseEnvelopeSchema = boundedRecord(z.strictObject({
  payloadType: z.literal("application/vnd.in-toto+json"), payload: z.string().min(1).max(64 * 1024 * 1024).regex(/^[A-Za-z0-9+/_-]+={0,2}$/),
  signatures: z.array(z.strictObject({ keyid: AssuranceSha256Schema, sig: z.string().min(1).max(256).regex(/^[A-Za-z0-9+/_-]+={0,2}$/) })).min(1).max(256),
}).superRefine((v, ctx) => uniqueBy(v.signatures, (x) => x.keyid, ctx)), 64 * 1024 * 1024);
export type DsseEnvelope = z.infer<typeof DsseEnvelopeSchema>;
export const DELIVERY_PREDICATE_TYPE = "https://github.com/9thLevelSoftware/legion-cli/blob/main/docs/design/assurance-integration.md#delivery-v1";
export const DeliveryStatementSchema = boundedRecord(z.strictObject({
  _type: z.literal("https://in-toto.io/Statement/v1"),
  subject: z.array(z.strictObject({ name: z.literal("manifest.json"), digest: z.strictObject({ sha256: AssuranceSha256Schema }) })).length(1),
  predicateType: z.literal(DELIVERY_PREDICATE_TYPE), predicate: DeliveryPredicateSchema,
}), 64 * 1024 * 1024);
export type DeliveryStatement = z.infer<typeof DeliveryStatementSchema>;
