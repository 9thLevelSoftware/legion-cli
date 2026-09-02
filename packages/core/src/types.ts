import type { FakeArtifact } from "@9thlevelsoftware/legion-cli-agents";
import type { GardenReport, SearchHit } from "@9thlevelsoftware/legion-cli-wiki";
import type {
  AdapterId,
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
  mode?: "greenfield" | "brownfield";
  controlMode?: ControlMode | "autonomous" | string;
};

export type BrownfieldOptions = {
  effort?: number;
  execute?: boolean;
  resume?: string;
  context?: string;
  runId?: string;
};

export type BrownfieldResult = {
  runId: string;
  effort: 1;
  execute: boolean;
  phase: "analysis" | "execute" | "complete";
  pages: string[];
  worktreePath: string | null;
  promoted: boolean;
  resumePath: string;
};

export type PromoteRunResult = {
  runId: string;
  pages: string[];
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
};

export type NewTicket = {
  title: string;
  parentId?: string;
  fromAgent?: boolean;
  type?: "feature" | "fix" | "bug";
  priority?: Priority;
  notes?: string;
  contract?: Partial<FileContract>;
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

export type {
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
