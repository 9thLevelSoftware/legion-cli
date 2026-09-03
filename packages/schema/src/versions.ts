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
  resume: "legion-cli-resume/v1",
  run: "legion-cli-run/v1",
  qa: "legion-cli-qa/v1",
  brief: "legion-cli-brief/v1",
  skillCatalog: "legion-cli-skill-catalog/v1",
  topics: "legion-cli-topics/v1",
  designSystem: "legion-cli-design-system/v1",
  designActive: "legion-cli-design-active/v1",
  packet: "legion-cli-packet/v1",
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

export const ControlModeSchema = z.enum(["guarded", "surgical", "advisory"]);
export type ControlMode = z.infer<typeof ControlModeSchema>;

export const SkillIdSchema = z.enum([
  "interview",
  "discuss",
  "spec",
  "ingest",
  "plan",
  "execute",
  "verify",
  "review",
  "qa",
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
] as const;
export const AdapterIdSchema = z.enum(ADAPTER_IDS);
export type AdapterId = z.infer<typeof AdapterIdSchema>;
export const ADAPTER_ID_HELP = ADAPTER_IDS.join("|");

/** Subscription coding CLIs spawned by PATH name. Vendor flags stay generic-style. */
export const EXTRA_ADAPTER_IDS = ["grok", "openai", "codex", "mimo", "minimax"] as const;
export type ExtraAdapterId = (typeof EXTRA_ADAPTER_IDS)[number];
export const ASSUMED_EXTRA_BINARIES = {
  grok: "grok",
  openai: "codex",
  codex: "codex",
  mimo: "mimo",
  minimax: "mcode",
} as const satisfies Record<ExtraAdapterId, string>;
