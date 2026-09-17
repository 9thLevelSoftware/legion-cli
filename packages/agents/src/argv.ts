import { ASSUMED_EXTRA_BINARIES, type ExtraAdapterId, type LegionConfig } from "@9thlevelsoftware/legion-cli-schema";
import type { AgentAdapterId } from "./types.js";

export { ASSUMED_EXTRA_BINARIES };

export const POINTER_PLACEHOLDER = "{{pointer}}";
export const DEFAULT_GENERIC_ARGS = [POINTER_PLACEHOLDER] as const;
export const CLAUDE_FROZEN_ARGV = ["-p", "--output-format", "json"] as const;

/**
 * Frozen extra-adapter argv (KD-7). `{{pointer}}` is the Legion pointer-prompt
 * text, not a file path. Retrieved 2026-09-16 from public vendor docs. Do not
 * invent flags here; operator extraArgs may append after the vendor prefix.
 *
 * - grok: https://docs.x.ai/build/cli/headless-scripting — `grok -p`
 * - openai/codex: https://developers.openai.com/codex/noninteractive — `codex exec`
 * - mimo: https://mimo.xiaomi.com/mimocode/cli-options — `mimo run`
 * - minimax: https://agent.minimax.io/docs/cli/reference — `mcode exec` (`mcode` is not an AdapterId)
 */
export const GROK_FROZEN_ARGV = ["-p", POINTER_PLACEHOLDER] as const;
export const CODEX_FROZEN_ARGV = ["exec", POINTER_PLACEHOLDER] as const;
export const MIMO_FROZEN_ARGV = ["run", POINTER_PLACEHOLDER] as const;
export const MINIMAX_FROZEN_ARGV = ["exec", POINTER_PLACEHOLDER] as const;

/** KD-7 table: id → frozen argv. Tests deepEqual `FROZEN_ARGV_TABLE[id].argv` to these rows. */
export const KD7_EXTRA_ARGV = {
  grok: GROK_FROZEN_ARGV,
  openai: CODEX_FROZEN_ARGV,
  codex: CODEX_FROZEN_ARGV,
  mimo: MIMO_FROZEN_ARGV,
  minimax: MINIMAX_FROZEN_ARGV,
} as const satisfies Record<ExtraAdapterId, readonly string[]>;

/** Frozen argv. Extra adapters use verified vendor argv (KD-7); generic stays `{{pointer}}`. */
export const FROZEN_ARGV_TABLE = {
  fake: { binary: "(in-process)", argv: null, spawnable: true },
  claude: {
    binary: "claude",
    argv: ["-p", "--output-format", "json", "{{pointer}}"],
    spawnable: true,
  },
  generic: {
    binary: "adapter.generic.binary",
    argv: DEFAULT_GENERIC_ARGS,
    spawnable: true,
  },
  grok: {
    binary: ASSUMED_EXTRA_BINARIES.grok,
    argv: KD7_EXTRA_ARGV.grok,
    spawnable: true,
  },
  openai: {
    binary: ASSUMED_EXTRA_BINARIES.openai,
    argv: KD7_EXTRA_ARGV.openai,
    spawnable: true,
  },
  codex: {
    binary: ASSUMED_EXTRA_BINARIES.codex,
    argv: KD7_EXTRA_ARGV.codex,
    spawnable: true,
  },
  mimo: {
    binary: ASSUMED_EXTRA_BINARIES.mimo,
    argv: KD7_EXTRA_ARGV.mimo,
    spawnable: true,
  },
  minimax: {
    binary: ASSUMED_EXTRA_BINARIES.minimax,
    argv: KD7_EXTRA_ARGV.minimax,
    spawnable: true,
  },
  http: {
    binary: "(http)",
    argv: null,
<<<<<<< HEAD
    spawnable: false,
=======
    spawnable: true,
>>>>>>> 0f2ff18 (fix: address review feedback for http adapter tool-loop)
  },
} as const satisfies Record<
  AgentAdapterId,
  { binary: string; argv: readonly string[] | null; spawnable: boolean }
>;

export function buildClaudeArgv(pointerPrompt: string, extraArgs: readonly string[] = []): string[] {
  return [...CLAUDE_FROZEN_ARGV, ...extraArgs, pointerPrompt];
}

export function argsIncludePointer(args: readonly string[]): boolean {
  return args.some((arg) => arg.includes(POINTER_PLACEHOLDER));
}

/** Empty args (init without --generic-args) still deliver the frozen pointer. */
export function genericArgsOrDefault(args: readonly string[]): string[] {
  return args.length === 0 ? [...DEFAULT_GENERIC_ARGS] : [...args];
}

export function basenameBinary(binary: string): string {
  return binary.replaceAll("\\", "/").split("/").pop()?.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase() ?? "";
}

/** First frozen token (`-p` / `exec` / `run`). Required when spawning the assumed vendor binary. */
export function extraVendorPrefix(id: ExtraAdapterId): string {
  return KD7_EXTRA_ARGV[id][0];
}

export function usesAssumedExtraBinary(id: ExtraAdapterId, binary?: string): boolean {
  return basenameBinary(binary ?? ASSUMED_EXTRA_BINARIES[id]) === ASSUMED_EXTRA_BINARIES[id];
}

/**
 * Prefix-compatible extension of the KD-7 frozen template.
 * Assumed vendor binary: argv must start with `-p` / `exec` / `run`.
 * Overridden binary (CI shim, `adapter.<id>.binary: node`): prefix is not required.
 */
export function extraArgvPrefixCompatible(
  id: ExtraAdapterId,
  args: readonly string[],
  binary?: string,
): boolean {
  if (!usesAssumedExtraBinary(id, binary)) return true;
  if (args[0] !== extraVendorPrefix(id)) return false;
  // grok `-p` consumes the next argv token as the prompt.
  if (id === "grok") return args[1] === POINTER_PLACEHOLDER;
  return true;
}

/** Empty extra-adapter args use that id's frozen vendor argv. Explicit args are not auto-repaired. */
export function extraArgsOrDefault(id: ExtraAdapterId, args: readonly string[] = [], _binary?: string): string[] {
  if (args.length === 0) {
    return [...KD7_EXTRA_ARGV[id]];
  }
  return [...args];
}

export function extraArgvIsSpawnable(
  id: ExtraAdapterId,
  args: readonly string[] = [],
  binary?: string,
): boolean {
  const resolved = extraArgsOrDefault(id, args, binary);
  return argsIncludePointer(resolved) && extraArgvPrefixCompatible(id, resolved, binary);
}

export function extraArgvRefuseReason(
  id: ExtraAdapterId,
  args: readonly string[],
  binary?: string,
): string | null {
  if (!argsIncludePointer(args)) return `adapter.${id}.args must include {{pointer}}`;
  if (!extraArgvPrefixCompatible(id, args, binary)) {
    if (id === "grok" && usesAssumedExtraBinary(id, binary) && args[0] === extraVendorPrefix(id)) {
      return "adapter.grok.args must put {{pointer}} immediately after -p";
    }
    return `adapter.${id}.args must keep ${extraVendorPrefix(id)} (vendor argv)`;
  }
  return null;
}

export function buildGenericArgv(args: readonly string[], pointerPrompt: string): string[] {
  return args.map((arg) => arg.replaceAll(POINTER_PLACEHOLDER, pointerPrompt));
}

/** Template argv for resume/audit. `{{pointer}}` is left unexpanded. */
export function templateArgv(
  id: AgentAdapterId,
  config: Pick<LegionConfig, "adapter">,
): { binary: string; argv: readonly string[] } {
  switch (id) {
    case "fake":
      return { binary: FROZEN_ARGV_TABLE.fake.binary, argv: [] };
    case "claude":
      return {
        binary: FROZEN_ARGV_TABLE.claude.binary,
        argv: [...CLAUDE_FROZEN_ARGV, ...(config.adapter.claude?.extraArgs ?? []), POINTER_PLACEHOLDER],
      };
    case "generic":
      return {
        binary: config.adapter.generic?.binary ?? FROZEN_ARGV_TABLE.generic.binary,
        argv: genericArgsOrDefault(config.adapter.generic?.args ?? []),
      };
    case "grok":
    case "openai":
    case "codex":
    case "mimo":
    case "minimax": {
      const extra = config.adapter[id];
      const binary = extra?.binary ?? ASSUMED_EXTRA_BINARIES[id];
      return {
        binary,
        argv: extraArgsOrDefault(id, extra?.args ?? [], binary),
      };
    }
    case "http":
      return { binary: FROZEN_ARGV_TABLE.http.binary, argv: [] };
  }
}
