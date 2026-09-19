import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isWin32BusyError } from "./atomic-write.js";
import { EngineLockedError } from "./errors.js";
import { DEFAULT_LOCK_TIMEOUT_MS } from "./layout.js";
import { ownProcessStartedAt, processIdentity, sameProcessStart } from "./process-identity.js";

export type HeldLock = {
  release: () => Promise<void>;
  token: string;
};

/** An empty or unparseable lock older than this is a crash between create and write (KD-8). */
export const EMPTY_LOCK_STALE_MS = 10_000;

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

type LockPayload = { pid: number; pidStartedAt?: number; acquiredAt?: string };

function parseLock(raw: string): LockPayload | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as { pid?: unknown; pidStartedAt?: unknown; acquiredAt?: unknown };
    if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0) return null;
    return {
      pid: rec.pid,
      ...(typeof rec.pidStartedAt === "number" && Number.isFinite(rec.pidStartedAt)
        ? { pidStartedAt: rec.pidStartedAt }
        : {}),
      ...(typeof rec.acquiredAt === "string" ? { acquiredAt: rec.acquiredAt } : {}),
    };
  } catch {
    return null;
  }
}

type Inspection =
  | { kind: "gone" }
  | { kind: "steal"; raw: string }
  | { kind: "wait"; holder?: LockPayload; undetermined?: boolean };

/**
 * Steal only when (a) the lock is empty/unparseable and older than 10 s by mtime, (b) its PID is
 * dead, or (c) with `deep`, its PID is alive but started at a different time (PID reuse).
 * Never by age while the recorded process is alive; an unknown start time is not stolen.
 */
async function inspectLock(lockPath: string, deep: boolean): Promise<Inspection> {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = await readFile(lockPath, "utf8");
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "gone" };
    return { kind: "wait" }; // unreadable (e.g. win32 sharing violation): wait, do not steal
  }
  const holder = parseLock(raw);
  if (!holder) {
    return Date.now() - mtimeMs > EMPTY_LOCK_STALE_MS ? { kind: "steal", raw } : { kind: "wait" };
  }
  if (holder.pid === process.pid) {
    // Another store in this process, unless the lock predates us under a reused PID.
    if (holder.pidStartedAt !== undefined && !sameProcessStart(holder.pidStartedAt, ownProcessStartedAt())) {
      return { kind: "steal", raw };
    }
    return { kind: "wait" };
  }
  if (!isPidAlive(holder.pid)) return { kind: "steal", raw };
  if (!deep) return { kind: "wait", holder };
  if (holder.pidStartedAt === undefined) return { kind: "wait", holder, undetermined: true };
  const actual = await processIdentity(holder.pid);
  if (actual === null) return { kind: "wait", holder, undetermined: true };
  if (!sameProcessStart(holder.pidStartedAt, actual)) return { kind: "steal", raw };
  return { kind: "wait", holder };
}

async function removeIfUnchanged(lockPath: string, raw: string): Promise<void> {
  try {
    const still = await readFile(lockPath, "utf8");
    if (still === raw) await unlinkIfExists(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
}

function lockedMessage(lockPath: string, inspection: Inspection | undefined): string | undefined {
  if (inspection?.kind !== "wait" || !inspection.holder) return undefined;
  const { pid, acquiredAt } = inspection.holder;
  const check =
    process.platform === "win32" ? `tasklist /FI "PID eq ${pid}"` : `ps -p ${pid} -o pid,lstart,command`;
  const why = inspection.undetermined ? " Its start time could not be read, so the lock was not cleared." : "";
  return (
    `another legion-cli is running. ${lockPath} is held by pid ${pid}` +
    `${acquiredAt ? ` since ${acquiredAt}` : ""}.${why} ` +
    `Check it with \`${check}\`; if that process is not legion-cli, delete ${lockPath} and re-run.`
  );
}

export async function acquireEngineLock(
  lockPath: string,
  opts?: { timeoutMs?: number },
): Promise<HeldLock> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const started = Date.now();
  let deepChecked = false;
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
            pidStartedAt: ownProcessStartedAt(),
            acquiredAt: new Date().toISOString(),
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
      if (isWin32BusyError(err)) {
        // The previous lock file is still being deleted while another handle reads it.
        if (Date.now() - started >= timeoutMs) throw new EngineLockedError();
        await delay(20);
        continue;
      }
      if (code !== "EEXIST") throw err;
      const quick = await inspectLock(lockPath, false);
      if (quick.kind === "gone") continue;
      if (quick.kind === "steal") {
        await removeIfUnchanged(lockPath, quick.raw);
        continue;
      }
      if (Date.now() - started >= timeoutMs) {
        // Contention path only: the start-time lookup is slow on Windows (PowerShell).
        let final: Inspection = quick;
        if (!deepChecked) {
          deepChecked = true;
          final = await inspectLock(lockPath, true);
          if (final.kind === "gone") continue;
          if (final.kind === "steal") {
            await removeIfUnchanged(lockPath, final.raw);
            continue;
          }
        }
        throw new EngineLockedError(lockedMessage(lockPath, final));
      }
      await delay(50);
    }
  }
}
