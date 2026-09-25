import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_SECRET_WALK_DEPTH = 16;

const SECRET_PATTERNS: { name: string; source: string }[] = [
  { name: "aws-access-key", source: "AKIA[0-9A-Z]{16}" },
  { name: "sk-proj", source: "\\bsk-proj-[A-Za-z0-9_-]{8,}" },
  { name: "sk-ant", source: "\\bsk-ant-[A-Za-z0-9_-]{8,}" },
  { name: "sk", source: "\\bsk-[A-Za-z0-9]{20,}" },
  { name: "xai", source: "\\bxai-[A-Za-z0-9]{20,}" },
  { name: "private-key", source: "-----BEGIN [A-Z ]*PRIVATE KEY-----" },
  { name: "ghp", source: "ghp_[A-Za-z0-9]+" },
  { name: "github_pat", source: "github_pat_[A-Za-z0-9_]+" },
];

export type SecretHit = {
  file: string;
  name: string;
};

async function walkFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SECRET_WALK_DEPTH) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: string[] = [];
  for (const name of names) {
    const abs = join(dir, name);
    let info;
    try {
      info = await lstat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      files.push(...(await walkFiles(abs, depth + 1)));
    } else if (info.isFile()) {
      files.push(abs);
    }
  }
  return files;
}

function hasSecret(text: string, source: string): boolean {
  return new RegExp(source).test(text);
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
      if (hasSecret(text, pattern.source)) {
        hits.push({ file, name: pattern.name });
      }
    }
  }
  return hits;
}
