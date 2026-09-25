import { join } from "node:path";
import { parseCommandLine, runCommand, splitCommand } from "@9thlevelsoftware/legion-cli-agents";
import {
  prepareVerificationWrapper,
  resolveVerificationTrustTier,
  type VerificationTrustPosture,
} from "@9thlevelsoftware/legion-cli-sandbox";
import { SandboxConfigSchema, type SandboxConfig } from "@9thlevelsoftware/legion-cli-schema";

export { splitCommand };
export { resolveVerificationTrustTier };
export type { VerificationTrustPosture };

/** Minutes, not hours — hung verify must not hold the lock for process lifetime. */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_VERIFY_SANDBOX: SandboxConfig = SandboxConfigSchema.parse({});

/** Copy jail is never the verify default; a mutation that copies the tree must bump these. */
export const verificationWork = { copyFiles: 0, copyBytes: 0 };

export function resetVerificationWork(): void {
  verificationWork.copyFiles = 0;
  verificationWork.copyBytes = 0;
}

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
  trustTier: string;
  trustTierNote: string;
};

export type VerificationOpts = {
  timeoutMs?: number;
  /** Log directory name under `.legion-cli/cache/runs/`; defaults to `verify-<timestamp>`. */
  runId?: string;
  /** Configured `adapter.*.apiKeyEnv` names, scrubbed on top of the KD-4 pattern. */
  secretEnvNames?: readonly string[];
  sandbox?: SandboxConfig;
  /** Accepted and ignored: no platform requires this flag to run verify. */
  allowNoSandbox?: boolean;
  platform?: NodeJS.Platform;
  dockerAvailable?: boolean;
  bwrapAvailable?: boolean;
  seatbeltAvailable?: boolean;
};

function attachPosture(
  run: Omit<VerificationRun, "trustTier" | "trustTierNote">,
  posture: VerificationTrustPosture,
): VerificationRun {
  return { ...run, trustTier: posture.tier, trustTierNote: posture.note };
}

/**
 * Run each `verificationCommands` entry (argv-only, no shell) from the project root with the
 * credential-scrubbed environment, stopping at the first failure. Never throws for a command
 * that cannot start: that is a failed run with `started: false` (KD-4).
 *
 * Linux: hardened bwrap. macOS: seatbelt. Windows without Docker: allowlist posture with a
 * named trust-tier note. Docker is opt-in. Copy jail is never used. No --allow-no-sandbox.
 */
export async function runVerificationCommands(
  cwd: string,
  commands: readonly string[],
  opts?: VerificationOpts,
): Promise<VerificationRun[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  const runId = opts?.runId || `verify-${Date.now()}`;
  resetVerificationWork();
  const sandbox = opts?.sandbox ?? DEFAULT_VERIFY_SANDBOX;
  const posture = resolveVerificationTrustTier(sandbox, {
    allowNoSandbox: opts?.allowNoSandbox,
    platform: opts?.platform,
    dockerAvailable: opts?.dockerAvailable,
    bwrapAvailable: opts?.bwrapAvailable,
    seatbeltAvailable: opts?.seatbeltAvailable,
  });
  const runs: VerificationRun[] = [];
  if (posture.error) {
    const command = commands[0] ?? "";
    runs.push(
      attachPosture(
        { command, ok: false, started: false, status: null, error: posture.error },
        posture,
      ),
    );
    return runs;
  }

  const wrapper = await prepareVerificationWrapper(cwd, runId, posture);
  if (posture.backend !== "host" && !wrapper) {
    const command = commands[0] ?? "";
    runs.push(
      attachPosture(
        {
          command,
          ok: false,
          started: false,
          status: null,
          error: `verification wrapper unavailable for ${posture.tier}`,
        },
        posture,
      ),
    );
    return runs;
  }

  for (const [index, command] of commands.entries()) {
    const parsed = parseCommandLine(command);
    if ("error" in parsed) {
      runs.push(
        attachPosture({ command, ok: false, started: false, status: null, error: parsed.error }, posture),
      );
      break;
    }
    const logStore = `.legion-cli/cache/runs/${runId}/verify-${index + 1}.log`;
    let argv = parsed.argv;
    if (wrapper) {
      const invoke = wrapper.translateInvoke ? wrapper.translateInvoke(argv[0] ?? "") : (argv[0] ?? "");
      argv = [wrapper.bin, ...wrapper.argvPrefix, invoke, ...argv.slice(1)];
    }
    const result = await runCommand(argv, {
      cwd,
      timeoutMs,
      logPath: join(cwd, ...logStore.split("/")),
      secretEnvNames: opts?.secretEnvNames,
    });
    const run = attachPosture(
      {
        command,
        ok: result.started && result.exitCode === 0 && !result.timedOut,
        started: result.started,
        status: result.exitCode,
        logPath: logStore,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
      posture,
    );
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
