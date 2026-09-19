import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isWin32BusyError } from "./atomic-write.js";
import { EngineLockedError } from "./errors.js";
import { DEFAULT_LOCK_TIMEOUT_MS } from "./layout.js";
import { ownProcessStartedAt, processIdentity, startedAfterRecorded } from "./process-identity.js";

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

/** `process.kill` only accepts a signed 32-bit pid; anything else throws a TypeError. */
const MAX_PID = 2 ** 31 - 1;

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) return false;
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

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function parseLock(raw: string): LockPayload | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as { pid?: unknown; pidStartedAt?: unknown; acquiredAt?: unknown };
    // An out-of-range pid is unparseable (stale after 10 s), never a TypeError from process.kill.
    if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0 || rec.pid > MAX_PID) {
      return null;
    }
    return {
      pid: rec.pid,
      ...(typeof rec.pidStartedAt === "number" && Number.isFinite(rec.pidStartedAt)
        ? { pidStartedAt: rec.pidStartedAt }
        : {}),
      // Printed in the refusal: accept only an ISO timestamp, never raw control characters.
      ...(typeof rec.acquiredAt === "string" && ISO_TIMESTAMP.test(rec.acquiredAt)
        ? { acquiredAt: rec.acquiredAt }
        : {}),
    };
  } catch {
    return null;
  }
}

type Inspection =
  | { kind: "gone" }
  | { kind: "steal"; raw: string }
  | { kind: "wait"; holder?: LockPayload; undetermined?: boolean; unparseable?: boolean };

/**
 * Steal only when (a) the lock is empty/unparseable and older than 10 s by mtime, (b) its PID is
 * dead, or (c) with `deep`, its PID is alive but that process started after the recorded start
 * (PID reuse). Never by age while the recorded process is alive; a missing or unreadable start
 * time (e.g. a lock written by an older legion-cli) is waited on, never stolen.
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
    return Date.now() - mtimeMs > EMPTY_LOCK_STALE_MS ? { kind: "steal", raw } : { kind: "wait", unparseable: true };
  }
  if (holder.pid === process.pid) {
    // Another store in this process, unless the lock predates us under a reused PID.
    if (holder.pidStartedAt !== undefined && startedAfterRecorded(ownProcessStartedAt(), holder.pidStartedAt)) {
      return { kind: "steal", raw };
    }
    return { kind: "wait" };
  }
  if (!isPidAlive(holder.pid)) return { kind: "steal", raw };
  if (!deep) return { kind: "wait", holder };
  if (holder.pidStartedAt === undefined) return { kind: "wait", holder, undetermined: true };
  const actual = await processIdentity(holder.pid);
  if (actual === null) return { kind: "wait", holder, undetermined: true };
  if (startedAfterRecorded(actual, holder.pidStartedAt)) return { kind: "steal", raw };
  return { kind: "wait", holder };
}

/** A steal guard older than this was left by a contender that crashed mid-steal. */
const STEAL_GUARD_STALE_MS = 10_000;

/**
 * Remove a stale lock only while holding `<lock>.steal` (created with O_EXCL), and only if the
 * lock still has the exact content judged stale. Stealers are serialized by the guard, and a
 * new lock can only be created once the stale one is gone, so a contender that judged the same
 * stale file later finds different content and leaves the new holder's lock alone (no
 * read-then-unlink race between two stealers).
 */
async function removeIfUnchanged(lockPath: string, raw: string): Promise<void> {
  const guardPath = `${lockPath}.steal`;
  let guard: Awaited<ReturnType<typeof open>>;
  try {
    guard = await open(guardPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        if (Date.now() - (await stat(guardPath)).mtimeMs > STEAL_GUARD_STALE_MS) await unlinkIfExists(guardPath);
      } catch {
        // gone already
      }
    }
    return; // another contender is stealing: re-inspect on the next round
  }
  try {
    const still = await readFile(lockPath, "utf8");
    if (still === raw) await unlinkIfExists(lockPath);
  } catch {
    // gone already or busy: re-inspect on the next round
  } finally {
    await guard.close().catch(() => undefined);
    await unlinkIfExists(guardPath).catch(() => undefined);
  }
}

function lockedMessage(lockPath: string, inspection: Inspection | undefined): string | undefined {
  if (inspection?.kind === "wait" && inspection.unparseable) {
    return (
      `another legion-cli is running, or ${lockPath} is empty or unreadable (a crash while taking it?). ` +
      `An unreadable lock is cleared automatically once it is ${EMPTY_LOCK_STALE_MS / 1000} s old; ` +
      `if this persists and no legion-cli is running, delete ${lockPath} and re-run.`
    );
  }
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
