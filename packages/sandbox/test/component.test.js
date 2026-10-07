import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJson, PathEscapeError } from "@9thlevelsoftware/legion-cli-persist";
import { COMPONENT_LIMITS } from "@9thlevelsoftware/legion-cli-schema";
import { runComponentValidator, snapshotComponentFiles } from "../dist/index.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packet = { abi: "legion-validator/v1", projectCheckId: "business-value", extensionCheckId: "json-contract", acceptanceIds: [], unitIds: [], configuration: {}, files: [], units: [] };

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "legion-component-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("snapshot preserves raw invalid UTF8, BOM, missing files, sorted records and byte identities", async (t) => {
  const root = await project(t);
  const invalid = Buffer.from([0xff, 0x00, 0xc0]);
  const text = Buffer.from("\ufeff{\"answer\":42}");
  await writeFile(join(root, "binary.bin"), invalid);
  await writeFile(join(root, "text.json"), text);
  const records = await snapshotComponentFiles(root, ["text.json", "absent.json", "binary.bin"]);
  assert.deepEqual(records.map((x) => x.path), ["absent.json", "binary.bin", "text.json"]);
  assert.deepEqual(records[0], { kind: "missing", path: "absent.json" });
  assert.equal(records[1].encoding, "base64");
  assert.equal(records[1].content, invalid.toString("base64"));
  assert.equal(records[1].sha256, hash(invalid));
  assert.equal(records[2].encoding, "utf8");
  assert.equal(records[2].content, text.toString("utf8"));
  assert.equal(records[2].sha256, hash(text));
});

test("snapshot refuses traversal, protected controls, duplicate normalized paths, directories and size excess", async (t) => {
  const root = await project(t);
  await mkdir(join(root, "data"));
  await writeFile(join(root, "oversized"), Buffer.alloc(8 * 1024 * 1024 + 1));
  for (const paths of [["../outside"], [".legion-cli/workflow/assurance.yaml"], [".git/config"], ["data"], ["oversized"], ["case.json", "CASE.json"], ["file:alternate"]]) {
    await assert.rejects(snapshotComponentFiles(root, paths));
  }
});

test("snapshot refuses physical junction/symlink aliases to product and engine authority", async (t) => {
  const root = await project(t);
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data", "normal.json"), "{}");
  await mkdir(join(root, ".legion-cli", "workflow"), { recursive: true });
  await writeFile(join(root, ".legion-cli", "workflow", "secret.json"), "{\"authority\":true}");
  await symlink(join(root, "data"), join(root, "data-alias"), process.platform === "win32" ? "junction" : "dir");
  await symlink(join(root, ".legion-cli", "workflow"), join(root, "authority-alias"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(snapshotComponentFiles(root, ["data-alias/normal.json"]));
  await assert.rejects(snapshotComponentFiles(root, ["authority-alias/secret.json"]));
});

test("component snapshots reject authority hardlinks but read ordinary product hardlinks", async (t) => {
  const root = await project(t);
  await mkdir(join(root, "src"));
  await mkdir(join(root, ".legion-cli", "workflow", "checks"), { recursive: true });
  const authority = join(root, ".legion-cli", "workflow", "checks", "business.yaml");
  await writeFile(authority, "control canary\n");
  await link(authority, join(root, "src", "control.txt"));
  await writeFile(join(root, "src", "product.json"), '{"answer":42}\n');
  await link(join(root, "src", "product.json"), join(root, "src", "product-copy.json"));
  await assert.rejects(snapshotComponentFiles(root, ["src/control.txt"]), PathEscapeError);
  const records = await snapshotComponentFiles(root, ["src/product.json", "src/product-copy.json"]);
  for (const record of records) {
    assert.equal(record.content, '{"answer":42}\n');
    assert.equal(record.sha256, hash(Buffer.from('{"answer":42}\n')));
    assert.equal(record.encoding, "utf8");
  }
  assert.deepEqual(records.map((record) => record.path), ["src/product-copy.json", "src/product.json"]);
});

test("host-only unavailable rejects incorrect module or raw input identity before execution", async (t) => {
  const root = await project(t);
  const module = Buffer.from([0, 97, 115, 109, 13, 0, 1, 0]);
  const componentPath = join(root, "validator.wasm");
  await writeFile(componentPath, module);
  const wrongModule = await runComponentValidator(packet, { componentPath, componentSha256: "0".repeat(64) });
  assert.equal(wrongModule.status, "unavailable");
  assert.equal(wrongModule.output, null);
  assert.match(wrongModule.reason, /module hash mismatch/);
  const badInput = { ...packet, files: [{ path: "data.json", kind: "file", mode: "100644", sha256: hash("different"), encoding: "utf8", content: "{}" }] };
  const result = await runComponentValidator(badInput, { componentPath, componentSha256: hash(module) });
  assert.equal(result.status, "unavailable");
  assert.equal(result.runtime, null);
  assert.equal(result.output, null);
  assert.match(result.reason, /input content digest mismatch/);
  assert.equal(result.inputDigest, hash(canonicalJson(badInput)));
});

// These process fixtures exercise Node admission/framing; only real native smokes establish OS containment.
async function installedFixture(t, mode = "business", probeChanges = {}) {
  const root = await mkdtemp(join(pkg, ".component-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, "dist");
  const native = join(dist, "native");
  await mkdir(native, { recursive: true });
  await copyFile(join(pkg, "dist", "component.js"), join(dist, "component.js"));
  const version = JSON.parse(await readFile(join(pkg, "package.json"), "utf8")).version;
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", version }));
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  let target;
  if (process.platform === "win32") target = "x86_64-pc-windows-msvc";
  else if (process.platform === "darwin") target = `${arch}-apple-darwin`;
  else {
    const previous = process.report.excludeNetwork;
    let glibc;
    try { process.report.excludeNetwork = true; glibc = process.report.getReport().header.glibcVersionRuntime; }
    finally { process.report.excludeNetwork = previous; }
    const parts = glibc?.split(".").map(Number);
    const gnu = parts && (parts[0] > 2 || parts[0] === 2 && parts[1] >= 39);
    target = `${arch}-unknown-linux-${gnu ? "gnu" : "musl"}`;
  }
  const settings = { abi: "legion-validator/v1", limits: COMPONENT_LIMITS, memoryGuardBytes: 65536, memoryReservationBytes: 67108864, memoryReservationForGrowthBytes: 0, nanCanonicalization: true, relaxedSimdDeterministic: true, sharedMemory: false, threads: false, wasmtimeVersion: "49.0.2" };
  const probe = { abi: "legion-validator/v1", version, target, settingsDigest: hash("legion-cli-component-settings/v1\0" + canonicalJson(settings)), guard: process.platform === "win32" ? "windows-job-committed" : "unix-address-space", guardVerified: true, ...probeChanges };
  const binary = join(native, "fixture-host");
  const script = `#!${process.execPath}\nimport { createHash } from 'node:crypto';
const hash = x => createHash('sha256').update(x).digest('hex');
if (process.argv.includes('--probe')) { console.log(${JSON.stringify(JSON.stringify(probe))}); process.exit(0); }
let data=[];for await(const x of process.stdin)data.push(x);const bytes=Buffer.concat(data);
const n=bytes.readUInt32BE(0);if(n>16384)process.exit(10);const h=JSON.parse(bytes.subarray(4,4+n));
const start=4+n;const inputStart=start+h.componentBytes;const inputBytes=bytes.subarray(inputStart);
if(bytes.length!==inputStart+h.inputBytes||hash(bytes.subarray(start,inputStart))!==h.moduleSha256||hash(inputBytes)!==h.inputSha256||h.limits.fuel!==20000000)process.exit(11);
const p=JSON.parse(inputBytes);const mode=${JSON.stringify(mode)};
if(mode==='stdout-overflow'){process.stdout.write(Buffer.alloc(1048577,32));setInterval(()=>{},1000);}
else if(mode==='stderr-overflow'){process.stderr.write(Buffer.alloc(1048577,32));setInterval(()=>{},1000);}
else if(mode==='hang'){setInterval(()=>{},1000);}
else if(mode==='duplicate'){process.stdout.write('{"schemaVersion":"legion-cli-validator-output/v1","checkId":"json-contract","status":"failed","status":"passed","observations":[]}');}
else if(mode==='invalid-utf8'){process.stdout.write(Buffer.from([255]));}
else {
const good=p.files.length===1&&JSON.parse(p.files[0].content).score===42;
const out={schemaVersion:'legion-cli-validator-output/v1',checkId:mode==='wrong-id'?'other-check':p.extensionCheckId,status:good?'passed':'failed',observations:[{id:'score',status:good?'passed':'failed',code:'eq',detail:'\\u001b[31mObserved value\\u001b[0m'}]};
if(mode==='extra')out.authority='forged';if(mode==='unavailable')out.status='unavailable';
if(mode==='masked-error'){out.status='passed';out.observations[0].status='error';}
if(mode==='empty-title')out.recommendations=[{title:'\\u001b[31m\\u001b[0m'}];
process.stdout.write(JSON.stringify(out));}
`;
  if (process.platform === "win32") await copyFile(process.execPath, binary);
  else await writeFile(binary, script);
  await chmod(binary, 0o755);
  const binaryBytes = await readFile(binary);
  await writeFile(join(native, "manifest.json"), canonicalJson({ schemaVersion: "legion-cli-native-host-manifest/v1", version, abi: "legion-validator/v1", scope: "local", hosts: [{ target, path: "fixture-host", size: binaryBytes.length, sha256: hash(binaryBytes) }] }));
  const module = Buffer.from([0, 97, 115, 109, 13, 0, 1, 0]);
  const componentPath = join(root, "fixture.wasm");
  await writeFile(componentPath, module);
  const api = await import(pathToFileURL(join(dist, "component.js")).href);
  const content = JSON.stringify({ score: 42, padding: "x".repeat(256 * 1024) });
  const input = { ...packet, files: [{ kind: "file", path: "data.json", mode: "100644", sha256: hash(content), encoding: "utf8", content }] };
  return { root, native, binary, script: script.slice(script.indexOf("\n") + 1), api, input, options: { componentPath, componentSha256: hash(module) } };
}

const processFixturesUnsupported = process.platform === "win32" || !["x64", "arm64"].includes(process.arch) || process.platform === "darwin" && Number.parseInt(release(), 10) < 25;

async function withLockedPrivateImage(fixture, persistent, operation) {
  const originalSpawn = childProcess.spawn;
  const originalRm = fsPromises.rm;
  const images = new Map();
  const holders = [];
  childProcess.spawn = function (binary, args, options) {
    images.set(dirname(binary), binary);
    // Windows needs a PE executable; run the fixture protocol in its verified Node image.
    return originalSpawn(binary, ["--input-type=module", "--eval", fixture.script, "--", ...args], options);
  };
  fsPromises.rm = async function (root, options) {
    const binary = images.get(root);
    if (binary) {
      images.delete(root);
      // Reproduce an OS image handle that outlives the completed protocol process.
      const holder = originalSpawn(binary, ["--eval", "process.stdout.write('locked');setInterval(()=>{},1000)"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const closed = once(holder, "close");
      const ready = once(holder.stdout, "data");
      holders.push({ holder, closed, root });
      await ready;
      await assert.rejects(originalRm(binary), (error) => error.code === "EBUSY" || error.code === "EPERM", "Fixture must hold an actual Windows executable lock");
      if (!persistent) setTimeout(() => holder.kill(), 200);
    }
    return originalRm(root, options);
  };
  syncBuiltinESMExports();
  try {
    await operation();
    assert.equal(holders.length, 1, "The private image cleanup must encounter the executable lock");
    assert.equal(existsSync(holders[0].root), persistent, "Only an exhausted cleanup may leave its private image behind");
  } finally {
    childProcess.spawn = originalSpawn;
    fsPromises.rm = originalRm;
    syncBuiltinESMExports();
    for (const { holder, closed, root } of holders) {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill();
      await closed;
      await originalRm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

test("transient Windows executable locks preserve resolution, validation and original refusal after cleanup", { skip: process.platform !== "win32" || process.arch !== "x64" }, async (t) => {
  for (const scenario of ["resolve", "passed", "wrong-id", "bad-probe"]) {
    const fixture = await installedFixture(t, scenario === "wrong-id" ? scenario : "business", scenario === "bad-probe" ? { guardVerified: false } : {});
    await withLockedPrivateImage(fixture, false, async () => {
      if (scenario === "resolve") {
        assert.equal((await fixture.api.resolveComponentRuntime()).hostSha256, hash(await readFile(fixture.binary)));
      } else {
        const result = await fixture.api.runComponentValidator(fixture.input, fixture.options);
        assert.equal(result.status, scenario === "passed" ? "passed" : "unavailable", result.reason);
        if (scenario === "wrong-id") assert.match(result.reason, /unrequested check ID/);
        if (scenario === "bad-probe") assert.doesNotMatch(result.reason, /EBUSY|EPERM|cleanup failed/);
      }
    });
  }
});

test("persistent Windows executable locks exhaust bounded cleanup and cannot produce evidence", { skip: process.platform !== "win32" || process.arch !== "x64", timeout: 10000 }, async (t) => {
  for (const resolveOnly of [true, false]) {
    const fixture = await installedFixture(t);
    await withLockedPrivateImage(fixture, true, async () => {
      if (resolveOnly) await assert.rejects(fixture.api.resolveComponentRuntime(), /Component runtime prerequisite:.*EBUSY|EPERM/);
      else {
        const result = await fixture.api.runComponentValidator(fixture.input, fixture.options);
        assert.equal(result.status, "unavailable");
        assert.equal(result.output, null);
        assert.match(result.reason, /Private native image cleanup failed:.*EBUSY|EPERM/);
      }
    });
  }
});

test("framed stdin carries large immutable business input and validates check identity without exposing terminal controls", { skip: processFixturesUnsupported }, async (t) => {
  const fixture = await installedFixture(t);
  const result = await fixture.api.runComponentValidator(fixture.input, fixture.options);
  assert.equal(result.status, "passed", result.reason);
  assert.equal(result.output.checkId, "json-contract");
  assert.equal(result.output.observations[0].detail, "Observed value");
  assert.equal(result.inputDigest, hash(canonicalJson(fixture.input)));
  const content = '{"score":43}';
  const failed = await fixture.api.runComponentValidator({ ...fixture.input, files: [{ ...fixture.input.files[0], content, sha256: hash(content) }] }, fixture.options);
  assert.equal(failed.status, "failed");
  assert.equal(failed.output.observations[0].status, "failed");
});

for (const mode of ["wrong-id", "extra", "unavailable", "masked-error", "duplicate", "invalid-utf8", "empty-title", "stdout-overflow", "stderr-overflow"]) {
  test(`native output ${mode} cannot produce passed evidence`, { skip: processFixturesUnsupported }, async (t) => {
    const fixture = await installedFixture(t, mode);
    const result = await fixture.api.runComponentValidator(fixture.input, fixture.options);
    assert.equal(result.status, "unavailable");
    assert.equal(result.output, null);
    if (mode.endsWith("overflow")) assert.match(result.reason, /exceeds 1 MiB/);
  });
}

test("installed native authority requires matching hash, ABI, settings, positive enforcement and current expected identity", { skip: processFixturesUnsupported }, async (t) => {
  for (const changes of [{ guardVerified: false }, { abi: "wrong-abi" }, { settingsDigest: "0".repeat(64) }, { unexpected: true }]) {
    const fixture = await installedFixture(t, "business", changes);
    await assert.rejects(fixture.api.resolveComponentRuntime());
  }
  const fixture = await installedFixture(t);
  const identity = await fixture.api.resolveComponentRuntime();
  const forged = await fixture.api.runComponentValidator(fixture.input, { ...fixture.options, runtimeIdentity: { ...identity, hostSha256: "0".repeat(64) } });
  assert.equal(forged.status, "unavailable");
  assert.equal(forged.output, null);
  assert.match(forged.reason, /expected approved authority/);
  await writeFile(fixture.binary, "tampered binary");
  await assert.rejects(fixture.api.resolveComponentRuntime(), /size\/type mismatch|hash\/race mismatch/);
});

test("oversized, cyclic and excessive-depth input cannot create a validator receipt", async (t) => {
  const root = await project(t);
  const componentPath = join(root, "module.wasm");
  const module = Buffer.from([0, 97, 115, 109, 13, 0, 1, 0]);
  await writeFile(componentPath, module);
  const cycle = {};
  cycle.self = cycle;
  let deep = {};
  for (let i = 0; i < 33; i++) deep = { child: deep };
  for (const configuration of [{ huge: "x".repeat(8 * 1024 * 1024) }, cycle, deep]) {
    const result = await runComponentValidator({ ...packet, configuration }, { componentPath, componentSha256: hash(module) });
    assert.equal(result.status, "unavailable");
    assert.equal(result.output, null);
    assert.equal(result.runtime, null);
  }
});

test("a nonterminating native invocation is killed and never becomes guest evidence", { skip: processFixturesUnsupported, timeout: 30000 }, async (t) => {
  const fixture = await installedFixture(t, "hang");
  const result = await fixture.api.runComponentValidator(fixture.input, fixture.options);
  assert.equal(result.status, "unavailable");
  assert.equal(result.output, null);
  assert.match(result.reason, /deadline/);
});

test("installation replacement at validation launch cannot receive input or forge the recorded host identity", { skip: processFixturesUnsupported }, async (t) => {
  const fixture = await installedFixture(t);
  const originalHash = hash(await readFile(fixture.binary));
  const capture = join(fixture.root, "replacement-captured-input.bin");
  const replacement = `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
const parts=[];for await(const chunk of process.stdin)parts.push(chunk);
writeFileSync(${JSON.stringify(capture)},Buffer.concat(parts));
process.stdout.write(JSON.stringify({schemaVersion:'legion-cli-validator-output/v1',checkId:'json-contract',status:'passed',observations:[{id:'forged-replacement',status:'passed',code:'forged'}]}));
`;
  const originalSpawn = childProcess.spawn;
  let replaced = false;
  childProcess.spawn = function (binary, args, options) {
    // Test-only scheduling seam: probe remains original; replace the installed source exactly at the execution boundary.
    if (!replaced && Array.isArray(args) && args.length === 0) {
      replaced = true;
      writeFileSync(fixture.binary, replacement);
    }
    return originalSpawn(binary, args, options);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await fixture.api.runComponentValidator(fixture.input, fixture.options);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
  const evidence = {
    status: result.status,
    observations: result.output?.observations.map((observation) => observation.id) ?? [],
    inputCaptured: existsSync(capture),
    recordedOriginalHash: result.runtime?.hostSha256 === originalHash,
  };
  assert.equal(replaced, true, "Replacement scheduling seam must execute");
  if (evidence.inputCaptured) {
    const bytes = await readFile(capture);
    const headerLength = bytes.readUInt32BE(0);
    const header = JSON.parse(bytes.subarray(4, 4 + headerLength));
    const deliveredInput = bytes.subarray(4 + headerLength + header.componentBytes);
    assert.equal(hash(deliveredInput), result.inputDigest, "Captured bytes must be the actual validator packet");
  }
  assert.equal(evidence.inputCaptured, false, JSON.stringify(evidence));
  assert.notDeepEqual(evidence.observations, ["forged-replacement"], JSON.stringify(evidence));
  if (result.status !== "unavailable") {
    assert.equal(result.status, "passed", JSON.stringify(evidence));
    assert.deepEqual(evidence.observations, ["score"], JSON.stringify(evidence));
    assert.equal(evidence.recordedOriginalHash, true, JSON.stringify(evidence));
  }
});

test("verified private native images are removed after resolution, success and failed admissions/results", { skip: processFixturesUnsupported }, async (t) => {
  for (const scenario of [
    { mode: "business", resolveOnly: true, changes: {}, expected: "resolved" },
    { mode: "business", resolveOnly: false, changes: {}, expected: "passed" },
    { mode: "wrong-id", resolveOnly: false, changes: {}, expected: "unavailable" },
    { mode: "business", resolveOnly: false, changes: { guardVerified: false }, expected: "unavailable" },
  ]) {
    const fixture = await installedFixture(t, scenario.mode, scenario.changes);
    const launched = [];
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = function (binary, args, options) {
      launched.push(binary);
      return originalSpawn(binary, args, options);
    };
    syncBuiltinESMExports();
    try {
      if (scenario.resolveOnly) {
        const identity = await fixture.api.resolveComponentRuntime();
        assert.equal(identity.hostSha256, hash(await readFile(fixture.binary)));
      } else {
        const result = await fixture.api.runComponentValidator(fixture.input, fixture.options);
        assert.equal(result.status, scenario.expected, result.reason);
      }
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
    assert.notEqual(launched[0], fixture.binary, "Mutable installed source must never be launched");
    for (const binary of launched) assert.equal(existsSync(binary), false, `Private executable remains after completion: ${binary}`);
    if (scenario.expected === "passed") assert.equal(launched[0], launched[1], "Probe and validator must execute the same verified image");
  }
});
