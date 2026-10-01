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

export type HttpAgentJob = {
  runId: string;
  skillId: string;
  promptPath: string;
  pointerPrompt: string;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  httpHost?: HttpToolHost;
  /** Engine-owned project root for durable checkpoints; never the disposable jail root. */
  checkpointRoot?: string;
  /** Resume only when all engine-owned identities still match the checkpoint. */
  resume?: boolean;
  sourceIdentity?: string;
  contractIdentity?: string;
  /** Secret-free identity of external transports used by the governed tool surface. */
  externalConfigIdentity?: string;
  jailIdentity?: string;
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
};

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
};

export type HttpAgentHandle = {
  pid: number | null;
  wait(): Promise<HttpAgentResult>;
  abort(): Promise<void>;
};

/** Single-address lookup so the client never happy-eyeballs to a second IP. */
export type SsrfLookup = (hostname: string) => Promise<{ address: string; family: number }>;
