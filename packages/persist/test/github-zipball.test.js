import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { crc32 } from "node:zlib";

import {
  githubZipballUrl,
  hashTreeFiles,
  MinisignError,
  parseGithubRepoSource,
  PathEscapeError,
  PersistError,
  readNinthlevelMinisignPub,
  unzipZipball,
  verifyMinisign,
} from "../dist/index.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const minisignFixture = join(pkgRoot, "test", "fixtures", "minisign");

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-zipball-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeZip(files) {
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

test("github: without tag refuses", () => {
  assert.deepEqual(parseGithubRepoSource("github:acme/brand"), { owner: "acme", repo: "brand", ref: undefined });
  assert.throws(() => githubZipballUrl("github:acme/brand"), (err) => {
    assert.equal(err instanceof PersistError, true);
    assert.match(err.message, /@tag/);
    return true;
  });
  assert.throws(() => githubZipballUrl("github:owner/repo"), PersistError);
  assert.throws(() => parseGithubRepoSource("github:pr:123"), PersistError);
  assert.throws(() => parseGithubRepoSource("github:acme"), PersistError);
});

test("githubZipballUrl builds tags zipball and heads only when allowBranch", () => {
  assert.equal(
    githubZipballUrl("github:acme/brand@v1.0.0"),
    "https://github.com/acme/brand/archive/refs/tags/v1.0.0.zip",
  );
  assert.equal(
    githubZipballUrl("github:acme/brand@main", { allowBranch: true }),
    "https://github.com/acme/brand/archive/refs/heads/main.zip",
  );
  assert.throws(() => githubZipballUrl("github:acme/brand@v1/../v2"), PersistError);
});

test("unzipZipball strips a single top-level folder", async () => {
  await withTempDir(async (dir) => {
    const zip = makeZip([
      { name: "brand-v1.0.0/README.md", data: "hello\n" },
      { name: "brand-v1.0.0/src/a.ts", data: "export {}\n" },
    ]);
    const dest = join(dir, "out");
    const files = await unzipZipball(zip, dest);
    assert.deepEqual([...files].sort(), ["README.md", "src/a.ts"]);
    assert.equal(await readFile(join(dest, "README.md"), "utf8"), "hello\n");
    assert.equal(await readFile(join(dest, "src", "a.ts"), "utf8"), "export {}\n");
  });
});

test("unzipZipball refuses zip-slip .. entries", async () => {
  await withTempDir(async (dir) => {
    const zip = makeZip([{ name: "../../etc/passwd", data: "root:x:0:0:root:/root:/bin/sh\n" }]);
    await assert.rejects(() => unzipZipball(zip, join(dir, "out")), PathEscapeError);
  });
});

test("unzipZipball refuses zip-slip inside a top-level folder", async () => {
  await withTempDir(async (dir) => {
    const zip = makeZip([{ name: "brand-v1/../../etc/passwd", data: "nope\n" }]);
    await assert.rejects(() => unzipZipball(zip, join(dir, "out")), PathEscapeError);
  });
});

test("unzipZipball refuses backslash entries", async () => {
  await withTempDir(async (dir) => {
    const zip = makeZip([{ name: "..\\..\\etc\\passwd", data: "nope\n" }]);
    await assert.rejects(() => unzipZipball(zip, join(dir, "out")), PathEscapeError);
  });
});

test("unzipZipball refuses absolute entries", async () => {
  await withTempDir(async (dir) => {
    const zip = makeZip([{ name: "/etc/passwd", data: "nope\n" }]);
    await assert.rejects(() => unzipZipball(zip, join(dir, "out")), PathEscapeError);
  });
});

test("hashTreeFiles is canonical sorted path+bytes", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "README.md"), "hello\n", "utf8");
    await writeFile(join(dir, "src", "a.ts"), "export {}\n", "utf8");
    const hex = await hashTreeFiles(dir);
    assert.match(hex, /^[a-f0-9]{64}$/);
    const again = await hashTreeFiles(dir, ["src/a.ts", "README.md"]);
    assert.equal(again, hex);
    const swapped = await hashTreeFiles(dir, ["README.md", "src/a.ts"]);
    assert.equal(swapped, hex);
  });
});

test("verifyMinisign accepts a real minisign fixture of the sha256 hex", async () => {
  const payload = await readFile(join(minisignFixture, "sha256.hex"), "utf8");
  const signature = await readFile(join(minisignFixture, "sha256.hex.minisig"), "utf8");
  const publicKey = readNinthlevelMinisignPub();
  assert.equal(payload, "32640f476ab6bf1f86800218e7aaf99b01e32f44d8194f8bef3c98c5b946e5e9");
  await verifyMinisign({ payload, signature, publicKey });
  await assert.rejects(
    () => verifyMinisign({ payload: "0".repeat(64), signature, publicKey }),
    MinisignError,
  );
});
