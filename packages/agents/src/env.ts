const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "ComSpec",
  "CLAUDE_API_KEY",
  "GROK_API_KEY",
  "XAI_API_KEY",
  "OPENAI_API_KEY",
  "MINIMAX_API_KEY",
  "TERM",
] as const;

/** Windows CreateProcess / node.exe fail without these even when PATH is set. */
const WINDOWS_INHERIT = ["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PATHEXT"] as const;

function allowKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (ENV_ALLOWLIST.some((name) => name.toUpperCase() === upper)) return true;
  if (process.platform === "win32" && WINDOWS_INHERIT.some((name) => name === upper)) return true;
  return false;
}

/**
 * Build a spawn env from the user process.
 * SSH_AUTH_SOCK is inherited when present, never injected into a blank env.
 */
export function filterSpawnEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (allowKey(key) || key.toUpperCase() === "SSH_AUTH_SOCK") {
      out[key] = value;
    }
  }
  return out;
}
