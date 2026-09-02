const SECRET_PATTERNS: { name: string; re: RegExp; replacement: string }[] = [
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED:aws-access-key]" },
  { name: "sk", re: /\bsk-[A-Za-z0-9]{20,}/g, replacement: "[REDACTED:sk]" },
  { name: "xai", re: /\bxai-[A-Za-z0-9]{20,}/g, replacement: "[REDACTED:xai]" },
  {
    name: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
  { name: "ghp", re: /ghp_[A-Za-z0-9]+/g, replacement: "[REDACTED:ghp]" },
  { name: "github_pat", re: /github_pat_[A-Za-z0-9_]+/g, replacement: "[REDACTED:github_pat]" },
];

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
