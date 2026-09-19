import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { cmdScriptLaunch, unwrapCmdShim } from "@9thlevelsoftware/legion-cli-agents";

// One resolver (F-021): PATH/PATHEXT lookup and the tool runner live in agents.
export { isSpawnableBinary, listOnPath, runTool, whichAll } from "@9thlevelsoftware/legion-cli-agents";

function killProcessTree(pid: number): void {
  if (pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      encoding: "utf8",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }
}

function boundedSpawnArgv(
  file: string,
  args: string[],
): { command: string; argv: string[]; verbatim: boolean } | { error: string } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    const unwrapped = unwrapCmdShim(file);
    if (unwrapped) {
      return { command: unwrapped.command, argv: [...unwrapped.prefixArgs, ...args], verbatim: false };
    }
    // The shared cmd.exe launch (F-096): /d /v:off, quoted script, outer quotes for /s.
    const launch = cmdScriptLaunch(file, args);
    if ("error" in launch) return launch;
    return { command: launch.command, argv: launch.args, verbatim: true };
  }
  return { command: file, argv: args, verbatim: false };
}

export const RUN_BOUNDED_MAX_BUFFER = 1024 * 1024;

export type BoundedRun = {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

/** Hard timeout + 1 MiB maxBuffer with tree-kill. spawnSync timeout cannot kill Windows cmd grandchildren. */
export async function runBounded(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<BoundedRun> {
  const planned = boundedSpawnArgv(file, args);
  if ("error" in planned) {
    return { status: 1, stdout: "", stderr: planned.error, timedOut: false, truncated: false };
  }
  const { command, argv, verbatim } = planned;
  const child = spawn(command, argv, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
    detached: process.platform !== "win32",
    windowsVerbatimArguments: verbatim,
  });

  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let truncated = false;
  let settled = false;

  return await new Promise((resolve) => {
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      resolve({ status: code, stdout, stderr, timedOut, truncated });
    };

    const abort = (reason: "timeout" | "truncated"): void => {
      if (reason === "timeout") timedOut = true;
      else truncated = true;
      if (child.pid) killProcessTree(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(1);
    };

    const onChunk = (kind: "stdout" | "stderr", chunk: string): void => {
      if (settled) return;
      const n = Buffer.byteLength(chunk);
      if (kind === "stdout") {
        if (stdoutBytes + n > RUN_BOUNDED_MAX_BUFFER) {
          abort("truncated");
          return;
        }
        stdoutBytes += n;
        stdout += chunk;
        return;
      }
      if (stderrBytes + n > RUN_BOUNDED_MAX_BUFFER) {
        abort("truncated");
        return;
      }
      stderrBytes += n;
      stderr += chunk;
    };

    const onStdout = (chunk: string): void => onChunk("stdout", chunk);
    const onStderr = (chunk: string): void => onChunk("stderr", chunk);
    const timer = setTimeout(() => abort("timeout"), timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
  });
}

/**
 * True when a PATH shim text (npm/pnpm `.cmd`/`.ps1`/sh shim) or a symlink target points at this
 * CLI's entry: `@9thlevelsoftware/legion-cli/dist/bin.js` or the workspace `packages/cli/dist/bin.js`.
 */
export function looksLikeLegionCliShim(text: string): boolean {
  return /legion-cli[\\/]dist[\\/]bin\.js/i.test(text) || /packages[\\/]cli[\\/]dist[\\/]bin\.js/i.test(text);
}

/**
 * Does the first `legion` on PATH run Legion CLI? Reads the shim or resolves the symlink; never
 * executes the binary. `null` when there is no `legion` on PATH or it can't be read.
 */
export function pathLegionIsLegionCli(paths: readonly string[]): boolean | null {
  const first = paths[0];
  if (!first) return null;
  try {
    const target = realpathSync(first);
    if (looksLikeLegionCliShim(target)) return true;
    const stat = statSync(target);
    if (!stat.isFile() || stat.size > 64 * 1024) return false;
    return looksLikeLegionCliShim(readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}
