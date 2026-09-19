import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { SymlinkRefusedError } from "./errors.js";

/** Codes Windows returns while another handle (reader, editor, antivirus) has the file open. */
const WIN32_BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export const RETRY_FS_OP_TOTAL_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

export function isWin32BusyError(err: unknown): boolean {
  return process.platform === "win32" && WIN32_BUSY_CODES.has((err as NodeJS.ErrnoException)?.code ?? "");
}

/**
 * Run `op`, retrying Windows sharing violations (EPERM/EACCES/EBUSY) with backoff for up to
 * `totalMs` (default 2 s). Other errors, and every error on POSIX, are thrown at once.
 */
export async function retryFsOp<T>(op: () => Promise<T>, opts?: { totalMs?: number }): Promise<T> {
  const totalMs = opts?.totalMs ?? RETRY_FS_OP_TOTAL_MS;
  const started = Date.now();
  let wait = 10;
  while (true) {
    try {
      return await op();
    } catch (err) {
      if (!isWin32BusyError(err)) throw err;
      const elapsed = Date.now() - started;
      if (elapsed >= totalMs) throw err;
      await delay(Math.min(wait, totalMs - elapsed));
      wait = Math.min(wait * 2, 200);
    }
  }
}

async function isLink(abs: string): Promise<boolean | null> {
  try {
    return (await lstat(abs)).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Refuse when `abs`, or any existing directory between `root` (exclusive) and `abs`, is a
 * symlink or junction. Without `root` only `abs` and its parent are checked.
 */
export async function assertNoLinkInPath(
  abs: string,
  opts?: { root?: string; message?: string },
): Promise<void> {
  const message = opts?.message ?? "path is a symlink";
  const target = resolve(abs);
  const candidates: string[] = [];
  const root = opts?.root ? resolve(opts.root) : undefined;
  const rel = root ? relative(root, target) : "";
  if (root && rel && !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel)) {
    let cursor = root;
    for (const part of rel.split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      candidates.push(cursor);
    }
  } else {
    candidates.push(dirname(target), target);
  }
  for (const candidate of candidates) {
    const linked = await isLink(candidate);
    if (linked === null) return; // nothing below a missing component exists yet
    if (linked) throw new SymlinkRefusedError(message, candidate);
  }
}

/** @deprecated kept for callers that check one path; prefer {@link assertNoLinkInPath}. */
export async function assertNotSymlink(abs: string, message = "path is a symlink"): Promise<void> {
  if (await isLink(abs)) throw new SymlinkRefusedError(message, abs);
}

/**
 * Write `abs` atomically: temp file in the same directory, fsync, rename. On win32 the rename
 * retries sharing violations for up to 2 s; the temp file is removed on final failure.
 * Refuses a link at the final component or at any ancestor below `root`.
 */
export async function atomicWriteFile(
  abs: string,
  body: string | Buffer,
  opts?: { symlinkMessage?: string; root?: string },
): Promise<void> {
  const target = resolve(abs);
  const dir = dirname(target);
  const linkOpts = { root: opts?.root, message: opts?.symlinkMessage };
  await assertNoLinkInPath(target, linkOpts);
  await mkdir(dir, { recursive: true });
  await assertNoLinkInPath(target, linkOpts);
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
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertNotSymlink(target, opts?.symlinkMessage);
    await retryFsOp(() => rename(tmp, target));
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
