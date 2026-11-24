#!/usr/bin/env node
// Fails when a non-private workspace package is not on the root `legionPublishAllowlist` (F-072),
// when an allowlisted name is not a workspace package, when any workspace package defines a mismatched
// `repository.url`, or when `--release-tag <tag>` fails release-tag/version/Cargo/LICENSE checks.
// Usage: node scripts/check-publish-allowlist.mjs [rootDir] [--release-tag <tag>]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_REPOSITORY_URL = "git+https://github.com/9thLevelSoftware/legion-cli.git";
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function parseArgs(argv) {
  let rootArg;
  let releaseTag;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--release-tag") {
      if (i + 1 >= argv.length || !argv[i + 1] || argv[i + 1].startsWith("-")) {
        console.error("check-publish-allowlist: --release-tag requires a tag value");
        process.exit(1);
      }
      releaseTag = argv[++i];
    } else if (arg.startsWith("--release-tag=")) {
      releaseTag = arg.slice("--release-tag=".length);
      if (!releaseTag) {
        console.error("check-publish-allowlist: --release-tag requires a tag value");
        process.exit(1);
      }
    } else if (arg.startsWith("-")) {
      console.error(`check-publish-allowlist: unknown option ${arg}`);
      process.exit(1);
    } else if (rootArg === undefined) {
      rootArg = arg;
    } else {
      console.error(`check-publish-allowlist: unexpected positional argument ${arg}`);
      process.exit(1);
    }
  }
  return {
    root: resolve(rootArg ?? join(dirname(fileURLToPath(import.meta.url)), "..")),
    releaseTag,
  };
}

function readCargoWorkspaceVersion(cargoTomlPath) {
  const content = readFileSync(cargoTomlPath, "utf8");
  let inWorkspacePackage = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && !trimmed.startsWith("[[")) {
      inWorkspacePackage = /^\[workspace\.package\]\s*(?:#.*)?$/.test(trimmed);
      continue;
    }
    if (inWorkspacePackage) {
      const match = trimmed.match(/^version\s*=\s*"([^"]*)"\s*(?:#.*)?$/);
      if (match) return match[1];
    }
  }
  return null;
}

const { root, releaseTag } = parseArgs(process.argv.slice(2));
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const allow = rootPkg.legionPublishAllowlist;
if (!Array.isArray(allow) || allow.length === 0) {
  console.error("check-publish-allowlist: root package.json has no legionPublishAllowlist");
  process.exit(1);
}

const packagesDir = join(root, "packages");
const publishable = [];
const publishablePkgs = [];
const all = [];
const repoUrlMismatches = [];

for (const entry of existsSync(packagesDir) ? readdirSync(packagesDir, { withFileTypes: true }) : []) {
  const manifest = join(packagesDir, entry.name, "package.json");
  if (!entry.isDirectory() || !existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  all.push(pkg.name);
  if (pkg.repository?.url !== undefined && pkg.repository.url !== EXPECTED_REPOSITORY_URL) {
    repoUrlMismatches.push(`${pkg.name} (${String(pkg.repository.url)})`);
  }
  if (pkg.private !== true) {
    publishable.push(pkg.name);
    publishablePkgs.push(pkg);
  }
}

let failed = false;
const unlisted = publishable.filter((name) => !allow.includes(name));
const stale = allow.filter((name) => !all.includes(name));
if (unlisted.length > 0) {
  console.error(
    `check-publish-allowlist: not on legionPublishAllowlist (add it, or mark the package private): ${unlisted.join(", ")}`,
  );
  failed = true;
}
if (stale.length > 0) {
  console.error(`check-publish-allowlist: on the allowlist but not a workspace package: ${stale.join(", ")}`);
  failed = true;
}
if (repoUrlMismatches.length > 0) {
  console.error(
    `check-publish-allowlist: repository.url must equal ${EXPECTED_REPOSITORY_URL}: ${repoUrlMismatches.join(", ")}`,
  );
  failed = true;
}

if (releaseTag !== undefined) {
  if (!RELEASE_TAG_RE.test(releaseTag)) {
    console.error(`check-publish-allowlist: invalid --release-tag ${JSON.stringify(releaseTag)} (expected vX.Y.Z[-prerelease])`);
    failed = true;
  } else {
    const expected = releaseTag.slice(1);
    if (expected === "0.0.0") {
      console.error("check-publish-allowlist: release version must not be 0.0.0");
      failed = true;
    } else {
      for (const pkg of publishablePkgs) {
        if (pkg.version !== expected) {
          console.error(
            `check-publish-allowlist: version mismatch for ${pkg.name}: expected ${expected}, found ${String(pkg.version)}`,
          );
          failed = true;
        }
      }
      const cargoTomlPath = join(root, "packages", "sandbox", "native", "Cargo.toml");
      if (!existsSync(cargoTomlPath)) {
        console.error("check-publish-allowlist: missing packages/sandbox/native/Cargo.toml for --release-tag check");
        failed = true;
      } else {
        const cargoVersion = readCargoWorkspaceVersion(cargoTomlPath);
        if (cargoVersion !== expected) {
          console.error(
            `check-publish-allowlist: packages/sandbox/native/Cargo.toml [workspace.package] version mismatch: expected ${expected}, found ${String(cargoVersion)}`,
          );
          failed = true;
        }
      }
      const licensePath = join(root, "LICENSE");
      if (!existsSync(licensePath) || !statSync(licensePath).isFile()) {
        console.error("check-publish-allowlist: missing root LICENSE file for --release-tag check");
        failed = true;
      }
    }
  }
}

if (failed) process.exit(1);
console.log(
  `check-publish-allowlist: ${publishable.length} publishable packages, all on the allowlist${releaseTag ? ` (release ${releaseTag} verified)` : ""}`,
);
