import type { AgentAdapterId } from "./types.js";

/** Frozen v0 argv. Pointer is substituted at spawn. grok/codex have no spawn argv. */
export const FROZEN_ARGV_TABLE = {
  fake: { binary: "(in-process)", argv: null, spawnable: true },
  claude: {
    binary: "claude",
    argv: ["-p", "--output-format", "json", "{{pointer}}"],
    spawnable: true,
  },
  generic: {
    binary: "adapter.generic.binary",
    argv: ["{{pointer}}"],
    spawnable: true,
  },
  grok: { binary: "grok", argv: null, spawnable: false },
  codex: { binary: "codex", argv: null, spawnable: false },
} as const satisfies Record<
  AgentAdapterId,
  { binary: string; argv: readonly string[] | null; spawnable: boolean }
>;

export const CLAUDE_FROZEN_ARGV = ["-p", "--output-format", "json"] as const;
export const POINTER_PLACEHOLDER = "{{pointer}}";
export const DEFAULT_GENERIC_ARGS = [POINTER_PLACEHOLDER] as const;

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
