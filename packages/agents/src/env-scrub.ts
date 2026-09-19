/**
 * Names that look like credentials (KD-4, widened in review): a trailing TOKEN, ACCESSTOKEN,
 * KEY, APIKEY, SECRET, PASSWORD, PASSWD, PASS, PWD, PAT, AUTH, AUTHTOKEN, CREDENTIAL(S),
 * CONNECTION_STRING or WEBHOOK(_URL) word. `DATABASE_URL` and other plain settings are kept.
 */
export const SECRET_ENV_NAME =
  /(^|_)(TOKEN|ACCESSTOKEN|KEY|APIKEY|SECRET|PASSWORD|PASSWD|PASS|PWD|PAT|AUTH|AUTHTOKEN|CREDENTIALS?|CONNECTION_STRING|WEBHOOK|WEBHOOK_URL)$/i;

/** Any name containing ACCESSTOKEN, e.g. Azure Pipelines' SYSTEM_ACCESSTOKEN. */
const ACCESS_TOKEN_ANYWHERE = /ACCESSTOKEN/i;

/** npm reads registry auth from `npm_config__auth*` and `npm_config_//host/:_authToken`. */
const NPM_AUTH_ENV_NAME = /^npm_config_.*_auth/i;

/** VS Code's git credential bridge: a child could ask the editor for git credentials. */
const VSCODE_GIT_ENV_NAME = /^VSCODE_GIT_(IPC_HANDLE|ASKPASS)/i;

const ALWAYS_SCRUBBED = new Set([
  "AWS_ACCESS_KEY_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "SSH_AUTH_SOCK",
  "PGPASSWORD",
  "MYSQL_PWD",
  "DOCKER_AUTH_CONFIG",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
]);

/** `PWD` (and `OLDPWD`) is the working directory on POSIX, not a password. */
const NOT_SECRETS = new Set(["PWD", "OLDPWD"]);

export function isSecretEnvName(name: string, extraNames: readonly string[] = []): boolean {
  const upper = name.toUpperCase();
  if (extraNames.some((extra) => extra.toUpperCase() === upper)) return true;
  if (NOT_SECRETS.has(upper)) return false;
  if (ALWAYS_SCRUBBED.has(upper)) return true;
  return (
    SECRET_ENV_NAME.test(name) ||
    ACCESS_TOKEN_ANYWHERE.test(name) ||
    NPM_AUTH_ENV_NAME.test(name) ||
    VSCODE_GIT_ENV_NAME.test(name)
  );
}

/**
 * A copy of `source` without API keys, tokens and other credentials, for commands Legion runs
 * outside the sandbox on the user's machine (verification, QA's unit command).
 * `extraNames` adds configured names such as `adapter.http.apiKeyEnv`. File-based credentials
 * (`~/.npmrc`, `~/.aws`, the git credential manager, the Windows OpenSSH agent pipe) stay
 * readable: this is defence in depth, not a sandbox.
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
