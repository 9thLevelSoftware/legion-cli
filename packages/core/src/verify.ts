import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertNoLinkInPath } from "@9thlevelsoftware/legion-cli-persist";
import { parseCommandLine, runCommand, splitCommand } from "@9thlevelsoftware/legion-cli-agents";
import {
  prepareVerificationWrapper,
  resolveVerificationTrustTier,
  SandboxError,
  type VerificationTrustPosture,
  type VerificationWrapper,
} from "@9thlevelsoftware/legion-cli-sandbox";
import { ProvenanceLabelSchema, SandboxConfigSchema, type ProvenanceLabel, type SandboxConfig, type WorkflowCommandEvidence } from "@9thlevelsoftware/legion-cli-schema";

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

/** Persisted with the run as workflow integration evidence (`WorkflowCommandEvidenceSchema`). */
export type VerificationOutputProvenance = NonNullable<WorkflowCommandEvidence["informationFlow"]>;

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
  /** Finite label metadata only; raw stdout/stderr remain in protected local storage. */
  informationFlow?: VerificationOutputProvenance;
};

export type VerificationInformationFlow = {
  label: ProvenanceLabel;
  installedEnginePaths: readonly string[];
  readOnlyEnginePaths: readonly string[];
};

export type VerificationOpts = {
  timeoutMs?: number;
  /** Log directory name; information-flow mode uses a protected hash-namespaced raw-log path. */
  runId?: string;
  /** Configured `adapter.*.apiKeyEnv` names, scrubbed on top of the KD-4 pattern. */
  secretEnvNames?: readonly string[];
  sandbox?: SandboxConfig;
  /** Accepted and ignored in legacy mode; information-flow mode never bypasses sandboxing. */
  allowNoSandbox?: boolean;
  platform?: NodeJS.Platform;
  dockerAvailable?: boolean;
  bwrapAvailable?: boolean;
  seatbeltAvailable?: boolean;
  /** Test seam for legacy verification only; information-flow mode requires a real wrapper. */
  wrapper?: VerificationWrapper;
  informationFlow?: VerificationInformationFlow;
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
async function prepareInformationFlowLogs(cwd: string, runId: string): Promise<string> {
  const runHash = createHash("sha256").update(runId, "utf8").digest("hex");
  const relativePath = `.legion-cli/audit/raw-logs/${runHash}`;
  const parts = [".legion-cli", ".legion-cli/audit", ".legion-cli/audit/raw-logs", relativePath];
  for (const part of parts) {
    const path = join(cwd, ...part.split("/"));
    await assertNoLinkInPath(path, { root: cwd, message: "protected verification log path contains a link" });
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertNoLinkInPath(path, { root: cwd, message: "protected verification log path contains a link" });
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SandboxError("protected verification log path is unsafe");
  }
  return relativePath;
}

function outputProvenance(label: ProvenanceLabel): VerificationOutputProvenance {
  const canonical = {
    origins: [...label.origins].sort(),
    integrity: label.integrity,
    confidentiality: label.confidentiality,
  };
  return {
    confidentiality: canonical.confidentiality,
    integrity: canonical.integrity,
    origins: canonical.origins,
    joinDigest: createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex"),
  };
}

export async function runVerificationCommands(
  cwd: string,
  commands: readonly string[],
  opts?: VerificationOpts,
): Promise<VerificationRun[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  const runId = opts?.runId || `verify-${Date.now()}`;
  const informationFlow = opts?.informationFlow;
  resetVerificationWork();
  const sandbox = opts?.sandbox ?? DEFAULT_VERIFY_SANDBOX;
  const posture = resolveVerificationTrustTier(sandbox, {
    allowNoSandbox: informationFlow ? undefined : opts?.allowNoSandbox,
    platform: opts?.platform,
    dockerAvailable: opts?.dockerAvailable,
    bwrapAvailable: opts?.bwrapAvailable,
    seatbeltAvailable: opts?.seatbeltAvailable,
  });
  const provenance = informationFlow ? outputProvenance(ProvenanceLabelSchema.parse(informationFlow.label)) : undefined;
  const runs: VerificationRun[] = [];
  const refuse = (error: string, trustPosture = posture): VerificationRun[] => {
    const command = commands[0] ?? "";
    runs.push(attachPosture({
      command,
      ok: false,
      started: false,
      status: null,
      error,
      ...(provenance ? { informationFlow: provenance } : {}),
    }, trustPosture));
    return runs;
  };
  if (informationFlow && (posture.backend === "host" || posture.backend === "copy")) {
    return refuse("information-flow verification requires a hardened OS sandbox");
  }
  if (posture.error) return refuse(posture.error);

  let logDirectory: string | undefined;
  if (informationFlow) {
    try {
      logDirectory = await prepareInformationFlowLogs(cwd, runId);
    } catch {
      return refuse("protected verification log path is unavailable or unsafe");
    }
  }
  let wrapper: VerificationWrapper | undefined;
  try {
    wrapper = informationFlow
      ? await prepareVerificationWrapper(cwd, runId, posture, {
        informationFlow: { installedEnginePaths: informationFlow.installedEnginePaths, readOnlyEnginePaths: informationFlow.readOnlyEnginePaths },
      })
      : opts?.wrapper ?? (await prepareVerificationWrapper(cwd, runId, posture));
  } catch {
    return refuse("verification isolation wrapper could not protect engine paths");
  }
  if (informationFlow && (opts?.wrapper || !wrapper)) {
    return refuse(`verification wrapper unavailable for ${posture.tier}`);
  }
  if (!opts?.wrapper && posture.backend !== "host" && !wrapper) {
    return refuse(`verification wrapper unavailable for ${posture.tier}`);
  }

  for (const [index, command] of commands.entries()) {
    const parsed = parseCommandLine(command);
    if ("error" in parsed) {
      runs.push(attachPosture({
        command,
        ok: false,
        started: false,
        status: null,
        error: informationFlow ? "verification command is invalid" : parsed.error,
        ...(provenance ? { informationFlow: provenance } : {}),
      }, posture));
      break;
    }
    const logStore = informationFlow
      ? `${logDirectory}/verify-${index + 1}.log`
      : `.legion-cli/cache/runs/${runId}/verify-${index + 1}.log`;
    let argv = parsed.argv;
    if (wrapper) {
      try {
        const invoke = wrapper.translateInvoke ? wrapper.translateInvoke(argv[0] ?? "") : (argv[0] ?? "");
        argv = [wrapper.bin, ...wrapper.argvPrefix, invoke, ...argv.slice(1)];
      } catch (err) {
        if (err instanceof SandboxError) {
          runs.push(attachPosture({
            command, ok: false, started: false, status: null,
            error: informationFlow ? "verification command could not be isolated" : err.message,
            ...(provenance ? { informationFlow: provenance } : {}),
          }, posture));
          break;
        }
        throw err;
      }
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
        ...(result.error ? { error: informationFlow ? "verification command could not start" : result.error } : {}),
        ...(provenance ? { informationFlow: provenance } : {}),
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
