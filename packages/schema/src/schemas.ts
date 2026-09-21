import { z } from "zod";
import { ConcretePosixPathSchema, PosixAllowedRootSchema } from "./paths.js";
import {
  ADAPTER_IDS,
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

export const SkillCatalogEntrySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.skillCatalog).optional(),
  skillId: SkillIdSchema,
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  description: z.string().min(1).max(400),
  required: z.boolean(),
  compatibility: z.string().optional(),
  resources: z
    .object({
      scripts: z.array(z.string()).default([]),
      references: z.array(z.string()).default([]),
      assets: z.array(z.string()).default([]),
    })
    .default({ scripts: [], references: [], assets: [] }),
  bodyChars: z.number().int().min(0),
  path: z.string().min(1),
});
export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntrySchema>;

export const SkillCatalogSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.skillCatalog),
  skills: z.array(SkillCatalogEntrySchema),
});
export type SkillCatalog = z.infer<typeof SkillCatalogSchema>;

export const TopicsFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.topics),
  topics: z.record(z.string().min(1), z.array(z.string().min(1))),
});
export type TopicsFile = z.infer<typeof TopicsFileSchema>;

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
  /**
   * Commits an agent made during a spawn (R-20). STATE.md is in the protected set, so a later
   * agent cannot erase this list. `refs/legion-quarantine/<runId>` keeps the commits reachable.
   */
  quarantinedCommits: z.array(z.string().regex(/^[0-9a-f]{7,64}$/)).optional(),
  /**
   * The spawn this project is inside, written before the protected-set snapshot (KD-15) and
   * cleared at the finish. Crash recovery reads exactly one control record: this one (PR 6).
   */
  activeRun: z
    .object({
      runId: z.string().min(1),
      taskId: z.string().min(1).nullable().optional(),
    })
    .nullable()
    .optional(),
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

export const ExtraAdapterConfigSchema = z
  .object({
    binary: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
  })
  .strict();
export type ExtraAdapterConfig = z.infer<typeof ExtraAdapterConfigSchema>;

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;
export const Sha256HexSchema = z.string().regex(SHA256_HEX_REGEX);

const HTTP_HEADER_SECRET_NAMES = ["authorization", "x-api-key"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const GITHUB_OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function httpBaseUrlIssue(baseUrl: string, allowLoopback: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return "adapter.http.baseUrl must be a URL";
  }
  if (parsed.username || parsed.password) {
    return "adapter.http.baseUrl cannot include userinfo";
  }
  if (parsed.protocol === "https:") return null;
  const host = parsed.hostname;
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (
    parsed.protocol === "http:" &&
    allowLoopback &&
    (LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(unwrapped))
  ) {
    return null;
  }
  return "adapter.http.baseUrl must be https: (http: loopback only with allowLoopback)";
}

export const HttpAdapterConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    model: z.string().min(1),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    allowLoopback: z.boolean().default(false),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const baseUrlIssue = httpBaseUrlIssue(val.baseUrl, val.allowLoopback);
    if (baseUrlIssue) {
      ctx.addIssue({ code: "custom", message: baseUrlIssue, path: ["baseUrl"] });
    }
    for (const key of Object.keys(val.headers ?? {})) {
      if (HTTP_HEADER_SECRET_NAMES.includes(key.toLowerCase())) {
        ctx.addIssue({
          code: "custom",
          message: "adapter.http.headers cannot set Authorization or X-Api-Key",
          path: ["headers", key],
        });
      }
    }
  });
export type HttpAdapterConfig = z.infer<typeof HttpAdapterConfigSchema>;

export const SandboxConfigSchema = z
  .object({
    requireHardened: z.boolean().default(true),
    allowCopyJail: z.boolean().default(false),
    backend: z.enum(["auto", "bwrap", "seatbelt", "copy"]).default("auto"),
    skills: z.array(SkillIdSchema).min(1).default(["execute"]),
  })
  .strict();
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export const SkillsConfigSchema = z
  .object({
    trustKeys: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

export const MapConfigSchema = z
  .object({
    roots: z.array(ConcretePosixPathSchema).optional(),
    ignore: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type MapConfig = z.infer<typeof MapConfigSchema>;

export const AdapterRoutesSchema = z
  .object({
    interview: AdapterIdSchema.optional(),
    discuss: AdapterIdSchema.optional(),
    spec: AdapterIdSchema.optional(),
    ingest: AdapterIdSchema.optional(),
    plan: AdapterIdSchema.optional(),
    execute: AdapterIdSchema.optional(),
    verify: AdapterIdSchema.optional(),
    review: AdapterIdSchema.optional(),
    qa: AdapterIdSchema.optional(),
    map: AdapterIdSchema.optional(),
    wireframe: AdapterIdSchema.optional(),
    chat: AdapterIdSchema.optional(),
  })
  .strict();
export type AdapterRoutes = z.infer<typeof AdapterRoutesSchema>;

export const NamedAdapterRoutesSchema = z.record(
  z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .refine((key) => !(ADAPTER_IDS as readonly string[]).includes(key), {
      message: "adapter.named keys must not be AdapterIds",
    }),
  AdapterIdSchema,
);
export type NamedAdapterRoutes = z.infer<typeof NamedAdapterRoutesSchema>;

function adapterTargetsId(
  adapter: {
    default: z.infer<typeof AdapterIdSchema>;
    routes?: AdapterRoutes;
    named?: NamedAdapterRoutes;
  },
  id: z.infer<typeof AdapterIdSchema>,
): boolean {
  if (adapter.default === id) return true;
  const routed = adapter.routes ? Object.values(adapter.routes) : [];
  const named = adapter.named ? Object.values(adapter.named) : [];
  return routed.includes(id) || named.includes(id);
}

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
      grok: ExtraAdapterConfigSchema.optional(),
      openai: ExtraAdapterConfigSchema.optional(),
      codex: ExtraAdapterConfigSchema.optional(),
      mimo: ExtraAdapterConfigSchema.optional(),
      minimax: ExtraAdapterConfigSchema.optional(),
      http: HttpAdapterConfigSchema.optional(),
      routes: AdapterRoutesSchema.optional(),
      named: NamedAdapterRoutesSchema.optional(),
    })
    .strict()
    .refine((adapter) => !adapterTargetsId(adapter, "generic") || adapter.generic !== undefined, {
      message: "adapter.generic is required when adapter.default or any routes/named target is generic",
      path: ["generic"],
    })
    .refine((adapter) => !adapterTargetsId(adapter, "http") || adapter.http !== undefined, {
      message: "adapter.http is required when adapter.default or any routes/named target is http",
      path: ["http"],
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
      passScore: z.literal(85).default(85),
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
      /** Later door (founding §5.4); unread by execute / isTaskReady. */
      parallelExecute: z.boolean().default(false),
    })
    .default({ mcpApps: false, webmcp: false, parallelExecute: false }),
  sandbox: SandboxConfigSchema.default({
    requireHardened: true,
    allowCopyJail: false,
    backend: "auto",
    skills: ["execute"],
  }),
  skills: SkillsConfigSchema.default({ trustKeys: [] }),
  map: MapConfigSchema.default({}),
}).strict();
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
  adapter: AdapterIdSchema.optional(),
  parentId: z.string().min(1).nullable().optional(),
  blockedBy: z.array(z.string().min(1)),
  blocks: z.array(z.string().min(1)),
  contract: FileContractSchema,
  assignee: z.enum(["agent", "human"]),
  notes: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const PacketSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.packet),
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["open", "responded"]),
  requester: z.enum(["pm", "designer", "human"]),
  request: z.string(),
  specId: z.string().min(1).nullable().optional(),
  ticketIds: z.array(z.string().min(1)),
  createdAt: z.string().min(1),
  respondedAt: z.string().min(1).nullable().optional(),
  response: z.string().nullable().optional(),
});
export type Packet = z.infer<typeof PacketSchema>;

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

export const AdapterResolutionSourceSchema = z.enum(["cli", "task", "route", "default"]);
export type AdapterResolutionSource = z.infer<typeof AdapterResolutionSourceSchema>;

/** Upper bound for an agent spawn's timeout (the adapter default, 20 minutes). */
export const MAX_SPAWN_TIMEOUT_MS = 20 * 60 * 1000;

/** Clock skew tolerated before a `startedAt` in the future makes a control record invalid. */
const RESUME_FUTURE_SKEW_MS = 60_000;

export const ResumeFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.resume),
  runId: z.string().min(1),
  taskId: z.string().min(1).nullable().optional(),
  skillId: SkillIdSchema,
  preSpawnRef: z.string().min(1),
  /** Never in the future (R-15): a forged future start would wedge recovery. */
  startedAt: z
    .string()
    .min(1)
    .refine((value) => {
      const ms = Date.parse(value);
      return Number.isFinite(ms) && ms <= Date.now() + RESUME_FUTURE_SKEW_MS;
    }, "startedAt must be a timestamp that is not in the future"),
  /** Spawn timeout, bounded by MAX_SPAWN_TIMEOUT_MS (R-15). */
  timeoutMs: z.number().int().positive().max(MAX_SPAWN_TIMEOUT_MS).optional(),
  pid: z.number().int().positive().nullable().optional(),
  /**
   * Start time (epoch ms) of the agent process, so crash replay never kills a reused PID (PR 6).
   * Recorded as the spawn moment, on the same clock {@link processIdentity} reports.
   */
  agentPidStartedAt: z.number().optional(),
  /** Legion CLI process that owns the run. Live after wait() while post-wait still runs. */
  enginePid: z.number().int().positive().optional(),
  /** Start time (epoch ms) of the engine process, to detect PID reuse. */
  engineStartedAt: z.number().optional(),
  adapterId: AdapterIdSchema.optional(),
  binary: z.string().min(1).optional(),
  argvSummary: z.string().optional(),
  resolutionSource: AdapterResolutionSourceSchema.optional(),
});
export type ResumeFile = z.infer<typeof ResumeFileSchema>;

/**
 * Brownfield run-scoped resume. Not a wiki page; promote copies markdown into the wiki.
 * The orchestrating agent does judgment; `legion-cli brownfield <sub>` keeps these books.
 * Legacy 3-phase files (analysis|execute|complete) still parse: every newer field is defaulted.
 */
export const BrownfieldRunPhaseSchema = z.enum([
  "intent",
  "plan",
  "analysis",
  "assumptions",
  "design",
  "review",
  "present",
  "execute",
  "verify",
  "complete",
]);
export type BrownfieldRunPhase = z.infer<typeof BrownfieldRunPhaseSchema>;

export const BrownfieldRunIdSchema = z.string().regex(/^[0-9a-f]{8}$/);

export const BrownfieldSizeTierSchema = z.enum(["tiny", "small", "medium", "large"]);
export type BrownfieldSizeTier = z.infer<typeof BrownfieldSizeTierSchema>;

export const BrownfieldSizeSchema = z
  .object({
    files: z.number().int().min(0),
    lines: z.number().int().min(0),
    tier: BrownfieldSizeTierSchema,
    maxPrs: z.number().int().min(1),
    suggestedEffortMax: z.number().int().min(1).max(5),
  })
  .strict();
export type BrownfieldSize = z.infer<typeof BrownfieldSizeSchema>;

export const BrownfieldSpecialistSchema = z.enum([
  "architecture",
  "product-intent",
  "code",
  "code-2",
  "tests",
  "security",
  "performance",
  "documentation",
]);
export type BrownfieldSpecialist = z.infer<typeof BrownfieldSpecialistSchema>;

export const BrownfieldRosterSchema = z
  .object({
    effort: z.number().int().min(1).max(5),
    pass1: z.array(BrownfieldSpecialistSchema),
    pass2: z.array(BrownfieldSpecialistSchema),
    addedBySignal: z.array(BrownfieldSpecialistSchema),
    injectDoctrine: z.boolean(),
    designReviewers: z.number().int().min(1).max(2),
    executeReviewersDefault: z.array(z.string().min(1)),
    outputs: z.record(z.string(), z.string().min(1)),
  })
  .strict();
export type BrownfieldRoster = z.infer<typeof BrownfieldRosterSchema>;

export const BrownfieldRunSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.run),
  runId: BrownfieldRunIdSchema,
  effort: z.number().int().min(1).max(5),
  execute: z.boolean(),
  phase: BrownfieldRunPhaseSchema,
  preSpawnRef: z.string().min(1),
  startedAt: z.string().min(1),
  /** Legacy single-worktree runs only. Per-PR worktrees are recorded on dag.json nodes. */
  worktreePath: z.string().min(1).nullable().optional(),
  promoted: z.boolean().default(false),
  /** Legacy page list. Promote now walks the run directory. */
  pages: z.array(z.string().min(1)).default([]),
  context: z.string().default(""),
  size: BrownfieldSizeSchema.optional(),
  roster: BrownfieldRosterSchema.optional(),
  designReviewRounds: z.number().int().min(0).default(0),
  assumptionRounds: z.number().int().min(0).default(0),
  /** Branch the run started on; null when HEAD was detached or unborn. */
  baseBranch: z.string().min(1).nullable().default(null),
  updatedAt: z.string().min(1).optional(),
  /** Free-form orchestrator notes (agent ids, decisions). Set via `state <id> meta.<key>=<json>`. */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type BrownfieldRun = z.infer<typeof BrownfieldRunSchema>;

export const BrownfieldDagNodeIdSchema = z.string().regex(/^pr-[1-9]\d*$/);

export const BrownfieldDagNodeStatusSchema = z.enum([
  "pending",
  "implementing",
  "reviewing",
  "completed",
  "failed",
  "skipped",
]);
export type BrownfieldDagNodeStatus = z.infer<typeof BrownfieldDagNodeStatusSchema>;

export const BrownfieldDagNodeSchema = z
  .object({
    id: BrownfieldDagNodeIdSchema,
    number: z.number().int().min(1),
    title: z.string().min(1),
    branch: z.string().min(1),
    dependsOn: z.array(BrownfieldDagNodeIdSchema),
    files: z.array(z.string().min(1)),
    tracesTo: z.string(),
    risk: z.string(),
    spec: z.string(),
    status: BrownfieldDagNodeStatusSchema,
    level: z.number().int().min(0),
    /** Branch name (dependents) or commit SHA / branch (roots). */
    base: z.string().min(1),
    mergeIn: z.array(z.string().min(1)),
    commit: z.string().min(1).nullable().default(null),
    worktree: z.string().min(1).nullable().default(null),
    agentId: z.string().min(1).nullable().default(null),
    reviewRounds: z.number().int().min(0).default(0),
    error: z.string().nullable().default(null),
  })
  .strict();
export type BrownfieldDagNode = z.infer<typeof BrownfieldDagNodeSchema>;

export const BrownfieldDagSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION.dag),
    runId: BrownfieldRunIdSchema,
    nodes: z.array(BrownfieldDagNodeSchema),
  })
  .strict();
export type BrownfieldDag = z.infer<typeof BrownfieldDagSchema>;

export const BrownfieldPatternsFileSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION.brownfieldPatterns),
    patterns: z.record(
      z.string().min(1),
      z
        .object({
          count: z.number().int().min(1),
          firstSeen: z.string().min(1),
          lastSeen: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type BrownfieldPatternsFile = z.infer<typeof BrownfieldPatternsFileSchema>;

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

function qaBucketPointsValid(buckets: QaBuckets): boolean {
  return (
    buckets.p0.points === (buckets.p0.failed === 0 ? 40 : 0) &&
    buckets.p1.points === Math.round(30 * buckets.p1.passRate) &&
    buckets.p2.points === Math.round(15 * buckets.p2.passRate) &&
    buckets.visual.points === (buckets.visual.regressions === 0 ? 15 : 0)
  );
}

function qaExpectedTotal(mode: "full" | "no-browser", buckets: QaBuckets): number {
  const sum =
    buckets.p0.points + buckets.p1.points + buckets.p2.points + buckets.visual.points;
  return mode === "no-browser" ? Math.min(sum, 70) : sum;
}

export const QAScoreSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION.qa),
    id: z.string().min(1),
    specId: z.string().min(1),
    mode: z.enum(["full", "no-browser"]),
    buckets: QaBucketsSchema,
    total: z.number().min(0).max(100),
    pass: z.boolean(),
    evidencePaths: z.array(z.string()),
    createdAt: z.string().min(1),
  })
  .refine((score) => qaBucketPointsValid(score.buckets), {
    path: ["buckets"],
    message:
      "bucket points must match P0 0-or-40, P1 round(30*passRate), P2 round(15*passRate), visual 0-or-15",
  })
  .refine((score) => score.total === qaExpectedTotal(score.mode, score.buckets), {
    path: ["total"],
    message: "total must equal the sum of bucket points (capped at 70 when mode is no-browser)",
  })
  .refine((score) => score.pass === computeQaPass(score), {
    path: ["pass"],
    message: "pass must be mode==full && total>=85 && p0.failed==0 && visual.regressions==0",
  });
export type QAScore = z.infer<typeof QAScoreSchema>;

export const DesignSystemIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "design-system id must be a lowercase slug");
export type DesignSystemId = z.infer<typeof DesignSystemIdSchema>;

export const DesignSystemPackageSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.designSystem),
  id: DesignSystemIdSchema,
  name: z.string().min(1),
  description: z.string(),
  source: z.object({
    type: z.enum(["bundled", "local", "github"]),
    origin: z.string().min(1),
  }),
  files: z.object({
    design: z.literal("DESIGN.md"),
    tokens: z.literal("tokens.css"),
    usage: z.string().min(1).optional(),
  }),
  wcag: z.enum(["A", "AA", "AAA"]).optional(),
  integrity: z
    .object({
      sha256: Sha256HexSchema,
      minisign: z.string().min(1).optional(),
    })
    .optional(),
});
export type DesignSystemPackage = z.infer<typeof DesignSystemPackageSchema>;

export const DesignActiveSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION.designActive),
  packageId: z.string().min(1).optional(),
  craft: z.array(z.string()),
  /** Set by generate/import review; blocks spec freeze for UI work when true. */
  brandViolation: z.boolean().optional(),
});
export type DesignActive = z.infer<typeof DesignActiveSchema>;

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
      adapter: AdapterIdSchema.optional(),
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
  skills: z
    .array(
      z.object({
        skillId: SkillIdSchema,
        name: z.string(),
        description: z.string(),
        active: z.boolean().optional(),
      }),
    )
    .optional(),
  mapRootHash: Sha256HexSchema.optional(),
  characterCount: z.number().int().min(0),
});
export type SessionBrief = z.infer<typeof SessionBriefSchema>;

export const ModuleFingerprintSchema = z.object({
  path: ConcretePosixPathSchema,
  language: z.enum(["ts", "js", "py", "go", "rs", "other"]),
  exports: z.array(z.string()).max(500),
  imports: z.array(z.string()).max(500),
  hash: Sha256HexSchema,
});
export type ModuleFingerprint = z.infer<typeof ModuleFingerprintSchema>;

export const FingerprintFileSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION.fingerprint),
    generatedAt: z.string().min(1),
    backend: z.enum(["lsp", "fallback"]),
    rootHash: Sha256HexSchema,
    modules: z.array(ModuleFingerprintSchema).max(10_000),
  })
  .strict();
export type FingerprintFile = z.infer<typeof FingerprintFileSchema>;

export const SkillOverlayPinSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION.skillOverlay),
    skillId: SkillIdSchema,
    source: z.object({
      type: z.enum(["local", "github"]),
      origin: z.string().min(1),
      ref: z.string().min(1).optional(),
    }),
    integrity: z.object({
      sha256: Sha256HexSchema,
      minisign: z.string().min(1).optional(),
    }),
    installedAt: z.string().min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.source.type !== "github") return;
    if (!GITHUB_OWNER_REPO.test(val.source.origin)) {
      ctx.addIssue({
        code: "custom",
        message: "github overlay origin must be owner/repo",
        path: ["source", "origin"],
      });
    }
    if (!val.source.ref) {
      ctx.addIssue({
        code: "custom",
        message: "source.ref is required when source.type is github",
        path: ["source", "ref"],
      });
    }
    if (!val.integrity.minisign) {
      ctx.addIssue({
        code: "custom",
        message: "integrity.minisign is required when source.type is github",
        path: ["integrity", "minisign"],
      });
    }
  });
export type SkillOverlayPin = z.infer<typeof SkillOverlayPinSchema>;

export const ChatReadActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("search"), q: z.string().min(1) }),
  z.object({ type: z.literal("next_verb") }),
]);
export type ChatReadAction = z.infer<typeof ChatReadActionSchema>;

export const ChatProposalActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("intent_answer"), answers: z.array(z.string()).min(1).max(2) }),
  z.object({
    type: z.literal("discuss_decide"),
    id: z.string().min(1),
    status: z.enum(["accepted", "rejected"]),
  }),
  z.object({
    type: z.literal("ticket"),
    title: z.string().min(1),
    parentId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("assume_answer"),
    id: z.string().min(1),
    status: z.enum(["confirmed", "rejected"]),
  }),
]);
export type ChatProposalAction = z.infer<typeof ChatProposalActionSchema>;

export const ChatActionSchema = z.union([ChatReadActionSchema, ChatProposalActionSchema]);
export type ChatAction = z.infer<typeof ChatActionSchema>;

export const ChatSessionFileSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION.chatSession),
    id: z.string().min(1),
    startedAt: z.string().min(1),
    turns: z.array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string(),
        action: ChatActionSchema.optional(),
      }),
    ),
  })
  .strict();
export type ChatSessionFile = z.infer<typeof ChatSessionFileSchema>;

export const ServeFileSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION.serve),
    port: z.number().int().min(1).max(65535),
    bind: z.string().min(1),
    mcpPath: z.literal("/mcp"),
    mcpHttp: z.boolean(),
    tokenSha256: Sha256HexSchema,
    startedAt: z.string().min(1),
    pid: z.number().int().positive(),
  })
  .strict();
export type ServeFile = z.infer<typeof ServeFileSchema>;
