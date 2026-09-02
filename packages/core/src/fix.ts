import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

/** Default product files a bug fix is allowed to create or edit. */
export const LIKELY_PRODUCT_PATHS = [
  "src/main.js",
  "src/main.ts",
  "src/index.js",
  "src/index.ts",
  "src/board.js",
  "src/board.ts",
] as const;

export const PRODUCT_ENTRY = "src/main.js";

export function regressionSlug(bug: string): string {
  const slug = bug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "bug";
}

export function regressionTestPath(bug: string): string {
  return `tests/unit/regression/${regressionSlug(bug)}.test.mjs`;
}

export function quoteCommandArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function regressionVerifyCommand(testPath: string): string {
  return `${quoteCommandArg(process.execPath)} --test ${quoteCommandArg(testPath)}`;
}

export function regressionTestSource(bug: string): string {
  const title = `${bug.trim()} @p0`;
  return [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    "",
    `test(${JSON.stringify(title)}, async () => {`,
    `  const mod = await import(new URL("../../../${PRODUCT_ENTRY}", import.meta.url).href);`,
    '  assert.equal(mod.ok, true, "this does not reproduce");',
    "});",
    "",
  ].join("\n");
}

function walkSourceFiles(projectRoot: string, rel: string, add: (posix: string) => void): void {
  const abs = join(projectRoot, ...rel.split("/"));
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const posix = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      walkSourceFiles(projectRoot, posix, add);
    } else if (entry.isFile() && /\.(ts|js|mjs|cjs|tsx|jsx)$/.test(entry.name)) {
      add(posix);
    }
  }
}

/** Concrete product paths the bug task may write (v0 has no globs). */
export function productSourcePaths(projectRoot: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (posix: string) => {
    if (seen.has(posix)) return;
    seen.add(posix);
    out.push(posix);
  };
  for (const path of LIKELY_PRODUCT_PATHS) add(path);
  walkSourceFiles(projectRoot, "src", add);
  return out.slice(0, 16);
}

export function fixFilesAllowed(projectRoot: string, testPath: string): string[] {
  return [testPath, ...productSourcePaths(projectRoot).filter((path) => path !== testPath)];
}

export async function ensureRegressionTest(projectRoot: string, testPath: string, bug: string): Promise<boolean> {
  const abs = join(projectRoot, ...testPath.split("/"));
  if (existsSync(abs)) return false;
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, regressionTestSource(bug), "utf8");
  return true;
}
