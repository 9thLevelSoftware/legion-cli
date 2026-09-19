import {
  atomicWriteFile as persistAtomicWriteFile,
  assertNotSymlink as persistAssertNotSymlink,
  SymlinkRefusedError,
} from "@9thlevelsoftware/legion-cli-persist";
import { HINT, refuse } from "./errors.js";

export { retryFsOp } from "@9thlevelsoftware/legion-cli-persist";

async function refuseLinks<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof SymlinkRefusedError) refuse(err.message, HINT.chat);
    throw err;
  }
}

export async function assertNotSymlink(abs: string, message = "path is a symlink"): Promise<void> {
  await refuseLinks(() => persistAssertNotSymlink(abs, message));
}

/** The persist atomic writer (temp + fsync + rename, win32 retry); a link refuses. */
export async function atomicWriteFile(
  abs: string,
  body: string | Buffer,
  opts?: { symlinkMessage?: string; root?: string },
): Promise<void> {
  await refuseLinks(() => persistAtomicWriteFile(abs, body, opts));
}
