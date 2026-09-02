import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentError } from "./errors.js";
import { ABORT_GRACE_MS, DEFAULT_TIMEOUT_MS, type AgentHandle, type AgentJob, type AgentResult } from "./types.js";
import { quoteCmdArgForSpawn, resolveBinary, unwrapCmdShim } from "./which.js";

function openWrite(path: string): Promise<WriteStream> {
  const stream = createWriteStream(path);
  return new Promise((resolve, reject) => {
    stream.once("open", () => resolve(stream));
    stream.once("error", reject);
  });
}

function terminateUnix(pid: number, force: boolean): void {
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

function terminateWindows(pid: number, force: boolean): void {
  const args = ["/PID", String(pid), "/T"];
  if (force) args.push("/F");
  spawnSync("taskkill", args, { windowsHide: true, shell: false, encoding: "utf8" });
}

function terminate(pid: number, force: boolean): void {
  if (pid <= 0) return;
  if (process.platform === "win32") terminateWindows(pid, force);
  else terminateUnix(pid, force);
}

function spawnCommand(binary: string, args: string[], job: AgentJob, stdout: WriteStream, stderr: WriteStream): ChildProcess {
  const resolved = resolveBinary(binary) ?? binary;
  const common = {
    cwd: job.cwd,
    env: job.env,
    windowsHide: true,
    shell: false,
  } as const;

  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const unwrapped = unwrapCmdShim(resolved);
    if (unwrapped) {
      // Real argv array: cmd.exe would truncate a multiline pointer at the first newline.
      return spawn(unwrapped.command, [...unwrapped.prefixArgs, ...args], {
        ...common,
        stdio: ["ignore", stdout, stderr],
        detached: false,
      });
    }
    if (args.some((arg) => /[\r\n]/.test(arg))) {
      throw new AgentError(
        `Windows .cmd/.bat cannot receive multiline argv (${resolved}); expected an npm node shim`,
      );
    }
    const line = [resolved, ...args].map(quoteCmdArgForSpawn).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], {
      ...common,
      stdio: ["ignore", stdout, stderr],
      detached: false,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(resolved, args, {
    ...common,
    stdio: ["ignore", stdout, stderr],
    detached: process.platform !== "win32",
  });
}

class ChildAgentHandle implements AgentHandle {
  readonly pid: number;
  readonly #stdoutPath: string;
  readonly #stderrPath: string;
  readonly #summaryPath: string;
  readonly #stdout: WriteStream;
  readonly #stderr: WriteStream;
  readonly #done: Promise<AgentResult>;
  #exitCode: number | null = null;
  #exited = false;
  #aborted = false;
  #timedOut = false;
  #settle!: (result: AgentResult) => void;
  #timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: {
    job: AgentJob;
    child: ChildProcess;
    stdout: WriteStream;
    stderr: WriteStream;
    stdoutPath: string;
    stderrPath: string;
    summaryPath: string;
  }) {
    this.#stdout = opts.stdout;
    this.#stderr = opts.stderr;
    this.#stdoutPath = opts.stdoutPath;
    this.#stderrPath = opts.stderrPath;
    this.#summaryPath = opts.summaryPath;
    this.pid = opts.child.pid ?? 0;
    this.#done = new Promise((resolve) => {
      this.#settle = resolve;
    });

    const onExit = (code: number | null) => {
      if (this.#exited) return;
      this.#exited = true;
      this.#exitCode = code;
      if (this.#timeout) clearTimeout(this.#timeout);
      void this.#finish();
    };

    opts.child.once("exit", (code) => onExit(code));
    opts.child.once("error", () => onExit(null));

    const timeoutMs = opts.job.timeoutMs > 0 ? opts.job.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.#timeout = setTimeout(() => {
      if (this.#exited) return;
      this.#timedOut = true;
      void this.abort();
    }, timeoutMs);
  }

  wait(): Promise<AgentResult> {
    return this.#done;
  }

  async abort(): Promise<void> {
    this.#aborted = true;
    if (this.#exited) return;
    terminate(this.pid, false);
    const dead = await this.#waitExit(ABORT_GRACE_MS);
    if (!dead) terminate(this.pid, true);
  }

  async #waitExit(ms: number): Promise<boolean> {
    if (this.#exited) return true;
    const start = Date.now();
    while (!this.#exited && Date.now() - start < ms) {
      await delay(50);
    }
    return this.#exited;
  }

  async #finish(): Promise<void> {
    await Promise.allSettled([
      new Promise<void>((resolve) => this.#stdout.end(() => resolve())),
      new Promise<void>((resolve) => this.#stderr.end(() => resolve())),
    ]);
    let summaryPath: string | undefined;
    try {
      await access(this.#summaryPath);
      summaryPath = this.#summaryPath;
    } catch {
      summaryPath = undefined;
    }
    this.#settle({
      exitCode: this.#exitCode,
      timedOut: this.#timedOut,
      aborted: this.#aborted,
      stdoutPath: this.#stdoutPath,
      stderrPath: this.#stderrPath,
      summaryPath,
    });
  }
}

export async function spawnAgentProcess(opts: {
  binary: string;
  args: string[];
  job: AgentJob;
  stdoutPath: string;
  stderrPath: string;
  summaryPath: string;
}): Promise<AgentHandle> {
  await mkdir(dirname(opts.stdoutPath), { recursive: true });
  const stdout = await openWrite(opts.stdoutPath);
  const stderr = await openWrite(opts.stderrPath);
  let child: ChildProcess;
  try {
    child = spawnCommand(opts.binary, opts.args, opts.job, stdout, stderr);
  } catch (err) {
    await Promise.allSettled([
      new Promise<void>((resolve) => stdout.end(() => resolve())),
      new Promise<void>((resolve) => stderr.end(() => resolve())),
    ]);
    throw err;
  }
  return new ChildAgentHandle({
    job: opts.job,
    child,
    stdout,
    stderr,
    stdoutPath: opts.stdoutPath,
    stderrPath: opts.stderrPath,
    summaryPath: opts.summaryPath,
  });
}
