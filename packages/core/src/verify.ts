import { join } from "node:path";
import { parseCommandLine, runCommand, splitCommand } from "@9thlevelsoftware/legion-cli-agents";

export { splitCommand };

/** Minutes, not hours — hung verify must not hold the lock for process lifetime. */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;

export type VerificationRun = {
  command: string;
  /** started && exit 0 && !timedOut */
  ok: boolean;
  started: boolean;
  status: number | null;
  timedOut?: boolean;
  error?: string;
  /** Project-relative POSIX path of the combined stdout/stderr log. */
  logPath?: string;
};

export type VerificationOpts = {
  timeoutMs?: number;
  /** Log directory name under `.legion-cli/cache/runs/`; defaults to `verify-<timestamp>`. */
  runId?: string;
  /** Configured `adapter.*.apiKeyEnv` names, scrubbed on top of the KD-4 pattern. */
  secretEnvNames?: readonly string[];
};

/**
 * Run each `verificationCommands` entry (argv-only, no shell) from the project root with the
 * credential-scrubbed environment, stopping at the first failure. Never throws for a command
 * that cannot start: that is a failed run with `started: false` (KD-4).
 */
export async function runVerificationCommands(
  cwd: string,
  commands: readonly string[],
  opts?: VerificationOpts,
): Promise<VerificationRun[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  const runId = opts?.runId || `verify-${Date.now()}`;
  const runs: VerificationRun[] = [];
  for (const [index, command] of commands.entries()) {
    const parsed = parseCommandLine(command);
    if ("error" in parsed) {
      runs.push({ command, ok: false, started: false, status: null, error: parsed.error });
      break;
    }
    const logStore = `.legion-cli/cache/runs/${runId}/verify-${index + 1}.log`;
    const result = await runCommand(parsed.argv, {
      cwd,
      timeoutMs,
      logPath: join(cwd, ...logStore.split("/")),
      secretEnvNames: opts?.secretEnvNames,
    });
    const run: VerificationRun = {
      command,
      ok: result.started && result.exitCode === 0 && !result.timedOut,
      started: result.started,
      status: result.exitCode,
      logPath: logStore,
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    runs.push(run);
    if (!run.ok) break;
  }
  return runs;
}

/** One line for the user: why verification did not pass, or undefined when it did. */
export function verificationFailureReason(runs: readonly VerificationRun[]): string | undefined {
  if (runs.length === 0) return "no verificationCommands ran";
  const failed = runs.find((run) => !run.ok);
  if (!failed) return undefined;
  if (!failed.started) return `verification command did not start: ${failed.command}: ${failed.error ?? "unknown error"}`;
  if (failed.timedOut) return `verification command timed out: ${failed.command}`;
  const where = failed.logPath ? ` (log: ${failed.logPath})` : "";
  return `verification command failed with exit ${failed.status ?? "?"}: ${failed.command}${where}`;
}
