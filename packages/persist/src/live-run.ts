import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNoLinkInPath, atomicWriteFile } from "./atomic-write.js";
import { legionPaths } from "./layout.js";
import { isPidAlive } from "./lock.js";
import { ownProcessStartedAt, processIdentity, startedAfterRecorded } from "./process-identity.js";

/**
 * One marker per spawned run at `.legion-cli/cache/live-spawn/<runId>.json`. It records the
 * engine pid and the agent child pid, each with its start time, so "is this run live?" survives
 * an engine crash (the agent may outlive it) and PID reuse (a reused pid starts later than the
 * recorded process). A run is live while EITHER process is alive with a matching identity.
 *
 * Scope: this is a guard against cooperating processes (the user, a second terminal, another
 * legion verb), not a boundary against a hostile agent. The marker lives under `cache/`, which an
 * unjailed agent can write; a jailed agent cannot reach it.
 */
export const LIVE_RUN_SCHEMA = "legion-cli-live-run/v1";

/** An unparseable marker younger than this is treated as being written right now (live). */
const UNPARSEABLE_GRACE_MS = 10_000;
/** Identity probes (PowerShell on Windows) are cached per pid for this long. */
const IDENTITY_CACHE_MS = 30_000;

export type LiveRunMarker = {
  schemaVersion: typeof LIVE_RUN_SCHEMA;
  runId: string;
  skillId: string;
  taskId: string | null;
  enginePid: number;
  /** Absent only for a migrated legacy marker: `startedAt` is then the recorded start. */
  engineStartedAt?: number;
  agentPid: number | null;
  agentStartedAt?: number;
  startedAt: string;
  /** Set for runs detected without a marker (resume.json): the file the refusal should name. */
  evidence?: string;
  /** Set for an unparseable marker file that is too fresh to call dead. */
  unknown?: true;
};

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function liveRunDir(projectRoot: string): string {
  return join(legionPaths(projectRoot).cacheDir, "live-spawn");
}

export function liveRunMarkerPath(projectRoot: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`invalid run id for live marker: ${runId}`);
  return join(liveRunDir(projectRoot), `${runId}.json`);
}

function legacyMarkerPath(projectRoot: string): string {
  return join(legionPaths(projectRoot).cacheDir, "live-spawn.json");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseMarker(raw: string): LiveRunMarker | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LiveRunMarker> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.runId !== "string" || !RUN_ID_PATTERN.test(parsed.runId)) return null;
    if (typeof parsed.skillId !== "string" || !isCount(parsed.enginePid)) return null;
    return {
      schemaVersion: LIVE_RUN_SCHEMA,
      runId: parsed.runId,
      skillId: parsed.skillId,
      taskId: typeof parsed.taskId === "string" ? parsed.taskId : null,
      enginePid: parsed.enginePid,
      ...(typeof parsed.engineStartedAt === "number" ? { engineStartedAt: parsed.engineStartedAt } : {}),
      agentPid: isCount(parsed.agentPid) ? parsed.agentPid : null,
      ...(typeof parsed.agentStartedAt === "number" ? { agentStartedAt: parsed.agentStartedAt } : {}),
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

async function ensureMarkerDir(projectRoot: string): Promise<string> {
  const dir = liveRunDir(projectRoot);
  const root = legionPaths(projectRoot).root;
  await assertNoLinkInPath(dir, { root, message: "live-run marker directory is a symlink" });
  await mkdir(dir, { recursive: true });
  await assertNoLinkInPath(dir, { root, message: "live-run marker directory is a symlink" });
  return dir;
}

function body(marker: LiveRunMarker): string {
  const persisted: Partial<LiveRunMarker> = { ...marker };
  delete persisted.evidence;
  delete persisted.unknown;
  return `${JSON.stringify(persisted)}\n`;
}

/**
 * Create this run's marker. Exclusive (a second spawn can never overwrite a live run's marker)
 * and atomic (temp file, then `link`, which fails with EEXIST): a crash never leaves a torn file.
 */
export async function createLiveRun(
  projectRoot: string,
  input: { runId: string; skillId: string; taskId: string | null },
): Promise<LiveRunMarker> {
  const marker: LiveRunMarker = {
    schemaVersion: LIVE_RUN_SCHEMA,
    runId: input.runId,
    skillId: input.skillId,
    taskId: input.taskId,
    enginePid: process.pid,
    engineStartedAt: ownProcessStartedAt(),
    agentPid: null,
    startedAt: new Date().toISOString(),
  };
  const dir = await ensureMarkerDir(projectRoot);
  const target = liveRunMarkerPath(projectRoot, marker.runId);
  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(tmp, body(marker), { encoding: "utf8", flag: "wx" });
  try {
    await link(tmp, target);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  return marker;
}

/**
 * Record the agent child right after spawn, atomically. No identity probe (PowerShell on Windows
 * takes seconds): the recorded start is `now`, an upper bound on the child's real start, so a
 * later pid reuse is still detected. A marker with a dead engine and no agent pid yet (engine
 * killed in the instant between spawn and this write) reads as dead; that window is one write.
 */
export async function recordLiveRunAgent(
  projectRoot: string,
  marker: LiveRunMarker,
  agentPid: number,
): Promise<LiveRunMarker> {
  const next: LiveRunMarker = { ...marker, agentPid, agentStartedAt: Date.now() };
  await ensureMarkerDir(projectRoot);
  await atomicWriteFile(liveRunMarkerPath(projectRoot, marker.runId), body(next), {
    root: legionPaths(projectRoot).root,
    symlinkMessage: "live-run marker path is a symlink",
  });
  return next;
}

export async function clearLiveRun(projectRoot: string, runId: string): Promise<void> {
  try {
    await unlink(liveRunMarkerPath(projectRoot, runId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** The marker as recorded, or null when absent or unparseable. */
export async function readLiveRun(projectRoot: string, runId: string): Promise<LiveRunMarker | null> {
  try {
    return parseMarker(await readFile(liveRunMarkerPath(projectRoot, runId), "utf8"));
  } catch {
    return null;
  }
}

const identityCache = new Map<number, { at: number; actual: number | null }>();

async function cachedIdentity(pid: number): Promise<number | null> {
  const hit = identityCache.get(pid);
  if (hit && Date.now() - hit.at < IDENTITY_CACHE_MS) return hit.actual;
  const actual = await processIdentity(pid);
  identityCache.set(pid, { at: Date.now(), actual });
  return actual;
}

/**
 * Alive with a matching identity. `recordedAt` is the recorded start; when the marker has none,
 * the marker's own creation time stands in, so a pid reused later is still recognised. An
 * identity that cannot be read at all keeps the guard (fail closed); the refusal and `doctor`
 * name the file to delete for that case.
 */
async function pidHoldsIdentity(pid: number | null, recordedAt: number | undefined): Promise<boolean> {
  if (pid === null || !isPidAlive(pid)) return false;
  if (recordedAt === undefined) return true;
  const actual = pid === process.pid ? ownProcessStartedAt() : await cachedIdentity(pid);
  if (actual === null) return true;
  return !startedAfterRecorded(actual, recordedAt);
}

export type LiveRunState = { engineAlive: boolean; agentAlive: boolean; live: boolean };

export async function liveRunState(marker: LiveRunMarker): Promise<LiveRunState> {
  if (marker.unknown) return { engineAlive: true, agentAlive: false, live: true };
  const created = Date.parse(marker.startedAt);
  const fallback = Number.isFinite(created) ? created : undefined;
  const engineAlive = await pidHoldsIdentity(marker.enginePid, marker.engineStartedAt ?? fallback);
  const agentAlive = await pidHoldsIdentity(marker.agentPid, marker.agentStartedAt ?? fallback);
  return { engineAlive, agentAlive, live: engineAlive || agentAlive };
}

/**
 * A resume.json (`cache/runs/<id>/resume.json`) as a run marker, for runs with no marker file
 * (an older binary, hand-built fixtures). Same identity check, keyed on the recorded start.
 */
export function liveRunFromResume(resume: {
  runId: string;
  skillId: string;
  taskId?: string | null;
  pid?: number | null;
  enginePid?: number | null;
  startedAt: string;
}): LiveRunMarker {
  const parsed = Date.parse(resume.startedAt);
  const recorded = Number.isFinite(parsed) ? parsed : undefined;
  return {
    schemaVersion: LIVE_RUN_SCHEMA,
    runId: resume.runId,
    skillId: resume.skillId,
    taskId: resume.taskId ?? null,
    enginePid: resume.enginePid ?? 0,
    ...(recorded !== undefined ? { engineStartedAt: recorded, agentStartedAt: recorded } : {}),
    agentPid: resume.pid ?? null,
    startedAt: resume.startedAt,
    evidence: `.legion-cli/cache/runs/${resume.runId}/resume.json`,
  };
}

/**
 * The legacy single file `cache/live-spawn.json` ({ enginePid, skillId, runId }) is read once and
 * removed. It becomes a per-run marker (recorded start = the file's mtime) so an older binary's
 * live run still guards until that engine exits.
 */
async function migrateLegacyMarker(projectRoot: string): Promise<void> {
  const legacy = legacyMarkerPath(projectRoot);
  let raw: string;
  let mtime: Date;
  try {
    raw = await readFile(legacy, "utf8");
    mtime = (await stat(legacy)).mtime;
  } catch {
    return;
  }
  const parsed = parseMarker(raw);
  if (parsed && isPidAlive(parsed.enginePid)) {
    try {
      await ensureMarkerDir(projectRoot);
      await atomicWriteFile(
        liveRunMarkerPath(projectRoot, parsed.runId),
        body({ ...parsed, startedAt: mtime.toISOString() }),
        { root: legionPaths(projectRoot).root, symlinkMessage: "live-run marker path is a symlink" },
      );
    } catch {
      // keep going: the legacy file is still consumed below
    }
  }
  await unlink(legacy).catch(() => undefined);
}

export async function listLiveRunMarkers(projectRoot: string): Promise<LiveRunMarker[]> {
  await migrateLegacyMarker(projectRoot);
  const dir = liveRunDir(projectRoot);
  let names: string[];
  try {
    if ((await lstat(dir)).isSymbolicLink()) return [];
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LiveRunMarker[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const path = join(dir, name);
    try {
      const st = await lstat(path);
      if (!st.isFile()) continue; // never follow a link or read a non-regular file
      const marker = parseMarker(await readFile(path, "utf8"));
      if (marker && `${marker.runId}.json` === name) {
        out.push(marker);
        continue;
      }
      const runId = name.slice(0, -".json".length);
      if (!RUN_ID_PATTERN.test(runId)) continue;
      // Unparseable: fresh means "being written" (live); old is a torn leftover (dead, clearable).
      out.push({
        schemaVersion: LIVE_RUN_SCHEMA,
        runId,
        skillId: "unknown",
        taskId: null,
        enginePid: 0,
        agentPid: null,
        startedAt: st.mtime.toISOString(),
        ...(Date.now() - st.mtimeMs < UNPARSEABLE_GRACE_MS ? { unknown: true as const } : {}),
      });
    } catch {
      // unreadable marker: ignore, never block on it
    }
  }
  return out;
}

/**
 * Markers whose run is live, and those provably dead: both the engine and the agent are gone or
 * hold a different identity now (an old unparseable file counts as dead). With `clearDead` the
 * dead ones are removed as a side effect.
 */
export async function liveRuns(
  projectRoot: string,
  opts?: { clearDead?: boolean },
): Promise<{ live: LiveRunMarker[]; dead: LiveRunMarker[] }> {
  const live: LiveRunMarker[] = [];
  const dead: LiveRunMarker[] = [];
  for (const marker of await listLiveRunMarkers(projectRoot)) {
    if ((await liveRunState(marker)).live) live.push(marker);
    else {
      dead.push(marker);
      if (opts?.clearDead) await clearLiveRun(projectRoot, marker.runId);
    }
  }
  return { live, dead };
}
