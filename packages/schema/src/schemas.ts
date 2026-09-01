import { z } from "zod";
import { ConcretePosixPathSchema, PosixAllowedRootSchema } from "./paths.js";
import {
  AdapterIdSchema,
  ControlModeSchema,
  PhaseSchema,
  PrioritySchema,
  ProjectModeSchema,
  ReadinessSchema,
  ReviewVerdictSchema,
  SCHEMA_VERSION,
  SkillIdSchema,
  TaskStatusSchema,
} from "./versions.js";

export const FileContractSchema = z.object({
  filesAllowed: z.array(ConcretePosixPathSchema),
  filesForbidden: z.array(PosixAllowedRootSchema),
  expectedArtifacts: z.array(ConcretePosixPathSchema),
  verificationCommands: z.array(z.string().min(1)),
  maxFilesTouched: z.number().int().positive().default(20),
});
export type FileContract = z.infer<typeof FileContractSchema>;

export const SkillContractSchema = z.object({
  skillId: SkillIdSchema,
  allowedRoots: z.array(PosixAllowedRootSchema),
});
export type SkillContract = z.infer<typeof SkillContractSchema>;

export const ProjectFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.project),
  name: z.string().min(1),
  mode: ProjectModeSchema,
  controlMode: ControlModeSchema,
  activeSpecId: z.string().min(1).nullable().optional(),
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

export const StateFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.state),
  phase: PhaseSchema,
  activeSpecId: z.string().min(1).nullable().optional(),
  currentTaskId: z.string().min(1).nullable().optional(),
  lastReadiness: ReadinessSchema.nullable().optional(),
  lastReview: ReviewVerdictSchema.nullable().optional(),
  lastQaId: z.string().min(1).nullable().optional(),
});
export type StateFile = z.infer<typeof StateFileSchema>;

export const ContextFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.context),
  standingInstructions: z.string(),
  platforms: z.array(z.enum(["phone", "desktop"])),
});
export type ContextFile = z.infer<typeof ContextFileSchema>;

export const IntentRoundSchema = z.object({
  n: z.number().int().positive(),
  questions: z.array(z.string()),
  answers: z.array(z.string()),
});
export type IntentRound = z.infer<typeof IntentRoundSchema>;

export const IntentMappedSchema = z.object({
  personas: z.array(z.string()),
  problem: z.string(),
  mustBeTrue: z.array(z.string()),
  mustNotChange: z.array(z.string()),
  outOfScope: z.array(z.string()),
  happyPath: z.string(),
  screens: z.array(z.string()),
});
export type IntentMapped = z.infer<typeof IntentMappedSchema>;

export const IntentAnswersFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.intentAnswers),
  rounds: z.array(IntentRoundSchema),
  mapped: IntentMappedSchema,
});
export type IntentAnswersFile = z.infer<typeof IntentAnswersFileSchema>;

export const LegionConfigSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.config),
  adapter: z
    .object({
      default: AdapterIdSchema,
      claude: z
        .object({
          extraArgs: z.array(z.string()).default([]),
        })
        .optional(),
      generic: z
        .object({
          binary: z.string().min(1),
          args: z.array(z.string()),
        })
        .optional(),
    })
    .refine((adapter) => adapter.default !== "generic" || adapter.generic !== undefined, {
      message: "adapter.generic is required when adapter.default is generic",
      path: ["generic"],
    }),
  ingest: z
    .object({
      autoCommit: z.boolean().default(true),
    })
    .default({ autoCommit: true }),
  control_mode: ControlModeSchema.default("guarded"),
  qa: z
    .object({
      mode: z.enum(["full", "no-browser"]).default("full"),
      passScore: z.number().int().min(0).max(100).default(85),
      unitCommand: z.string().min(1).optional(),
    })
    .default({ mode: "full", passScore: 85 }),
  dashboard: z
    .object({
      port: z.number().int().min(1).max(65535).default(7420),
      bind: z.literal("127.0.0.1").default("127.0.0.1"),
    })
    .default({ port: 7420, bind: "127.0.0.1" }),
  flags: z
    .object({
      mcpApps: z.boolean().default(false),
      webmcp: z.boolean().default(false),
      parallelExecute: z.boolean().default(false),
    })
    .default({ mcpApps: false, webmcp: false, parallelExecute: false }),
});
export type LegionConfig = z.infer<typeof LegionConfigSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  kind: z.enum(["behavior", "test", "rubric"]),
  priority: PrioritySchema,
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const SpecSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.spec),
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["draft", "frozen", "superseded"]),
  mustBeTrue: z.array(z.string()),
  mustNotChange: z.array(z.string()),
  outOfScope: z.array(z.string()),
  acceptance: z.array(AcceptanceCriterionSchema),
  personas: z.array(z.string()),
  happyPath: z.string(),
  stories: z.string().nullable().optional(),
  wireframesIndex: z.string().nullable().optional(),
  frozenAt: z.string().nullable().optional(),
  frozenBy: z.string().nullable().optional(),
});
export type Spec = z.infer<typeof SpecSchema>;

export const TaskSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.task),
  id: z.string().min(1),
  title: z.string().min(1),
  status: TaskStatusSchema,
  type: z.enum(["feature", "fix", "bug"]),
  priority: PrioritySchema,
  specId: z.string().min(1),
  parentId: z.string().min(1).nullable().optional(),
  blockedBy: z.array(z.string()),
  blocks: z.array(z.string()),
  contract: FileContractSchema,
  assignee: z.enum(["agent", "human"]),
  notes: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const AssumptionSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.assumption),
  id: z.string().min(1),
  statement: z.string().min(1),
  status: z.enum(["open", "confirmed", "rejected"]),
  blocking: z.boolean(),
  evidence: z.string().nullable().optional(),
  escalatesTo: z.enum(["user", "engineer"]),
  createdIn: z.string().min(1),
});
export type Assumption = z.infer<typeof AssumptionSchema>;

export const DiscussDecisionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  status: z.enum(["proposed", "accepted", "rejected"]),
});
export type DiscussDecision = z.infer<typeof DiscussDecisionSchema>;

export const DiscussFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.discuss),
  decisions: z.array(DiscussDecisionSchema),
});
export type DiscussFile = z.infer<typeof DiscussFileSchema>;

export const IngestReceiptSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.ingest),
  id: z.string().min(1),
  sources: z.array(z.string()),
  pagesCreated: z.array(z.string()),
  pagesUpdated: z.array(z.string()),
  skipped: z.array(z.string()),
});
export type IngestReceipt = z.infer<typeof IngestReceiptSchema>;

export const AuditEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.audit),
  ts: z.string().min(1),
  type: z.string().min(1),
  phase: PhaseSchema,
  taskId: z.string().min(1).nullable().optional(),
  actor: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const ResumeFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.resume),
  runId: z.string().min(1),
  taskId: z.string().min(1).nullable().optional(),
  skillId: SkillIdSchema,
  preSpawnRef: z.string().min(1),
  startedAt: z.string().min(1),
  pid: z.number().int().positive().nullable().optional(),
});
export type ResumeFile = z.infer<typeof ResumeFileSchema>;

const QaP0BucketSchema = z.object({
  points: z.number(),
  max: z.literal(40),
  failed: z.number().int().min(0),
});
const QaP1BucketSchema = z.object({
  points: z.number(),
  max: z.literal(30),
  passRate: z.number().min(0).max(1),
});
const QaP2BucketSchema = z.object({
  points: z.number(),
  max: z.literal(15),
  passRate: z.number().min(0).max(1),
});
const QaVisualBucketSchema = z.object({
  points: z.number(),
  max: z.literal(15),
  regressions: z.number().int().min(0),
});

export const QaBucketsSchema = z.object({
  p0: QaP0BucketSchema,
  p1: QaP1BucketSchema,
  p2: QaP2BucketSchema,
  visual: QaVisualBucketSchema,
});
export type QaBuckets = z.infer<typeof QaBucketsSchema>;

export function computeQaPass(input: {
  mode: "full" | "no-browser";
  total: number;
  buckets: { p0: { failed: number }; visual: { regressions: number } };
}): boolean {
  return (
    input.mode === "full" &&
    input.total >= 85 &&
    input.buckets.p0.failed === 0 &&
    input.buckets.visual.regressions === 0
  );
}

export const QAScoreSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION.qa),
    id: z.string().min(1),
    specId: z.string().min(1),
    mode: z.enum(["full", "no-browser"]),
    buckets: QaBucketsSchema,
    total: z.number(),
    pass: z.boolean(),
    evidencePaths: z.array(z.string()),
    createdAt: z.string().min(1),
  })
  .refine((score) => score.pass === computeQaPass(score), {
    path: ["pass"],
    message: "pass must be mode==full && total>=85 && p0.failed==0 && visual.regressions==0",
  });
export type QAScore = z.infer<typeof QAScoreSchema>;

export const SessionBriefSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.brief),
  project: z.object({
    name: z.string().min(1),
    mode: ProjectModeSchema,
    controlMode: ControlModeSchema,
  }),
  phase: PhaseSchema,
  currentTask: z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
    })
    .nullable()
    .optional(),
  blockers: z.array(AssumptionSchema),
  decisions: z.array(
    z.object({
      id: z.string().min(1),
      summary: z.string(),
    }),
  ),
  wiki: z.array(
    z.object({
      path: z.string().min(1),
      title: z.string().min(1),
      summary: z.string().nullable().optional(),
      trust: z.enum(["untrusted", "reviewed"]),
    }),
  ),
  contract: FileContractSchema.nullable().optional(),
  lastQa: z
    .object({
      total: z.number(),
      pass: z.boolean(),
    })
    .nullable()
    .optional(),
  characterCount: z.number().int().min(0),
});
export type SessionBrief = z.infer<typeof SessionBriefSchema>;
