import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unwrapCmdShim } from "@9thlevelsoftware/legion-cli-agents";

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const abs of paths) {
    const key = process.platform === "win32" ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

export function whichAll(name: string): string[] {
  if (process.platform === "win32") {
    const result = spawnSync("where.exe", [name], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    if (result.status !== 0) return [];
    return uniquePaths(
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }

  const which = spawnSync("which", ["-a", name], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (which.status === 0 && which.stdout.trim()) {
    return uniquePaths(
      which.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }

  const command = spawnSync("sh", ["-lc", 'command -v -- "$1"', "sh", name], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (command.status === 0 && command.stdout.trim()) {
    return [command.stdout.trim()];
  }
  return [];
}

export function listOnPath(names: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of names) {
    found.push(...whichAll(name));
  }
  return uniquePaths(found);
}

function quoteCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\t\r\n "]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}

type SpawnText = {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
};

function asText(result: ReturnType<typeof spawnSync>): SpawnText {
  return {
    error: result.error,
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function spawnDirect(command: string, args: string[], cwd: string | undefined): SpawnText {
  return asText(
    spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    }),
  );
}

function spawnCmdFile(command: string, args: string[], cwd: string | undefined): SpawnText {
  const line = [command, ...args].map(quoteCmdArg).join(" ");
  return asText(
    spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: true,
    }),
  );
}

export function runTool(
  name: string,
  args: string[],
  cwd?: string,
): { status: number; stdout: string; stderr: string } {
  if (process.platform !== "win32") {
    const result = spawnDirect(name, args, cwd);
    if (result.error) return { status: 1, stdout: "", stderr: "not found" };
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  const resolved = listOnPath([name, `${name}.cmd`, `${name}.exe`]);
  const candidates = [...resolved, name, `${name}.exe`, `${name}.cmd`];
  const seen = new Set<string>();
  for (const cmd of candidates) {
    const key = cmd.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const viaCmd = /\.(cmd|bat)$/i.test(cmd);
    const result = viaCmd ? spawnCmdFile(cmd, args, cwd) : spawnDirect(cmd, args, cwd);
    if (result.error) continue;
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
  return { status: 1, stdout: "", stderr: "not found" };
}

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
): { command: string; argv: string[]; verbatim: boolean } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    const unwrapped = unwrapCmdShim(file);
    if (unwrapped) {
      return { command: unwrapped.command, argv: [...unwrapped.prefixArgs, ...args], verbatim: false };
    }
    const line = [file, ...args].map(quoteCmdArg).join(" ");
    return {
      command: process.env.ComSpec || "cmd.exe",
      argv: ["/d", "/s", "/c", line],
      verbatim: true,
    };
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
  const { command, argv, verbatim } = boundedSpawnArgv(file, args);
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

export function isSpawnableBinary(binary: string): boolean {
  if (binary.includes("/") || binary.includes("\\") || /^[A-Za-z]:/.test(binary)) {
    return existsSync(binary);
  }
  const names = process.platform === "win32" ? [binary, `${binary}.cmd`, `${binary}.exe`] : [binary];
  return listOnPath(names).length > 0;
}
