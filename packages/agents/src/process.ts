import { execFile, spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, realpathSync, type WriteStream } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { translateWrapperInvoke } from "@9thlevelsoftware/legion-cli-sandbox";
import { AgentError } from "./errors.js";
import { ABORT_GRACE_MS, DEFAULT_TIMEOUT_MS, type AgentHandle, type AgentJob, type AgentResult } from "./types.js";
import type { AgentUsage } from "./profiles.js";
import { cmdScriptLaunch, resolveBinary, unwrapCmdShim, withNoCwdExeSearch } from "./which.js";

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

/** Terminates the complete adapter process tree/group. */
export function terminateAgentProcessTree(pid: number, force = false): void {
  terminate(pid, force);
}

function powershellExePath(): string {
  return join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function extractDockerCleanup(wrapper?: AgentJob["wrapper"]): { bin: string; containerName: string } | undefined {
  if (!wrapper) return undefined;
  const nameIdx = wrapper.argvPrefix.indexOf("--name");
  if (nameIdx < 0) return undefined;
  const containerName = wrapper.argvPrefix[nameIdx + 1];
  if (!containerName || !/^legion-[A-Za-z0-9_.-]+$/.test(containerName)) return undefined;
  return { bin: wrapper.bin, containerName };
}

/** Removes a named Docker sandbox container best-effort after an interrupted or aborted run. */
export async function cleanupDockerWrapperContainer(wrapper?: AgentJob["wrapper"]): Promise<void> {
  const target = extractDockerCleanup(wrapper);
  if (!target) return;
  await new Promise<void>((resolve) => {
    execFile(target.bin, ["rm", "-f", target.containerName], { timeout: 5000, windowsHide: true }, () => resolve());
  });
}

function spawnEnv(job: AgentJob): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(job.env)) {
    if (value !== undefined) env[key] = value;
  }
  return withNoCwdExeSearch(env);
}

type SpawnStdio = ["ignore" | "pipe", WriteStream | "pipe", WriteStream | "pipe"];

function spawnTarget(binary: string, args: string[], job: AgentJob, stdio: SpawnStdio): ChildProcess {
  const resolved = resolveBinary(binary) ?? binary;
  const common = {
    cwd: job.cwd,
    env: spawnEnv(job),
    windowsHide: true,
    shell: false,
  } as const;

  if (job.wrapper) {
    let invoke = resolved;
    try {
      invoke = realpathSync(resolved);
    } catch {
      invoke = resolved;
    }
    invoke = translateWrapperInvoke(job.wrapper, invoke, job.cwd);
    return spawn(job.wrapper.bin, [...job.wrapper.argvPrefix, invoke, ...args], {
      ...common,
      stdio,
      detached: process.platform !== "win32",
    });
  }

  if (process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(resolved)) {
    if (/\.ps1$/i.test(resolved)) {
      return spawn(
        powershellExePath(),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args],
        {
          ...common,
          stdio,
          detached: false,
        },
      );
    }
    const unwrapped = unwrapCmdShim(resolved);
    if (unwrapped) {
      // Real argv array: cmd.exe would truncate a multiline pointer at the first newline.
      return spawn(unwrapped.command, [...unwrapped.prefixArgs, ...args], {
        ...common,
        stdio,
        detached: false,
      });
    }
    if (args.some((arg) => /[\r\n]/.test(arg))) {
      throw new AgentError(
        `Windows .cmd/.bat cannot receive multiline argv (${resolved}); expected an npm node shim`,
      );
    }
    const launch = cmdScriptLaunch(resolved, args);
    if ("error" in launch) throw new AgentError(launch.error);
    return spawn(launch.command, launch.args, {
      ...common,
      stdio,
      detached: false,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(resolved, args, {
    ...common,
    stdio,
    detached: process.platform !== "win32",
  });
}

function spawnCommand(binary: string, args: string[], job: AgentJob, stdout: WriteStream, stderr: WriteStream): ChildProcess {
  return spawnTarget(binary, args, job, ["ignore", stdout, stderr]);
}

/** Spawn an interactive stdio adapter through the same wrapper and process-group policy as CLI adapters. */
export function spawnInteractiveAgentProcess(
  binary: string,
  args: string[],
  job: AgentJob,
): ChildProcessWithoutNullStreams {
  return spawnTarget(binary, args, job, ["pipe", "pipe", "pipe"]) as ChildProcessWithoutNullStreams;
}

/**
 * Kill the agent tree when this engine is interrupted or exits. POSIX agents run in their own
 * process group, so the terminal's Ctrl-C never reaches them; without this they keep writing into
 * the project after Legion is gone. Windows children die with the engine only when they share its
 * job object, so the same hooks run there too. Under the Docker/bwrap wrapper the killed pid is the
 * wrapper client, so a container may outlive an interrupt (its writes stay in the jail). Handlers do not run on a Windows console close or
 * `taskkill /F`: the identity-based live-run marker is what makes the next command see a survivor.
 * Mirrors `runCommand`: after killing, let the signal act on us as it would have.
 */
function killTreeOnInterrupt(
  child: ChildProcess,
  pid: number,
  exited: Promise<unknown>,
  wrapper?: AgentJob["wrapper"],
): void {
  if (pid <= 0) return;
  const dockerTarget = extractDockerCleanup(wrapper);
  const kill = (): void => {
    // The child already exited: its pid may belong to someone else now.
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      terminate(pid, true);
    } catch {
      // best effort: the process may already be gone
    }
    if (dockerTarget) {
      try {
        spawnSync(dockerTarget.bin, ["rm", "-f", dockerTarget.containerName], {
          windowsHide: true,
          timeout: 3000,
          stdio: "ignore",
        });
      } catch {
        // best effort cleanup
      }
    }
  };
  const onExit = (): void => kill();
  const onSignal = (signal: NodeJS.Signals): void => {
    kill();
    remove();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  const onInt = (): void => onSignal("SIGINT");
  const onTerm = (): void => onSignal("SIGTERM");
  // A closed terminal sends SIGHUP; the agent has its own process group and would never see it.
  const onHup = (): void => onSignal("SIGHUP");
  const remove = (): void => {
    process.removeListener("exit", onExit);
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    if (process.platform !== "win32") process.removeListener("SIGHUP", onHup);
  };
  process.once("exit", onExit);
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  if (process.platform !== "win32") process.once("SIGHUP", onHup);
  void exited.then(remove, remove);
}

function finiteInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseUsageObject(parsed: unknown): AgentUsage | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const root = parsed as Record<string, unknown>;
  const rawUsage = root.usage;
  if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) return undefined;
  const u = rawUsage as Record<string, unknown>;
  const inputTokens = finiteInt(u.input_tokens);
  const outputTokens = finiteInt(u.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const totalTokens = finiteInt(u.total_tokens) ?? inputTokens + outputTokens;
  const requests = finiteInt(u.requests) ?? finiteInt(root.num_turns);
  const model = typeof root.model === "string" && root.model.trim().length > 0 ? root.model.trim() : undefined;
  const cost =
    typeof root.total_cost_usd === "number" && Number.isFinite(root.total_cost_usd) && root.total_cost_usd >= 0
      ? root.total_cost_usd
      : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(requests !== undefined ? { requests } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(cost !== undefined ? { estimatedCostUsd: cost, costEstimated: true } : {}),
  };
}

function parseStdoutJsonUsage(raw: string): AgentUsage | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      const direct = parseUsageObject(JSON.parse(trimmed));
      if (direct) return direct;
    } catch {
      // fall through to check trailing JSON lines
    }
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith("{")) continue;
    try {
      const fromLine = parseUsageObject(JSON.parse(line));
      if (fromLine) return fromLine;
    } catch {
      continue;
    }
  }
  return undefined;
}

class ChildAgentHandle implements AgentHandle {
  readonly pid: number;
  readonly #stdoutPath: string;
  readonly #stderrPath: string;
  readonly #summaryPath: string;
  readonly #stdout: WriteStream;
  readonly #stderr: WriteStream;
  readonly #wrapper: AgentJob["wrapper"];
  readonly #done: Promise<AgentResult>;
  #exitCode: number | null = null;
  #errorMessage: string | undefined;
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
    this.#wrapper = opts.job.wrapper;
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
    opts.child.once("error", (err) => {
      this.#errorMessage ??= err instanceof Error ? err.message : String(err);
      onExit(null);
    });

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
    if (!this.#exited) {
      terminate(this.pid, false);
      const dead = await this.#waitExit(ABORT_GRACE_MS);
      if (!dead) terminate(this.pid, true);
    }
    await cleanupDockerWrapperContainer(this.#wrapper);
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
    let usage: AgentUsage | undefined;
    if (this.#exitCode === 0) {
      try {
        const info = await stat(this.#stdoutPath);
        if (info.size > 0 && info.size <= 2 * 1024 * 1024) {
          usage = parseStdoutJsonUsage(await readFile(this.#stdoutPath, "utf8"));
        }
      } catch {
        usage = undefined;
      }
    }
    this.#settle({
      exitCode: this.#exitCode,
      timedOut: this.#timedOut,
      aborted: this.#aborted,
      stdoutPath: this.#stdoutPath,
      stderrPath: this.#stderrPath,
      summaryPath,
      ...(usage ? { usage } : {}),
      ...(this.#errorMessage ? { errorMessage: this.#errorMessage } : {}),
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
  const handle = new ChildAgentHandle({
    job: opts.job,
    child,
    stdout,
    stderr,
    stdoutPath: opts.stdoutPath,
    stderrPath: opts.stderrPath,
    summaryPath: opts.summaryPath,
  });
  killTreeOnInterrupt(child, handle.pid, handle.wait(), opts.job.wrapper);
  return handle;
}
