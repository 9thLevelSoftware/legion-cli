import { AdapterNotEnabled } from "../errors.js";
import { isSpawnableBinary, resolveBinary, versionOf } from "../which.js";
import type { AgentAdapter, AgentAdapterId, AgentHandle, AgentJob, DetectResult } from "../types.js";

export class DetectOnlyAdapter implements AgentAdapter {
  readonly id: AgentAdapterId;
  readonly binary: string;

  constructor(id: "grok" | "codex") {
    this.id = id;
    this.binary = id;
  }

  async detect(): Promise<DetectResult> {
    if (!isSpawnableBinary(this.binary)) {
      return { ok: false, reason: `${this.binary} is not on PATH (detect-only)` };
    }
    const resolved = resolveBinary(this.binary) ?? this.binary;
    return { ok: true, version: versionOf(resolved) };
  }

  async spawn(_job: AgentJob): Promise<AgentHandle> {
    throw new AdapterNotEnabled(this.id);
  }
}
