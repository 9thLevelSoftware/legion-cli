import {
  ADAPTER_IDS,
  EXTRA_ADAPTER_IDS,
  type AdapterId,
  type ExtraAdapterId,
  type SkillId,
} from "@9thlevelsoftware/legion-cli-schema";

export type { ExtraAdapterId, SkillId };

export type AgentAdapterId = AdapterId;
export type SpawnableAdapterId = AgentAdapterId;

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
  spawn(job: AgentJob): Promise<AgentHandle>;
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
  skillId: SkillId;
  promptPath: string;
  pointerPrompt: string;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  /** Fixture paths the fake adapter writes. Real adapters ignore this. */
  expectedArtifacts?: Array<string | FakeArtifact>;
}

export interface AgentHandle {
  pid: number;
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
}

export type GenericAdapterConfig = {
  binary: string;
  args: string[];
};

/** Override assumed PATH name and fill generic-style argv (vendor flags unverified). */
export type ExtraAdapterConfig = {
  binary?: string;
  args?: string[];
};

export type AdapterCreateOptions = {
  extraArgs?: string[];
  generic?: GenericAdapterConfig;
  grok?: ExtraAdapterConfig;
  openai?: ExtraAdapterConfig;
  codex?: ExtraAdapterConfig;
  mimo?: ExtraAdapterConfig;
  minimax?: ExtraAdapterConfig;
  artifacts?: FakeArtifact[];
  throwAfterWrite?: boolean;
  timedOut?: boolean;
};
