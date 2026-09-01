import type { AgentAdapterId, ExtraAdapterId } from "./types.js";

export const POINTER_PLACEHOLDER = "{{pointer}}";
export const DEFAULT_GENERIC_ARGS = [POINTER_PLACEHOLDER] as const;
export const CLAUDE_FROZEN_ARGV = ["-p", "--output-format", "json"] as const;

/** Assumed PATH names. Not verified vendor CLIs; tests spawn via shim override. */
export const ASSUMED_EXTRA_BINARIES = {
  grok: "grok",
  codex: "codex",
} as const satisfies Record<ExtraAdapterId, string>;

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
  codex: {
    binary: ASSUMED_EXTRA_BINARIES.codex,
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

export function buildGenericArgv(args: readonly string[], pointerPrompt: string): string[] {
  return args.map((arg) => arg.replaceAll(POINTER_PLACEHOLDER, pointerPrompt));
}
