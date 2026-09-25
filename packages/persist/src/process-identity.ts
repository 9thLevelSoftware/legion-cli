import { execFile } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

/**
 * Two start times closer than this are the same process. The lock writer estimates its own
 * start from `process.uptime()` on win32/macOS (tens of ms from the OS value), while the
 * reader asks the OS; a reused PID starts far later than the original.
 */
export const PROCESS_START_TOLERANCE_MS = 5_000;

export const PROC_READ_MAX_BYTES = 64 * 1024;
export const PROC_READ_TIMEOUT_MS = 5_000;
export const IDENTITY_TIMEOUT_MS = 45_000;

const LINUX_CLK_TCK = 100;

const IDENTITY_ENV_KEYS = [
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "windir",
  "SYSTEMDRIVE",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "ComSpec",
  "COMSPEC",
] as const;

/** Env passed to PowerShell/`ps`. Never `process.env` — that would leak host credentials. */
export function identitySpawnEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allow = new Set(IDENTITY_ENV_KEYS.map((key) => key.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!allow.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  return env;
}

function powershellExePath(): string {
  return join(
    process.env.SystemRoot || process.env.windir || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function readProcFileSync(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(PROC_READ_MAX_BYTES);
      const n = readSync(fd, buf, 0, PROC_READ_MAX_BYTES, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

async function readProcFile(path: string): Promise<string | null> {
  try {
    const handle = await open(path, "r");
    try {
      const buf = Buffer.alloc(PROC_READ_MAX_BYTES);
      const { bytesRead } = await handle.read(buf, 0, PROC_READ_MAX_BYTES, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function parseLinuxStartedAt(stat: string, procStat: string): number | null {
  // comm (field 2) may contain spaces and parens; fields resume after the last ')'.
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const startTicks = Number(rest[19]); // field 22: starttime, in clock ticks since boot
  const btimeLine = procStat.split("\n").find((line) => line.startsWith("btime "));
  const btime = Number(btimeLine?.split(/\s+/)[1]);
  if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
  return Math.round((btime + startTicks / LINUX_CLK_TCK) * 1000);
}

function linuxStartedAtSync(pid: number): number | null {
  const stat = readProcFileSync(`/proc/${pid}/stat`);
  const procStat = readProcFileSync("/proc/stat");
  if (stat === null || procStat === null) return null;
  return parseLinuxStartedAt(stat, procStat);
}

async function linuxStartedAt(pid: number): Promise<number | null> {
  const timedOut = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), PROC_READ_TIMEOUT_MS);
  });
  const read = Promise.all([readProcFile(`/proc/${pid}/stat`), readProcFile("/proc/stat")]);
  void read.catch(() => undefined);
  const result = await Promise.race([read, timedOut]);
  if (!result) return null;
  const [stat, procStat] = result;
  if (stat === null || procStat === null) return null;
  return parseLinuxStartedAt(stat, procStat);
}

/** Windows PowerShell 5.1 writes UTF-16LE to a pipe. UTF-8 decoding makes Date.parse fail. */
function decodeProcessText(stdout: string | Buffer): string {
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) return buf.toString("utf16le");
  return buf.toString("utf8");
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      file,
      args,
      {
        encoding: "buffer",
        windowsHide: true,
        timeout: IDENTITY_TIMEOUT_MS,
        maxBuffer: PROC_READ_MAX_BYTES,
        env,
      },
      (err, stdout) => {
        if (err || stdout == null || stdout.length === 0) return done(null);
        const text = decodeProcessText(stdout).replace(/^\uFEFF/, "").trim();
        done(text.length ? text : null);
      },
    );
  });
}

/**
 * Start time (epoch ms) of a live process, or null when it can't be determined.
 * Linux reads `/proc/<pid>/stat` with a byte cap and timeout; macOS asks `/bin/ps`;
 * Windows asks PowerShell for `Get-Process` StartTime. The scrubbed env keeps PATH and
 * PSModulePath so powershell.exe can start; without them the hosted runner hangs until timeout.
 */
export async function processIdentity(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return linuxStartedAt(pid);
  if (process.platform === "win32" && pid === process.pid) return ownProcessStartedAt();
  if (process.platform === "win32") {
    const env = identitySpawnEnv();
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.PSModulePath) env.PSModulePath = process.env.PSModulePath;
    const out = await run(
      powershellExePath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
      env,
    );
    const line = out?.split(/\r?\n/).map((row) => row.trim()).find((row) => Number.isFinite(Date.parse(row)));
    const ms = line ? Date.parse(line) : Number.NaN;
    return Number.isFinite(ms) ? ms : null;
  }
  const env = identitySpawnEnv();
  env.LC_ALL = "C";
  const out = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], env);
  const ms = out ? Date.parse(out) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * This process's start time, fixed when the module loads (not at the first lock, which in a
 * long-lived dashboard can be hours later, after a sleep or a clock step). Linux reads the
 * kernel's value with a bounded `/proc` read; win32/macOS estimate `now - uptime`.
 */
const OWN_STARTED_AT: number =
  (process.platform === "linux" ? linuxStartedAtSync(process.pid) : null) ??
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
