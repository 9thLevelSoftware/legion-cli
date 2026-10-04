import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, parse as parsePath, relative, resolve, sep } from "node:path";
import {
  DELIVERY_PREDICATE_TYPE,
  DeliveryArtifactsSchema,
  DeliveryEvidenceSchema,
  DeliveryManifestSchema,
  DeliveryPredicateSchema,
  DeliveryProductSchema,
  DeliveryStatementSchema,
  DeliveryTrustSchema,
  DsseEnvelopeSchema,
  GovernanceTraceSchema,
  type DeliveryManifest,
  type DeliveryTrust,
  type DsseEnvelope,
} from "@9thlevelsoftware/legion-cli-schema";
import { canonicalJson } from "./canonical-json.js";
import { atomicWriteFile } from "./atomic-write.js";
import { parseStrictJson } from "./strict-json.js";

export type DeliveryRequirement = "integrity" | "local-key" | "ci-oidc";
export interface DeliveryVerificationOptions {
  require?: DeliveryRequirement | string;
  trustPolicy?: DeliveryTrust | string | Uint8Array;
  sourceRoot?: string;
  artifactsRoot?: string;
  expectedApproval?: string;
}
export interface DeliveryVerificationReport {
  requirement: string;
  passed: boolean;
  integrity: { status: "valid" | "invalid"; reason: string | null };
  authenticity: { status: "verified" | "unverified" | "invalid" | "unsupported"; method: "local-key" | "ci-oidc" | null; keyId?: string; trustedRootAgeMs?: number; reason: string | null };
  suppliedContent: { status: "verified" | "unavailable" | "not-supplied" | "mismatch"; source: string | null; artifacts: string | null; unavailableGitlinks: string[] };
  claims: { status: "self-reported" | "approval-mismatch"; approvalId: string | null };
  /** SHA-256 of the exact `predicate.json` bytes; null unless that member matched the manifest and its schema. */
  predicate: { sha256: string } | null;
}

export const DELIVERY_MAX_MEMBER_BYTES = 64 * 1024 * 1024;
export const DELIVERY_MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const JSON_MEMBERS = new Set(["product.json", "artifacts.json", "evidence.json", "trace.json", "predicate.json"]);
const OPTIONAL_MEMBERS = new Set(["signature.dsse.json", "ci.sigstore.json"]);
const PAE_PREFIX = Buffer.from("DSSEv1 ");
const CI_ROOT_MAX_BYTES = 1024 * 1024;
const CI_ROOT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const CI_GH_TIMEOUT_MS = 30_000;
const CI_GH_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function field(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (Object.hasOwn(record, name)) return record[name];
  return undefined;
}

function requireString(record: Record<string, unknown>, description: string, ...names: string[]): string {
  const value = field(record, ...names);
  if (typeof value !== "string" || value.length === 0) throw new DeliveryRefusalError(`gh verification result is missing ${description}`);
  return value;
}

function validateCiResult(output: Buffer, manifestBytes: Buffer, predicateBytes: Buffer, trust: NonNullable<DeliveryTrust["ci"]>): void {
  const results = parseStrictJson(output, { maxBytes: CI_GH_OUTPUT_MAX_BYTES, maxDepth: 64 });
  if (!Array.isArray(results) || results.length === 0) throw new DeliveryRefusalError("gh returned no verified attestations");
  for (const item of results) {
    const entry = objectRecord(item);
    const verification = objectRecord(entry?.verificationResult);
    const signature = objectRecord(verification?.signature);
    const certificate = objectRecord(signature?.certificate);
    const statement = objectRecord(verification?.statement);
    if (!entry || !verification || !signature || !certificate || !statement || !Array.isArray(verification.verifiedTimestamps) || verification.verifiedTimestamps.length === 0) {
      throw new DeliveryRefusalError("gh verification result is missing certificate, timestamp, or statement confirmation fields");
    }
    const san = requireString(certificate, "certificate SAN", "SubjectAlternativeName", "subjectAlternativeName", "subject_alternative_name");
    const issuer = requireString(certificate, "OIDC issuer", "OIDCIssuer", "oidcIssuer", "issuer");
    const repository = requireString(certificate, "source repository", "SourceRepository", "sourceRepository", "source_repository");
    const signerWorkflow = requireString(certificate, "signer workflow", "BuildSignerURI", "buildSignerURI", "buildSignerUri", "build_signer_uri");
    const signerDigest = requireString(certificate, "signer digest", "BuildSignerDigest", "buildSignerDigest", "build_signer_digest");
    const sourceDigest = requireString(certificate, "source digest", "SourceRepositoryDigest", "sourceRepositoryDigest", "source_repository_digest");
    const workflowMatches = signerWorkflow === trust.signerWorkflow ||
      signerWorkflow === `https://github.com/${trust.signerWorkflow}` ||
      signerWorkflow.startsWith(`https://github.com/${trust.signerWorkflow}@`);
    if (san !== trust.certificateSan || issuer !== trust.issuer ||
        repository !== trust.repository && repository !== `https://github.com/${trust.repository}` ||
        !workflowMatches || signerDigest !== trust.signerDigest || sourceDigest !== trust.sourceDigest) {
      throw new DeliveryRefusalError("gh certificate identity does not match the external CI trust policy");
    }
    const subjects = statement.subject;
    if (!Array.isArray(subjects) || subjects.length !== 1) throw new DeliveryRefusalError("Verified statement must have exactly one manifest subject");
    const subject = objectRecord(subjects[0]);
    const digest = objectRecord(subject?.digest);
    if (subject?.name !== "manifest.json" || digest?.sha256 !== sha256(manifestBytes)) {
      throw new DeliveryRefusalError("Verified statement subject does not bind this manifest");
    }
    if (statement.predicateType !== DELIVERY_PREDICATE_TYPE ||
        canonicalJson(statement.predicate) !== canonicalJson(parseStrictJson(predicateBytes, { maxBytes: DELIVERY_MAX_MEMBER_BYTES, maxDepth: 32 }))) {
      throw new DeliveryRefusalError("Verified statement predicate does not match predicate.json");
    }
  }
}

async function resolveGhExecutable(env: NodeJS.ProcessEnv): Promise<string> {
  const windows = process.platform === "win32";
  const pathValue = (windows ? env.Path ?? env.PATH : env.PATH) ?? "";
  const names = windows ? ["gh.exe", "gh.com"] : ["gh"];
  const shims = windows ? ["gh.cmd", "gh.bat"] : [];
  let shim: string | undefined;
  for (const entry of pathValue.split(windows ? ";" : ":")) {
    if (entry.length === 0 || !isAbsolute(entry)) continue;
    for (const name of names) {
      const candidate = resolve(entry, name);
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        if (!windows && (info.mode & 0o111) === 0) continue;
        return candidate;
      } catch {
        continue;
      }
    }
    for (const name of shims) {
      try {
        if ((await lstat(resolve(entry, name))).isFile()) shim ??= resolve(entry, name);
      } catch {
        continue;
      }
    }
  }
  if (shim !== undefined) throw new DeliveryRefusalError(`Unable to run operator-installed gh: only a script shim was found (${shim}); a native gh executable is required`);
  throw new DeliveryRefusalError("Unable to run operator-installed gh: no gh executable on an absolute PATH entry");
}

async function runGhCiVerification(
  directory: string,
  manifestBytes: Buffer,
  predicateBytes: Buffer,
  ciBundlePath: string,
  trust: NonNullable<DeliveryTrust["ci"]>,
): Promise<number> {
  const root = await readStableFile(trust.trustedRootPath, CI_ROOT_MAX_BYTES, true);
  if (root.sha256 !== trust.trustedRootSha256) throw new DeliveryRefusalError("External trusted-root digest does not match policy");
  const capturedAt = Date.parse(trust.trustedRootCapturedAt);
  const rootAgeMs = Date.now() - capturedAt;
  if (!Number.isFinite(capturedAt) || rootAgeMs < 0 || rootAgeMs > CI_ROOT_MAX_AGE_MS) {
    throw new DeliveryRefusalError("External trusted-root snapshot is future-dated or older than 90 days");
  }
  const configDirectory = await mkdtemp(resolve(tmpdir(), "delivery-gh-config-"));
  const isolatedTrustedRoot = resolve(configDirectory, "trusted-root.jsonl");
  try {
    await writeFile(isolatedTrustedRoot, root.bytes!, { flag: "wx", mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.GH_CONFIG_DIR = configDirectory;
    env.GH_PROMPT_DISABLED = "1";
    env.GH_NO_UPDATE_NOTIFIER = "1";
    env.CI = "1";
    const args = [
      "attestation", "verify", resolve(directory, "manifest.json"),
      "--bundle", ciBundlePath,
      "--custom-trusted-root", isolatedTrustedRoot,
      "--repo", trust.repository,
      "--cert-identity", trust.certificateSan,
      "--cert-oidc-issuer", trust.issuer,
      "--signer-workflow", trust.signerWorkflow,
      "--signer-digest", trust.signerDigest,
      "--source-digest", trust.sourceDigest,
      "--predicate-type", DELIVERY_PREDICATE_TYPE,
      "--format", "json",
    ];
    const gh = await resolveGhExecutable(env);
    const output = await new Promise<Buffer>((resolveOutput, reject) => {
      const child = spawn(gh, args, { cwd: configDirectory, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(error);
      };
      const timer = setTimeout(() => fail(new DeliveryRefusalError("gh attestation verification timed out")), CI_GH_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > CI_GH_OUTPUT_MAX_BYTES) fail(new DeliveryRefusalError("gh verification output exceeds 4 MiB"));
        else chunks.push(chunk);
      });
      child.once("error", (error) => fail(new DeliveryRefusalError(`Unable to run operator-installed gh: ${error.message}`)));
      child.once("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code !== 0) reject(new DeliveryRefusalError(`gh attestation verification refused (exit ${String(code)})`));
        else resolveOutput(Buffer.concat(chunks, size));
      });
    });
    validateCiResult(output, manifestBytes, predicateBytes, trust);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
  return rootAgeMs;
}

async function assertNoLinks(path: string, message: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parsePath(absolute);
  let cursor = parsed.root;
  for (const part of relative(parsed.root, absolute).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new DeliveryRefusalError(message);
  }
}
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function pae(payloadType: string, payload: Uint8Array): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([PAE_PREFIX, Buffer.from(String(type.length)), Buffer.from(" "), type, Buffer.from(" "), Buffer.from(String(payload.byteLength)), Buffer.from(" "), payload]);
}
function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new TypeError("Invalid base64 value");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const bare = normalized.replace(/=+$/, "");
  const decoded = Buffer.from(bare, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== bare) throw new TypeError("Noncanonical base64 value");
  return decoded;
}
function keyId(publicKey: KeyObject): string {
  return sha256(publicKey.export({ type: "spki", format: "der" }));
}

/** Build the DSSE signing input for callers implementing an offline signing UX. */
export function deliveryDssePae(payloadType: string, payload: Uint8Array): Buffer { return pae(payloadType, payload); }

/** Sign exact caller-provided payload bytes with an external Ed25519 PKCS8 key. */
export function signDeliveryDsse(
  payload: Uint8Array,
  privateKeyPem: string | Uint8Array,
  payloadType = "application/vnd.in-toto+json",
  options: { passphrase?: string } = {},
): DsseEnvelope {
  if (options.passphrase !== undefined && Buffer.byteLength(options.passphrase, "utf8") > 4096) {
    throw new DeliveryRefusalError("Passphrase exceeds the supported input limit");
  }
  if (payloadType !== "application/vnd.in-toto+json") throw new DeliveryRefusalError("Unsupported DSSE payload type");
  if (payload.byteLength < 1 || payload.byteLength > 48 * 1024 * 1024) throw new RangeError("DSSE payload exceeds the supported envelope size limit");
  const keyBytes = typeof privateKeyPem === "string" ? privateKeyPem : Buffer.from(privateKeyPem);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(options.passphrase === undefined
      ? { key: keyBytes }
      : { key: keyBytes, passphrase: options.passphrase });
  } catch (cause) {
    const encryptedPem = keyBytes.toString().includes("-----BEGIN ENCRYPTED PRIVATE KEY-----");
    const encryptionError = /passphrase|encrypted|decrypt|bad password/i.test(String((cause as Error)?.message ?? cause));
    if (options.passphrase === undefined && (encryptedPem || encryptionError)) {
      throw new EncryptedDeliveryKeyError();
    }
    throw new DeliveryRefusalError(options.passphrase === undefined
      ? "Invalid external PKCS8 private key"
      : "Unable to use the external PKCS8 private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new DeliveryRefusalError("Only Ed25519 keys are supported");
  const publicKey = createPublicKey(privateKey);
  const signature = cryptoSign(null, pae(payloadType, payload), privateKey);
  return { payloadType: payloadType as DsseEnvelope["payloadType"], payload: Buffer.from(payload).toString("base64"), signatures: [{ keyid: keyId(publicKey), sig: signature.toString("base64") }] };
}

export class DeliveryRefusalError extends Error {
  constructor(message: string) { super(message); this.name = "DeliveryRefusalError"; }
}

export class EncryptedDeliveryKeyError extends DeliveryRefusalError {
  readonly code = "ERR_ENCRYPTED_DELIVERY_KEY";
  constructor() { super("Encrypted PKCS8 key requires a passphrase"); this.name = "EncryptedDeliveryKeyError"; }
}


interface StableFile {
  bytes?: Buffer;
  size: number;
  sha256: string;
  identity: string;
}
type FileStat = {
  dev: bigint; ino: bigint; mode: bigint; nlink: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};
function fileIdentity(stat: FileStat): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
async function readStableFile(path: string, maxBytes: number, captureBytes: boolean): Promise<StableFile> {
  await assertNoLinks(path, "file path traverses a link");
  const beforeName = await lstat(path, { bigint: true }) as FileStat;
  if (!beforeName.isFile() || beforeName.isSymbolicLink() || beforeName.nlink !== 1n) {
    throw new DeliveryRefusalError(`Expected an unlinked regular file: ${basename(path)}`);
  }
  if (beforeName.size > BigInt(maxBytes)) throw new RangeError(`${basename(path)} exceeds its size limit`);
  const flags = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
  const handle = await open(path, flags);
  try {
    const beforeHandle = await handle.stat({ bigint: true }) as FileStat;
    const identity = fileIdentity(beforeName);
    if (!beforeHandle.isFile() || beforeHandle.nlink !== 1n || fileIdentity(beforeHandle) !== identity) {
      throw new DeliveryRefusalError(`File changed while opening: ${basename(path)}`);
    }
    const size = Number(beforeHandle.size);
    const bytes = captureBytes ? Buffer.alloc(size) : undefined;
    const scratch = bytes ?? Buffer.allocUnsafe(64 * 1024);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < size) {
      const count = Math.min(scratch.length, size - offset);
      const targetOffset = bytes ? offset : 0;
      const { bytesRead } = await handle.read(scratch, targetOffset, count, offset);
      if (bytesRead === 0) throw new DeliveryRefusalError(`File shrank while reading: ${basename(path)}`);
      hash.update(scratch.subarray(targetOffset, targetOffset + bytesRead));
      offset += bytesRead;
    }
    const afterHandle = await handle.stat({ bigint: true }) as FileStat;
    await assertNoLinks(path, "file path became linked while reading");
    const afterName = await lstat(path, { bigint: true }) as FileStat;
    if (!afterHandle.isFile() || afterHandle.nlink !== 1n || fileIdentity(afterHandle) !== identity ||
        !afterName.isFile() || afterName.nlink !== 1n || fileIdentity(afterName) !== identity) {
      throw new DeliveryRefusalError(`File changed while reading: ${basename(path)}`);
    }
    return { ...(bytes ? { bytes } : {}), size: offset, sha256: hash.digest("hex"), identity };
  } finally {
    await handle.close();
  }
}
async function hashFile(path: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<{ sha256: string; size: number }> {
  const file = await readStableFile(path, maxBytes, false);
  return { sha256: file.sha256, size: file.size };
}
async function readRegular(path: string, maxBytes: number): Promise<Buffer> {
  return (await readStableFile(path, maxBytes, true)).bytes!;
}
function parseSchema(bytes: Uint8Array, schema: { parse(value: unknown): unknown }, maxBytes: number): unknown {
  return schema.parse(parseStrictJson(bytes, { maxBytes, maxDepth: 32 }));
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
async function assertBundleState(directory: string, rootIdentity: string, initialNames: string[], fileIdentities: Map<string, string>): Promise<void> {
  await assertNoLinks(directory, "bundle directory became linked during verification");
  const rootStat = await lstat(directory, { bigint: true }) as FileStat;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fileIdentity(rootStat) !== rootIdentity) {
    throw new DeliveryRefusalError("Bundle directory changed during verification");
  }
  const expectedNames = [...initialNames].sort();
  const finalNames = (await readdir(directory)).sort();
  if (finalNames.length !== expectedNames.length || finalNames.some((name, index) => name !== expectedNames[index])) {
    throw new DeliveryRefusalError("Bundle membership changed during verification");
  }
  for (const name of finalNames) {
    const stat = await lstat(resolve(directory, name), { bigint: true }) as FileStat;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || fileIdentity(stat) !== fileIdentities.get(name)) {
      throw new DeliveryRefusalError(`Bundle member changed during verification: ${name}`);
    }
  }
}
async function safeRoot(root: string): Promise<string> {
  const abs = resolve(root);
  await assertNoLinks(abs, "content root traverses a link");
  const before = await lstat(abs, { bigint: true }) as FileStat;
  if (!before.isDirectory() || before.isSymbolicLink()) throw new DeliveryRefusalError(`Content root is not a regular directory: ${root}`);
  const physical = await realpath(abs);
  await assertNoLinks(abs, "content root became linked during resolution");
  const after = await lstat(abs, { bigint: true }) as FileStat;
  if (!after.isDirectory() || after.isSymbolicLink() || fileIdentity(after) !== fileIdentity(before)) {
    throw new DeliveryRefusalError(`Content root changed during resolution: ${root}`);
  }
  return physical;
}
async function verifyInventory(rootArg: string, entries: Array<{ path: string; sha256?: string; size?: number; kind: string; oid?: string }>, kind: "source" | "artifacts", allowNativeFileSymlinks = false): Promise<{ result: "verified" | "unavailable" | "mismatch"; gitlinks: string[] }> {
  const root = await safeRoot(rootArg);
  const gitlinks: string[] = [];
  const directories = new Map<string, string>();
  const symlinks = new Map<string, string>();
  const rootStat = await lstat(root, { bigint: true }) as FileStat;
  directories.set(root, fileIdentity(rootStat));
  let mismatch = false;
  for (const entry of entries) {
    if (entry.kind === "gitlink") { gitlinks.push(`${entry.path}@${entry.oid}`); continue; }
    const path = resolve(root, ...entry.path.split("/"));
    if (!within(root, path)) throw new DeliveryRefusalError(`${kind} path escapes supplied root`);
    const rel = relative(root, path); let cursor = root; let symlinkHandled = false;
    for (const part of rel.split(sep)) {
      cursor = resolve(cursor, part);
      const stat = await lstat(cursor, { bigint: true }) as FileStat;
      if (stat.isSymbolicLink()) {
        if (!(allowNativeFileSymlinks && kind === "source" && entry.kind === "native-file" && cursor === path)) {
          throw new DeliveryRefusalError(`${kind} content contains a link: ${entry.path}`);
        }
        const identity = fileIdentity(stat);
        const target = await readlink(path, { encoding: "buffer" });
        const afterRead = await lstat(path, { bigint: true }) as FileStat;
        if (!afterRead.isSymbolicLink() || fileIdentity(afterRead) !== identity) {
          throw new DeliveryRefusalError(`${kind} symlink changed while reading: ${entry.path}`);
        }
        symlinks.set(path, identity);
        const digest = { sha256: sha256(target), size: target.length };
        if (digest.sha256 !== entry.sha256 || digest.size !== entry.size) mismatch = true;
        symlinkHandled = true;
        break;
      }
      if (cursor !== path && !stat.isDirectory()) throw new DeliveryRefusalError(`${kind} path traverses a non-directory: ${entry.path}`);
      if (cursor === path && !stat.isFile()) throw new DeliveryRefusalError(`${kind} path is not a regular file: ${entry.path}`);
      if (cursor !== path) directories.set(cursor, fileIdentity(stat));
    }
    if (symlinkHandled) continue;
    const digest = await hashFile(path, entry.size ?? Number.MAX_SAFE_INTEGER);
    if (digest.sha256 !== entry.sha256 || digest.size !== entry.size) mismatch = true;
  }
  for (const [directory, identity] of directories) {
    await assertNoLinks(directory, "content directory became linked during verification");
    const stat = await lstat(directory, { bigint: true }) as FileStat;
    if (!stat.isDirectory() || stat.isSymbolicLink() || fileIdentity(stat) !== identity) throw new DeliveryRefusalError("Supplied content directory changed during verification");
  }
  for (const [path, identity] of symlinks) {
    const stat = await lstat(path, { bigint: true }) as FileStat;
    if (!stat.isSymbolicLink() || fileIdentity(stat) !== identity) throw new DeliveryRefusalError("Supplied content symlink changed during verification");
  }
  return { result: mismatch ? "mismatch" : gitlinks.length ? "unavailable" : "verified", gitlinks };
}

function invalidReport(requirement: string, reason: string): DeliveryVerificationReport {
  return { requirement, passed: false, integrity: { status: "invalid", reason }, authenticity: { status: "unverified", method: null, reason: null }, suppliedContent: { status: "not-supplied", source: null, artifacts: null, unavailableGitlinks: [] }, claims: { status: "self-reported", approvalId: null }, predicate: null };
}
function parseTrust(value: DeliveryVerificationOptions["trustPolicy"]): DeliveryTrust | undefined {
  if (!value) return undefined;
  const parsed = typeof value === "string" || value instanceof Uint8Array
    ? parseStrictJson(value, { maxBytes: 1024 * 1024, maxDepth: 32 })
    : value;
  return DeliveryTrustSchema.parse(parsed);
}

/** Verify a bundle using only the directory and explicit caller-supplied trust/content inputs. */
export async function verifyDeliveryBundle(directory: string, options: DeliveryVerificationOptions = {}): Promise<DeliveryVerificationReport> {
  const requirement = options.require ?? "integrity";
  if (!["integrity", "local-key", "ci-oidc"].includes(requirement)) return invalidReport(requirement, "Unknown trust requirement; refusing closed");
  let dir: string;
  let predicateDigest: { sha256: string } | null = null;
  try {
    dir = resolve(directory);
    await assertNoLinks(dir, "bundle path traverses a link");
    const rootStat = await lstat(dir, { bigint: true }) as FileStat;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new DeliveryRefusalError("Bundle path must be a regular directory, not a link");
    const rootIdentity = fileIdentity(rootStat);
    const names = await readdir(dir);
    const fileIdentities = new Map<string, string>();
    for (const name of names) {
      if (name.includes("/") || name.includes("\\") || name === "." || name === "..") throw new DeliveryRefusalError("Invalid bundle member path");
      const stat = await lstat(resolve(dir, name), { bigint: true }) as FileStat;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new DeliveryRefusalError(`Bundle entries must be regular unlinked files: ${name}`);
      if (!JSON_MEMBERS.has(name) && name !== "manifest.json" && !OPTIONAL_MEMBERS.has(name)) throw new DeliveryRefusalError(`Unexpected bundle entry: ${name}`);
    }
    const manifestFile = await readStableFile(resolve(dir, "manifest.json"), 1024 * 1024, true);
    const manifestBytes = manifestFile.bytes!;
    fileIdentities.set("manifest.json", manifestFile.identity);
    const manifestValue = parseStrictJson(manifestBytes, { maxBytes: 1024 * 1024, maxDepth: 32 });
    if (canonicalJson(manifestValue) !== manifestBytes.toString("utf8")) throw new DeliveryRefusalError("manifest.json is not canonical JSON");
    const manifest = DeliveryManifestSchema.parse(manifestValue) as DeliveryManifest;
    const declared = new Set<string>(manifest.members.map((m) => m.path));
    if (declared.size !== JSON_MEMBERS.size || [...JSON_MEMBERS].some((name) => !declared.has(name))) throw new DeliveryRefusalError("Manifest must declare each required member exactly once");
    let total = manifestBytes.length;
    const docs = new Map<string, unknown>();
    const memberBytes = new Map<string, Buffer>();
    for (const member of manifest.members) {
      total += member.size;
      if (total > DELIVERY_MAX_BUNDLE_BYTES) throw new RangeError("Bundle exceeds 256 MiB");
      const memberPath = resolve(dir, member.path);
      const file = await readStableFile(memberPath, DELIVERY_MAX_MEMBER_BYTES, true);
      if (file.size !== member.size || file.sha256 !== member.sha256) throw new DeliveryRefusalError(`Integrity mismatch for ${member.path}`);
      memberBytes.set(member.path, file.bytes!);
      fileIdentities.set(member.path, file.identity);
      const schema = member.path === "product.json" ? DeliveryProductSchema : member.path === "artifacts.json" ? DeliveryArtifactsSchema : member.path === "evidence.json" ? DeliveryEvidenceSchema : member.path === "trace.json" ? GovernanceTraceSchema : DeliveryPredicateSchema;
      docs.set(member.path, parseSchema(file.bytes!, schema, DELIVERY_MAX_MEMBER_BYTES));
      if (member.path === "predicate.json") predicateDigest = { sha256: file.sha256 };
    }
    let signatureBytes: Buffer | undefined;
    let ciBytes: Buffer | undefined;
    for (const optional of OPTIONAL_MEMBERS) {
      if (!names.includes(optional)) continue;
      const file = await readStableFile(resolve(dir, optional), DELIVERY_MAX_MEMBER_BYTES, true);
      total += file.size;
      if (total > DELIVERY_MAX_BUNDLE_BYTES) throw new RangeError("Bundle exceeds 256 MiB");
      fileIdentities.set(optional, file.identity);
      if (optional === "signature.dsse.json") signatureBytes = file.bytes!;
      else ciBytes = file.bytes!;
    }
    const mustBe = new Set(["manifest.json", ...declared]);
    for (const optional of OPTIONAL_MEMBERS) if (names.includes(optional)) mustBe.add(optional);
    if (names.some((name) => !mustBe.has(name))) throw new DeliveryRefusalError("Bundle contains undeclared files");
    const product = docs.get("product.json") as { scope: string; subjectDigest: string; entries: Array<{ path: string; sha256?: string; size?: number; kind: string; oid?: string }> };
    const evidence = docs.get("evidence.json") as { approvalId: string | null; executionFingerprint: string; environmentFingerprint: string };
    if (product.scope !== manifest.deliveredScope || product.subjectDigest !== manifest.subjectDigest) throw new DeliveryRefusalError("Product inventory scope or subject digest does not match manifest");
    if (evidence.approvalId !== manifest.approvalId || evidence.executionFingerprint !== manifest.executionFingerprint || evidence.environmentFingerprint !== manifest.environmentFingerprint) throw new DeliveryRefusalError("Evidence claims do not match manifest identity fields");
    const predicate = docs.get("predicate.json");
    if (predicate && typeof predicate === "object" && "subjectDigest" in predicate && predicate.subjectDigest !== manifest.subjectDigest) throw new DeliveryRefusalError("Predicate subject digest does not match manifest");
    let authenticity: DeliveryVerificationReport["authenticity"] = { status: "unverified", method: null, reason: null };
    const signatureFile = names.includes("signature.dsse.json");
    const ciFile = names.includes("ci.sigstore.json");
    if (signatureFile && ciFile) authenticity = { status: "invalid", method: null, reason: "Conflicting second signature mechanisms are not accepted" };
    let trust: DeliveryTrust | undefined;
    try { trust = parseTrust(options.trustPolicy); }
    catch (error) { authenticity = { status: "invalid", method: null, reason: `Invalid external trust policy: ${String(error)}` }; }
    if (ciFile) {
      try { parseStrictJson(ciBytes!, { maxBytes: DELIVERY_MAX_MEMBER_BYTES, maxDepth: 32 }); }
      catch (error) { authenticity = { status: "invalid", method: "ci-oidc", reason: `Invalid CI signature bundle: ${String(error)}` }; }
    }
    if (signatureFile && !ciFile && authenticity.status !== "invalid") {
      const envelopeBytes = signatureBytes!;
      try {
        const envelope = parseSchema(envelopeBytes, DsseEnvelopeSchema, DELIVERY_MAX_MEMBER_BYTES) as DsseEnvelope;
        const payload = decodeBase64(envelope.payload);
        const statement = DeliveryStatementSchema.parse(parseStrictJson(payload, { maxBytes: DELIVERY_MAX_MEMBER_BYTES, maxDepth: 32 }));
        if (canonicalJson(statement) !== payload.toString("utf8")) throw new DeliveryRefusalError("DSSE payload is not canonical JSON");
        if (statement.subject[0]?.digest.sha256 !== sha256(manifestBytes)) throw new DeliveryRefusalError("DSSE statement does not bind this manifest");
        if (statement.predicateType !== DELIVERY_PREDICATE_TYPE) throw new DeliveryRefusalError("Unexpected DSSE predicate type");
        const keys = trust?.localKeys ?? [];
        let foundKey: string | undefined;
        for (const signature of envelope.signatures) {
          for (const pin of keys) {
            const publicKey = createPublicKey(pin.spkiPem);
            if (keyId(publicKey) !== pin.sha256 || signature.keyid !== pin.sha256) continue;
            if (cryptoVerify(null, pae(envelope.payloadType, payload), publicKey, decodeBase64(signature.sig))) foundKey = pin.sha256;
          }
        }
        if (canonicalJson(statement.predicate) !== canonicalJson(predicate)) throw new DeliveryRefusalError("DSSE predicate does not match predicate.json");
        authenticity = foundKey ? { status: "verified", method: "local-key", keyId: foundKey, reason: null } : { status: "unverified", method: null, reason: "No valid signature matched an externally pinned SPKI key" };
      } catch (error) { authenticity = { status: "invalid", method: null, reason: `Invalid DSSE signature: ${String(error)}` }; }
    } else if (ciFile && !signatureFile && authenticity.status !== "invalid") {
      if (!trust?.ci) {
        authenticity = { status: "unsupported", method: "ci-oidc", reason: "CI verification requires an external CI identity and trusted-root policy" };
      } else {
        try {
          const rootAgeMs = await runGhCiVerification(dir, manifestBytes, memberBytes.get("predicate.json")!, resolve(dir, "ci.sigstore.json"), trust.ci);
          authenticity = { status: "verified", method: "ci-oidc", trustedRootAgeMs: rootAgeMs, reason: null };
        } catch (error) {
          authenticity = { status: "invalid", method: "ci-oidc", reason: `CI-OIDC verification failed: ${String((error as Error)?.message ?? error)}` };
        }
      }
    }

    let suppliedContent: DeliveryVerificationReport["suppliedContent"] = { status: "not-supplied", source: null, artifacts: null, unavailableGitlinks: [] };
    const artifacts = (docs.get("artifacts.json") as { artifacts: Array<{ path: string; sha256: string; size: number }> }).artifacts;
    let sourceResult: string | null = null; let artifactResult: string | null = null; const gitlinks: string[] = [];
    if (options.sourceRoot) {
      try {
        const result = await verifyInventory(options.sourceRoot, product.entries, "source", product.scope === "host-native-product"); sourceResult = result.result; gitlinks.push(...result.gitlinks);
      } catch { sourceResult = "mismatch"; }
    }
    if (options.artifactsRoot) {
      try {
        const result = await verifyInventory(options.artifactsRoot, artifacts.map((x) => ({ ...x, kind: "blob" })), "artifacts"); artifactResult = result.result;
      } catch { artifactResult = "mismatch"; }
    }
    const vals = [sourceResult, artifactResult].filter((x): x is string => x !== null);
    suppliedContent = { status: vals.includes("mismatch") ? "mismatch" : vals.includes("unavailable") ? "unavailable" : vals.length ? "verified" : "not-supplied", source: sourceResult, artifacts: artifactResult, unavailableGitlinks: gitlinks };
    const approvalId = evidence.approvalId;
    const claims: DeliveryVerificationReport["claims"] = options.expectedApproval !== undefined && options.expectedApproval !== approvalId ? { status: "approval-mismatch", approvalId } : { status: "self-reported", approvalId };
    await assertBundleState(dir, rootIdentity, names, fileIdentities);
    const integrity = { status: "valid" as const, reason: null };
    const requiredPassed = requirement === "integrity" ? true : requirement === "local-key" ? authenticity.status === "verified" && authenticity.method === "local-key" : authenticity.status === "verified" && authenticity.method === "ci-oidc";
    return { requirement, passed: requiredPassed && claims.status !== "approval-mismatch" && suppliedContent.status !== "mismatch", integrity, authenticity, suppliedContent, claims, predicate: predicateDigest };
  } catch (error) {
    const report = invalidReport(requirement, String((error as Error)?.message ?? error));
    if (requirement !== "integrity") report.passed = false;
    report.predicate = predicateDigest;
    return report;
  }
}

/** Sign or append one local signature, requiring the exact existing statement payload. */
export async function signDeliveryBundle(directory: string, privateKeyPath: string, options: { projectRoot: string; projectRoots?: string[]; passphrase?: string }): Promise<DsseEnvelope> {
  const dir = resolve(directory);
  const checked = await verifyDeliveryBundle(dir);
  if (checked.integrity.status !== "valid") throw new DeliveryRefusalError(`Refusing to sign invalid delivery bundle: ${checked.integrity.reason}`);
  await assertNoLinks(dir, "bundle path traverses a link");
  const bundleStat = await lstat(dir);
  if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) throw new DeliveryRefusalError("Bundle path must be a regular directory, not a link");
  const initialNames = await readdir(dir);
  if (initialNames.includes("ci.sigstore.json")) throw new DeliveryRefusalError("A CI signature already exists; refusing a second signature mechanism");
  const projectRoot = await safeRoot(options.projectRoot);
  const projectRoots = [projectRoot, ...(options.projectRoots ?? [])];
  await assertDeliverySigningKeyOutsideRoots(privateKeyPath, dir, projectRoots);
  const keyBytes = await readRegular(resolve(privateKeyPath), 64 * 1024);
  await assertDeliverySigningKeyOutsideRoots(privateKeyPath, dir, projectRoots);
  const manifestBytes = await readRegular(resolve(dir, "manifest.json"), 1024 * 1024);
  const manifestValue = parseStrictJson(manifestBytes, { maxBytes: 1024 * 1024, maxDepth: 32 });
  if (canonicalJson(manifestValue) !== manifestBytes.toString("utf8")) throw new DeliveryRefusalError("manifest.json is not canonical JSON");
  const manifest = DeliveryManifestSchema.parse(manifestValue);
  const predicateBytes = await readRegular(resolve(dir, "predicate.json"), DELIVERY_MAX_MEMBER_BYTES);
  const predicate = DeliveryPredicateSchema.parse(parseStrictJson(predicateBytes, { maxBytes: DELIVERY_MAX_MEMBER_BYTES, maxDepth: 32 }));
  if (predicate.subjectDigest !== manifest.subjectDigest) throw new DeliveryRefusalError("Predicate subject digest does not match manifest");
  const statement = DeliveryStatementSchema.parse({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "manifest.json", digest: { sha256: sha256(manifestBytes) } }],
    predicateType: DELIVERY_PREDICATE_TYPE,
    predicate,
  });
  const statementBytes = Buffer.from(canonicalJson(statement));
  const candidate = signDeliveryDsse(statementBytes, keyBytes, "application/vnd.in-toto+json", { passphrase: options.passphrase });
  const existing = initialNames.includes("signature.dsse.json");
  if (existing) {
    const oldBytes = await readRegular(resolve(dir, "signature.dsse.json"), DELIVERY_MAX_MEMBER_BYTES);
    const envelope = parseSchema(oldBytes, DsseEnvelopeSchema, DELIVERY_MAX_MEMBER_BYTES) as DsseEnvelope;
    const oldPayload = decodeBase64(envelope.payload);
    if (!oldPayload.equals(statementBytes) || envelope.payloadType !== candidate.payloadType) {
      throw new DeliveryRefusalError("Existing DSSE signature binds a different exact payload; refusing replacement");
    }
    const signatures = [...envelope.signatures, ...candidate.signatures];
    const unique = new Set(signatures.map((signature) => signature.keyid));
    if (unique.size !== signatures.length) throw new DeliveryRefusalError("This key already signed the DSSE payload");
    const finalCheck = await verifyDeliveryBundle(dir);
    if (finalCheck.integrity.status !== "valid" || finalCheck.authenticity.status === "invalid" ||
        (await readdir(dir)).includes("ci.sigstore.json") ||
        !(await readRegular(resolve(dir, "manifest.json"), 1024 * 1024)).equals(manifestBytes) ||
        !(await readRegular(resolve(dir, "predicate.json"), DELIVERY_MAX_MEMBER_BYTES)).equals(predicateBytes) ||
        !(await readRegular(resolve(dir, "signature.dsse.json"), DELIVERY_MAX_MEMBER_BYTES)).equals(oldBytes)) {
      throw new DeliveryRefusalError("Delivery bundle changed while signing; refusing to write signature");
    }
    const appended = { ...envelope, signatures };
    await atomicWriteFile(resolve(dir, "signature.dsse.json"), canonicalJson(appended), { root: dir });
    return appended;
  }
  const finalCheck = await verifyDeliveryBundle(dir);
  const finalNames = await readdir(dir);
  if (finalCheck.integrity.status !== "valid" || finalCheck.authenticity.status === "invalid" ||
      finalNames.includes("signature.dsse.json") || finalNames.includes("ci.sigstore.json") ||
      !(await readRegular(resolve(dir, "manifest.json"), 1024 * 1024)).equals(manifestBytes) ||
      !(await readRegular(resolve(dir, "predicate.json"), DELIVERY_MAX_MEMBER_BYTES)).equals(predicateBytes)) {
    throw new DeliveryRefusalError("Delivery bundle changed while signing; refusing to write signature");
  }
  await atomicWriteFile(resolve(dir, "signature.dsse.json"), canonicalJson(candidate), { root: dir });
  return candidate;
}

/** Refuse an external signing key located within the bundle or an explicitly discovered project root. */
export async function assertDeliverySigningKeyOutsideRoots(keyPath: string, bundleDirectory: string, projectRoots: string[] = []): Promise<void> {
  await assertNoLinks(resolve(keyPath), "signing key path traverses a link");
  const key = await realpath(resolve(keyPath));
  for (const rootPath of [bundleDirectory, ...projectRoots]) {
    let root: string;
    try { root = await realpath(resolve(rootPath)); } catch { continue; }
    if (within(root, key)) throw new DeliveryRefusalError("Signing key must be external to the bundle and every supplied project root");
  }
}
