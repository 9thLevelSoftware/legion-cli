import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  assertAgentPathAllowed, assertNoLinkInPath, canonicalJson, parseStrictJson,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  AssurancePathSchema, AssuranceSha256Schema, COMPONENT_LIMITS, ComponentInputSchema,
  ComponentRequestSchema, ComponentRuntimeIdentitySchema, NativeHostManifestSchema,
  NativeHostProbeSchema, SCHEMA_VERSION, ValidatorOutputSchema, normalizePathKey,
  type ComponentInput, type ComponentRawInput, type ComponentRuntimeIdentity,
  type NativeHostManifest, type ValidatorOutput,
} from "@9thlevelsoftware/legion-cli-schema";

const MAX_INPUT = 8 * 1024 * 1024;
const MAX_COMPONENT = 16 * 1024 * 1024;
const MAX_HEADER = 16 * 1024;
const installedDist = dirname(fileURLToPath(import.meta.url));
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface ComponentValidationResult {
  status: "passed" | "failed" | "unavailable";
  output: ValidatorOutput | null;
  inputDigest: string;
  moduleSha256: string;
  runtime: ComponentRuntimeIdentity | null;
  reason: string | null;
}

interface ResolvedComponentHost {
  path: string;
  temporaryRoot: string;
  identity: ComponentRuntimeIdentity;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function displayData(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function errorText(error: unknown): string {
  return displayData(error instanceof Error ? error.message : String(error)).slice(0, 4096);
}

async function removePrivateImage(root: string): Promise<void> {
  // Windows can retain an executable image lock briefly after the child closes.
  // Retry at the root only: fs.rm's recursive retries multiply across child paths.
  for (let retry = 0; ; retry++) {
    try { await rm(root, { recursive: true, force: true }); return; }
    catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (process.platform !== "win32" || retry >= 5 || !["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"].includes(String(code))) throw error;
      await delay((retry + 1) * 100);
    }
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function readBoundedFile(path: string, root: string, cap: number): Promise<Buffer> {
  if (!inside(root, path)) throw new Error("Component file escapes its selected root");
  await assertNoLinkInPath(path, { root });
  const physical = await realpath(path);
  if (!inside(root, physical)) throw new Error("Component file escapes its canonical root");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Component input must be a regular non-linked file");
  if (before.size > cap) throw new Error(`Component file exceeds ${cap} bytes`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("Component file changed while opening");
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("Component file changed while reading");
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) throw new Error("Component file grew while reading");
    const after = await handle.stat();
    await assertNoLinkInPath(path, { root });
    const current = await lstat(path);
    if ((await realpath(path)) !== physical || after.dev !== current.dev || after.ino !== current.ino ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs ||
        after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs || opened.mode !== after.mode) {
      throw new Error("Component file changed during snapshot");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function snapshotNativeBinary(path: string, root: string, expected: { size: number; sha256: string }): Promise<{ path: string; temporaryRoot: string }> {
  if (!inside(root, path)) throw new Error("Packaged native path escapes its root");
  await assertNoLinkInPath(path, { root });
  const physical = await realpath(path);
  if (!inside(root, physical)) throw new Error("Packaged native path escapes its canonical root");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.size) throw new Error("Packaged native host size/type mismatch");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "legion-component-host-"));
  const imagePath = join(temporaryRoot, process.platform === "win32" ? "legion-wasi-host.exe" : "legion-wasi-host");
  try {
    await chmod(temporaryRoot, 0o700);
    const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await source.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
          opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new Error("Packaged native host changed while opening");
      const image = await open(imagePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const digest = createHash("sha256");
        let bytes = 0;
        for await (const chunk of source.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
          bytes += chunk.length;
          if (bytes > expected.size) throw new Error("Packaged native host grew while copying");
          digest.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const written = await image.write(chunk, offset, chunk.length - offset);
            if (written.bytesWritten === 0) throw new Error("Private native image could not be written completely");
            offset += written.bytesWritten;
          }
        }
        const after = await source.stat();
        await assertNoLinkInPath(path, { root });
        const current = await lstat(path);
        if (bytes !== expected.size || digest.digest("hex") !== expected.sha256 || (await image.stat()).size !== expected.size ||
            (await realpath(path)) !== physical || current.dev !== opened.dev || current.ino !== opened.ino ||
            current.size !== opened.size || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs ||
            after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
            after.mode !== opened.mode || current.mode !== opened.mode) throw new Error("Packaged native host hash/race mismatch");
        await image.chmod(0o500);
        await image.sync();
      } finally { await image.close(); }
    } finally { await source.close(); }
    // Pin normal installer replacements to these verified bytes, not a mutable installed pathname.
    // This private image is not an OS tamper-proof boundary against a hostile same-user process.
    return { path: imagePath, temporaryRoot };
  } catch (error) {
    await removePrivateImage(temporaryRoot);
    throw error;
  }
}

export async function snapshotComponentFiles(projectRoot: string, paths: readonly string[]): Promise<ComponentRawInput[]> {
  if (paths.length > 256) throw new Error("Component file count exceeds 256");
  const root = await realpath(projectRoot);
  const seen = new Set<string>();
  const result: ComponentRawInput[] = [];
  let total = 2;
  for (const path of [...paths].sort()) {
    AssurancePathSchema.parse(path);
    const key = normalizePathKey(path);
    if (seen.has(key)) throw new Error("Duplicate component input path");
    seen.add(key);
    await assertAgentPathAllowed(root, path);
    const absolute = resolve(root, ...path.split("/"));
    await assertNoLinkInPath(absolute, { root });
    let record: ComponentRawInput;
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (!stat) {
      record = { path, kind: "missing" };
    } else {
      const bytes = await readBoundedFile(absolute, root, MAX_INPUT);
      const current = await lstat(absolute);
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.mode !== stat.mode || current.size !== stat.size ||
          current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw new Error("Component source changed during snapshot");
      await assertAgentPathAllowed(root, path);
      let content: string;
      let encoding: "utf8" | "base64";
      try { content = utf8.decode(bytes); encoding = "utf8"; }
      catch { content = bytes.toString("base64"); encoding = "base64"; }
      const mode = process.platform === "win32" ? `native:${(stat.mode & 0o777).toString(8).padStart(3, "0")}` : (stat.mode & 0o111) !== 0 ? "100755" : "100644";
      record = { path, kind: "file", mode, sha256: sha256(bytes), encoding, content };
    }
    total += Buffer.byteLength(canonicalJson(record)) + 1;
    if (total > MAX_INPUT) throw new Error("Component file snapshots exceed 8 MiB input limit");
    result.push(record);
  }
  return result;
}

function nativeTarget(): NativeHostManifest["hosts"][number]["target"] {
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : null;
  if (!arch) throw new Error(`Packaged component host unavailable for architecture ${process.arch}`);
  if (process.platform === "darwin") {
    if (Number.parseInt(release().split(".")[0]!, 10) < 25) throw new Error("Component native boundary requires macOS 26 or later");
    return `${arch}-apple-darwin`;
  }
  if (process.platform === "linux") {
    const report = process.report as typeof process.report & { excludeNetwork: boolean };
    const old = report.excludeNetwork;
    let glibc: string | undefined;
    try {
      report.excludeNetwork = true;
      const data: unknown = report.getReport();
      if (data && typeof data === "object" && "header" in data) {
        const header = data.header;
        if (header && typeof header === "object" && "glibcVersionRuntime" in header && typeof header.glibcVersionRuntime === "string") glibc = header.glibcVersionRuntime;
      }
    } finally { report.excludeNetwork = old; }
    const parts = glibc?.match(/^(\d+)\.(\d+)(?:\.|$)/);
    const gnu = parts && (Number(parts[1]) > 2 || Number(parts[1]) === 2 && Number(parts[2]) >= 39);
    return `${arch}-unknown-linux-${gnu ? "gnu" : "musl"}`;
  }
  throw new Error(`Packaged component host unavailable on ${process.platform}`);
}

async function invokeHost(binary: string, args: readonly string[], frames: readonly Uint8Array[], deadlineMs: number): Promise<Buffer> {
  const child = spawn(binary, [...args], { cwd: dirname(binary), env: {}, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const completion = once(child, "close");
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  let failure: Error | null = null;
  const terminate = (error: Error) => {
    if (failure) return;
    failure = error;
    child.kill("SIGKILL");
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const timer = setTimeout(() => terminate(new Error("Component native helper exceeded its 20-second deadline")), deadlineMs);
  child.stdout.once("error", terminate);
  child.stderr.once("error", terminate);
  child.stdout.on("data", (chunk: Buffer) => {
    outBytes += chunk.length;
    if (outBytes > COMPONENT_LIMITS.outputBytes) terminate(new Error("Component native stdout exceeds 1 MiB"));
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errBytes += chunk.length;
    if (errBytes > COMPONENT_LIMITS.outputBytes) terminate(new Error("Component native stderr exceeds 1 MiB"));
    else stderr.push(chunk);
  });
  void pipeline(Readable.from(frames), child.stdin).catch((error: unknown) => terminate(new Error(errorText(error))));
  try {
    const [code, signal] = await completion;
    if (failure) throw failure;
    if (code !== 0) throw new Error(`Component native helper unavailable (${signal ?? code}): ${displayData(Buffer.concat(stderr).toString("utf8")).slice(0, 4096)}`);
    return Buffer.concat(stdout, outBytes);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveHost(deadline: number): Promise<ResolvedComponentHost> {
  const root = await realpath(installedDist);
  const native = join(root, "native");
  const manifestPath = join(native, "manifest.json");
  const manifest = NativeHostManifestSchema.parse(parseStrictJson(await readBoundedFile(manifestPath, root, 1024 * 1024)));
  const metadata = parseStrictJson(await readBoundedFile(join(root, "..", "package.json"), resolve(root, ".."), 1024 * 1024));
  if (!metadata || typeof metadata !== "object" || !("version" in metadata) || manifest.version !== metadata.version) throw new Error("Packaged native host version does not match sandbox package");
  const target = nativeTarget();
  const host = manifest.hosts.find((entry) => entry.target === target);
  if (!host) throw new Error(`Packaged component host missing for ${target} (${manifest.scope} manifest)`);
  const binary = resolve(native, ...host.path.split("/"));
  const image = await snapshotNativeBinary(binary, native, host);
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Component runtime resolution exceeded deadline");
    const probe = NativeHostProbeSchema.parse(parseStrictJson(await invokeHost(image.path, ["--probe"], [], remaining), { maxBytes: MAX_HEADER }));
    if (probe.target !== target || probe.version !== manifest.version || probe.abi !== manifest.abi) throw new Error("Packaged native probe target/version/ABI mismatch");
    if (probe.settingsDigest !== componentSettingsDigest()) throw new Error("Packaged native runtime settings mismatch");
    return { ...image, identity: ComponentRuntimeIdentitySchema.parse({ ...probe, hostSha256: host.sha256 }) };
  } catch (error) {
    await removePrivateImage(image.temporaryRoot);
    throw error;
  }
}

export async function resolveComponentRuntime(): Promise<ComponentRuntimeIdentity> {
  try {
    const host = await resolveHost(Date.now() + COMPONENT_LIMITS.deadlineMs);
    try { return host.identity; }
    finally { await removePrivateImage(host.temporaryRoot); }
  }
  catch (error) { throw new Error(`Component runtime prerequisite: ${errorText(error)}`, { cause: error }); }
}

export async function runComponentValidator(input: ComponentInput, options: {
  componentPath: string;
  componentSha256: string;
  runtimeIdentity?: ComponentRuntimeIdentity;
}): Promise<ComponentValidationResult> {
  const deadline = Date.now() + COMPONENT_LIMITS.deadlineMs;
  let inputDigest = "";
  let runtime: ComponentRuntimeIdentity | null = null;
  const moduleSha256 = options.componentSha256;
  let host: ResolvedComponentHost | null = null;
  let status: ComponentValidationResult["status"] = "unavailable";
  let output: ValidatorOutput | null = null;
  let reason: string | null = null;
  try {
    // The schema preflight bounds finite JSON/depth/bytes before serialization allocates its packet.
    const packet = ComponentInputSchema.parse(input);
    packet.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    packet.units.sort((a, b) => a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0);
    const canonical = Buffer.from(canonicalJson(packet), "utf8");
    if (canonical.length > MAX_INPUT) throw new Error("Component input exceeds 8 MiB");
    inputDigest = sha256(canonical);
    for (const record of packet.files) {
      if (record.kind === "missing") continue;
      const content = record.encoding === "utf8" ? Buffer.from(record.content, "utf8") : Buffer.from(record.content, "base64");
      if (record.encoding === "base64" && content.toString("base64") !== record.content) throw new Error("Component input has noncanonical base64");
      if (sha256(content) !== record.sha256) throw new Error("Component input content digest mismatch");
    }
    AssuranceSha256Schema.parse(moduleSha256);
    // The caller-selected directory is the trust anchor; canonicalize it so 8.3 short names
    // (Windows TEMP) and symlinked ancestors (macOS /var) compare against the file's realpath.
    const componentPath = resolve(options.componentPath);
    const componentRoot = await realpath(dirname(componentPath));
    const module = await readBoundedFile(join(componentRoot, basename(componentPath)), componentRoot, MAX_COMPONENT);
    if (sha256(module) !== moduleSha256) throw new Error("Component module hash mismatch");
    host = await resolveHost(deadline);
    runtime = host.identity;
    if (options.runtimeIdentity && canonicalJson(ComponentRuntimeIdentitySchema.parse(options.runtimeIdentity)) !== canonicalJson(runtime)) throw new Error("Current component runtime differs from expected approved authority");
    const request = ComponentRequestSchema.parse({ schemaVersion: SCHEMA_VERSION.componentRequest, abi: "legion-validator/v1", moduleSha256,
      inputSha256: inputDigest, componentBytes: module.length, inputBytes: canonical.length, limits: COMPONENT_LIMITS });
    const header = Buffer.from(canonicalJson(request));
    if (header.length > MAX_HEADER) throw new Error("Component request header exceeds 16 KiB");
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(header.length);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Component validation exceeded 20-second deadline");
    const bytes = await invokeHost(host.path, [], [prefix, header, module, canonical], remaining);
    output = ValidatorOutputSchema.parse(parseStrictJson(bytes, { maxBytes: COMPONENT_LIMITS.outputBytes }));
    if (output.checkId !== packet.extensionCheckId) throw new Error("Component returned an unrequested check ID");
    for (const observation of output.observations) if (observation.detail !== undefined) observation.detail = displayData(observation.detail);
    for (const recommendation of output.recommendations ?? []) {
      recommendation.title = displayData(recommendation.title);
      if (!recommendation.title.trim()) throw new Error("Component recommendation title contains no displayable data");
      if (recommendation.detail !== undefined) recommendation.detail = displayData(recommendation.detail);
    }
    status = output.status;
  } catch (error) {
    status = "unavailable";
    output = null;
    reason = errorText(error);
  } finally {
    if (host) {
      try { await removePrivateImage(host.temporaryRoot); }
      catch (error) {
        status = "unavailable";
        output = null;
        reason = `Private native image cleanup failed: ${errorText(error)}`;
      }
    }
  }
  return { status, output, inputDigest, moduleSha256, runtime, reason };
}

function componentSettingsDigest(): string {
  return sha256("legion-cli-component-settings/v1\0" + canonicalJson({ abi: "legion-validator/v1", limits: COMPONENT_LIMITS,
    memoryGuardBytes: 65_536, memoryReservationBytes: 67_108_864, memoryReservationForGrowthBytes: 0,
    nanCanonicalization: true, relaxedSimdDeterministic: true, sharedMemory: false, threads: false, wasmtimeVersion: "49.0.2" }));
}
