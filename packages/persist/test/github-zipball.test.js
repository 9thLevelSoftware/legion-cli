import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { crc32 } from "node:zlib";

import {
  githubZipballUrl,
  hashTreeFiles,
  hashTreeRecords,
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

test("unzipZipball refuses compressed size, uncompressed size, and entry caps", async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, "out");
    const twoFiles = makeZip([
      { name: "a.txt", data: "aaaa\n" },
      { name: "b.txt", data: "bbbb\n" },
    ]);
    await assert.rejects(
      () => unzipZipball(twoFiles, dest, { maxBytes: 40 }),
      (err) => {
        assert.equal(err instanceof PersistError, true);
        assert.match(err.message, /size cap/);
        return true;
      },
    );
    await assert.rejects(
      () => unzipZipball(twoFiles, dest, { maxUncompressedBytes: 6 }),
      (err) => {
        assert.equal(err instanceof PersistError, true);
        assert.match(err.message, /size cap/);
        return true;
      },
    );
    await assert.rejects(
      () => unzipZipball(twoFiles, dest, { maxEntries: 1 }),
      (err) => {
        assert.equal(err instanceof PersistError, true);
        assert.match(err.message, /entry cap/);
        return true;
      },
    );
  });
});

test("unzipZipball refuses a destDir or child directory that is a symlink", async () => {
  await withTempDir(async (dir) => {
    const leak = join(dir, "leak");
    await mkdir(leak, { recursive: true });
    const dest = join(dir, "out");
    try {
      await symlink(leak, dest, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    const zip = makeZip([{ name: "README.md", data: "pwned\n" }]);
    await assert.rejects(() => unzipZipball(zip, dest), PathEscapeError);
    assert.equal(existsSync(join(leak, "README.md")), false);

    const dest2 = join(dir, "out2");
    await mkdir(dest2, { recursive: true });
    const child = join(dest2, "src");
    try {
      await symlink(leak, child, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    const nested = makeZip([
      { name: "pkg/README.md", data: "ok\n" },
      { name: "pkg/src/payload.ts", data: "pwned\n" },
    ]);
    await assert.rejects(() => unzipZipball(nested, dest2), PathEscapeError);
    assert.equal(existsSync(join(leak, "payload.ts")), false);
  });
});

test("unzipZipball allows POSIX colon names", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, "out");
    const zip = makeZip([
      { name: "brand-v1/README.md", data: "ok\n" },
      { name: "brand-v1/docs/api:v2.md", data: "colon\n" },
    ]);
    const written = await unzipZipball(zip, dest);
    assert.equal(written.includes("docs/api:v2.md"), true);
    assert.equal(await readFile(join(dest, "docs", "api:v2.md"), "utf8"), "colon\n");
  });
});

test("unzipZipball refuses hard-linked extraction targets", async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, "out");
    const leak = join(dir, "outside.txt");
    await mkdir(dest, { recursive: true });
    await writeFile(leak, "secret\n", "utf8");
    try {
      await link(leak, join(dest, "README.md"));
    } catch {
      return;
    }
    const zip = makeZip([{ name: "brand-v1/README.md", data: "pwned\n" }]);
    await assert.rejects(() => unzipZipball(zip, dest), PathEscapeError);
    assert.equal(await readFile(leak, "utf8"), "secret\n");
  });
});

test("unzipZipball refuses nested Windows drive-relative zip-slip", async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, "out");
    const zip = makeZip([
      { name: "brand-v1/README.md", data: "ok\n" },
      { name: "brand-v1/nested/D:payload", data: "pwned\n" },
    ]);
    await assert.rejects(() => unzipZipball(zip, dest), PathEscapeError);
    const escaped = resolve(dest, "nested", "D:payload");
    assert.equal(existsSync(escaped), false, escaped);
    assert.equal(existsSync(join(dest, "nested", "D:payload")), false);
  });
});

test("hashTreeFiles is canonical sorted path+bytes", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "README.md"), "hello\n", "utf8");
    await writeFile(join(dir, "src", "a.ts"), "export {}\n", "utf8");
    const hex = await hashTreeFiles(dir);
    assert.equal(hex, "2a5c5cc8389700aef11e5fe8cfb3edb75757b2bac832eacc13960acf1709dd21");
    const again = await hashTreeFiles(dir, ["src/a.ts", "README.md"]);
    assert.equal(again, hex);
    const swapped = await hashTreeFiles(dir, ["README.md", "src/a.ts"]);
    assert.equal(swapped, hex);
  });
});

test("hashTreeFiles refuses listed symlinks", async () => {
  await withTempDir(async (dir) => {
    const leak = join(dir, "outside.txt");
    await writeFile(leak, "secret\n", "utf8");
    const tree = join(dir, "tree");
    await mkdir(tree, { recursive: true });
    try {
      await symlink(leak, join(tree, "README.md"));
    } catch {
      return;
    }
    await assert.rejects(() => hashTreeFiles(tree, ["README.md"]), PathEscapeError);
  });
});

test("hashTreeRecords does not collide across path/byte NUL boundaries", () => {
  const a = hashTreeRecords([{ path: "a", bytes: Buffer.from("b\0c") }]);
  const b = hashTreeRecords([{ path: "a\0b", bytes: Buffer.from("c") }]);
  assert.notEqual(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.match(b, /^[a-f0-9]{64}$/);
});

test("verifyMinisign accepts a real minisign fixture of the sha256 hex", async () => {
  const payload = await readFile(join(minisignFixture, "sha256.hex"), "utf8");
  const signature = await readFile(join(minisignFixture, "sha256.hex.minisig"), "utf8");
  const publicKey = readNinthlevelMinisignPub();
  assert.equal(payload, "32640f476ab6bf1f86800218e7aaf99b01e32f44d8194f8bef3c98c5b946e5e9");
  await verifyMinisign({ payload, signature, publicKey });
  const bare = publicKey
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("untrusted comment:"));
  await verifyMinisign({ payload, signature, publicKey: bare });
  await assert.rejects(
    () => verifyMinisign({ payload: "0".repeat(64), signature, publicKey }),
    MinisignError,
  );
  await assert.rejects(
    () => verifyMinisign({ payload: "not-a-digest", signature, publicKey }),
    MinisignError,
  );
});
