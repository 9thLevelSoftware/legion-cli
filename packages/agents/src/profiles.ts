import type { AdapterId, AdapterProfile, AgentUsage, SkillId } from "@9thlevelsoftware/legion-cli-schema";
import { AdapterConfigError } from "./errors.js";

export type { AgentUsage };
export type AgentPricing = NonNullable<AdapterProfile["pricing"]>;
export type AgentLimits = NonNullable<AdapterProfile["limits"]>;
export type AgentProfileConfig = AdapterProfile;

type ProfileConfig = {
  adapter: {
    default: AdapterId;
    routes?: Partial<Record<SkillId, AdapterId>>;
    profiles?: Record<string, AgentProfileConfig>;
    skillProfiles?: Partial<Record<SkillId, string>>;
  };
};

export type ResolvedAgentProfile = {
  adapterId: AdapterId;
  source: "cli" | "profile" | "task" | "skill-profile" | "route" | "default";
  profile?: string;
  config?: AgentProfileConfig;
};

const PROFILE_RE = /^[a-z][a-z0-9-]{0,31}$/;

function namedProfile(config: ProfileConfig, name: string, source: ResolvedAgentProfile["source"]): ResolvedAgentProfile {
  if (!PROFILE_RE.test(name)) throw new AdapterConfigError(`invalid profile '${name}'`);
  const profile = config.adapter.profiles?.[name];
  if (!profile) throw new AdapterConfigError(`unknown profile '${name}'`);
  return { adapterId: profile.adapter, profile: name, source, config: profile };
}

export function resolveAgentProfile(
  config: ProfileConfig,
  input: {
    skillId: SkillId;
    cliAdapter?: AdapterId | null;
    cliProfile?: string | null;
    taskProfile?: string | null;
    taskAdapter?: AdapterId | null;
  },
): ResolvedAgentProfile {
  if (input.cliAdapter && input.cliProfile) {
    throw new AdapterConfigError("--adapter and --profile are mutually exclusive");
  }
  if (input.cliAdapter) return { adapterId: input.cliAdapter, source: "cli" };
  if (input.cliProfile) return namedProfile(config, input.cliProfile, "profile");
  const taskScoped = input.skillId === "execute" || input.skillId === "verify";
  if (taskScoped && input.taskProfile) return namedProfile(config, input.taskProfile, "task");
  if (taskScoped && input.taskAdapter) return { adapterId: input.taskAdapter, source: "task" };
  const skillProfile = config.adapter.skillProfiles?.[input.skillId];
  if (skillProfile) return namedProfile(config, skillProfile, "skill-profile");
  const routed = config.adapter.routes?.[input.skillId];
  if (routed) return { adapterId: routed, source: "route" };
  return { adapterId: config.adapter.default, source: "default" };
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function applyUsagePricing(usage: AgentUsage, pricing?: AgentPricing): AgentUsage {
  const inputTokens = finiteNonNegative(usage.inputTokens);
  const outputTokens = finiteNonNegative(usage.outputTokens);
  const explicitTotal = finiteNonNegative(usage.totalTokens);
  const totalTokens = explicitTotal ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  const normalized: AgentUsage = {
    ...usage,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
  // An adapter that reports whether its cost is complete owns that decision.
  // Repricing an explicit false can turn an aggregate of incomplete rounds into
  // an apparently enforceable estimate.
  if (usage.costEstimated !== undefined || !pricing) return normalized;
  const requests = finiteNonNegative(usage.requests);
  if (
    requests === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    pricing.inputPerMillionUsd === undefined ||
    pricing.outputPerMillionUsd === undefined ||
    pricing.requestUsd === undefined
  ) {
    return normalized;
  }
  const estimated =
    (inputTokens / 1_000_000) * pricing.inputPerMillionUsd +
    (outputTokens / 1_000_000) * pricing.outputPerMillionUsd +
    requests * pricing.requestUsd;
  return { ...normalized, estimatedCostUsd: Number(estimated.toFixed(9)), costEstimated: true };
}

export function usageLimitReason(usage: AgentUsage, limits?: AgentLimits): string | null {
  if (!limits) return null;
  if (limits.maxRequests !== undefined && usage.requests !== undefined && usage.requests > limits.maxRequests) {
    return `agent request limit exceeded (${usage.requests} > ${limits.maxRequests})`;
  }
  const reportedTotal = finiteNonNegative(usage.totalTokens);
  const reportedInput = finiteNonNegative(usage.inputTokens);
  const reportedOutput = finiteNonNegative(usage.outputTokens);
  const reportedTokenLowerBound = reportedTotal ??
    (reportedInput !== undefined || reportedOutput !== undefined
      ? (reportedInput ?? 0) + (reportedOutput ?? 0)
      : undefined);
  if (
    limits.maxReportedTokens !== undefined &&
    reportedTokenLowerBound !== undefined &&
    reportedTokenLowerBound > limits.maxReportedTokens
  ) {
    return `reported token threshold exceeded (${reportedTokenLowerBound} > ${limits.maxReportedTokens})`;
  }
  if (limits.maxEstimatedCostUsd !== undefined) {
    if (usage.costEstimated !== true || usage.estimatedCostUsd === undefined) {
      return "cannot enforce estimated cost threshold because this adapter did not report enough usage; guaranteed spending caps are unsupported";
    }
    if (usage.estimatedCostUsd > limits.maxEstimatedCostUsd) {
      return `estimated cost threshold exceeded ($${usage.estimatedCostUsd} > $${limits.maxEstimatedCostUsd})`;
    }
  }
  return null;
}

export function assertProfileRuntimeSupport(resolved: ResolvedAgentProfile): void {
  const profile = resolved.config;
  if (!profile) return;
  if (profile.outputLimit !== undefined && resolved.adapterId !== "http") {
    throw new AdapterConfigError(`profile outputLimit is unsupported for adapter ${resolved.adapterId}`);
  }
  if (
    resolved.adapterId !== "http" &&
    (profile.limits?.maxRequests !== undefined || profile.limits?.maxToolRounds !== undefined)
  ) {
    throw new AdapterConfigError(`hard request/tool-round limits are unsupported for adapter ${resolved.adapterId}`);
  }
  if (profile.limits?.maxEstimatedCostUsd !== undefined) {
    if (resolved.adapterId !== "http") {
      throw new AdapterConfigError(
        `guaranteed spending caps are unsupported for adapter ${resolved.adapterId}; estimated cost thresholds require reported HTTP usage`,
      );
    }
    if (!profile.pricing || Object.keys(profile.pricing).length === 0) {
      throw new AdapterConfigError("maxEstimatedCostUsd requires operator-supplied profile pricing");
    }
  }
}

export function applyProfileArgs<T extends ProfileConfig>(config: T, resolved: ResolvedAgentProfile): T {
  const args = resolved.config?.modelArgs ?? [];
  if (args.length === 0) return config;
  const adapter = resolved.adapterId;
  const currentAdapter = config.adapter as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = { ...currentAdapter };
  if (adapter === "claude") {
    const current = currentAdapter.claude as { extraArgs?: string[] } | undefined;
    next.claude = { ...current, extraArgs: [...(current?.extraArgs ?? []), ...args] };
  } else if (adapter === "generic") {
    const current = currentAdapter.generic as { binary: string; args: string[] } | undefined;
    if (!current) throw new AdapterConfigError("adapter.generic is required by the selected profile");
    next.generic = { ...current, args: [...current.args, ...args] };
  } else if (adapter !== "fake" && adapter !== "http") {
    const current = currentAdapter[adapter] as { binary?: string; args?: string[] } | undefined;
    next[adapter] = { ...current, args: [...(current?.args ?? []), ...args] };
  } else {
    throw new AdapterConfigError(`profile modelArgs are unsupported for adapter ${adapter}`);
  }
  return { ...config, adapter: next } as T;
}
