import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HINT, refuse } from "./errors.js";

export async function assertNotSymlink(abs: string, message = "path is a symlink"): Promise<void> {
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      refuse(message, HINT.chat);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Write `abs` via tmp + rename. Refuses if `abs` or its parent is a symlink. */
export async function atomicWriteFile(
  abs: string,
  body: string | Buffer,
  opts?: { symlinkMessage?: string },
): Promise<void> {
  const dir = dirname(abs);
  await mkdir(dir, { recursive: true });
  const message = opts?.symlinkMessage ?? "path is a symlink";
  await assertNotSymlink(dir, message);
  await assertNotSymlink(abs, message);
  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, flags);
    await handle.writeFile(body);
    await handle.close();
    handle = undefined;
    await assertNotSymlink(abs, message);
    await rename(tmp, abs);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // already closed
      }
    }
    try {
      await unlink(tmp);
    } catch {
      // tmp may not exist
    }
    throw err;
  }
}
