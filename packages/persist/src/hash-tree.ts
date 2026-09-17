import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PathEscapeError } from "./errors.js";
import { toFsPath, toPosixPath } from "./paths.js";

async function listTreeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel ? toFsPath(dir, rel) : dir;
    const ents = await readdir(abs, { withFileTypes: true });
    for (const ent of ents) {
      if (ent.name === "." || ent.name === "..") continue;
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) {
        throw new PathEscapeError(child);
      }
      if (ent.isDirectory()) {
        await walk(child);
      } else if (ent.isFile()) {
        out.push(toPosixPath(child));
      }
    }
  }
  await walk("");
  return out.sort();
}

function sha256Bytes(data: string | Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/** Injective over (path, bytes) pairs: sha256(path) || sha256(bytes), sorted by path. */
export function hashTreeRecords(files: ReadonlyArray<{ path: string; bytes: Buffer }>): string {
  const sorted = [...files]
    .map((file) => ({ path: toPosixPath(file.path), bytes: file.bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash.update(sha256Bytes(file.path));
    hash.update(sha256Bytes(file.bytes));
  }
  return hash.digest("hex");
}

/** SHA-256 hex of canonical sorted relative paths and file bytes. */
export async function hashTreeFiles(dir: string, files?: readonly string[]): Promise<string> {
  const list = files ? [...files].map(toPosixPath).sort() : await listTreeFiles(dir);
  const records = await Promise.all(
    list.map(async (path) => ({ path, bytes: await readFile(toFsPath(dir, path)) })),
  );
  return hashTreeRecords(records);
}
