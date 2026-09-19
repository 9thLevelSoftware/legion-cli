import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, win32 } from "node:path";

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

  // Minimal images ship without `which`; the shell builtin still answers.
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

/**
 * cmd.exe itself: an absolute `%ComSpec%`, else `%SystemRoot%\System32\cmd.exe`. Never a bare
 * `cmd.exe`, which the process search would look up in the child's cwd (the project) first.
 */
export function cmdExePath(): string {
  const comspec = process.env.ComSpec;
  if (comspec && win32.isAbsolute(comspec)) return comspec;
  return win32.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "cmd.exe");
}

/** cmd.exe acts on these even inside quotes (`%VAR%`, `^`), or splits the line on them. */
const CMD_UNSAFE = /[&|<>^%\r\n]/;

export type CmdScriptLaunch = { command: string; args: string[]; verbatim: true } | { error: string };

/**
 * The one way Legion runs a `.cmd`/`.bat` that is not an npm shim (F-096): `cmd.exe /d /v:off
 * /s /c ""<script>" <args>"`. AutoRun and delayed expansion are off; the script path is always
 * quoted; the whole line is quoted once more because `/s` strips exactly the outer pair; and a
 * script path or argument containing `& | < > ^ %` or a newline is refused, not escaped.
 */
export function cmdScriptLaunch(script: string, args: readonly string[]): CmdScriptLaunch {
  if (CMD_UNSAFE.test(script) || script.includes('"')) {
    return { error: `${script}: a .cmd/.bat path containing & | < > ^ % or quotes is not run through cmd.exe` };
  }
  const unsafe = args.find((arg) => CMD_UNSAFE.test(arg));
  if (unsafe !== undefined) {
    return {
      error: `${script} is a .cmd/.bat script; argument ${JSON.stringify(unsafe)} contains & | < > ^ % or a newline`,
    };
  }
  const line = [`"${script}"`, ...args.map(quoteCmdArg)].join(" ");
  return { command: cmdExePath(), args: ["/d", "/v:off", "/s", "/c", `"${line}"`], verbatim: true };
}

function spawnCmdFile(command: string, args: string[], cwd?: string): SpawnText {
  const launch = cmdScriptLaunch(command, args);
  if ("error" in launch) return { error: new Error(launch.error), status: null, stdout: "", stderr: launch.error };
  return asText(
    spawnSync(launch.command, launch.args, {
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

const LAUNCHABLE_EXT = /\.(exe|com|cmd|bat)$/i;

export function resolveBinary(binary: string): string | null {
  if (!binary) return null;
  if (binary.includes("/") || binary.includes("\\") || /^[A-Za-z]:/.test(binary)) {
    return existsSync(binary) ? binary : null;
  }
  const names = process.platform === "win32" ? [binary, `${binary}.cmd`, `${binary}.exe`] : [binary];
  const found = listOnPath(names);
  if (process.platform === "win32") {
    // `where npm` lists the extensionless POSIX shell script first; CreateProcess can't run it.
    // Prefer, in PATH order, what spawn (.exe/.com) or the .cmd/.bat path can launch — not
    // PATHEXT's .js/.vbs/.wsf, which need a script host.
    const runnable = found.find((abs) => LAUNCHABLE_EXT.test(abs));
    if (runnable) return runnable;
  }
  return found[0] ?? null;
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

function isShimAnchored(raw: string): boolean {
  return /^%~?dp0%?/i.test(raw);
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
      // Only a token anchored at the shim's directory, or already absolute, names a file.
      // `%_prog%`, `node` and other bare tokens are symbolic: resolving them would pick up a
      // file planted in the current directory (the audited repo) and run it as "node".
      const anchored = isShimAnchored(raw) ? expandShimVars(raw, dp0) : isAbsolute(raw) ? raw : null;
      if (isNodeBinaryToken(raw) || (anchored !== null && isNodeBinaryToken(anchored))) {
        if (!nodeFromShim && anchored !== null) nodeFromShim = resolve(anchored);
        continue;
      }
      if (anchored !== null && existsSync(resolve(anchored))) script = resolve(anchored);
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
