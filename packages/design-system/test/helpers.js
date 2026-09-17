import { createHash, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { hashTreeRecords } from "@9thlevelsoftware/legion-cli-persist";

export const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const odFixture = join(pkgRoot, "test", "fixtures", "od-acme");
export const repoRoot = join(pkgRoot, "..", "..");
export const legionFixture = join(repoRoot, "design-systems", "_fixture-neutral");

export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-ds-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function initStub(dir) {
  const root = join(dir, ".legion-cli");
  await mkdir(join(root, "design", "craft"), { recursive: true });
  await writeFile(join(root, "STATE.md"), "---\nschemaVersion: legion-cli-state/v1\nphase: initialized\n---\n", "utf8");
  return dir;
}

export function hashPackageRecords(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.data);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function hashTreePackageRecords(files) {
  return hashTreeRecords(
    files.map((file) => ({
      path: file.name,
      bytes: Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data),
    })),
  );
}

export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localFull = Buffer.concat([local, name, data]);
    locals.push(localFull);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(file.external ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += localFull.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

export function makeMinisignPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const pubRaw = pubDer.subarray(pubDer.length - 32);
  const keyId = Buffer.from("testds01");
  const pubDecoded = Buffer.concat([Buffer.from("Ed"), keyId, pubRaw]);
  const pubText = `untrusted comment: minisign public key 7465737464733031\n${pubDecoded.toString("base64")}\n`;
  return { publicKey: pubText, privateKey, keyId };
}

export function signMinisign(payloadHex, pair) {
  const payload = Buffer.from(payloadHex, "utf8");
  const prehash = createHash("blake2b512").update(payload).digest();
  const signature = nodeSign(null, prehash, pair.privateKey);
  const trusted = "timestamp:0 file:sha256.hex hashed";
  const globalMsg = Buffer.concat([signature, Buffer.from(trusted, "utf8")]);
  const globalSignature = nodeSign(null, globalMsg, pair.privateKey);
  const sigDecoded = Buffer.concat([Buffer.from("ED"), pair.keyId, signature]);
  return [
    "untrusted comment: signature from legion-cli test key",
    sigDecoded.toString("base64"),
    `trusted comment: ${trusted}`,
    globalSignature.toString("base64"),
    "",
  ].join("\n");
}

export function makeDesignZip(opts = {}) {
  const files = opts.files ?? [
    { name: "DESIGN.md", data: "# Acme\n" },
    { name: "tokens.css", data: ":root { --legion-ink: #111111; }\n" },
  ];
  const sha = opts.sha256 ?? hashTreePackageRecords(files);
  const pair = opts.pair ?? (opts.minisign || opts.sign ? makeMinisignPair() : undefined);
  const minisign = opts.minisign ?? (pair ? signMinisign(sha, pair) : undefined);
  const manifest = {
    schemaVersion: "legion-cli-design-system/v1",
    id: opts.id ?? "acme",
    name: opts.name ?? "Acme",
    description: opts.description ?? "Brand",
    source: opts.source ?? { type: "github", origin: "github:acme/brand@v1.2.0" },
    files: { design: "DESIGN.md", tokens: "tokens.css", ...(opts.usage ? { usage: "USAGE.md" } : {}) },
    integrity: {
      sha256: sha,
      ...(minisign ? { minisign } : {}),
    },
  };
  const prefix = opts.prefix ?? "acme-brand-v1.2.0/";
  const zipFiles = [
    { name: `${prefix}manifest.json`, data: `${JSON.stringify(manifest, null, 2)}\n` },
    ...files.map((file) => ({ name: `${prefix}${file.name}`, data: file.data })),
  ];
  return { zip: makeZip(zipFiles), sha, pair, minisign, manifest };
}
