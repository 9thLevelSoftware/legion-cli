export type HttpToolHost = {
  jailRoot: string;
  readFile(posix: string): Promise<string>;
  writeFile(posix: string, contents: string): Promise<void>;
  listDir(posix: string): Promise<string[]>;
  runCommand?(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
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
};

export type HttpAgentResult = {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stdoutPath: string;
  stderrPath: string;
  summaryPath?: string;
};

export type HttpAgentHandle = {
  pid: number | null;
  wait(): Promise<HttpAgentResult>;
  abort(): Promise<void>;
};

/** Single-address lookup so the client never happy-eyeballs to a second IP. */
export type SsrfLookup = (hostname: string) => Promise<{ address: string; family: number }>;
