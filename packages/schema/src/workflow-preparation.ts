import { z } from "zod";
import { ConcretePosixPathSchema } from "./paths.js";

const Text = z.string().trim().min(1);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const WorkflowStageIdSchema = z.enum(["context", "requirements", "user-experience", "functional-design", "architecture", "nfr-design", "infrastructure-design", "delivery-handoff"]);
export type WorkflowStageId = z.infer<typeof WorkflowStageIdSchema>;
export const WORKFLOW_STAGE_FIELDS: Record<WorkflowStageId, readonly string[]> = {
  context: ["goal", "affectedPaths", "constraints", "assumptions"],
  requirements: ["outcomes", "invariants", "acceptanceIds", "qualityAttributes"],
  "user-experience": ["decision", "interfaces", "failureCompatibility", "verification"],
  "functional-design": ["decision", "interfaces", "failureCompatibility", "verification"],
  architecture: ["decision", "interfaces", "failureCompatibility", "verification"],
  "nfr-design": ["decision", "interfaces", "failureCompatibility", "verification"],
  "infrastructure-design": ["decision", "interfaces", "failureCompatibility", "verification"],
  "delivery-handoff": ["installation", "recovery", "externalChecks", "operator"],
};
export const WorkflowAssessmentSchema = z.object({
  schemaVersion: z.literal("legion-cli-workflow-assessment/v1"), policyVersion: z.literal(2), specId: Text,
  inputFingerprint: Digest,
  stageDecisions: z.array(z.object({ stage: WorkflowStageIdSchema, decision: z.enum(["required", "not_applicable"]), rationale: Text, evidenceRefs: z.array(Text) }).strict()),
  unresolvedDecisions: z.array(Text), predecessorSpecId: Text.optional(),
}).strict();
export type WorkflowAssessment = z.infer<typeof WorkflowAssessmentSchema>;
export const PreparationInputSchema = z.object({ path: ConcretePosixPathSchema, digest: Digest }).strict();
export const PreparationArtifactSchema = z.object({
  stage: WorkflowStageIdSchema, path: ConcretePosixPathSchema, digest: Digest,
  inputs: z.array(PreparationInputSchema), fields: z.record(z.string(), z.string()),
}).strict();
export type PreparationArtifact = z.infer<typeof PreparationArtifactSchema>;
export const AcceptancePlanMappingSchema = z.object({
  criterionId: Text, taskIds: z.array(Text),
  methods: z.array(z.object({
    id: Text, kind: z.enum(["task_check", "integration_check", "assurance", "manual", "external"]), expectedObservation: Text,
    taskId: Text.optional(), command: Text.optional(), validatorId: Text.optional(), procedure: Text.optional(),
  }).strict()).min(1), notApplicableWhen: Text.optional(),
}).strict();
export type AcceptancePlanMapping = z.infer<typeof AcceptancePlanMappingSchema>;
export const TestingMethodSchema = z.object({ taskId: Text, method: z.enum(["test-first", "regression-first", "existing-checks"]), behavior: Text, testInterface: Text, limitations: z.array(Text) }).strict();
export type TestingMethod = z.infer<typeof TestingMethodSchema>;
export const PlanningStrategySchema = z.object({
  kind: z.enum(["outcomes", "risk-first", "expand-contract", "custom"]), rationale: Text,
  granularity: z.enum(["coarse", "balanced", "fine"]).optional(),
  outcomes: z.array(z.object({ id: Text, statement: Text, acceptanceIds: z.array(Text).min(1), taskIds: z.array(Text).min(1) }).strict()),
  risk: z.object({ uncertainty: Text, probeTaskId: Text, dependentTaskIds: z.array(Text).min(1) }).strict().optional(),
  migration: z.object({ compatibility: Text, transition: Text, retirementTaskIds: z.array(Text), prerequisites: z.array(PreparationInputSchema) }).strict().optional(),
}).strict();
export type PlanningStrategy = z.infer<typeof PlanningStrategySchema>;
export const GuidanceModeSchema = z.enum(["guided", "balanced", "direct"]);
export type GuidanceMode = z.infer<typeof GuidanceModeSchema>;
export const AssistanceSessionSchema = z.object({
  schemaVersion: z.literal("legion-cli-assistance/v1"), sessionId: Text, specId: Text.nullable(), guidance: GuidanceModeSchema,
  paused: z.boolean(), cursor: z.object({ stage: Text, questionId: Text.optional(), round: z.number().int().nonnegative() }).strict(),
  decisionIds: z.array(Text), comparisonIds: z.array(Text),
}).strict();
export type AssistanceSession = z.infer<typeof AssistanceSessionSchema>;
export const IntentSourceBindingSchema = z.object({ path: Text, digest: Digest, format: z.enum(["markdown", "text"]), provenance: z.literal("local-file"), importedAt: Text }).strict();
export type IntentSourceBinding = z.infer<typeof IntentSourceBindingSchema>;
export const PlanningDecisionSchema = z.object({
  id: Text, name: Text, question: Text, kind: z.enum(["preference", "fact", "scope", "design"]), blocking: z.boolean(), prerequisiteIds: z.array(Text),
  evidence: z.array(z.object({ path: ConcretePosixPathSchema.optional(), digest: Digest.optional(), kind: z.enum(["observation", "assumption", "user_report", "verified_execution"]), statement: Text }).strict()),
  options: z.array(z.object({ id: Text, label: Text, consequence: Text }).strict()), recommendedOptionId: Text.optional(),
  resolution: z.object({ disposition: z.enum(["answered", "deferred", "out_of_scope"]), response: Text, selectedOptionId: Text.optional(), resolvedAt: Text }).strict().optional(),
}).strict();
export type PlanningDecision = z.infer<typeof PlanningDecisionSchema>;
const DesignAlternativeSchema = z.object({ id: Text, name: Text, behavior: Text, usageExample: Text.optional(), constraints: z.array(Text), failureImplications: z.array(Text), testingApproach: Text, tradeoffs: z.array(Text) }).strict();
export const DesignComparisonSchema = z.object({ id: Text, decisionId: Text, stageId: WorkflowStageIdSchema, alternatives: z.tuple([DesignAlternativeSchema, DesignAlternativeSchema]), recommendation: Text.optional(), selectedOptionId: Text.optional(), rationale: Text.optional(), revisionCount: z.literal(1).optional() }).strict();
export type DesignComparison = z.infer<typeof DesignComparisonSchema>;
export const WorkflowPreparationSchema = z.object({
  schemaVersion: z.literal("legion-cli-workflow-preparation/v1"), assessment: WorkflowAssessmentSchema,
  specArtifacts: z.array(PreparationArtifactSchema), planArtifacts: z.array(PreparationArtifactSchema),
  acceptanceMappings: z.array(AcceptancePlanMappingSchema), strategy: PlanningStrategySchema.optional(),
  comparisons: z.array(DesignComparisonSchema).optional(), knowledge: z.array(PreparationInputSchema).optional(),
  testingMethods: z.array(TestingMethodSchema).optional(),
}).strict();
export type WorkflowPreparation = z.infer<typeof WorkflowPreparationSchema>;
