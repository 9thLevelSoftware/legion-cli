import type { FakeArtifact, FakeHoldWait } from "@9thlevelsoftware/legion-cli-agents";
import type { AssuranceEvidenceReport, AssuranceStatus } from "./assurance.js";
import type { MapOptions, MapResult } from "./map.js";
import type { GardenReport, SearchHit } from "@9thlevelsoftware/legion-cli-wiki";
import type {
  AdapterId,
  AdapterResolutionSource,
  AcceptanceReceipt,
  ActionApproval,
  AgentUsage,
  Assumption,
  BrownfieldDagNode,
  BrownfieldRoster,
  BrownfieldRun,
  BrownfieldRunPhase,
  BrownfieldSize,
  ControlMode,
  DiscussDecision,
  FileContract,
  GovernanceAction,
  GovernanceFrame,
  GovernanceViolation,
  IngestReceipt,
  IntentAnswersFile,
  IntentMapped,
  Packet,
  PlanApprovalReceipt,
  Phase,
  Priority,
  QAScore,
  Readiness,
  ReviewVerdict,
  SessionBrief,
  Spec,
  Task,
  WorkflowEvidenceReceipt,
} from "@9thlevelsoftware/legion-cli-schema";

export type Actor = {
  id: string;
};

export type LegionEngineOptions = {
  skillsDir?: string;
  fakeArtifacts?: FakeArtifact[];
  fakeThrowAfterWrite?: boolean;
  fakeTimedOut?: boolean;
  /** Test-only: exit code the fake agent reports. */
  fakeExitCode?: number;
  /** Test-only: per-task exit codes for parallel fake-agent coverage. */
  fakeExitCodeForTask?: (taskId: string) => number | undefined;
  /** Test-only: adapter resource cleanup hook for each parallel task. */
  fakeResourceCleanupForTask?: (taskId: string) => Promise<void>;
  /** Test-only: fake agent writes no summary. */
  fakeOmitSummary?: boolean;
  fakeHoldWait?: FakeHoldWait;
  fakeOnWait?: () => Promise<void>;
  /** Test-only: runs immediately before each serialized parallel output application. */
  fakeBeforeParallelApply?: (taskId: string, index: number) => Promise<void>;
  /** Test-only: can hold one parallel member before its child starts. */
  fakeBeforeParallelStart?: (taskId: string, index: number) => Promise<void>;
  fakeHandlePid?: number;
  /** Test-only, like the other fake* seams: verification throws this message. */
  fakeVerificationError?: string;
  /** Test-only: runs during verify (lock-free after F-026). Injected-clock advance lives here. */
  fakeOnVerify?: () => Promise<void>;
  /** Test-only: runs during qa (lock-free after F-026). Injected-clock advance lives here. */
  fakeOnQa?: () => Promise<void>;
  /** Test-only: runs after validated challenge output is durably checkpointed and before spawn cleanup. */
  fakeAfterChallengeOutputCheckpoint?: () => Promise<void>;
  /** Test-only: runs after an engine-authored challenge draft write and before the completion receipt. */
  fakeAfterChallengeDraftWrite?: () => Promise<void>;
  /** Test-only: permits QaOptions.score; production engines must execute configured reports. */
  fakeQaScoreInjection?: boolean;
  verificationTimeoutMs?: number;
  /** Test-only: overrides hardened-backend detection for the `ingest --distill` refusal. */
  fakeDistillSandboxHardened?: boolean;
  /** Test-only: runs at each adopted governance boundary point (crash-consistency fault injection). */
  fakeGovernanceFault?: (point: GovernanceFaultPoint) => Promise<void>;
};

export type GovernanceFaultPoint =
  | "after-begin-frame"
  | "after-begin-head"
  | "after-mutation"
  | "after-end-frame"
  | "after-end-head";

export type GovernanceInspection = {
  current: {
    approvalId: string | null;
    adopted: boolean;
    status: "valid" | "incomplete" | "invalid" | "not-adopted" | "interrupted-epoch";
  };
  epochs: Array<{
    sequence: number;
    approvalId: string | null;
    adopted: boolean;
    recordedAt: string;
    status: "valid" | "incomplete" | "invalid" | "not-adopted";
    frames: number;
    headDigest: string | null;
    lastAction: GovernanceAction | null;
    lastOutcome: GovernanceFrame["outcome"] | null;
    violations: GovernanceViolation[];
  }>;
};

export type IntentState = {
  phase: Phase;
  answers: IntentAnswersFile;
  mapped: IntentMapped;
  nextQuestions: string[];
  readyToConfirm: boolean;
  canFinishEarly: boolean;
  brief: string;
};

export type DecisionInput = {
  id: string;
  status: "accepted" | "rejected";
};

export type { DiscussDecision };

export type InitOptions = {
  name: string;
  adapter: AdapterId;
  generic?: { binary: string; args: string[] };
  http?: { baseUrl: string; model: string; apiKeyEnv: string; allowLoopback?: boolean };
  acp?: { command: string; args: string[]; enabled: true };
  mode?: "greenfield" | "brownfield";
  brownfieldGoal?: "change" | "audit";
  /** New public CLI initialization uses focused; omitted preserves low-level API compatibility. */
  workflowProfile?: "focused" | "legacy";
  controlMode?: ControlMode | "autonomous" | string;
  allowCopyJail?: boolean;
};

export type PlanApprovalOptions = {
  /** Additional project-level checks, merged with config.workflow.verificationCommands. */
  verificationCommands?: string[];
  assuranceManifestPath?: string;
  assuranceOff?: boolean;
};

export type AcceptanceEvidenceInput = {
  id: string;
  status: "passed" | "failed" | "not_applicable";
  note?: string;
};

export type ExecuteWorkflowOptions = {
  taskId?: string;
  step?: boolean;
  adapter?: AdapterId;
  profile?: string;
  resume?: string;
  untilBlocked?: boolean;
  jobs?: number;
  onProgress?: ExecuteOptions["onProgress"];
  fix?: boolean;
  allowNoSandbox?: boolean;
  /** Explicitly retry the failed integration or review stage once. */
  retry?: boolean;
};

export type WorkflowAcceptanceStatus = {
  required: string[];
  passed: string[];
  failed: string[];
  pending: string[];
  notApplicable: string[];
};

export type WorkflowStatus = {
  stage: "spec" | "plan" | "execute" | "ship";
  planApproval: "missing" | "valid" | "stale";
  execution: "not_started" | "running" | "blocked" | "complete" | "stale";
  acceptance: WorkflowAcceptanceStatus;
  blocker: string | null;
  next: string;
  assurance?: AssuranceStatus;
};

export type WorkflowExecutionResult = {
  status: "blocked" | "complete" | "step_complete";
  taskId?: string;
  completedTaskIds: string[];
  blocker: string | null;
  next: string;
  tasks?: ExecuteTaskResult[];
  warnings?: string[];
  assurance?: Pick<AssuranceEvidenceReport, "checks" | "policyStatus" | "traceStatus">;
};

export type { AcceptanceReceipt, PlanApprovalReceipt, WorkflowEvidenceReceipt };

export type {
  SpecChallengeDisposition,
  SpecChallengeManualQuestionKey,
  SpecChallengeManualReviewInput,
  SpecChallengeResolutionInput,
  SpecChallengeResult,
  SpecChallengeStatus,
} from "./spec-challenge.js";

export type BrownfieldEffort = 1 | 2 | 3 | 4 | 5;

export type BrownfieldOptions = {
  effort?: number;
  execute?: boolean;
  /** With resume: show state and where to continue (same as `brownfield state <id>`). */
  resume?: string;
  context?: string;
  runId?: string;
  /** Init always maps the repo. true = `{ lsp: "require" }` (refuse without a language server); default "auto". */
  lsp?: boolean;
  resolveBinary?: MapOptions["resolveBinary"];
  spawnLsp?: MapOptions["spawnLsp"];
  lspDeadlineMs?: number;
};

/** POSIX store paths for every artifact of a run. Authoritative for the orchestrating agent. */
export type BrownfieldArtifactPaths = {
  runDir: string;
  state: string;
  intent: string;
  plan: string;
  analysisDir: string;
  findings: string;
  assumptions: string;
  design: string;
  summary: string;
  reviewsDir: string;
  designReview: string;
  dag: string;
  evidenceDir: string;
  execDir: string;
  verify: string;
};

export type BrownfieldInitResult = {
  kind: "init";
  runId: string;
  effort: BrownfieldEffort;
  execute: boolean;
  phase: BrownfieldRunPhase;
  size: BrownfieldSize;
  baseBranch: string | null;
  preSpawnRef: string;
  paths: BrownfieldArtifactPaths;
  resumePath: string;
  /** The codebase map every init refreshes (`.legion-cli/map/`). */
  map: MapResult;
  warnings: string[];
  next: string;
};

export type BrownfieldAnalysisOutputStatus = "present" | "empty" | "missing";

export type BrownfieldStateResult = {
  kind: "state";
  runId: string;
  state: BrownfieldRun;
  paths: BrownfieldArtifactPaths;
  artifacts: Record<string, boolean>;
  analysisOutputs: Record<string, BrownfieldAnalysisOutputStatus>;
  dag: { present: boolean; done: boolean; ready: string[]; completed: number } | null;
  next: string;
};

export type BrownfieldResult = BrownfieldInitResult | BrownfieldStateResult;

export type BrownfieldRosterResult = BrownfieldRoster & { runId: string; next: string };

export type BrownfieldSeverity = "critical" | "major" | "minor" | "nit";

export type BrownfieldIgnoredBlock = { source: string; heading: string; reason: string };

export type BrownfieldBlockingAssumption = {
  id: string;
  statement: string;
  evidence: string;
  question: string;
  sources: string[];
};

export type BrownfieldMergeResult = {
  runId: string;
  findingsTotal: number;
  bySeverity: Record<BrownfieldSeverity, number>;
  perSource: Record<string, { findings: number; assumptions: number }>;
  assumptionsTotal: number;
  blockingAssumptions: BrownfieldBlockingAssumption[];
  emptySources: string[];
  ignoredBlocks: BrownfieldIgnoredBlock[];
  files: { findings: string; assumptions: string };
  next: string;
};

export type BrownfieldReviewItem = {
  id: string;
  title: string;
  severity: BrownfieldSeverity;
  status: string;
};

export type BrownfieldReviewVerdict = "pass" | "pass-with-minor" | "revise" | "escalate";

export type BrownfieldReviewStatusOptions = {
  file?: string;
  previous?: string;
  strict?: boolean;
  snapshot?: boolean;
};

export type BrownfieldReviewStatusResult = {
  runId: string;
  file: string;
  previous: string | null;
  verdict: BrownfieldReviewVerdict;
  total: number;
  open: number;
  openBlocking: number;
  openBySeverity: Record<BrownfieldSeverity, number>;
  needsUserInput: BrownfieldReviewItem[];
  stalemates: BrownfieldReviewItem[];
  openItems: BrownfieldReviewItem[];
  ignoredBlocks: BrownfieldIgnoredBlock[];
  snapshot: string | null;
};

export type BrownfieldPrPlanResult = {
  runId: string;
  count: number;
  levels: number;
  order: { id: string; title: string; level: number; base: string; mergeIn: string[]; branch: string }[];
  dagFile: string;
  next: string;
};

export type BrownfieldDagNodeSummary = Pick<
  BrownfieldDagNode,
  "id" | "title" | "status" | "branch" | "base" | "mergeIn" | "commit" | "worktree" | "agentId" | "reviewRounds" | "error"
>;

export type BrownfieldDagResult = {
  runId: string;
  counts: Record<string, number>;
  ready: string[];
  inFlight: string[];
  done: boolean;
  nodes: BrownfieldDagNodeSummary[];
};

export type BrownfieldWorktreeOptions = { remove?: boolean; force?: boolean };

export type BrownfieldWorktreeResult = {
  runId: string;
  nodeId: string;
  branch: string;
  base: string;
  mergeIn: string[];
  worktree: string | null;
  created: boolean;
  removed: boolean;
  /** Main checkout had uncommitted changes (does not affect the new worktree). */
  mainCheckoutDirty: boolean;
};

export type BrownfieldEvidenceOptions = { skipAudit?: boolean };

export type BrownfieldEvidenceResult = {
  runId: string;
  files: { tests: string; security: string; docs: string };
  /** Exports in map-fingerprinted modules with no nearby markdown (0 without `legion-cli map`). */
  undocumentedExports: number;
  mapFingerprints: boolean;
  testFiles: number;
  sourceFiles: number;
  coverageGaps: number;
  runners: string[];
  secretFindings: number;
  auditRan: boolean;
};

export type BrownfieldPatternsOptions = { add?: string[]; top?: number };

export type BrownfieldPatternsResult = {
  file: string;
  added: string[];
  top: { pattern: string; count: number }[];
};

export type PromoteRunOptions = {
  /** Explicit human gate. Default promote stays ingest-class untrusted. */
  trust?: boolean;
};

export type PromoteRunResult = {
  runId: string;
  pages: string[];
  trust: "untrusted" | "reviewed";
};

export type QaOptions = {
  mode?: "full" | "no-browser";
  allowDegraded?: boolean;
  /** Test seam: skip the in-process runner and persist this score. */
  score?: QAScore;
};

export type ShipPreview = {
  staged: string[];
  added: string[];
  stagedDisplay: string;
  diff: string;
  unrelatedUnchanged: boolean;
  unrelated: string[];
  productFingerprint: string;
  qaCoverage: {
    missing: string[];
    failed: string[];
    skipped: string[];
  };
};

export type ShipOptions = {
  allowDegradedQa?: boolean;
  commit?: boolean;
  pr?: boolean;
  actor?: string;
  confirm?: (preview: ShipPreview) => Promise<boolean>;
  /** Where the confirm answer came from; recorded in the ship audit event. */
  confirmSource?: "tty" | "piped";
  /** Capture a durable immutable delivery and export it after successful delivery. */
  bundleDirectory?: string;
  /** Test seam for `gh pr create`. */
  prCreate?: (input: { cwd: string; title: string; body: string }) => { url?: string; error?: string };
};

export type ShipBundleStatus =
  | { status: "exported"; path: string; manifestSha256: string; snapshotDigest: string; warning?: string }
  | { status: "failed"; path: string; reason: string; recoveryHint: string };

export type ShipDeliverySnapshotStatus = { status: "pending"; error: string; recoveryHint: string };


export type ShipExportResult = {
  snapshotId: string;
  directory: string;
  manifestSha256: string;
  /** SHA-256 of the exact exported `predicate.json` bytes. */
  predicateSha256: string;
  snapshotDigest: string;
};

export type GovernedActionApprovalOptions = {
  runId: string;
  actionId: string;
  valueDigest: string;
  sinkId: string;
  operatorId: string;
  reason: string;
};
export type PendingGovernedAction = {
  runId: string;
  actionId: string;
  actionKind: "provider" | "write" | "http-mcp";
  valueDigest: string;
  sinkId: string;
  requestDigest: string;
  confidentiality: "public" | "workspace" | "sealed";
  integrity: "approved" | "untrusted";
  target: string;
};

export type GovernedActionApprovalResult = ActionApproval;

export type ExecuteOptions = {
  /** Resume a compatible interrupted engine-owned HTTP run. */
  resume?: string;
  untilBlocked?: boolean;
  fix?: boolean;
  adapter?: AdapterId;
  /** Parallel workers for automatic --until-blocked execution (1-4). */
  jobs?: number;
  /** Named adapter profile; mutually exclusive with adapter. */
  profile?: string;
  allowNoSandbox?: boolean;
  onProgress?: (progress: ExecuteProgress) => void;
};

export type ExecuteProgress = {
  taskId: string;
  stage: "starting" | "running" | "agent-complete" | "integrating" | "verifying" | "done" | "blocked";
  elapsedMs: number;
  logPath?: string;
};

export type TicketSource = {
  id: string;
  label: "running task" | "verified task" | "parent";
  filesAllowed: readonly string[];
  verificationCommands: readonly string[];
};

/** A ticket filed from agent output, with what it will run and where the commands came from (F-039). */
export type FiledTicketSummary = {
  id: string;
  verificationCommands: string[];
  filesAllowed: string[];
  /** "parent" | "running task" | "verified task" | "engine default (pnpm test)". */
  verificationSource: string;
};

export type ExecuteTaskResult = {
  taskId: string;
  status: "done" | "blocked";
  runId: string;
  extrasReverted: string[];
  incident: boolean;
  headMoved: boolean;
  ticketId?: string;
  /** Every ticket filed from this task's agent output, with the commands each will run. */
  filedTickets?: FiledTicketSummary[];
  verificationPass?: boolean;
  /** Why the task was blocked by verification, e.g. "verification command did not start: …". */
  reason?: string;
  /** Named KD-4 posture; printed on the verification PASS/blocked line. */
  trustTierNote?: string;
  adapterId?: AdapterId;
  resolutionSource?: AdapterResolutionSource;
  profile?: string;
  usage?: AgentUsage;
  limitReason?: string;
  /** Set when the agent exited non-zero; shown as a warning (verification commands remain the evidence). */
  agentExitWarning?: string;
  /** Set when the tree was dirty inside the task filesAllowed at start (F-007 residual). */
  dirtyWarning?: string;
};

export type ExecuteResult = {
  taskId: string;
  phase: Phase;
  status: "done" | "blocked";
  tasks: ExecuteTaskResult[];
  warnings: string[];
};

export type VerifyResult = {
  taskId?: string;
  spawned: boolean;
  notesPath?: string;
  createdTaskIds: string[];
  /** The commands each created ticket will run (inherited, never agent-authored). */
  createdTickets: FiledTicketSummary[];
  extrasReverted: string[];
  /** One line per skipped or non-zero agent run; verify is optional, so these warn instead of failing. */
  warnings: string[];
};

export type ReviewResult = {
  verdict: ReviewVerdict;
  createdTaskIds: string[];
  createdTickets: FiledTicketSummary[];
  extrasReverted: string[];
  rewrittenExistingTaskIds: string[];
  explicitVerdict?: ReviewVerdict;
  evidencePath?: string;
  evidenceFingerprint?: string;
  /** Captured from this run's review report before spawn cleanup. */
  evidenceBody?: string;
  /** Non-zero agent exit on a review that still ended FAIL (filed tasks). */
  warnings: string[];
};

export type ShipReceipt = {
  specId: string;
  shippedAt: string;
  phase: "shipped";
  qaMode: "full" | "no-browser" | null;
  qaScore: number | null;
  qaPass: boolean;
  allowDegradedQa: boolean;
  staged: string[];
  committed: boolean;
  commitSha?: string;
  prUrl?: string;
  receiptPath: string;
  snapshotId?: string;
  deliverySnapshot?: ShipDeliverySnapshotStatus;
  bundle?: ShipBundleStatus;
};

export type IngestSource = string;

export type IngestOpts = {
  noCommit?: boolean;
  transcript?: string;
  diff?: string;
  distill?: boolean;
};

export type IngestResult = IngestReceipt & {
  distillSkipped?: string;
  distillRan?: boolean;
};

export type NewTicket = {
  title: string;
  parentId?: string;
  fromAgent?: boolean;
  type?: "feature" | "fix" | "bug";
  priority?: Priority;
  notes?: string;
  contract?: Partial<FileContract>;
  adapter?: AdapterId;
  profile?: string;
  /**
   * Engine-supplied source for an agent-filed ticket (the running or verified task). Takes
   * precedence over an agent-chosen parentId for the inherited commands and the filesAllowed cap.
   */
  inheritFrom?: TicketSource;
  /**
   * Set by the engine for agent spawns with no engine-supplied source (review, verify without a
   * task): the agent's own parentId and filesAllowed are ignored (default commands, notes/<id>.md).
   */
  agentSourceless?: boolean;
};

export type NewPacket = {
  title: string;
  request?: string;
  requester?: "pm" | "designer" | "human";
};

export type PacketRespondInput = {
  id: string;
  message?: string;
  title?: string;
  type?: "feature" | "fix" | "bug";
  priority?: Priority;
};

export type PacketResult = {
  packet: Packet;
  path: string;
  tickets: Task[];
};

export type AmendTaskOptions = {
  allowDeps?: boolean;
  blockedBy?: string[];
  blocks?: string[];
  adapter?: AdapterId;
  profile?: string;
  /** Mutually exclusive with `adapter`. */
  clearAdapter?: boolean;
  clearProfile?: boolean;
};

export type CompactedTask = {
  id: string;
  title: string;
};

export type SkippedCompactTask = {
  id: string;
  title: string;
  reason: string;
};

export type CompactResult = {
  compacted: CompactedTask[];
  skipped: SkippedCompactTask[];
};

export type CompactOptions = {
  timeoutMs?: number;
};

export type WireframeOptions = {
  restyle?: boolean;
  spawn?: boolean;
  adapter?: AdapterId;
  profile?: string;
};

export type WireframeResult = {
  specId: string;
  status: "draft" | "frozen";
  index: string;
  pages: string[];
  restyled: boolean;
};

export type {
  Assumption,
  FileContract,
  GardenReport,
  IngestReceipt,
  Packet,
  Phase,
  Priority,
  QAScore,
  Readiness,
  ReviewVerdict,
  SearchHit,
  SessionBrief,
  Spec,
  Task,
};
