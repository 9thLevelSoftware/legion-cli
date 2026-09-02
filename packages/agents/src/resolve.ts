import type { LegionConfig } from "@9thlevelsoftware/legion-cli-schema";
import { ClaudeAdapter } from "./adapters/claude.js";
import { ExtraAdapter } from "./adapters/extra.js";
import { FakeAdapter } from "./adapters/fake.js";
import { GenericAdapter } from "./adapters/generic.js";
import { AdapterConfigError } from "./errors.js";
import {
  DETECT_ADAPTER_IDS,
  DETECT_ONLY_ADAPTER_IDS,
  type AdapterCreateOptions,
  type AdapterResolution,
  type AgentAdapter,
  type AgentAdapterId,
  type DetectResult,
  type SkillId,
} from "./types.js";

export type { AdapterResolution };

export type ResolveAdapterOptions = AdapterCreateOptions & { id?: AgentAdapterId };

export function resolveAdapterId(input: {
  config: Pick<LegionConfig, "adapter">;
  skillId: SkillId;
  taskAdapter?: AgentAdapterId | null;
  cliAdapter?: AgentAdapterId | null;
}): AdapterResolution {
  if (input.cliAdapter) return { id: input.cliAdapter, source: "cli" };
  const taskScoped = input.skillId === "execute" || input.skillId === "verify";
  if (taskScoped && input.taskAdapter) return { id: input.taskAdapter, source: "task" };
  const routed = input.config.adapter.routes?.[input.skillId];
  if (routed) return { id: routed, source: "route" };
  return { id: input.config.adapter.default, source: "default" };
}

export function isDetectOnly(id: AgentAdapterId): boolean {
  return (DETECT_ONLY_ADAPTER_IDS as readonly string[]).includes(id);
}

export function createAdapter(id: AgentAdapterId, options: AdapterCreateOptions = {}): AgentAdapter {
  switch (id) {
    case "fake":
      return new FakeAdapter(
        options.artifacts ?? [],
        options.throwAfterWrite ?? false,
        options.timedOut ?? false,
      );
    case "claude":
      return new ClaudeAdapter(options.extraArgs ?? []);
    case "generic":
      return new GenericAdapter(options.generic ?? { binary: "", args: [] });
    case "grok":
      return new ExtraAdapter("grok", options.grok);
    case "openai":
      return new ExtraAdapter("openai", options.openai);
    case "codex":
      return new ExtraAdapter("codex", options.codex);
    case "mimo":
      return new ExtraAdapter("mimo", options.mimo);
    case "minimax":
      return new ExtraAdapter("minimax", options.minimax);
  }
}

export function resolveAdapter(
  config: Pick<LegionConfig, "adapter">,
  options: ResolveAdapterOptions = {},
): AgentAdapter {
  const id = options.id ?? config.adapter.default;
  if (id === "generic" && !config.adapter.generic?.binary) {
    throw new AdapterConfigError("adapter.generic is required when the resolved adapter is generic");
  }
  return createAdapter(id, {
    extraArgs: options.extraArgs ?? config.adapter.claude?.extraArgs,
    generic: options.generic ?? config.adapter.generic,
    grok: options.grok ?? config.adapter.grok,
    openai: options.openai ?? config.adapter.openai,
    codex: options.codex ?? config.adapter.codex,
    mimo: options.mimo ?? config.adapter.mimo,
    minimax: options.minimax ?? config.adapter.minimax,
    artifacts: options.artifacts,
    throwAfterWrite: options.throwAfterWrite,
    timedOut: options.timedOut,
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
      grok: config?.adapter.grok,
      openai: config?.adapter.openai,
      codex: config?.adapter.codex,
      mimo: config?.adapter.mimo,
      minimax: config?.adapter.minimax,
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

export async function isResolvedAdapterSpawnable(
  config: Pick<LegionConfig, "adapter">,
  id?: AgentAdapterId,
): Promise<boolean> {
  try {
    return await isSpawnable(resolveAdapter(config, { id }));
  } catch (err) {
    if (err instanceof AdapterConfigError) return false;
    throw err;
  }
}
