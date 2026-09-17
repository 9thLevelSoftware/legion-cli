import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { EngineLockedError } from "./errors.js";
import { DEFAULT_LOCK_TIMEOUT_MS } from "./layout.js";

export type HeldLock = {
  release: () => Promise<void>;
  token: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isPidAlive(pid: number): boolean {
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

type ParsedLockPid = { kind: "wait" } | { kind: "pid"; pid: number };

/** Empty/partial/invalid payload is wait, not steal (KD-12). */
function lockPid(raw: string): ParsedLockPid {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "wait" };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return { kind: "wait" };
    const pid = (parsed as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return { kind: "wait" };
    return { kind: "pid", pid };
  } catch {
    return { kind: "wait" };
  }
}

async function maybeRemoveStaleLock(lockPath: string): Promise<void> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = lockPid(raw);
    if (parsed.kind === "wait") return;
    if (parsed.pid === process.pid) return;
    if (!isPidAlive(parsed.pid)) {
      const still = await readFile(lockPath, "utf8");
      if (still === raw) await unlinkIfExists(lockPath);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // Unreadable lock: wait, do not steal.
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
      const handle = await open(lockPath, "wx+");
      created = true;
      const token = randomBytes(16).toString("hex");
      try {
        await handle.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString(),
            token,
          })}\n`,
          "utf8",
        );
        const onDisk = await readFile(lockPath, "utf8");
        if (!onDisk.includes(`"token":"${token}"`)) {
          await handle.close().catch(() => undefined);
          created = false;
          continue;
        }
      } catch (err) {
        await handle.close().catch(() => undefined);
        if (created) await unlinkIfExists(lockPath);
        throw err;
      }
      let released = false;
      return {
        token,
        async release() {
          if (released) return;
          released = true;
          try {
            await handle.close();
          } finally {
            await unlinkIfExists(lockPath);
          }
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
