import type { ApprovedHttpAssuranceContext, GovernedEffectHost, HttpToolHost } from "@9thlevelsoftware/legion-cli-http";
import type { AgentProfileConfig, AgentUsage } from "./profiles.js";
import {
  ADAPTER_IDS,
  EXTRA_ADAPTER_IDS,
  type AdapterId,
  type AdapterResolutionSource,
  type AcpAdapterConfig,
  type ExtraAdapterId,
  type HttpAdapterConfig,
  type SkillId,
} from "@9thlevelsoftware/legion-cli-schema";

export type { AdapterResolutionSource, ExtraAdapterId, SkillId };

export type AgentAdapterId = AdapterId;
export type SpawnableAdapterId = AgentAdapterId;

export type AdapterResolution = {
  id: AgentAdapterId;
  source: AdapterResolutionSource;
  profile?: string;
  profileConfig?: AgentProfileConfig;
};

export const DETECT_ADAPTER_IDS = ADAPTER_IDS;
export const SPAWNABLE_ADAPTER_IDS = ADAPTER_IDS;
export { EXTRA_ADAPTER_IDS };
export const DETECT_ONLY_ADAPTER_IDS = [] as const satisfies readonly AgentAdapterId[];

export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
export const ABORT_GRACE_MS = 5_000;
export const POINTER_PROMPT_MAX_CHARS = 2000;
export const FAKE_ADAPTER_ENV = "LEGION_CLI_ADAPTER";

export type DetectResult = {
  ok: boolean;
  version?: string;
  reason?: string;
};

export interface AgentAdapter {
  id: AgentAdapterId;
  binary: string;
  detect(): Promise<DetectResult>;
  spawn(job: AgentExecutionJob): Promise<AgentHandle>;
}

export type FakeArtifact = {
  path: string;
  content?: string;
  /** Fixture-only: `git add` + `git commit` this path after write. */
  gitAdd?: boolean;
  /** Fixture-only: `git mv path gitMv` then commit (rename extras vs preSpawnRef). */
  gitMv?: string;
};

export interface AgentJob {
  runId: string;
  skillId: SkillId | `extension:${string}`;
  promptPath: string;
  pointerPrompt: string;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  /** Hardened sandbox wrapper (bwrap/seatbelt). Copy jail omits this. */
  wrapper?: { bin: string; argvPrefix: string[] };
  /** Engine-owned jail FS for the in-process HTTP tool-loop. Spawn CLIs ignore this. */
  httpHost?: HttpToolHost;
  /** Resume a compatible engine-owned HTTP checkpoint. Spawn CLIs ignore this. */
  resume?: boolean;
  sourceIdentity?: string;
  contractIdentity?: string;
  externalConfigIdentity?: string;
  jailIdentity?: string;
  checkpointRoot?: string;
  /** Selected named profile and engine-enforced request/tool budgets. */
  profile?: string;
  outputLimit?: number;
  maxRequests?: number;
  maxToolRounds?: number;
  maxReportedTokens?: number;
  maxEstimatedCostUsd?: number;
  pricing?: {
    inputPerMillionUsd?: number;
    outputPerMillionUsd?: number;
    requestUsd?: number;
  };
  /** Fixture paths the fake adapter writes. Real adapters ignore this. */
  expectedArtifacts?: Array<string | FakeArtifact>;
}
export type GovernedAgentJob = Omit<AgentJob, "promptPath" | "pointerPrompt" | "httpHost"> & {
  assuranceContext: ApprovedHttpAssuranceContext;
  effectHost: GovernedEffectHost;
  promptPath?: never;
  pointerPrompt?: never;
  httpHost?: never;
};
export type AgentExecutionJob = AgentJob | GovernedAgentJob;
export function isGovernedAgentJob(job: AgentExecutionJob): job is GovernedAgentJob {
  return "assuranceContext" in job || "effectHost" in job;
}

export interface AgentHandle {
  pid: number | null;
  wait(): Promise<AgentResult>;
  abort(): Promise<void>;
}

export interface AgentResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stdoutPath: string;
  stderrPath: string;
  summaryPath?: string;
  checkpointPath?: string;
  usage?: AgentUsage;
  recovery?: "resume" | "manual" | "none";
  /** Spawn failure message (for example ENOENT) when the process never ran. */
  errorMessage?: string;
}

export type GenericAdapterConfig = {
  binary: string;
  args: string[];
};

/** Override assumed PATH name. Args must keep the KD-7 vendor prefix and `{{pointer}}`. */
export type ExtraAdapterConfig = {
  binary?: string;
  args?: string[];
};

export type FakeHoldWait = {
  readyPath: string;
  releasePath: string;
  timeoutMs?: number;
};

export type AdapterCreateOptions = {
  extraArgs?: string[];
  generic?: GenericAdapterConfig;
  grok?: ExtraAdapterConfig;
  openai?: ExtraAdapterConfig;
  codex?: ExtraAdapterConfig;
  mimo?: ExtraAdapterConfig;
  minimax?: ExtraAdapterConfig;
  http?: HttpAdapterConfig;
  acp?: AcpAdapterConfig;
  artifacts?: FakeArtifact[];
  throwAfterWrite?: boolean;
  timedOut?: boolean;
  /** Fake only: exit code the fake agent reports (default 0). */
  exitCode?: number;
  /** Fake only: skip writing summary.md (an agent that produced nothing). */
  omitSummary?: boolean;
  holdWait?: FakeHoldWait;
  onWait?: () => Promise<void>;
  /** Fixture: AgentHandle.pid (default process.pid). Use an exited child to prove post-wait recovery. */
  handlePid?: number;
};
