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

async function unlinkIfExists(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

function lockPid(raw: string): number | "stale" {
  const trimmed = raw.trim();
  if (trimmed === "") return "stale";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return "stale";
    const pid = (parsed as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "stale";
    return pid;
  } catch {
    return "stale";
  }
}

async function maybeRemoveStaleLock(lockPath: string): Promise<void> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const pid = lockPid(raw);
    if (pid === "stale") {
      await unlinkIfExists(lockPath);
      return;
    }
    if (pid === process.pid) return;
    if (!isPidAlive(pid)) {
      await unlinkIfExists(lockPath);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    await unlinkIfExists(lockPath);
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
    let created = false;
    try {
      const handle = await open(lockPath, "wx");
      created = true;
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
          await unlinkIfExists(lockPath);
        },
      };
    } catch (err) {
      if (created) {
        await unlinkIfExists(lockPath);
        throw err;
      }
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
