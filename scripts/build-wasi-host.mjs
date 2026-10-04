#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_SMOKE_CASES, nativeGuardKind } from "./lib/native-smoke.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const native = join(repo, "packages", "sandbox", "native");
const installed = join(repo, "packages", "sandbox", "dist", "native");
const targets = ["aarch64-apple-darwin", "aarch64-unknown-linux-gnu", "aarch64-unknown-linux-musl", "x86_64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"];
const abi = "legion-validator/v1";
const flags = process.argv.slice(2);
const validateRelease = flags.length === 1 && flags[0] === "--validate-release";
const assemble = flags.length === 2 && flags[0] === "--assemble" ? resolve(flags[1]) : null;
if (!validateRelease && !assemble && flags.length !== 0 && !(flags.length === 2 && flags[0] === "--target" && targets.includes(flags[1]))) throw new Error("Usage: build-wasi-host.mjs [--target <supported-rust-target> | --validate-release | --assemble <native-artifacts-dir>]");
const { canonicalJson, parseStrictJson, assertNoLinkInPath } = await import("../packages/persist/dist/index.js");
const { NativeHostManifestSchema, SCHEMA_VERSION } = await import("../packages/schema/dist/index.js");
const pkg = parseStrictJson(await readFile(join(repo, "packages", "sandbox", "package.json")));

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: native, stdio: "inherit", windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} failed (${result.signal ?? result.status})`);
  return result;
}

async function describe(path, root) {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Native artifact escapes its root");
  await assertNoLinkInPath(path, { root });
  const physical = await realpath(path);
  const physicalRel = relative(root, physical);
  if (isAbsolute(physicalRel) || physicalRel === ".." || physicalRel.startsWith(`..${sep}`)) throw new Error("Native artifact canonical path escapes its root");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw new Error("Native artifact must be a bounded regular file");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("Native artifact changed while hashing");
  } finally { await file.close(); }
  return { size: stat.size, sha256: hash.digest("hex") };
}

const hostName = (target) => target.endsWith("windows-msvc") ? "legion-wasi-host.exe" : "legion-wasi-host";

async function validateReleaseManifest() {
  const manifest = NativeHostManifestSchema.parse(parseStrictJson(await readFile(join(installed, "manifest.json"))));
  if (manifest.scope !== "release" || manifest.version !== pkg.version || manifest.abi !== abi || manifest.hosts.length !== targets.length || targets.some((target) => !manifest.hosts.some((host) => host.target === target))) throw new Error("Publishing requires the complete matching seven-target release host manifest, not a local development build");
  for (const host of manifest.hosts) {
    const actual = await describe(resolve(installed, ...host.path.split("/")), installed);
    if (actual.sha256 !== host.sha256 || actual.size !== host.size) throw new Error(`Release native host hash/size mismatch: ${host.target}`);
  }
}

async function exactEntries(directory, expected, kind) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const missing = [...expected].filter((name) => !names.has(name));
  const extra = [...names].filter((name) => !expected.has(name));
  if (missing.length || extra.length) throw new Error(`Native release artifacts in ${directory} must be exactly the expected set (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`);
  for (const entry of entries) if (kind === "directory" ? !entry.isDirectory() : !entry.isFile()) throw new Error(`Native release artifact ${join(directory, entry.name)} must be a plain ${kind}`);
}

async function readSmoke(path, root) {
  await assertNoLinkInPath(path, { root });
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Native smoke evidence must be a bounded regular file");
  return parseStrictJson(await readFile(path));
}

if (assemble) {
  const root = await realpath(assemble);
  const destination = resolve(installed);
  for (const [outer, inner] of [[root, destination], [destination, root]]) {
    const rel = relative(outer, inner);
    if (rel === "" || !(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))) throw new Error("Native artifact directory must be separate from the packaged native directory");
  }
  await exactEntries(root, new Set(targets), "directory");
  const expectedCases = canonicalJson(NATIVE_SMOKE_CASES);
  const hosts = [];
  for (const target of targets) {
    const name = hostName(target);
    await exactEntries(join(root, target), new Set([name, "smoke.json"]), "file");
    const binary = join(root, target, name);
    const description = await describe(binary, root);
    const smoke = await readSmoke(join(root, target, "smoke.json"), root);
    const keys = smoke && typeof smoke === "object" && !Array.isArray(smoke) ? Object.keys(smoke).sort().join(",") : "";
    if (keys !== "cases,guardKind,sha256,status,target") throw new Error(`Native smoke evidence for ${target} must contain exactly target, sha256, status, guardKind and cases`);
    if (smoke.target !== target) throw new Error(`Native smoke evidence target mismatch: ${String(smoke.target)} in ${target}`);
    if (smoke.sha256 !== description.sha256) throw new Error(`Native smoke evidence for ${target} does not describe the supplied host binary`);
    if (smoke.status !== "passed") throw new Error(`Native smoke for ${target} did not pass`);
    if (smoke.guardKind !== nativeGuardKind(target)) throw new Error(`Native smoke for ${target} reports guard ${String(smoke.guardKind)}, expected ${nativeGuardKind(target)}`);
    if (!Array.isArray(smoke.cases) || smoke.cases.some((x) => !x || typeof x !== "object" || Array.isArray(x) || Object.keys(x).sort().join(",") !== "id,status") || canonicalJson(smoke.cases) !== expectedCases) throw new Error(`Native smoke cases for ${target} differ from the required JSON-contract case set`);
    hosts.push({ target, path: `${target}/${name}`, binary, ...description });
  }
  await rm(installed, { recursive: true, force: true });
  for (const host of hosts) {
    await mkdir(join(installed, host.target), { recursive: true });
    const copy = join(installed, ...host.path.split("/"));
    await copyFile(host.binary, copy, constants.COPYFILE_EXCL);
    const copied = await describe(copy, installed);
    if (copied.sha256 !== host.sha256 || copied.size !== host.size) throw new Error(`Native host changed while assembling: ${host.target}`);
  }
  const manifest = NativeHostManifestSchema.parse({ schemaVersion: SCHEMA_VERSION.nativeHostManifest, abi, version: pkg.version, scope: "release",
    hosts: hosts.map(({ target, path, size, sha256 }) => ({ target, path, sha256, size })) });
  await writeFile(join(installed, "manifest.json"), canonicalJson(manifest));
  await validateReleaseManifest();
  console.log(`Assembled and validated the seven-target release host manifest from smoke-passed artifacts (${hosts.map((x) => `${x.target}=${x.sha256}`).join(", ")}).`);
} else if (validateRelease) {
  await validateReleaseManifest();
  console.log("Validated seven packaged native host targets; target smoke evidence is release assembly's separate prerequisite.");
} else {
  const compiler = command("rustc", ["+1.96.0", "-vV"], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  const localTarget = compiler.stdout.match(/^host: (\S+)$/m)?.[1];
  if (!targets.includes(localTarget)) throw new Error(`Pinned Rust host target is unsupported: ${localTarget}`);
  const target = flags[1] ?? localTarget;
  // Panic locations embed source paths in the guest; remap the checkout and Cargo home so the
  // committed component hash does not depend on where or by whom it was built.
  const cargoHome = process.env.CARGO_HOME ? resolve(process.env.CARGO_HOME) : join(homedir(), ".cargo");
  const guestEnv = { ...process.env, CARGO_ENCODED_RUSTFLAGS: [`--remap-path-prefix=${native}=/legion-native`, `--remap-path-prefix=${cargoHome}=/cargo`].join("\x1f") };
  for (const [args, options] of [
    [["+1.96.0", "build", "--locked", "--release", "--package", "legion-wasi-host", "--target", target], {}],
    [["+1.96.0", "build", "--locked", "--release", "--package", "legion-json-contract", "--target", "wasm32-unknown-unknown"], { env: guestEnv }],
    [["+1.96.0", "build", "--locked", "--release", "--package", "legion-pack-component", "--target", localTarget], {}],
  ]) command("cargo", args, options);
  const binaryName = hostName(target);
  const hostPath = `${target}/${binaryName}`;
  await mkdir(join(installed, target), { recursive: true });
  await copyFile(join(native, "target", target, "release", binaryName), join(installed, ...hostPath.split("/")));
  const description = await describe(join(installed, ...hostPath.split("/")), installed);
  const manifest = NativeHostManifestSchema.parse({ schemaVersion: SCHEMA_VERSION.nativeHostManifest, abi, version: pkg.version, scope: "local", hosts: [{ target, path: hostPath, ...description }] });
  await writeFile(join(installed, "manifest.json"), canonicalJson(manifest));
  const extensionRoot = join(repo, "extensions", "json-contract");
  const asset = join(extensionRoot, "assets", "json-contract.wasm");
  await mkdir(dirname(asset), { recursive: true });
  const builder = join(native, "target", localTarget, "release", localTarget.endsWith("windows-msvc") ? "legion-pack-component.exe" : "legion-pack-component");
  command(builder, [join(native, "target", "wasm32-unknown-unknown", "release", "legion_json_contract.wasm"), asset]);
  const component = await describe(asset, extensionRoot);
  const metadata = parseStrictJson(await readFile(join(extensionRoot, "metadata.json")));
  const runtime = { kind: "wasi-component", abi, component: "assets/json-contract.wasm", sha256: component.sha256 };
  const frontmatter = { ...metadata.frontmatter, metadata: { ...metadata.frontmatter.metadata,
    legion: { ...metadata.frontmatter.metadata.legion, runtime } } };
  await writeFile(join(extensionRoot, "SKILL.md"), `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${metadata.body}\n`);
  console.log(`Built ${target} native host (${description.sha256}) and import-free JSON-contract component (${component.sha256}); local manifest is not a seven-target release claim.`);
}
