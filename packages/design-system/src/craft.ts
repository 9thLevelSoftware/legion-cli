import { existsSync } from "node:fs";
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CRAFT_SLUGS, packageRootFromModule } from "./paths.js";

export function findCraftDir(from = process.cwd()): string | undefined {
  const env = process.env.LEGION_CLI_CRAFT_DIR?.trim();
  if (env && existsSync(join(env, "typography.md"))) return env;

  const starts = [packageRootFromModule(), from];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // ignore
  }
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 12; i++) {
      for (const candidate of [join(dir, "craft"), dir]) {
        if (existsSync(join(candidate, "typography.md"))) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

export async function copyShippedCraft(destDir: string): Promise<string[]> {
  const src = findCraftDir();
  await mkdir(destDir, { recursive: true });
  if (!src) return [];
  const copied: string[] = [];
  for (const slug of CRAFT_SLUGS) {
    const name = `${slug}.md`;
    const from = join(src, name);
    if (!existsSync(from)) continue;
    await cp(from, join(destDir, name), { dereference: true, force: true });
    copied.push(slug);
  }
  return copied;
}

export async function readCraftFiles(craftDir: string): Promise<Array<{ slug: string; body: string }>> {
  const out: Array<{ slug: string; body: string }> = [];
  for (const slug of CRAFT_SLUGS) {
    const file = join(craftDir, `${slug}.md`);
    if (!existsSync(file)) continue;
    out.push({ slug, body: await readFile(file, "utf8") });
  }
  return out;
}
