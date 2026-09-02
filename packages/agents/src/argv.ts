import { ASSUMED_EXTRA_BINARIES, type ExtraAdapterId } from "@9thlevelsoftware/legion-cli-schema";
import type { AgentAdapterId } from "./types.js";

export { ASSUMED_EXTRA_BINARIES };

export const POINTER_PLACEHOLDER = "{{pointer}}";
export const DEFAULT_GENERIC_ARGS = [POINTER_PLACEHOLDER] as const;
export const CLAUDE_FROZEN_ARGV = ["-p", "--output-format", "json"] as const;
/** Codex CLI: `codex exec` is the non-interactive subcommand. `openai` shares binary `codex`. */
export const CODEX_FROZEN_ARGV = ["exec", POINTER_PLACEHOLDER] as const;

/** Frozen argv. Extra adapters stay generic-style until vendor flags are verified. */
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
    argv: DEFAULT_GENERIC_ARGS,
    spawnable: true,
  },
  openai: {
    binary: ASSUMED_EXTRA_BINARIES.openai,
    argv: CODEX_FROZEN_ARGV,
    spawnable: true,
  },
  codex: {
    binary: ASSUMED_EXTRA_BINARIES.codex,
    argv: CODEX_FROZEN_ARGV,
    spawnable: true,
  },
  mimo: {
    binary: ASSUMED_EXTRA_BINARIES.mimo,
    argv: DEFAULT_GENERIC_ARGS,
    spawnable: true,
  },
  minimax: {
    binary: ASSUMED_EXTRA_BINARIES.minimax,
    argv: DEFAULT_GENERIC_ARGS,
    spawnable: true,
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

/** Empty extra-adapter args use that id's frozen argv (`codex exec {{pointer}}` for openai/codex). */
export function extraArgsOrDefault(id: ExtraAdapterId, args: readonly string[] = []): string[] {
  if (args.length > 0) return [...args];
  const frozen = FROZEN_ARGV_TABLE[id].argv;
  return frozen ? [...frozen] : [...DEFAULT_GENERIC_ARGS];
}

export function buildGenericArgv(args: readonly string[], pointerPrompt: string): string[] {
  return args.map((arg) => arg.replaceAll(POINTER_PLACEHOLDER, pointerPrompt));
}
