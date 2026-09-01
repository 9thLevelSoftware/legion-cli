import type { FakeArtifact } from "@9thlevelsoftware/legion-cli-agents";
import type { SearchHit } from "@9thlevelsoftware/legion-cli-wiki";
import type {
  AdapterId,
  ControlMode,
  DiscussDecision,
  IngestReceipt,
  IntentAnswersFile,
  IntentMapped,
  Phase,
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

export type QaOptions = {
  mode?: "full" | "no-browser";
  allowDegraded?: boolean;
  /** Injected until @9thlevelsoftware/legion-cli-qa exists. */
  score: QAScore;
};

export type ShipOptions = {
  allowDegradedQa?: boolean;
};

export type ExecuteResult = {
  taskId: string;
  phase: Phase;
};

export type ReviewResult = {
  verdict: ReviewVerdict;
  createdTaskIds: string[];
};

export type ShipReceipt = {
  specId: string;
  shippedAt: string;
  phase: "shipped";
};

export type IngestSource = string;

export type IngestOpts = {
  noCommit?: boolean;
  transcript?: string;
  diff?: string;
};

export type { IngestReceipt, Phase, QAScore, Readiness, ReviewVerdict, SearchHit, SessionBrief, Spec, Task };
