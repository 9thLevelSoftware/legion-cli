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

/** SHA-256 hex of canonical sorted relative paths and file bytes. */
export async function hashTreeFiles(dir: string, files?: readonly string[]): Promise<string> {
  const list = files ? [...files].map(toPosixPath).sort() : await listTreeFiles(dir);
  const hash = createHash("sha256");
  for (const file of list) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(toFsPath(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
