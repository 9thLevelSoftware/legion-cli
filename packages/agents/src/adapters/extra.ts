import { ASSUMED_EXTRA_BINARIES, extraArgsOrDefault, extraArgvRefuseReason, buildGenericArgv } from "../argv.js";
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

/** Spawnable extra CLI with verified vendor argv (KD-7). */
export class ExtraAdapter implements AgentAdapter {
  readonly id: ExtraAdapterId;
  readonly binary: string;
  readonly #args: string[];

  constructor(id: ExtraAdapterId, config: ExtraAdapterConfig = {}) {
    this.id = id;
    this.binary = config.binary ?? ASSUMED_EXTRA_BINARIES[id];
    this.#args = extraArgsOrDefault(id, config.args ?? [], this.binary);
  }

  async detect(): Promise<DetectResult> {
    const argvReason = extraArgvRefuseReason(this.id, this.#args, this.binary);
    if (argvReason) return { ok: false, reason: argvReason };
    if (!isSpawnableBinary(this.binary)) {
      return { ok: false, reason: `${this.binary} is not on PATH` };
    }
    const resolved = resolveBinary(this.binary) ?? this.binary;
    return { ok: true, version: versionOf(resolved) };
  }

  async spawn(job: AgentJob): Promise<AgentHandle> {
    const argvReason = extraArgvRefuseReason(this.id, this.#args, this.binary);
    if (argvReason) throw new AdapterConfigError(argvReason);
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
