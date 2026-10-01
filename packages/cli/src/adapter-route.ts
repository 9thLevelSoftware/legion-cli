import { HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import {
  ADAPTER_ID_HELP,
  AdapterIdSchema,
  type AdapterId,
  type LegionConfig,
} from "@9thlevelsoftware/legion-cli-schema";

export function expandNamedAdapter(
  config: Pick<LegionConfig, "adapter">,
  route: string,
): AdapterId {
  const named = config.adapter.named;
  if (!named || !Object.hasOwn(named, route)) {
    refuse(`unknown named route ${route}`, HINT.doctor);
  }
  const parsed = AdapterIdSchema.safeParse(named[route]);
  if (!parsed.success) refuse(`unknown named route ${route}`, HINT.doctor);
  return parsed.data;
}

export function parseAdapterFlag(raw: string | undefined): AdapterId | undefined {
  if (raw === undefined) return undefined;
  const parsed = AdapterIdSchema.safeParse(raw.trim());
  if (!parsed.success) {
    refuse(`adapter must be ${ADAPTER_ID_HELP}`, `--adapter ${ADAPTER_ID_HELP}`);
  }
  return parsed.data;
}

export type PersistAdapterFlags = {
  adapter?: string;
  route?: string;
  profile?: string;
  clearAdapter?: boolean;
  clearProfile?: boolean;
};

function resolveProfile(config: Pick<LegionConfig, "adapter">, raw: string): string {
  const profile = raw.trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(profile) || !config.adapter.profiles || !Object.hasOwn(config.adapter.profiles, profile)) {
    refuse(`unknown adapter profile ${profile}`, HINT.doctor);
  }
  return profile;
}

export function resolvePersistAdapter(
  config: Pick<LegionConfig, "adapter">,
  flags: PersistAdapterFlags,
): { adapter?: AdapterId; profile?: string; clearAdapter?: boolean; clearProfile?: boolean } {
  const hasAdapter = flags.adapter !== undefined;
  const hasRoute = flags.route !== undefined;
  const hasProfile = flags.profile !== undefined;
  if (hasProfile && (hasAdapter || hasRoute)) {
    refuse("--profile is mutually exclusive with --adapter and --route", HINT.amend);
  }
  if (flags.clearProfile && hasProfile) {
    refuse("--clear-profile cannot be combined with --profile", HINT.amend);
  }
  if (flags.clearAdapter && (hasAdapter || hasRoute)) {
    refuse("--clear-adapter cannot be combined with --adapter or --route", HINT.amend);
  }
  if (flags.clearAdapter || flags.clearProfile) return { clearAdapter: flags.clearAdapter, clearProfile: flags.clearProfile };
  if (flags.profile !== undefined) return { profile: resolveProfile(config, flags.profile) };
  if (flags.adapter !== undefined) return { adapter: parseAdapterFlag(flags.adapter), clearProfile: true };
  if (flags.route !== undefined) return { adapter: expandNamedAdapter(config, flags.route), clearProfile: true };
  return {};
}
