import { readdir } from "node:fs/promises";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The next `<prefix>-<n>` id for `dir`: the maximum over file *names* plus one. Names count
 * whether or not the file is a valid record, so a corrupt file's id is never reused (F-004).
 *
 * Call it under engine.lock (the store's `withLock`), which serializes every writer in this
 * process and across processes. No placeholder file is created, so an interrupted command
 * cannot leave an empty reservation behind that blocks the gates.
 */
export async function nextFileId(dir: string, prefix: string, width = 4): Promise<string> {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)\\.md$`, "i");
  let max = 0;
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const name of names) {
    const match = pattern.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(width, "0")}`;
}
