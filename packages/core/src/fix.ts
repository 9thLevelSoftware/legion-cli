import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

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
    `test(${JSON.stringify(title)}, () => {`,
    '  assert.fail("this does not reproduce");',
    "});",
    "",
  ].join("\n");
}

export async function ensureRegressionTest(projectRoot: string, testPath: string, bug: string): Promise<boolean> {
  const abs = join(projectRoot, ...testPath.split("/"));
  if (existsSync(abs)) return false;
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, regressionTestSource(bug), "utf8");
  return true;
}
