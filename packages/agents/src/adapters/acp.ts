import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { ExperimentalAcpAdapter } from "@9thlevelsoftware/legion-cli-http";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { AcpAdapterConfig } from "@9thlevelsoftware/legion-cli-schema";
import type { StopReason } from "@agentclientprotocol/sdk";
import { AdapterConfigError } from "../errors.js";
import { runCachePaths } from "../paths.js";
import { spawnInteractiveAgentProcess, terminateAgentProcessTree } from "../process.js";
import { isSpawnableBinary, resolveBinary, versionOf } from "../which.js";
import type { AgentAdapter, AgentHandle, AgentJob, AgentResult, DetectResult } from "../types.js";

export function acpStopExitCode(reason: StopReason): number | null {
  if (reason === "end_turn") return 0;
  if (reason === "cancelled") return null;
  return 1;
}

class AcpProcessHandle implements AgentHandle {
  readonly pid: number | null;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #controller = new AbortController();
  readonly #result: Promise<AgentResult>;
  #timedOut = false;
  #exited = false;

  constructor(child: ChildProcessWithoutNullStreams, job: AgentJob, paths: ReturnType<typeof runCachePaths>) {
    this.#child = child;
    this.pid = child.pid ?? null;
    child.once("exit", () => { this.#exited = true; });
    const timer = job.timeoutMs > 0
      ? setTimeout(() => {
          this.#timedOut = true;
          this.#controller.abort();
          if (child.pid) terminateAgentProcessTree(child.pid);
        }, job.timeoutMs)
      : undefined;
    this.#result = this.#run(job, paths).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async #run(job: AgentJob, paths: ReturnType<typeof runCachePaths>): Promise<AgentResult> {
    await mkdir(dirname(paths.stdoutPath), { recursive: true });
    const stderrChunks: string[] = [];
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => stderrChunks.push(chunk));
    try {
      const promptAbs = isAbsolute(job.promptPath) ? job.promptPath : join(job.cwd, job.promptPath);
      const prompt = await readFile(promptAbs, "utf8");
      const target = ndJsonStream(
        Writable.toWeb(this.#child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(this.#child.stdout) as ReadableStream<Uint8Array>,
      );
      const adapter = new ExperimentalAcpAdapter({ target });
      const result = await adapter.run({
        cwd: job.cwd,
        prompt: `${job.pointerPrompt}\n\n${prompt}`,
        signal: this.#controller.signal,
      });
      const exitCode = acpStopExitCode(result.stopReason);
      if (exitCode !== 0) stderrChunks.push(`ACP stopped without completion: ${result.stopReason}\n`);
      await writeFile(
        paths.stdoutPath,
        `ACP protocol=${result.protocolVersion} session=${result.sessionId} updates=${result.updates.length}\n`,
        "utf8",
      );
      await writeFile(paths.stderrPath, stderrChunks.join(""), "utf8");
      await writeFile(paths.summaryPath, result.text.endsWith("\n") ? result.text : `${result.text}\n`, "utf8");
      return {
        exitCode,
        timedOut: this.#timedOut,
        aborted: result.stopReason === "cancelled" && !this.#timedOut,
        stdoutPath: paths.stdoutPath,
        stderrPath: paths.stderrPath,
        summaryPath: paths.summaryPath,
      };
    } catch (err) {
      const aborted = this.#controller.signal.aborted;
      stderrChunks.push(`${err instanceof Error ? err.message : String(err)}\n`);
      await writeFile(paths.stdoutPath, "", "utf8");
      await writeFile(paths.stderrPath, stderrChunks.join(""), "utf8");
      return {
        exitCode: aborted ? null : 1,
        timedOut: this.#timedOut,
        aborted: aborted && !this.#timedOut,
        stdoutPath: paths.stdoutPath,
        stderrPath: paths.stderrPath,
      };
    } finally {
      await this.#terminate();
    }
  }

  wait(): Promise<AgentResult> {
    return this.#result;
  }

  async abort(): Promise<void> {
    this.#controller.abort();
    await this.#terminate();
  }

  async #terminate(): Promise<void> {
    if (this.#exited || !this.#child.pid) return;
    terminateAgentProcessTree(this.#child.pid);
    for (let attempt = 0; attempt < 20 && !this.#exited; attempt += 1) await delay(50);
    if (!this.#exited) terminateAgentProcessTree(this.#child.pid, true);
  }
}

/** Explicitly-enabled ACP stdio adapter. Permissions remain default-deny in the SDK client. */
export class AcpAdapter implements AgentAdapter {
  readonly id = "acp" as const;
  readonly binary: string;
  readonly #config?: AcpAdapterConfig;

  constructor(config?: AcpAdapterConfig) {
    this.#config = config;
    this.binary = config?.command ?? "";
  }

  async detect(): Promise<DetectResult> {
    if (!this.#config?.enabled) return { ok: false, reason: "adapter.acp.enabled must be true (experimental opt-in)" };
    if (!isSpawnableBinary(this.binary)) return { ok: false, reason: `${this.binary} is not on PATH` };
    const resolved = resolveBinary(this.binary) ?? this.binary;
    return { ok: true, version: versionOf(resolved) };
  }

  async spawn(job: AgentJob): Promise<AgentHandle> {
    if (!this.#config?.enabled) {
      throw new AdapterConfigError("adapter.acp.enabled must be true (experimental opt-in)");
    }
    if (!isSpawnableBinary(this.binary)) throw new AdapterConfigError(`${this.binary} is not on PATH`);
    const effectiveJob = { ...job, env: { ...job.env, ...(this.#config.env ?? {}) } };
    const child = spawnInteractiveAgentProcess(this.binary, this.#config.args ?? [], effectiveJob);
    return new AcpProcessHandle(child, effectiveJob, runCachePaths(job.cwd, job.runId));
  }
}
