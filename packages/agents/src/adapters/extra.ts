import { ASSUMED_EXTRA_BINARIES, argsIncludePointer, buildGenericArgv, genericArgsOrDefault } from "../argv.js";
import { AdapterConfigError } from "../errors.js";
import { spawnAgentProcess } from "../process.js";
import { runCachePaths } from "../paths.js";
import { isSpawnableBinary, resolveBinary, versionOf } from "../which.js";
import type {
  AgentAdapter,
  AgentHandle,
  AgentJob,
  DetectResult,
  ExtraAdapterConfig,
  ExtraAdapterId,
} from "../types.js";

function pointerRequired(id: ExtraAdapterId): string {
  return `adapter.${id}.args must include {{pointer}}`;
}

/** Spawnable extra CLI. Vendor flags are unverified, so argv stays generic-style. */
export class ExtraAdapter implements AgentAdapter {
  readonly id: ExtraAdapterId;
  readonly binary: string;
  readonly #args: string[];

  constructor(id: ExtraAdapterId, config: ExtraAdapterConfig = {}) {
    this.id = id;
    this.binary = config.binary ?? ASSUMED_EXTRA_BINARIES[id];
    this.#args = genericArgsOrDefault(config.args ?? []);
  }

  async detect(): Promise<DetectResult> {
    if (!argsIncludePointer(this.#args)) {
      return { ok: false, reason: pointerRequired(this.id) };
    }
    if (!isSpawnableBinary(this.binary)) {
      return { ok: false, reason: `${this.binary} is not on PATH` };
    }
    const resolved = resolveBinary(this.binary) ?? this.binary;
    return { ok: true, version: versionOf(resolved) };
  }

  async spawn(job: AgentJob): Promise<AgentHandle> {
    if (!argsIncludePointer(this.#args)) {
      throw new AdapterConfigError(pointerRequired(this.id));
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
