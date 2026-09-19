import type { FakeArtifact, FakeHoldWait } from "@9thlevelsoftware/legion-cli-agents";
import type { MapOptions, MapResult } from "./map.js";
import type { GardenReport, SearchHit } from "@9thlevelsoftware/legion-cli-wiki";
import type {
  AdapterId,
  AdapterResolutionSource,
  Assumption,
  BrownfieldDagNode,
  BrownfieldRoster,
  BrownfieldRun,
  BrownfieldRunPhase,
  BrownfieldSize,
  ControlMode,
  DiscussDecision,
  FileContract,
  IngestReceipt,
  IntentAnswersFile,
  IntentMapped,
  Packet,
  Phase,
  Priority,
  QAScore,
  Readiness,
  ReviewVerdict,
  SessionBrief,
  Spec,
  Task,
} from "@9thlevelsoftware/legion-cli-schema";

export type Actor = {
  id: string;
};

export type LegionEngineOptions = {
  skillsDir?: string;
  fakeArtifacts?: FakeArtifact[];
  fakeThrowAfterWrite?: boolean;
  fakeTimedOut?: boolean;
  fakeHoldWait?: FakeHoldWait;
  fakeOnWait?: () => Promise<void>;
  fakeHandlePid?: number;
  /** Test-only, like the other fake* seams: verification throws this message. */
  fakeVerificationError?: string;
  verificationTimeoutMs?: number;
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
  mode?: "greenfield" | "brownfield";
  controlMode?: ControlMode | "autonomous" | string;
};

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
};

export type ShipOptions = {
  allowDegradedQa?: boolean;
  commit?: boolean;
  pr?: boolean;
  actor?: string;
  confirm?: (preview: ShipPreview) => Promise<boolean>;
  /** Test seam for `gh pr create`. */
  prCreate?: (input: { cwd: string; title: string; body: string }) => { url?: string; error?: string };
};

export type ExecuteOptions = {
  untilBlocked?: boolean;
  fix?: boolean;
  adapter?: AdapterId;
  allowNoSandbox?: boolean;
};

export type ExecuteTaskResult = {
  taskId: string;
  status: "done" | "blocked";
  runId: string;
  extrasReverted: string[];
  incident: boolean;
  headMoved: boolean;
  ticketId?: string;
  verificationPass?: boolean;
  /** Why the task was blocked by verification, e.g. "verification command did not start: …". */
  reason?: string;
  adapterId?: AdapterId;
  resolutionSource?: AdapterResolutionSource;
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
  extrasReverted: string[];
};

export type ReviewResult = {
  verdict: ReviewVerdict;
  createdTaskIds: string[];
  extrasReverted: string[];
  rewrittenExistingTaskIds: string[];
  /** The reviewer changed protected files; they were quarantined and restored (FAIL). */
  incident?: boolean;
  /** Protected paths the reviewer changed (restored), when `incident`. */
  protectedChanged?: string[];
  /** Out-of-project quarantine folder for this run, when anything was quarantined. */
  quarantineDir?: string;
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
  /** Mutually exclusive with `adapter`. */
  clearAdapter?: boolean;
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
