import type { SkillId } from "@9thlevelsoftware/legion-cli-schema";

export type { SkillId };

/** Includes detect-only ids. Config `adapter.default` is only fake | generic | claude. */
export type AgentAdapterId = "fake" | "generic" | "claude" | "grok" | "codex";

export type SpawnableAdapterId = "fake" | "generic" | "claude";

export const DETECT_ADAPTER_IDS = ["fake", "generic", "claude", "grok", "codex"] as const;
export const SPAWNABLE_ADAPTER_IDS = ["fake", "generic", "claude"] as const;
export const DETECT_ONLY_ADAPTER_IDS = ["grok", "codex"] as const;

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

export type AdapterCreateOptions = {
  extraArgs?: string[];
  generic?: GenericAdapterConfig;
  artifacts?: FakeArtifact[];
  throwAfterWrite?: boolean;
};
