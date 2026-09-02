import type { LegionConfig } from "@9thlevelsoftware/legion-cli-schema";
import { ClaudeAdapter } from "./adapters/claude.js";
import { DetectOnlyAdapter } from "./adapters/detect-only.js";
import { FakeAdapter } from "./adapters/fake.js";
import { GenericAdapter } from "./adapters/generic.js";
import { AdapterConfigError } from "./errors.js";
import {
  DETECT_ADAPTER_IDS,
  DETECT_ONLY_ADAPTER_IDS,
  type AdapterCreateOptions,
  type AgentAdapter,
  type AgentAdapterId,
  type DetectResult,
} from "./types.js";

export function isDetectOnly(id: AgentAdapterId): boolean {
  return (DETECT_ONLY_ADAPTER_IDS as readonly string[]).includes(id);
}

export function createAdapter(id: AgentAdapterId, options: AdapterCreateOptions = {}): AgentAdapter {
  switch (id) {
    case "fake":
      return new FakeAdapter(options.artifacts ?? [], options.throwAfterWrite ?? false);
    case "claude":
      return new ClaudeAdapter(options.extraArgs ?? []);
    case "generic":
      return new GenericAdapter(options.generic ?? { binary: "", args: [] });
    case "grok":
      return new DetectOnlyAdapter("grok");
    case "codex":
      return new DetectOnlyAdapter("codex");
  }
}

export function resolveAdapter(
  config: Pick<LegionConfig, "adapter">,
  options: AdapterCreateOptions = {},
): AgentAdapter {
  const id = config.adapter.default;
  if (id !== "fake" && id !== "generic" && id !== "claude") {
    throw new AdapterConfigError("adapter.default must be claude, generic, or fake");
  }
  if (id === "generic" && !config.adapter.generic?.binary) {
    throw new AdapterConfigError("adapter.generic is required when adapter.default is generic");
  }
  return createAdapter(id, {
    extraArgs: options.extraArgs ?? config.adapter.claude?.extraArgs,
    generic: options.generic ?? config.adapter.generic,
    artifacts: options.artifacts,
    throwAfterWrite: options.throwAfterWrite,
  });
}

export async function detectMatrix(
  config?: Pick<LegionConfig, "adapter">,
): Promise<Record<AgentAdapterId, DetectResult>> {
  const out = {} as Record<AgentAdapterId, DetectResult>;
  for (const id of DETECT_ADAPTER_IDS) {
    const adapter = createAdapter(id, {
      extraArgs: config?.adapter.claude?.extraArgs,
      generic: config?.adapter.generic,
    });
    out[id] = await adapter.detect();
  }
  return out;
}

export async function isSpawnable(adapter: AgentAdapter): Promise<boolean> {
  if (isDetectOnly(adapter.id)) return false;
  const detected = await adapter.detect();
  return detected.ok;
}
