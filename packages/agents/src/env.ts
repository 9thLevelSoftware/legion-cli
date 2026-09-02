import type { AgentAdapterId } from "./types.js";

const BASE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "ComSpec",
  "TERM",
] as const;

/** Vendor credentials allowed only for the adapter being spawned. */
export const ADAPTER_CREDENTIAL_KEYS = {
  fake: [] as const,
  generic: [] as const,
  claude: ["CLAUDE_API_KEY"],
  grok: ["GROK_API_KEY", "XAI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  mimo: [] as const,
  minimax: ["MINIMAX_API_KEY"],
} as const satisfies Record<AgentAdapterId, readonly string[]>;

/** Windows CreateProcess / node.exe fail without these even when PATH is set. */
const WINDOWS_INHERIT = ["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PATHEXT"] as const;

function inferAdapterIdFromBinary(binary?: string): AgentAdapterId | undefined {
  if (!binary) return undefined;
  const base =
    binary.replaceAll("\\", "/").split("/").pop()?.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase() ?? "";
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  if (base === "grok") return "grok";
  if (base === "mimo") return "mimo";
  if (base === "mcode") return "minimax";
  return undefined;
}

function credentialKeysFor(adapterId?: AgentAdapterId, binary?: string): readonly string[] {
  if (adapterId && adapterId !== "generic" && adapterId !== "fake") {
    return ADAPTER_CREDENTIAL_KEYS[adapterId];
  }
  if (adapterId === "generic") {
    const inferred = inferAdapterIdFromBinary(binary);
    if (inferred) return ADAPTER_CREDENTIAL_KEYS[inferred];
  }
  return adapterId ? ADAPTER_CREDENTIAL_KEYS[adapterId] : [];
}

function allowKey(key: string, adapterId?: AgentAdapterId, binary?: string): boolean {
  const upper = key.toUpperCase();
  if (BASE_ENV_ALLOWLIST.some((name) => name.toUpperCase() === upper)) return true;
  if (process.platform === "win32" && WINDOWS_INHERIT.some((name) => name === upper)) return true;
  return credentialKeysFor(adapterId, binary).some((name) => name.toUpperCase() === upper);
}

/**
 * Build a spawn env from the user process.
 * SSH_AUTH_SOCK is inherited when present, never injected into a blank env.
 * Provider credentials are included only for `adapterId` (generic infers from binary).
 */
export function filterSpawnEnv(
  source: NodeJS.ProcessEnv = process.env,
  adapterId?: AgentAdapterId,
  binary?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (allowKey(key, adapterId, binary) || key.toUpperCase() === "SSH_AUTH_SOCK") {
      out[key] = value;
    }
  }
  return out;
}
