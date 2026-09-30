#!/usr/bin/env node
// Fails when a non-private workspace package is not on the root `legionPublishAllowlist` (F-072),
// or when an allowlisted name is not a workspace package. publish.yml runs this before publishing.
// Usage: node scripts/check-publish-allowlist.mjs [rootDir]   (default: the repo root)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const allow = rootPkg.legionPublishAllowlist;
if (!Array.isArray(allow) || allow.length === 0) {
  console.error("check-publish-allowlist: root package.json has no legionPublishAllowlist");
  process.exit(1);
}

const packagesDir = join(root, "packages");
const publishable = [];
const all = [];
for (const entry of existsSync(packagesDir) ? readdirSync(packagesDir, { withFileTypes: true }) : []) {
  const manifest = join(packagesDir, entry.name, "package.json");
  if (!entry.isDirectory() || !existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  all.push(pkg.name);
  if (pkg.private !== true) publishable.push(pkg.name);
}

const unlisted = publishable.filter((name) => !allow.includes(name));
const stale = allow.filter((name) => !all.includes(name));
if (unlisted.length > 0) {
  console.error(
    `check-publish-allowlist: not on legionPublishAllowlist (add it, or mark the package private): ${unlisted.join(", ")}`,
  );
}
if (stale.length > 0) {
  console.error(`check-publish-allowlist: on the allowlist but not a workspace package: ${stale.join(", ")}`);
}
if (unlisted.length > 0 || stale.length > 0) process.exit(1);
console.log(`check-publish-allowlist: ${publishable.length} publishable packages, all on the allowlist`);
