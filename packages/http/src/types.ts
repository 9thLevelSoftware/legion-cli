import type { FailureCode } from "./governed-types.js";
import type { ApprovedHttpAssuranceContext, GovernedEffectHost, GovernedHttpJobFields } from "./governed-types.js";

export type HttpToolHost = {
  jailRoot: string;
  readFile(posix: string): Promise<string>;
  writeFile(posix: string, contents: string): Promise<void>;
  listDir(posix: string): Promise<string[]>;
  runCommand?(argv: string[], signal?: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  externalTools?: Array<{
    callName: string;
    namespacedName: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
  callExternalTool?(callName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
};

export type HttpAgentJobBase = {
  runId: string;
  skillId: string;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  checkpointRoot?: string;
  resume?: boolean;
  sourceIdentity?: string;
  contractIdentity?: string;
  externalConfigIdentity?: string;
  jailIdentity?: string;
  profile?: string;
  outputLimit?: number;
  maxRequests?: number;
  maxToolRounds?: number;
  maxReportedTokens?: number;
  maxEstimatedCostUsd?: number;
  pricing?: { inputPerMillionUsd?: number; outputPerMillionUsd?: number; requestUsd?: number };
};
export type LegacyHttpAgentJob = HttpAgentJobBase & {
  promptPath: string;
  pointerPrompt: string;
  httpHost?: HttpToolHost;
  assuranceContext?: never;
  effectHost?: never;
};
export type GovernedHttpAgentJob = HttpAgentJobBase & GovernedHttpJobFields & {
  assuranceContext: ApprovedHttpAssuranceContext;
  effectHost: GovernedEffectHost;
};
export type HttpAgentJob = LegacyHttpAgentJob | GovernedHttpAgentJob;


export type HttpAgentUsage = {
  requests: number;
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  profile?: string;
  estimatedCostUsd?: number;
  costEstimated?: boolean;
};

export type HttpAgentResult = {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stdoutPath: string;
  stderrPath: string;
  summaryPath?: string;
  checkpointPath?: string;
  usage?: HttpAgentUsage;
  recovery?: "resume" | "manual" | "none";
  governedBlock?: FailureCode;
};

export type HttpAgentHandle = {
  pid: number | null;
  wait(): Promise<HttpAgentResult>;
  abort(): Promise<void>;
};

/** Single-address lookup so the client never happy-eyeballs to a second IP. */
export type SsrfLookup = (hostname: string) => Promise<{ address: string; family: number }>;
