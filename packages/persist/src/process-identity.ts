import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Two start times closer than this are the same process. The lock writer estimates its own
 * start from `process.uptime()` on win32/macOS (tens of ms from the OS value), while the
 * reader asks the OS; a reused PID starts far later than the original.
 */
export const PROCESS_START_TOLERANCE_MS = 5_000;

const LINUX_CLK_TCK = 100;
const IDENTITY_TIMEOUT_MS = 10_000;

function linuxStartedAt(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) may contain spaces and parens; fields resume after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = Number(rest[19]); // field 22: starttime, in clock ticks since boot
    const btimeLine = readFileSync("/proc/stat", "utf8")
      .split("\n")
      .find((line) => line.startsWith("btime "));
    const btime = Number(btimeLine?.split(/\s+/)[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
    return Math.round((btime + startTicks / LINUX_CLK_TCK) * 1000);
  } catch {
    return null;
  }
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      file,
      args,
      { encoding: "utf8", windowsHide: true, timeout: IDENTITY_TIMEOUT_MS, env: env ?? process.env },
      (err, stdout) => done(err ? null : String(stdout).trim()),
    );
  });
}

/**
 * Start time (epoch ms) of a live process, or null when it can't be determined.
 * Linux reads `/proc/<pid>/stat`, macOS asks `ps -o lstart=`, Windows asks PowerShell for the
 * CIM `Win32_Process` CreationDate. Slow on Windows (PowerShell start-up), so the lock only
 * calls it on the contention path, after the acquire wait has expired.
 */
export async function processIdentity(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return linuxStartedAt(pid);
  if (process.platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`,
    ]);
    const ms = out ? Date.parse(out) : Number.NaN;
    return Number.isFinite(ms) ? ms : null;
  }
  const out = await run("ps", ["-o", "lstart=", "-p", String(pid)], { ...process.env, LC_ALL: "C" });
  const ms = out ? Date.parse(out) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * This process's start time, fixed when the module loads (not at the first lock, which in a
 * long-lived dashboard can be hours later, after a sleep or a clock step). Linux reads the
 * kernel's value; win32/macOS estimate `now - uptime` while the two clocks still agree.
 */
const OWN_STARTED_AT: number =
  (process.platform === "linux" ? linuxStartedAt(process.pid) : null) ??
  Math.round(Date.now() - process.uptime() * 1000);

/** This process's start time, on the same clock {@link processIdentity} reports. Cheap. */
export function ownProcessStartedAt(): number {
  return OWN_STARTED_AT;
}

export function sameProcessStart(a: number, b: number): boolean {
  return Math.abs(a - b) <= PROCESS_START_TOLERANCE_MS;
}

/**
 * PID reuse, one-sided: a process that reuses a PID always started *after* the recorded holder.
 * A sleep that pauses the uptime clock only makes the recorded start look later than the OS
 * value, which never steals; the estimate is taken at module load, so a later clock step
 * cannot skew it either.
 */
export function startedAfterRecorded(actualStartedAt: number, recordedStartedAt: number): boolean {
  return actualStartedAt > recordedStartedAt + PROCESS_START_TOLERANCE_MS;
}

export type KillTreeOutcome = "killed" | "not-running" | "pid-reused" | "unknown-identity";

/**
 * Crash replay (PR 6): tear down a process tree recorded in a control record, but only when the
 * PID still belongs to the process that was recorded. A PID that has been reused since is never
 * killed — the one-sided {@link startedAfterRecorded} test decides — and a PID whose identity we
 * cannot read at all is left alone too, so replay never shoots a bystander.
 *
 * POSIX kills the process *group* (the agent is spawned detached, so the group id is its pid);
 * win32 uses `taskkill /T`. The group/tree kill lives here rather than in `agents` because
 * `persist` is the lower package: `agents` owns the live handle, this owns the dead record.
 */
export async function killRecordedProcessTree(
  pid: number | null | undefined,
  recordedStartedAt: number | undefined,
): Promise<KillTreeOutcome> {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "not-running";
  if (pid === process.pid) return "not-running";
  if (!pidExists(pid)) return "not-running";
  const actual = await processIdentity(pid);
  if (actual === null) return pidExists(pid) ? "unknown-identity" : "not-running";
  if (typeof recordedStartedAt !== "number") return "unknown-identity";
  if (startedAfterRecorded(actual, recordedStartedAt)) return "pid-reused";
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      encoding: "utf8",
    });
  } else {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") break;
      }
    }
  }
  return "killed";
}

/** Whether a pid exists (no signal sent). `lock.ts` imports this module, so its own copy stays there. */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
