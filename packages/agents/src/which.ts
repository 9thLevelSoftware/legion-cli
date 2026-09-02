import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
  return [];
}

export function listOnPath(names: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of names) found.push(...whichAll(name));
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

function spawnDirect(command: string, args: string[], cwd?: string): SpawnText {
  return asText(
    spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    }),
  );
}

function spawnCmdFile(command: string, args: string[], cwd?: string): SpawnText {
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
  if (!binary) return false;
  if (binary.includes("/") || binary.includes("\\") || /^[A-Za-z]:/.test(binary)) {
    return existsSync(binary);
  }
  const names = process.platform === "win32" ? [binary, `${binary}.cmd`, `${binary}.exe`] : [binary];
  return listOnPath(names).length > 0;
}

export function resolveBinary(binary: string): string | null {
  if (!binary) return null;
  if (binary.includes("/") || binary.includes("\\") || /^[A-Za-z]:/.test(binary)) {
    return existsSync(binary) ? binary : null;
  }
  const names = process.platform === "win32" ? [binary, `${binary}.cmd`, `${binary}.exe`] : [binary];
  return listOnPath(names)[0] ?? null;
}

export function versionOf(binary: string): string | undefined {
  const result = runTool(binary, ["--version"]);
  const line = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0] ?? "";
  return line || undefined;
}

export function quoteCmdArgForSpawn(arg: string): string {
  return quoteCmdArg(arg);
}

export type UnwrappedCmdShim = {
  command: string;
  prefixArgs: string[];
};

function expandShimVars(value: string, dp0: string): string {
  const trailing = /[\\/]$/.test(dp0) ? dp0 : `${dp0}\\`;
  let out = value.replaceAll("%~dp0", trailing).replaceAll("%dp0%", dp0);
  if (process.platform !== "win32") out = out.replaceAll("\\", "/");
  return out;
}

function isNodeBinaryToken(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return normalized === "%_prog%" || normalized === "node" || normalized.endsWith("/node") || normalized.endsWith("/node.exe") || normalized === "node.exe";
}

/**
 * npm/pnpm `.cmd` shims are not CreateProcess binaries. Unwrap to node.exe + the
 * JS entry so multiline argv (the pointer prompt) is not flattened through cmd.exe.
 */
export function unwrapCmdShim(cmdPath: string): UnwrappedCmdShim | null {
  let text: string;
  try {
    text = readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  const dp0 = dirname(resolve(cmdPath));
  const lines = text.split(/\r?\n/).map((line) => line.trim().replace(/^@+/, "")).filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    if (!/%\*/.test(line) && !/node(?:\.exe)?/i.test(line)) continue;
    const quoted = [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    if (quoted.length === 0) continue;

    let script: string | undefined;
    let nodeFromShim: string | undefined;
    for (const raw of quoted) {
      const expanded = resolve(expandShimVars(raw, dp0));
      if (isNodeBinaryToken(raw) || isNodeBinaryToken(expanded)) {
        if (!nodeFromShim) nodeFromShim = expanded;
        continue;
      }
      if (existsSync(expanded)) script = expanded;
    }
    if (!script) continue;

    const nodeBeside = resolve(dp0, "node.exe");
    const command =
      nodeFromShim && existsSync(nodeFromShim)
        ? nodeFromShim
        : existsSync(nodeBeside)
          ? nodeBeside
          : process.execPath;
    return { command, prefixArgs: [script] };
  }
  return null;
}
