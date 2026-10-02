import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { terminateAgentProcessTree } from "@9thlevelsoftware/legion-cli-agents";
import { isRunCommandAllowed, MAX_RUN_COMMAND_BYTES, type HttpToolHost } from "@9thlevelsoftware/legion-cli-http";
import { PathEscapeError, toFsPath, toStorePath } from "@9thlevelsoftware/legion-cli-persist";
import { isImplicitForbidden, matchesGlob } from "./contracts.js";

const RUN_COMMAND_TIMEOUT_MS = 60_000;
const RUN_COMMAND_ABORT_GRACE_MS = 250;

export type HttpHostOpts = {
  jailRoot: string;
  allowedWrites: readonly string[];
  filesForbidden?: readonly string[];
  hardened: boolean;
  /** Exact argv[0] basenames granted by a governed job. Undefined retains the lifecycle policy. */
  commandAllowlist?: readonly string[];
  /** Exact argv prefixes granted by a governed job. Checked before the shared command policy. */
  commandPrefixes?: readonly (readonly string[])[];
  spawnOpts: { cwd: string; env: NodeJS.ProcessEnv; wrapper?: { bin: string; argvPrefix: string[] } };
  externalTools?: HttpToolHost["externalTools"];
  callExternalTool?: HttpToolHost["callExternalTool"];
};

function commandBasename(bin: string): string {
  return bin.replaceAll("\\", "/").split("/").pop()?.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase() ?? "";
}

function matchesCommandPrefix(argv: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0 || argv.length < prefix.length) return false;
  return prefix.every((expected, index) =>
    index === 0 ? commandBasename(argv[index] ?? "") === commandBasename(expected) : argv[index] === expected,
  );
}

function matchesAllowed(posix: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => posix === entry || posix.startsWith(`${entry}/`));
}

/** Kernel-owned SoT: never a write_file target, even if listed in allowedWrites. */
export function engineSotRefuseReason(posix: string): string | null {
  if (posix === ".legion-cli/STATE.md") return `engine-SoT refused: ${posix}`;
  if (posix === ".legion-cli/config.yaml") return `engine-SoT refused: ${posix}`;
  if (posix === ".legion-cli/map/selection.json") return `engine-SoT refused: ${posix}`;
  if (posix === ".legion-cli/workflow" || posix.startsWith(".legion-cli/workflow/")) {
    return `engine-SoT refused: ${posix}`;
  }
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
    ...(opts.externalTools ? { externalTools: opts.externalTools } : {}),
    ...(opts.callExternalTool ? { callExternalTool: opts.callExternalTool } : {}),
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
    host.runCommand = (argv, signal) => runJailedCommand(argv, opts, wrapper, signal);
  }
  return host;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("run_command aborted", "AbortError");
}

function runJailedCommand(
  argv: string[],
  opts: HttpHostOpts,
  wrapper: { bin: string; argvPrefix: string[] },
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (opts.commandPrefixes !== undefined && !opts.commandPrefixes.some((prefix) => matchesCommandPrefix(argv, prefix))) {
    return Promise.resolve({ exitCode: 1, stdout: "", stderr: "run_command argv is not in the job command prefix allowlist" });
  }
  if (opts.commandAllowlist !== undefined) {
    const granted = new Set(opts.commandAllowlist.map(commandBasename));
    if (!granted.has(commandBasename(argv[0] ?? ""))) {
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: "run_command argv[0] is not in the job command allowlist" });
    }
  }
  if (!isRunCommandAllowed(argv)) {
    return Promise.resolve({ exitCode: 1, stdout: "", stderr: "run_command argv is not allowlisted" });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(wrapper.bin, [...wrapper.argvPrefix, ...argv], {
      cwd: opts.spawnOpts.cwd,
      env: opts.spawnOpts.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    let timedOut = false;
    let aborting = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const forceTerminate = (): void => {
      if (forceTimer) {
        clearTimeout(forceTimer);
        forceTimer = undefined;
      }
      try {
        terminateAgentProcessTree(child.pid ?? 0, true);
      } catch {
        // The process group may already be gone.
      }
    };
    const terminate = (): void => {
      try {
        terminateAgentProcessTree(child.pid ?? 0, process.platform === "win32");
      } catch {
        // The process can exit between the liveness check and process-group kill.
      }
      if (process.platform === "win32") return;
      forceTimer = setTimeout(forceTerminate, RUN_COMMAND_ABORT_GRACE_MS);
    };
    const onAbort = (): void => {
      if (settled || aborting) return;
      aborting = true;
      terminate();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      // A descendant may survive SIGTERM after the wrapper closes. Keep the POSIX
      // process-group escalation armed whenever termination was requested.
      if (forceTimer && !aborting && !timedOut && !overflowed) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: { exitCode: number; stdout: string; stderr: string } | Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const take = (kind: "stdout" | "stderr", chunk: string) => {
      if (overflowed) return;
      const target = kind === "stdout" ? stdout : stderr;
      if (target.length + chunk.length > MAX_RUN_COMMAND_BYTES) {
        const kept = `${target}${chunk}`.slice(0, MAX_RUN_COMMAND_BYTES);
        if (kind === "stdout") stdout = kept;
        else stderr = kept;
        overflowed = true;
        terminate();
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
      timedOut = true;
      terminate();
    }, RUN_COMMAND_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on("error", (err) => {
      if (process.platform !== "win32" && (aborting || timedOut || overflowed)) forceTerminate();
      finish(aborting && signal ? abortError(signal) : { exitCode: 1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      // The wrapper can exit after SIGTERM while a detached descendant ignores it.
      // Kill the process group before resolving so no post-settlement timer is required.
      if (process.platform !== "win32" && (aborting || timedOut || overflowed)) forceTerminate();
      if (aborting && signal) {
        finish(abortError(signal));
        return;
      }
      if (timedOut) {
        finish({ exitCode: 1, stdout, stderr: `${stderr}\nrun_command timed out`.trim() });
        return;
      }
      const message = overflowed ? `${stderr}\nrun_command output exceeded ${MAX_RUN_COMMAND_BYTES} bytes`.trim() : stderr;
      finish({ exitCode: overflowed ? 1 : (code ?? 1), stdout, stderr: message });
    });
  });
}
