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

export function runTool(
  name: string,
  args: string[],
  cwd?: string,
): { status: number; stdout: string; stderr: string } {
  const win = process.platform === "win32";
  // Windows PATH shims are .cmd; those need a shell. Bare name first so git.exe wins.
  const candidates = win ? [name, `${name}.cmd`, `${name}.exe`] : [name];
  for (const cmd of candidates) {
    const result = spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      shell: win && cmd.endsWith(".cmd"),
    });
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
