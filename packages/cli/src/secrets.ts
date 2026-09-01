import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "sk", re: /\bsk-[A-Za-z0-9]{20,}/g },
  { name: "xai", re: /\bxai-[A-Za-z0-9]{20,}/g },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "ghp", re: /ghp_[A-Za-z0-9]+/g },
  { name: "github_pat", re: /github_pat_[A-Za-z0-9_]+/g },
];

export type SecretHit = {
  file: string;
  name: string;
};

async function walkFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: string[] = [];
  for (const name of entries) {
    const abs = join(dir, name);
    const info = await stat(abs);
    if (info.isDirectory()) {
      files.push(...(await walkFiles(abs)));
    } else if (info.isFile()) {
      files.push(abs);
    }
  }
  return files;
}

export async function scanWikiSecrets(wikiDir: string): Promise<SecretHit[]> {
  const files = await walkFiles(wikiDir);
  const hits: SecretHit[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const pattern of SECRET_PATTERNS) {
      pattern.re.lastIndex = 0;
      if (pattern.re.test(text)) {
        hits.push({ file, name: pattern.name });
      }
    }
  }
  return hits;
}
