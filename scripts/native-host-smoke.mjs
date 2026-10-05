#!/usr/bin/env node
// Real installed-host smoke: resolves the packaged native host through the sandbox barrel and runs
// the pinned JSON-contract component over real file snapshots. Writes release-assembly evidence.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_SMOKE_CASES, nativeGuardKind } from "./lib/native-smoke.mjs";

const USAGE = "Usage: native-host-smoke.mjs --expect-target <supported-rust-target> --out <smoke.json>";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { parseStrictJson } = await import("../packages/persist/dist/index.js");
const { NativeHostManifestSchema, NativeTargetSchema } = await import("../packages/schema/dist/index.js");
const { resolveComponentRuntime, runComponentValidator, snapshotComponentFiles } = await import("../packages/sandbox/dist/index.js");

const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if ((flag !== "--expect-target" && flag !== "--out") || value === undefined || options.has(flag)) throw new Error(USAGE);
  options.set(flag, value);
}
const target = options.get("--expect-target");
const out = options.get("--out");
if (!NativeTargetSchema.safeParse(target).success || !out) throw new Error(USAGE);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const identity = await resolveComponentRuntime();
if (identity.target !== target) throw new Error(`Resolved native host target ${identity.target}, expected ${target}`);
if (identity.guard !== nativeGuardKind(target) || identity.guardVerified !== true) throw new Error(`Native host guard ${identity.guard} is not the verified ${nativeGuardKind(target)} guard`);

const native = join(repo, "packages", "sandbox", "dist", "native");
const manifest = NativeHostManifestSchema.parse(parseStrictJson(await readFile(join(native, "manifest.json"))));
const host = manifest.hosts.find((entry) => entry.target === target);
if (!host) throw new Error(`Installed native manifest lacks ${target}`);
const binarySha256 = sha256(await readFile(join(native, ...host.path.split("/"))));
if (binarySha256 !== host.sha256 || binarySha256 !== identity.hostSha256) throw new Error("Installed native host bytes differ from manifest/resolved identity");

const extensionRoot = join(repo, "extensions", "json-contract");
const frontmatter = (await readFile(join(extensionRoot, "SKILL.md"), "utf8")).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
if (!frontmatter) throw new Error("JSON-contract SKILL.md lacks its frontmatter");
const runtime = parseStrictJson(frontmatter[1]).metadata?.legion?.runtime;
if (runtime?.kind !== "wasi-component" || typeof runtime.component !== "string" || typeof runtime.sha256 !== "string") throw new Error("JSON-contract SKILL.md lacks its pinned component runtime");
const componentOptions = { componentPath: join(extensionRoot, ...runtime.component.split("/")), componentSha256: runtime.sha256, runtimeIdentity: identity };

const inputPath = "data/product.json";
const configuration = { assertions: [{ id: "status-ok", predicate: { file: inputPath, pointer: "/status", op: "eq", expected: "ok" } }] };
const MIB = 1024 * 1024;
const padded = (bytes) => JSON.stringify({ status: "ok", padding: "x".repeat(bytes) });
// The approved 20M guest fuel bounds practical JSON-contract input near 1.4 MiB; beyond it the check must fail closed.
const FUEL_BOUND_REASON = "exceeded a guest resource bound";
const fixtures = new Map([
  ["pass", { content: '{"status":"ok"}', check: () => {} }],
  ["wrong-value", { content: '{"status":"degraded"}', check: (output) => {
    if (output.observations[0]?.status !== "failed") throw new Error("wrong-value observation did not fail");
  } }],
  ["missing-pointer", { content: '{"state":"ok"}', check: (output) => {
    if (output.observations[0]?.code !== "pointer-missing") throw new Error("missing-pointer observation did not report pointer-missing");
  } }],
  ["large-1mib-pass", { content: padded(MIB), minimumBytes: MIB, check: () => {} }],
  ["fuel-bound-2mib-unavailable", { content: padded(2 * MIB), minimumBytes: 2 * MIB, check: () => {} }],
]);

const project = await mkdtemp(join(tmpdir(), "legion-native-smoke-"));
const cases = [];
try {
  await mkdir(join(project, "data"));
  for (const expected of NATIVE_SMOKE_CASES) {
    const fixture = fixtures.get(expected.id);
    if (!fixture) throw new Error(`No fixture for smoke case ${expected.id}`);
    await writeFile(join(project, ...inputPath.split("/")), fixture.content);
    const files = await snapshotComponentFiles(project, [inputPath]);
    if (fixture.minimumBytes !== undefined && Buffer.byteLength(files[0].content) < fixture.minimumBytes) throw new Error(`${expected.id} fixture is below ${fixture.minimumBytes} bytes`);
    const result = await runComponentValidator({ abi: "legion-validator/v1", projectCheckId: "native-smoke", extensionCheckId: "json-contract",
      acceptanceIds: [], unitIds: [], configuration, files, units: [] }, componentOptions);
    if (result.status !== expected.status) throw new Error(`Smoke case ${expected.id} returned ${result.status}, expected ${expected.status}${result.reason ? `: ${result.reason}` : ""}`);
    if (result.runtime?.hostSha256 !== binarySha256) throw new Error(`Smoke case ${expected.id} ran on an unexpected host`);
    if (expected.status === "unavailable") {
      if (result.output !== null || !result.reason?.includes(FUEL_BOUND_REASON)) throw new Error(`Smoke case ${expected.id} was not refused by the guest resource bound: ${result.reason}`);
    } else {
      if (!result.output) throw new Error(`Smoke case ${expected.id} produced no validator output`);
      fixture.check(result.output);
    }
    cases.push({ id: expected.id, status: result.status });
  }
} finally {
  await rm(project, { recursive: true, force: true });
}

const evidence = { target, sha256: binarySha256, status: "passed", guardKind: identity.guard, cases };
await mkdir(dirname(resolve(out)), { recursive: true });
await writeFile(resolve(out), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Native host smoke passed for ${target} (${binarySha256}, ${identity.guard}): ${cases.map((x) => `${x.id}=${x.status}`).join(", ")}`);
