import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

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

export function isSpawnableBinary(binary: string): boolean {
  if (binary.includes("/") || binary.includes("\\") || /^[A-Za-z]:/.test(binary)) {
    return existsSync(binary);
  }
  const names = process.platform === "win32" ? [binary, `${binary}.cmd`, `${binary}.exe`] : [binary];
  return listOnPath(names).length > 0;
}
