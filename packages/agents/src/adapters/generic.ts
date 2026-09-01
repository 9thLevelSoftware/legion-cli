import { argsIncludePointer, buildGenericArgv, genericArgsOrDefault } from "../argv.js";
import { AdapterConfigError } from "../errors.js";
import { spawnAgentProcess } from "../process.js";
import { runCachePaths } from "../paths.js";
import { isSpawnableBinary, resolveBinary, versionOf } from "../which.js";
import type { AgentAdapter, AgentHandle, AgentJob, DetectResult, GenericAdapterConfig } from "../types.js";

const POINTER_REQUIRED = "adapter.generic.args must include {{pointer}}";

export class GenericAdapter implements AgentAdapter {
  readonly id = "generic" as const;
  readonly binary: string;
  readonly #args: string[];

  constructor(config: GenericAdapterConfig) {
    this.binary = config.binary;
    this.#args = genericArgsOrDefault(config.args);
  }

  async detect(): Promise<DetectResult> {
    if (!this.binary) {
      return { ok: false, reason: "adapter.generic.binary is missing" };
    }
    if (!argsIncludePointer(this.#args)) {
      return { ok: false, reason: POINTER_REQUIRED };
    }
    if (!isSpawnableBinary(this.binary)) {
      return { ok: false, reason: `${this.binary} is not on PATH` };
    }
    const resolved = resolveBinary(this.binary) ?? this.binary;
    return { ok: true, version: versionOf(resolved) };
  }

  async spawn(job: AgentJob): Promise<AgentHandle> {
    if (!this.binary) {
      throw new AdapterConfigError("adapter.generic is required when adapter.default is generic");
    }
    if (!argsIncludePointer(this.#args)) {
      throw new AdapterConfigError(POINTER_REQUIRED);
    }
    const paths = runCachePaths(job.cwd, job.runId);
    const args = buildGenericArgv(this.#args, job.pointerPrompt);
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
