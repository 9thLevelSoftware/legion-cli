import { z } from "zod";

export const SCHEMA_VERSION = {
  project: "legion-cli-project/v1",
  state: "legion-cli-state/v1",
  context: "legion-cli-context/v1",
  intentAnswers: "legion-cli-intent-answers/v1",
  config: "legion-cli-config/v1",
  spec: "legion-cli-spec/v1",
  task: "legion-cli-task/v1",
  assumption: "legion-cli-assumption/v1",
  discuss: "legion-cli-discuss/v1",
  ingest: "legion-cli-ingest/v1",
  audit: "legion-cli-audit/v1",
  resume: "legion-cli-resume/v2",
  run: "legion-cli-run/v1",
  dag: "legion-cli-dag/v1",
  brownfieldPatterns: "legion-cli-brownfield-patterns/v1",
  qa: "legion-cli-qa/v2",
  brief: "legion-cli-brief/v1",
  skillCatalog: "legion-cli-skill-catalog/v1",
  topics: "legion-cli-topics/v1",
  designSystem: "legion-cli-design-system/v1",
  designActive: "legion-cli-design-active/v1",
  packet: "legion-cli-packet/v1",
  map: "legion-cli-map/v1",
  fingerprint: "legion-cli-fingerprint/v1",
  lspDiagnostics: "legion-cli-lsp-diagnostics/v1",
  skillOverlay: "legion-cli-skill-overlay/v1",
  chatSession: "legion-cli-chat/v1",
  serve: "legion-cli-serve/v1",
  recipe: "legion-cli-recipe/v1",
  recipesLock: "legion-cli-recipes-lock/v1",
  planApproval: "legion-cli-plan-approval/v1",
  specApproval: "legion-cli-spec-approval/v1",
  workflowEvidence: "legion-cli-workflow-evidence/v1",
  acceptanceReceipt: "legion-cli-acceptance-receipt/v1",
  workflowClaim: "legion-cli-workflow-claim/v1",
  specChallenge: "legion-cli-spec-challenge/v1",
  assurancePlan: "legion-cli-assurance-plan/v1",
  assuranceApproval: "legion-cli-assurance-approval/v1",
  checkEvidence: "legion-cli-check-evidence/v1",
  assuranceExecution: "legion-cli-assurance-execution/v1",
  governanceProjection: "legion-cli-governance-projection/v1",
  governanceFrame: "legion-cli-governance-frame/v1",
  governanceHead: "legion-cli-governance-head/v1",
  governanceTrace: "legion-cli-governance-trace/v1",
  governanceEpochs: "legion-cli-governance-epochs/v1",
  deliverySnapshot: "legion-cli-delivery-snapshot/v1",
  deliveryManifest: "legion-cli-delivery-manifest/v1",
  deliveryTrust: "legion-cli-delivery-trust/v1",
  deliveryPredicate: "legion-cli-delivery-predicate/v1",
  deliveryOutcome: "legion-cli-delivery-outcome/v1",
  deliveryExport: "legion-cli-delivery-export/v1",
  actionApproval: "legion-cli-action-approval/v2",
  httpGovernedCheckpoint: "legion-cli-http-governed-checkpoint/v3",
  httpRunAuthority: "legion-cli-http-run-authority/v2",
  fileProvenance: "legion-cli-file-provenance/v1",
  componentRequest: "legion-cli-component-request/v1",
  componentInvocation: "legion-cli-component-invocation/v1",
  validatorOutput: "legion-cli-validator-output/v1",
  nativeHostManifest: "legion-cli-native-host-manifest/v1",
} as const;

export type SchemaVersion = (typeof SCHEMA_VERSION)[keyof typeof SCHEMA_VERSION];

/** CONCERNS is lastReadiness on plan_ready, not a phase. */
export const PhaseSchema = z.enum([
  "uninitialized",
  "initialized",
  "intent_draft",
  "intent_ready",
  "discussing",
  "spec_draft",
  "spec_frozen",
  "planning",
  "plan_failed",
  "plan_ready",
  "executing",
  "ready_to_ship",
  "shipped",
  "abandoned",
]);
export type Phase = z.infer<typeof PhaseSchema>;

/** `compacted` is shipped (`legion-cli context compact`). */
export const TaskStatusSchema = z.enum([
  "todo",
  "ready",
  "in_progress",
  "verifying",
  "blocked",
  "done",
  "compacted",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Old configs that still name `surgical` fail closed with this hint; never coerced. */
export const SURGICAL_MIGRATION_HINT = "control_mode surgical is removed; migrate to guarded";

export const ControlModeSchema = z.enum(["guarded", "advisory"], {
  error: (iss) =>
    iss.input === "surgical"
      ? SURGICAL_MIGRATION_HINT
      : `control_mode ${String(iss.input ?? "")} is rejected`,
});
export type ControlMode = z.infer<typeof ControlModeSchema>;

export const SkillIdSchema = z.enum([
  "interview",
  "discuss",
  "spec",
  "spec-challenge",
  "ingest",
  "plan",
  "execute",
  "verify",
  "review",
  "qa",
  "map",
  "wireframe",
  "chat",
]);
export type SkillId = z.infer<typeof SkillIdSchema>;

export const PrioritySchema = z.enum(["P0", "P1", "P2"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const ProjectModeSchema = z.enum(["greenfield", "brownfield"]);
export type ProjectMode = z.infer<typeof ProjectModeSchema>;

export const ReadinessSchema = z.enum(["PASS", "CONCERNS", "FAIL"]);
export type Readiness = z.infer<typeof ReadinessSchema>;

export const ReviewVerdictSchema = z.enum(["PASS", "FAIL"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ADAPTER_IDS = [
  "claude",
  "generic",
  "fake",
  "grok",
  "openai",
  "codex",
  "mimo",
  "minimax",
  "http",
  "acp",
] as const;
export const AdapterIdSchema = z.enum(ADAPTER_IDS);
export type AdapterId = z.infer<typeof AdapterIdSchema>;
/** Ids for CLI help / `--adapter`. `fake` is test-only: still accepted, never advertised. */
export const ADAPTER_ID_HELP = ADAPTER_IDS.filter((id) => id !== "fake").join("|");

/** Subscription coding CLIs spawned by PATH name. Frozen vendor argv lives in agents `FROZEN_ARGV_TABLE`. */
export const EXTRA_ADAPTER_IDS = ["grok", "openai", "codex", "mimo", "minimax"] as const;
export type ExtraAdapterId = (typeof EXTRA_ADAPTER_IDS)[number];
export const ASSUMED_EXTRA_BINARIES = {
  grok: "grok",
  openai: "codex",
  codex: "codex",
  mimo: "mimo",
  minimax: "mcode",
} as const satisfies Record<ExtraAdapterId, string>;
