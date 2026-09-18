import { lstat, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { PathEscapeError, PersistError } from "./errors.js";
import { MAX_ZIPBALL_BYTES, MAX_ZIPBALL_ENTRIES } from "./layout.js";
import { assertResolvedInside, canonicalizePath, toFsPath } from "./paths.js";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl") as typeof import("yauzl");

const UNIX_IFMT = 0o170000;
const UNIX_IFLNK = 0o120000;
const YAUZL_PATH_ERROR = /^(?:invalid relative path|absolute path|invalid characters in fileName):\s*(.*)$/;

function wrapYauzlError(err: unknown): never {
  if (err instanceof PathEscapeError || err instanceof PersistError) throw err;
  if (err instanceof Error) {
    const match = YAUZL_PATH_ERROR.exec(err.message);
    if (match) throw new PathEscapeError(match[1] ?? err.message);
    throw new PersistError("invalid zip", { cause: err });
  }
  throw new PersistError("invalid zip", { cause: err });
}

type ZipEntryData = {
  fileName: string;
  isDir: boolean;
  data: Buffer;
};

function isUnixSymlink(entry: import("yauzl").Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & UNIX_IFMT) === UNIX_IFLNK;
}

function openZipBuffer(buffer: Buffer): Promise<import("yauzl").ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (err, zipfile) => {
      if (err || !zipfile) {
        try {
          wrapYauzlError(err ?? new PersistError("invalid zip"));
        } catch (wrapped) {
          reject(wrapped);
        }
        return;
      }
      resolve(zipfile);
    });
  });
}

function readEntryData(
  zip: import("yauzl").ZipFile,
  entry: import("yauzl").Entry,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(new PersistError("invalid zip", { cause: err }));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          stream.destroy();
          reject(new PersistError("zip exceeded size cap"));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  });
}

function readAllEntries(
  zip: import("yauzl").ZipFile,
  maxUncompressed: number,
  maxEntries: number,
): Promise<ZipEntryData[]> {
  const out: ZipEntryData[] = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch {
        // zip may already be closed after a stream error
      }
      try {
        wrapYauzlError(err);
      } catch (wrapped) {
        reject(wrapped);
      }
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(out);
      }
    });
    zip.on("entry", (entry: import("yauzl").Entry) => {
      void (async () => {
        try {
          if (entry.fileName.includes("\\") || entry.fileName.includes("\0") || entry.fileName.includes(":")) {
            throw new PathEscapeError(entry.fileName);
          }
          if (isUnixSymlink(entry)) {
            throw new PathEscapeError(entry.fileName);
          }
          if (out.length >= maxEntries) {
            throw new PersistError("zip exceeded entry cap");
          }
          const isDir = entry.fileName.endsWith("/");
          if (!isDir) {
            const remaining = maxUncompressed - total;
            if (entry.uncompressedSize > remaining) {
              throw new PersistError("zip exceeded size cap");
            }
            const data = await readEntryData(zip, entry, remaining);
            total += data.length;
            out.push({ fileName: entry.fileName, isDir: false, data });
          } else {
            out.push({ fileName: entry.fileName, isDir: true, data: Buffer.alloc(0) });
          }
          if (!settled) zip.readEntry();
        } catch (err) {
          fail(err);
        }
      })();
    });
    zip.readEntry();
  });
}

function singleTopLevelPrefix(names: string[]): string | undefined {
  const tops = new Set<string>();
  for (const name of names) {
    const top = name.split("/")[0] ?? "";
    if (!top || top === "." || top === "..") return undefined;
    tops.add(top);
  }
  if (tops.size !== 1) return undefined;
  const top = [...tops][0];
  if (!top) return undefined;
  const prefix = `${top}/`;
  if (!names.some((name) => name.startsWith(prefix) || name === prefix)) return undefined;
  return prefix;
}

export type UnzipZipballOpts = {
  maxBytes?: number;
  maxUncompressedBytes?: number;
  maxEntries?: number;
};

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function assertNoSymlinkAncestors(root: string, abs: string): Promise<void> {
  const stop = resolve(root);
  let current = resolve(abs);
  for (;;) {
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) throw new PathEscapeError(abs);
      const real = canonicalizePath(current);
      if (!samePath(real, current)) throw new PathEscapeError(abs);
    } catch (err) {
      if (err instanceof PathEscapeError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (samePath(current, stop)) return;
    const parent = dirname(current);
    if (samePath(parent, current)) return;
    current = parent;
  }
}

export async function unzipZipball(zip: Buffer, destDir: string, opts?: UnzipZipballOpts): Promise<string[]> {
  const maxBytes = Math.min(opts?.maxBytes ?? MAX_ZIPBALL_BYTES, MAX_ZIPBALL_BYTES);
  const maxUncompressed = Math.min(opts?.maxUncompressedBytes ?? MAX_ZIPBALL_BYTES, MAX_ZIPBALL_BYTES);
  const maxEntries = Math.min(opts?.maxEntries ?? MAX_ZIPBALL_ENTRIES, MAX_ZIPBALL_ENTRIES);
  if (zip.byteLength > maxBytes) {
    throw new PersistError("zip exceeded size cap");
  }
  let zipfile: import("yauzl").ZipFile;
  try {
    zipfile = await openZipBuffer(zip);
  } catch (err) {
    wrapYauzlError(err);
  }
  const entries = await readAllEntries(zipfile, maxUncompressed, maxEntries);
  try {
    zipfile.close();
  } catch {
    // already closed on some error paths
  }

  const prefix = singleTopLevelPrefix(entries.map((entry) => entry.fileName));
  const written: string[] = [];
  await mkdir(destDir, { recursive: true });
  await assertNoSymlinkAncestors(destDir, destDir);

  for (const entry of entries) {
    let rel = entry.fileName;
    if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
    if (rel === "" || rel === "/") continue;
    if (rel.includes("\\") || rel.includes("\0") || rel.includes(":")) {
      throw new PathEscapeError(rel);
    }
    const abs = assertResolvedInside(destDir, toFsPath(destDir, rel), rel);
    await assertNoSymlinkAncestors(destDir, abs);
    if (entry.isDir) {
      await mkdir(abs, { recursive: true });
      await assertNoSymlinkAncestors(destDir, abs);
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    await assertNoSymlinkAncestors(destDir, abs);
    await writeFile(abs, entry.data);
    written.push(rel);
  }
  return written;
}
