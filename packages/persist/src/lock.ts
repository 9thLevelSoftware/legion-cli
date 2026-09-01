import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { EngineLockedError } from "./errors.js";
import { DEFAULT_LOCK_TIMEOUT_MS } from "./layout.js";

export type HeldLock = {
  release: () => Promise<void>;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}

async function maybeRemoveStaleLock(lockPath: string): Promise<void> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid !== "number") return;
    if (parsed.pid === process.pid) return;
    if (!isPidAlive(parsed.pid)) {
      await unlink(lockPath);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
  }
}

export async function acquireEngineLock(
  lockPath: string,
  opts?: { timeoutMs?: number },
): Promise<HeldLock> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const started = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          "utf8",
        );
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            await unlink(lockPath);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") throw err;
          }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      await maybeRemoveStaleLock(lockPath);
      if (Date.now() - started >= timeoutMs) {
        throw new EngineLockedError();
      }
      await delay(50);
    }
  }
}
