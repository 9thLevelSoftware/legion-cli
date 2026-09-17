import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRunCommandAllowed, type HttpToolHost } from "@9thlevelsoftware/legion-cli-http";
import { PathEscapeError, toFsPath, toStorePath } from "@9thlevelsoftware/legion-cli-persist";
import { isImplicitForbidden, matchesGlob } from "./contracts.js";

const RUN_COMMAND_TIMEOUT_MS = 60_000;

export type HttpHostOpts = {
  jailRoot: string;
  allowedWrites: readonly string[];
  filesForbidden?: readonly string[];
  hardened: boolean;
  spawnOpts: { cwd: string; env: NodeJS.ProcessEnv; wrapper?: { bin: string; argvPrefix: string[] } };
};

function matchesAllowed(posix: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => posix === entry || posix.startsWith(`${entry}/`));
}

function assertJailPosix(posix: string): string {
  const stored = toStorePath(posix);
  if (!stored || stored === ".") {
    throw new PathEscapeError(posix);
  }
  return stored;
}

export function createHttpToolHost(opts: HttpHostOpts): HttpToolHost {
  const host: HttpToolHost = {
    jailRoot: opts.jailRoot,
    async readFile(posix) {
      const rel = assertJailPosix(posix);
      return readFile(toFsPath(opts.jailRoot, rel), "utf8");
    },
    async writeFile(posix, contents) {
      const rel = assertJailPosix(posix);
      if (isImplicitForbidden(rel)) {
        throw new Error(`implicit forbidden: ${rel}`);
      }
      if (opts.filesForbidden?.some((pattern) => matchesGlob(pattern, rel))) {
        throw new Error(`forbidden: ${rel}`);
      }
      if (!matchesAllowed(rel, opts.allowedWrites)) {
        throw new Error(`not in allowedWrites: ${rel}`);
      }
      const abs = toFsPath(opts.jailRoot, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, contents, "utf8");
    },
    async listDir(posix) {
      const rel = posix === "" || posix === "." ? "." : assertJailPosix(posix);
      const abs = rel === "." ? opts.jailRoot : toFsPath(opts.jailRoot, rel);
      const names = await readdir(abs);
      return names;
    },
  };
  if (opts.hardened && opts.spawnOpts.wrapper) {
    const wrapper = opts.spawnOpts.wrapper;
    host.runCommand = (argv) => runJailedCommand(argv, opts, wrapper);
  }
  return host;
}

function runJailedCommand(
  argv: string[],
  opts: HttpHostOpts,
  wrapper: { bin: string; argvPrefix: string[] },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!isRunCommandAllowed(argv)) {
    return Promise.resolve({ exitCode: 1, stdout: "", stderr: "run_command argv is not allowlisted" });
  }
  return new Promise((resolve) => {
    const child = spawn(wrapper.bin, [...wrapper.argvPrefix, ...argv], {
      cwd: opts.spawnOpts.cwd,
      env: opts.spawnOpts.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\nrun_command timed out`.trim() });
    }, RUN_COMMAND_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
