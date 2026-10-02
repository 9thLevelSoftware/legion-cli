#!/usr/bin/env node
// Bundles the repo's `skills/` into the agents package so the published CLI finds them
// without a cloned repo (F-025). Run by `prepack` (copy) and `postpack` (--clean); the copy
// is gitignored and removed after packing so a checkout never resolves a stale copy.
// Usage: node scripts/copy-skills.mjs [--clean] [--target <dir>]   (run from any cwd; the default
// source and target are script-relative; --target exists for the test)
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "skills");
const targetIdx = process.argv.indexOf("--target");
const target =
  targetIdx >= 0 && process.argv[targetIdx + 1]
    ? resolve(process.argv[targetIdx + 1])
    : join(repoRoot, "packages", "agents", "skills");

if (process.argv.includes("--clean")) {
  rmSync(target, { recursive: true, force: true });
  process.exit(0);
}

if (!existsSync(join(source, "plan", "SKILL.md"))) {
  console.error(`copy-skills: ${source} has no plan/SKILL.md; refusing to pack without skills`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`copy-skills: ${readdirSync(target).length} skill folders -> ${target}`);
