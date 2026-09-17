import { spawnSync } from "node:child_process";
import { filterSpawnEnv } from "@9thlevelsoftware/legion-cli-agents";

/** Minutes, not hours — hung verify must not hold the lock for process lifetime. */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;

export type VerificationRun = {
  command: string;
  ok: boolean;
  status: number | null;
  timedOut?: boolean;
};

export function splitCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\"|[^"])*)"|'((?:\\'|[^'])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    out.push(raw.replaceAll('\\"', '"').replaceAll("\\'", "'"));
  }
  return out;
}

export type VerificationOpts = {
  timeoutMs?: number;
};

/** `cwd` = project, `shell: false`. Missing executable is an engine bug. */
export function runVerificationCommands(
  cwd: string,
  commands: readonly string[],
  opts?: VerificationOpts,
): VerificationRun[] {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  const runs: VerificationRun[] = [];
  for (const command of commands) {
    const argv = splitCommand(command);
    if (argv.length === 0) {
      throw new Error("verificationCommands entry is empty (engine bug)");
    }
    const env = filterSpawnEnv(process.env);
    // Nested `node --test` inherits this and exits 0 without running the file.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`verificationCommands executable missing: ${argv[0]} (engine bug)`);
      }
      if (code === "ETIMEDOUT") {
        runs.push({ command, ok: false, status: result.status, timedOut: true });
        break;
      }
      throw result.error;
    }
    const timedOut = result.signal === "SIGKILL" && result.status === null;
    const run: VerificationRun = {
      command,
      ok: result.status === 0 && !timedOut,
      status: result.status,
      ...(timedOut ? { timedOut: true } : {}),
    };
    runs.push(run);
    if (!run.ok) break;
  }
  return runs;
}
