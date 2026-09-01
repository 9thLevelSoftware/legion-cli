import { buildClaudeArgv } from "../argv.js";
import { spawnAgentProcess } from "../process.js";
import { runCachePaths } from "../paths.js";
import { isSpawnableBinary, resolveBinary, versionOf } from "../which.js";
import type { AgentAdapter, AgentHandle, AgentJob, DetectResult } from "../types.js";

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude" as const;
  readonly binary = "claude";
  readonly #extraArgs: string[];

  constructor(extraArgs: readonly string[] = []) {
    this.#extraArgs = [...extraArgs];
  }

  async detect(): Promise<DetectResult> {
    if (!isSpawnableBinary(this.binary)) {
      return { ok: false, reason: "claude is not on PATH" };
    }
    const resolved = resolveBinary(this.binary) ?? this.binary;
    return { ok: true, version: versionOf(resolved) };
  }

  async spawn(job: AgentJob): Promise<AgentHandle> {
    const paths = runCachePaths(job.cwd, job.runId);
    const args = buildClaudeArgv(job.pointerPrompt, this.#extraArgs);
    return spawnAgentProcess({
      binary: this.binary,
      args,
      job,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      summaryPath: paths.summaryPath,
    });
  }
}
