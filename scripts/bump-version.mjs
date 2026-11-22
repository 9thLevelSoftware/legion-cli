#!/usr/bin/env node
// Bumps workspace package versions, Cargo [workspace.package] version, and Cargo.lock entries in lockstep.
// Usage: node scripts/bump-version.mjs <newVersion> [rootDir]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

const REQUIRED_CARGO_LOCK_CRATES = [
  "legion-wasi-host",
  "legion-json-contract",
  "legion-pack-component",
];
const ALL_WORKSPACE_CRATES = new Set([
  ...REQUIRED_CARGO_LOCK_CRATES,
  "legion-strict-json",
  "legion-component-fixtures",
]);

function parseArgs(argv) {
  const positionals = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) {
      console.error(`bump-version: unknown option ${arg}`);
      console.error("Usage: node scripts/bump-version.mjs <newVersion> [rootDir]");
      process.exit(1);
    }
    positionals.push(arg);
  }
  if (positionals.length < 1 || positionals.length > 2) {
    console.error("Usage: node scripts/bump-version.mjs <newVersion> [rootDir]");
    process.exit(1);
  }
  const [newVersion, rootArg] = positionals;
  if (!SEMVER_RE.test(newVersion)) {
    console.error(`bump-version: invalid semver ${JSON.stringify(newVersion)}`);
    process.exit(1);
  }
  return {
    newVersion,
    root: resolve(rootArg ?? join(dirname(fileURLToPath(import.meta.url)), "..")),
  };
}

function updateCargoToml(cargoTomlPath, newVersion) {
  if (!existsSync(cargoTomlPath)) {
    throw new Error(`Missing ${cargoTomlPath}`);
  }
  const raw = readFileSync(cargoTomlPath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  let inWorkspacePackage = false;
  let updated = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[") && !trimmed.startsWith("[[")) {
      inWorkspacePackage = /^\[workspace\.package\]\s*(?:#.*)?$/.test(trimmed);
      continue;
    }
    if (inWorkspacePackage) {
      const match = lines[i].match(/^(\s*version\s*=\s*)"([^"]*)"(.*)$/);
      if (match) {
        lines[i] = `${match[1]}"${newVersion}"${match[3]}`;
        updated = true;
        break;
      }
    }
  }
  if (!updated) {
    throw new Error(`Could not find [workspace.package] version in ${cargoTomlPath}`);
  }
  writeFileSync(cargoTomlPath, lines.join(eol), "utf8");
}

function updateCargoLock(cargoLockPath, newVersion) {
  if (!existsSync(cargoLockPath)) {
    throw new Error(`Missing ${cargoLockPath}`);
  }
  const raw = readFileSync(cargoLockPath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const updatedCrates = new Set();

  let inPackage = false;
  let pkgStart = -1;
  const flushPackage = (endExclusive) => {
    if (!inPackage || pkgStart < 0) return;
    let crateName = null;
    let hasSource = false;
    let versionLine = -1;
    for (let i = pkgStart; i < endExclusive; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("name = ")) {
        const m = trimmed.match(/^name\s*=\s*"([^"]+)"$/);
        if (m) crateName = m[1];
      } else if (trimmed.startsWith("version = ")) {
        versionLine = i;
      } else if (trimmed.startsWith("source = ")) {
        hasSource = true;
      }
    }
    if (crateName && !hasSource && ALL_WORKSPACE_CRATES.has(crateName) && versionLine >= 0) {
      const match = lines[versionLine].match(/^(\s*version\s*=\s*)"([^"]*)"(.*)$/);
      if (match) {
        lines[versionLine] = `${match[1]}"${newVersion}"${match[3]}`;
        updatedCrates.add(crateName);
      }
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === "[[package]]") {
      flushPackage(i);
      inPackage = true;
      pkgStart = i + 1;
    }
  }
  flushPackage(lines.length);

  const missing = REQUIRED_CARGO_LOCK_CRATES.filter((name) => !updatedCrates.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing required Cargo.lock entries: ${missing.join(", ")}`);
  }
  writeFileSync(cargoLockPath, lines.join(eol), "utf8");
}

const { newVersion, root } = parseArgs(process.argv.slice(2));
const packagesDir = join(root, "packages");
const updatedPackages = [];
for (const entry of existsSync(packagesDir)
  ? readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  : []) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(packagesDir, entry.name, "package.json");
  if (!existsSync(manifestPath)) continue;
  const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  pkg.version = newVersion;
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  updatedPackages.push(pkg.name);
}

if (updatedPackages.length === 0) {
  throw new Error(`No packages/*/package.json manifests found under ${root}`);
}

const nativeDir = join(root, "packages", "sandbox", "native");
updateCargoToml(join(nativeDir, "Cargo.toml"), newVersion);
updateCargoLock(join(nativeDir, "Cargo.lock"), newVersion);

console.log(
  `bump-version: updated ${updatedPackages.length} workspace packages, Cargo.toml, and Cargo.lock to ${newVersion}`,
);
