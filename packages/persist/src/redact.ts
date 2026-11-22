type SecretRule = {
  name: string;
  source: string;
  replacement: string;
};

const SECRET_RULES: ReadonlyArray<SecretRule> = [
  { name: "aws-access-key", source: "AKIA[0-9A-Z]{16}", replacement: "[REDACTED:aws-access-key]" },
  { name: "aws-sts-key", source: "ASIA[0-9A-Z]{16}", replacement: "[REDACTED:aws-sts-key]" },
  { name: "sk-proj", source: "\\bsk-proj-[A-Za-z0-9_-]{8,}", replacement: "[REDACTED:sk-proj]" },
  { name: "sk-ant", source: "\\bsk-ant-[A-Za-z0-9_-]{8,}", replacement: "[REDACTED:sk-ant]" },
  { name: "sk", source: "\\bsk-[A-Za-z0-9]{20,}", replacement: "[REDACTED:sk]" },
  { name: "xai", source: "\\bxai-[A-Za-z0-9]{20,}", replacement: "[REDACTED:xai]" },
  {
    name: "private-key",
    source: "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
    replacement: "[REDACTED:private-key]",
  },
  { name: "ghp", source: "ghp_[A-Za-z0-9]+", replacement: "[REDACTED:ghp]" },
  { name: "github_pat", source: "github_pat_[A-Za-z0-9_]+", replacement: "[REDACTED:github_pat]" },
  { name: "github-token", source: "gh[ousr]_[A-Za-z0-9_]{20,}", replacement: "[REDACTED:github-token]" },
  { name: "gitlab-pat", source: "glpat-[A-Za-z0-9_-]{20,}", replacement: "[REDACTED:gitlab-pat]" },
  { name: "slack-token", source: "xox[baprs]-[A-Za-z0-9-]{10,}", replacement: "[REDACTED:slack-token]" },
  { name: "google-api-key", source: "AIza[0-9A-Za-z_-]{35}", replacement: "[REDACTED:google-api-key]" },
  {
    name: "url-credentials",
    // Negative lookahead avoids re-matching the `[REDACTED]` placeholder inserted by `redactSecrets`.
    source: "([A-Za-z][A-Za-z0-9+.-]*:\\/\\/[^\\/\\s:@]+:)(?!\\[REDACTED\\]@)[^\\/\\s@]+(@)",
    replacement: "$1[REDACTED]$2",
  },
];

export const SECRET_SOURCE_PATTERNS: ReadonlyArray<{ name: string; source: string }> = Object.freeze(
  SECRET_RULES.map(({ name, source }) => Object.freeze({ name, source })),
);

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; replacement: string }> = SECRET_RULES.map(
  ({ name, source, replacement }) => ({
    name,
    re: new RegExp(source, "g"),
    replacement,
  }),
);

/** Best-effort redaction before a wiki write; not a complete secret scanner. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    out = out.replace(pattern.re, pattern.replacement);
  }
  return out;
}

export function hasSecretPattern(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.re.lastIndex = 0;
    return pattern.re.test(text);
  });
}
