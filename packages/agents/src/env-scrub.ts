/**
 * Names that look like credentials (KD-4): a trailing TOKEN, KEY, APIKEY, SECRET, PASSWORD,
 * PASSWD, PAT, AUTH, AUTHTOKEN, CREDENTIAL(S) or CONNECTION_STRING word.
 * `DATABASE_URL` and other plain settings are kept.
 */
export const SECRET_ENV_NAME =
  /(^|_)(TOKEN|KEY|APIKEY|SECRET|PASSWORD|PASSWD|PAT|AUTH|AUTHTOKEN|CREDENTIALS?|CONNECTION_STRING)$/i;

/** npm reads registry auth from `npm_config__auth*` and `npm_config_//host/:_authToken`. */
const NPM_AUTH_ENV_NAME = /^npm_config_.*_auth/i;

const ALWAYS_SCRUBBED = new Set(["AWS_ACCESS_KEY_ID", "GOOGLE_APPLICATION_CREDENTIALS", "SSH_AUTH_SOCK"]);

export function isSecretEnvName(name: string, extraNames: readonly string[] = []): boolean {
  const upper = name.toUpperCase();
  if (ALWAYS_SCRUBBED.has(upper)) return true;
  if (extraNames.some((extra) => extra.toUpperCase() === upper)) return true;
  return SECRET_ENV_NAME.test(name) || NPM_AUTH_ENV_NAME.test(name);
}

/**
 * A copy of `source` without API keys, tokens and other credentials, for commands Legion runs
 * outside the sandbox on the user's machine (verification, QA's unit command).
 * `extraNames` adds configured names such as `adapter.http.apiKeyEnv`.
 */
export function scrubSecretsEnv(
  source: NodeJS.ProcessEnv = process.env,
  opts?: { extraNames?: readonly string[] },
): NodeJS.ProcessEnv {
  const extra = opts?.extraNames ?? [];
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isSecretEnvName(key, extra)) continue;
    out[key] = value;
  }
  return out;
}
