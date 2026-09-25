import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isRunCommandAllowed, MAX_RUN_COMMAND_BYTES, type HttpToolHost } from "@9thlevelsoftware/legion-cli-http";
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

/** Kernel-owned SoT: never a write_file target, even if listed in allowedWrites. */
export function engineSotRefuseReason(posix: string): string | null {
  if (posix === ".legion-cli/STATE.md") return `engine-SoT refused: ${posix}`;
  if (posix === ".legion-cli/config.yaml") return `engine-SoT refused: ${posix}`;
  if (posix === ".legion-cli/tasks" || posix.startsWith(".legion-cli/tasks/")) {
    return `engine-SoT refused: ${posix}`;
  }
  return null;
}

/** HTTP host grant list: drop engine-SoT and other implicit-forbidden paths. */
export function httpAllowedWrites(paths: readonly string[]): string[] {
  return paths.filter((posix) => !engineSotRefuseReason(posix) && !isImplicitForbidden(posix));
}

function assertJailPosix(posix: string): string {
  const stored = toStorePath(posix);
  if (!stored || stored === ".") {
    throw new PathEscapeError(posix);
  }
  return stored;
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** lstat the leaf and every ancestor down to jailRoot; never follow guest links. */
async function assertNoSymlink(abs: string, jailRoot: string): Promise<void> {
  let current = resolve(abs);
  const stop = resolve(jailRoot);
  for (;;) {
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) {
        throw new Error(`symlink refused: ${abs}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (samePath(current, stop)) break;
    const parent = dirname(current);
    if (samePath(parent, current)) {
      throw new Error(`symlink refused: ${abs}`);
    }
    current = parent;
  }
}

export function createHttpToolHost(opts: HttpHostOpts): HttpToolHost {
  const host: HttpToolHost = {
    jailRoot: opts.jailRoot,
    async readFile(posix) {
      const rel = assertJailPosix(posix);
      if (isImplicitForbidden(rel)) {
        throw new Error(`implicit forbidden: ${rel}`);
      }
      const abs = toFsPath(opts.jailRoot, rel);
      await assertNoSymlink(abs, opts.jailRoot);
      return readFile(abs, "utf8");
    },
    async writeFile(posix, contents) {
      const rel = assertJailPosix(posix);
      const sot = engineSotRefuseReason(rel);
      if (sot) throw new Error(sot);
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
      await assertNoSymlink(abs, opts.jailRoot);
      await mkdir(dirname(abs), { recursive: true });
      await assertNoSymlink(abs, opts.jailRoot);
      await writeFile(abs, contents, "utf8");
    },
    async listDir(posix) {
      const rel = posix === "" || posix === "." ? "." : assertJailPosix(posix);
      if (rel !== "." && isImplicitForbidden(rel)) {
        throw new Error(`implicit forbidden: ${rel}`);
      }
      const abs = rel === "." ? opts.jailRoot : toFsPath(opts.jailRoot, rel);
      await assertNoSymlink(abs, opts.jailRoot);
      return readdir(abs);
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
    let overflowed = false;
    const take = (kind: "stdout" | "stderr", chunk: string) => {
      if (overflowed) return;
      const target = kind === "stdout" ? stdout : stderr;
      if (target.length + chunk.length > MAX_RUN_COMMAND_BYTES) {
        const kept = `${target}${chunk}`.slice(0, MAX_RUN_COMMAND_BYTES);
        if (kind === "stdout") stdout = kept;
        else stderr = kept;
        overflowed = true;
        child.kill();
        return;
      }
      if (kind === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => take("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => take("stderr", chunk));
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
      const message = overflowed ? `${stderr}\nrun_command output exceeded ${MAX_RUN_COMMAND_BYTES} bytes`.trim() : stderr;
      resolve({ exitCode: overflowed ? 1 : (code ?? 1), stdout, stderr: message });
    });
  });
}
