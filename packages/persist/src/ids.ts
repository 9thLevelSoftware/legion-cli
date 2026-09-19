import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Allocate `<prefix>-<n>` in `dir`: the maximum over file *names* (valid or not) plus one,
 * reserved by creating `<id>.md` with O_EXCL (`wx`) and retried on EEXIST. The reservation is an
 * empty file; write the record over it, or call {@link releaseFileId} if the caller gives up.
 */
export async function nextFileId(dir: string, prefix: string, width = 4): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)\\.md$`, "i");
  let max = 0;
  for (const name of await readdir(dir)) {
    const match = pattern.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  for (let n = max + 1; ; n += 1) {
    const id = `${prefix}-${String(n).padStart(width, "0")}`;
    try {
      const handle = await open(join(dir, `${id}.md`), "wx");
      await handle.close();
      return id;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/** Remove an unused reservation from {@link nextFileId}; a file with content is left alone. */
export async function releaseFileId(dir: string, id: string): Promise<void> {
  const abs = join(dir, `${id}.md`);
  try {
    if ((await stat(abs)).size === 0) await unlink(abs);
  } catch {
    // already gone or written
  }
}
