import { z } from "zod";
import { ControlModeSchema, PhaseSchema, SCHEMA_VERSION, TaskStatusSchema } from "./versions.js";
import { AssuranceIdSchema, AssurancePathsSchema, AssuranceSha256Schema, OpaqueIdSchema, UtcTimestampSchema, boundedRecord, uniqueBy } from "./assurance-primitives.js";

export const GovernanceActionSchema = z.enum([
  "approval-adopt", "claim-acquire", "claim-release", "task-start", "task-verify", "task-complete", "task-block",
  "integration-start", "integration-complete", "review-start", "review-complete", "acceptance-record", "ship-confirm",
  "ship-prepare", "ship-complete", "ship-rollback", "recover", "amend-inputs", "unblock", "undo", "abandon", "compact",
]);
export type GovernanceAction = z.infer<typeof GovernanceActionSchema>;
const StageSchema = z.enum(["not-run", "running", "passed", "failed", "unavailable", "stale"]);
const FreshnessSchema = z.enum(["current", "stale", "unknown"]);
export const GovernanceProjectionSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.governanceProjection), phase: PhaseSchema, controlMode: ControlModeSchema,
  tasks: z.array(z.strictObject({ id: OpaqueIdSchema, status: TaskStatusSchema, owner: OpaqueIdSchema.nullable(), writes: AssurancePathsSchema, checks: StageSchema })).max(256),
  approval: z.strictObject({ id: OpaqueIdSchema.nullable(), freshness: FreshnessSchema }),
  claim: z.strictObject({ owner: OpaqueIdSchema.nullable(), liveness: z.enum(["none", "live", "dead", "unknown"]) }),
  integration: StageSchema, components: z.array(z.strictObject({ checkId: AssuranceIdSchema, status: StageSchema })).max(256), review: StageSchema,
  acceptance: z.array(z.strictObject({ id: OpaqueIdSchema, status: z.enum(["not-recorded", "passed", "failed", "unknown"]), freshness: FreshnessSchema })).max(256),
  sourceFingerprint: AssuranceSha256Schema.nullable(), evidenceFingerprint: AssuranceSha256Schema.nullable(),
  ship: z.strictObject({ confirmationId: OpaqueIdSchema.nullable(), previewFingerprint: AssuranceSha256Schema.nullable(), confirmed: z.boolean(), status: z.enum(["none", "prepared", "complete", "aborted"]) }),
}).superRefine((v, ctx) => {
  uniqueBy(v.tasks, (x) => x.id, ctx); uniqueBy(v.components, (x) => x.checkId, ctx); uniqueBy(v.acceptance, (x) => x.id, ctx);
  if ((v.claim.owner === null) !== (v.claim.liveness === "none")) ctx.addIssue({ code: "custom", message: "Claim owner/liveness mismatch" });
  if (v.ship.confirmed && (v.ship.confirmationId === null || v.ship.previewFingerprint === null)) ctx.addIssue({ code: "custom", message: "Confirmation must bind preview" });
}), 1024 * 1024);
export type GovernanceProjection = z.infer<typeof GovernanceProjectionSchema>;
export const GovernanceFrameSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.governanceFrame), approvalId: OpaqueIdSchema, sequence: z.number().int().nonnegative(),
  previousDigest: AssuranceSha256Schema.nullable(), digest: AssuranceSha256Schema, modelDigest: AssuranceSha256Schema,
  boundary: z.enum(["begin", "end"]), action: GovernanceActionSchema, correlationId: OpaqueIdSchema,
  before: GovernanceProjectionSchema, after: GovernanceProjectionSchema.nullable(), outcome: z.enum(["pending", "success", "failed", "incomplete", "refused"]), explicitRetry: z.boolean(), recordedAt: UtcTimestampSchema,
}).superRefine((v, ctx) => {
  if (v.boundary === "begin" ? v.after !== null || v.outcome !== "pending" : v.after === null || v.outcome === "pending") ctx.addIssue({ code: "custom", message: "Begin/end projection and outcome mismatch" });
  if ((v.sequence === 0) !== (v.previousDigest === null)) ctx.addIssue({ code: "custom", message: "Only first frame has null previous digest" });
}), 4 * 1024 * 1024);
export type GovernanceFrame = z.infer<typeof GovernanceFrameSchema>;
export const GovernanceHeadSchema = boundedRecord(z.strictObject({ schemaVersion: z.literal(SCHEMA_VERSION.governanceHead), approvalId: OpaqueIdSchema, sequence: z.number().int().nonnegative(), digest: AssuranceSha256Schema, status: z.enum(["valid", "incomplete", "invalid"]) }), 16 * 1024);
export type GovernanceHead = z.infer<typeof GovernanceHeadSchema>;
export const GovernanceTraceSchema = boundedRecord(z.union([
  z.strictObject({ schemaVersion: z.literal(SCHEMA_VERSION.governanceTrace), status: z.literal("not-adopted"), frames: z.array(z.never()).length(0) }),
  z.strictObject({ schemaVersion: z.literal(SCHEMA_VERSION.governanceTrace), status: z.enum(["valid", "incomplete", "invalid"]), approvalId: OpaqueIdSchema, modelDigest: AssuranceSha256Schema, headDigest: AssuranceSha256Schema.nullable(), frames: z.array(GovernanceFrameSchema).max(100000) }).superRefine((v, ctx) => {
    if (v.status !== "valid") return;
    if (!v.frames.length) ctx.addIssue({ code: "custom", message: "Valid adopted trace requires frames" });
    let pending: z.infer<typeof GovernanceFrameSchema> | undefined;
    v.frames.forEach((frame, i) => {
      if (frame.sequence !== i || frame.previousDigest !== (i === 0 ? null : v.frames[i - 1]!.digest) || frame.approvalId !== v.approvalId || frame.modelDigest !== v.modelDigest) ctx.addIssue({ code: "custom", message: "Trace identity/chain mismatch" });
      if (frame.boundary === "begin") {
        if (pending) ctx.addIssue({ code: "custom", message: "Nested boundary" });
        pending = frame;
      } else {
        if (!pending || pending.correlationId !== frame.correlationId || pending.action !== frame.action || frame.outcome === "incomplete") ctx.addIssue({ code: "custom", message: "Unmatched boundary" });
        pending = undefined;
      }
    });
    if (pending || v.headDigest !== v.frames.at(-1)?.digest) ctx.addIssue({ code: "custom", message: "Unfinished trace or stale head" });
  }),
]), 64 * 1024 * 1024);
export type GovernanceTrace = z.infer<typeof GovernanceTraceSchema>;
export const GovernanceEpochsSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.governanceEpochs),
  epochs: z.array(z.strictObject({
    sequence: z.number().int().nonnegative(),
    approvalId: OpaqueIdSchema.nullable(),
    adopted: z.boolean(),
    recordedAt: UtcTimestampSchema,
    previousDigest: AssuranceSha256Schema.nullable(),
    digest: AssuranceSha256Schema,
  })).min(1).max(10_000),
}), 4 * 1024 * 1024);
export type GovernanceEpochs = z.infer<typeof GovernanceEpochsSchema>;
