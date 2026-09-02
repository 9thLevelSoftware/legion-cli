import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const GITIGNORE_ENTRIES = [
  ".legion-cli/index/",
  ".legion-cli/cache/",
  ".legion-cli/index/engine.lock",
] as const;

export const GITIGNORE_TEMPLATE = [
  "# Legion CLI derived index, cache, and lock",
  ...GITIGNORE_ENTRIES,
  "",
].join("\n");

export async function ensureGitignore(projectRoot: string): Promise<void> {
  const file = join(projectRoot, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }

  if (existing === "") {
    await writeFile(file, GITIGNORE_TEMPLATE, "utf8");
    return;
  }

  const present = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;

  const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
  await writeFile(file, `${prefix}${missing.join("\n")}\n`, "utf8");
}
