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
  clearAdapter?: boolean;
};

export function resolvePersistAdapter(
  config: Pick<LegionConfig, "adapter">,
  flags: PersistAdapterFlags,
): { adapter?: AdapterId; clearAdapter?: boolean } {
  const hasAdapter = flags.adapter !== undefined;
  const hasRoute = flags.route !== undefined;
  if (flags.clearAdapter && (hasAdapter || hasRoute)) {
    refuse("--clear-adapter cannot be combined with --adapter or --route", HINT.amend);
  }
  if (flags.clearAdapter) return { clearAdapter: true };
  if (flags.adapter !== undefined) return { adapter: parseAdapterFlag(flags.adapter) };
  if (flags.route !== undefined) return { adapter: expandNamedAdapter(config, flags.route) };
  return {};
}
