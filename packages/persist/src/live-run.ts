import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { legionPaths } from "./layout.js";
import { isPidAlive } from "./lock.js";
import { ownProcessStartedAt, processIdentity, startedAfterRecorded } from "./process-identity.js";

/**
 * One marker per spawned run at `.legion-cli/cache/live-spawn/<runId>.json`. It records the
 * engine pid and the agent child pid, each with its start time, so "is this run live?" survives
 * an engine crash (the agent may outlive it) and PID reuse (a reused pid starts later than the
 * recorded process). A run is live while EITHER process is alive with a matching identity.
 */
export const LIVE_RUN_SCHEMA = "legion-cli-live-run/v1";

export type LiveRunMarker = {
  schemaVersion: typeof LIVE_RUN_SCHEMA;
  runId: string;
  skillId: string;
  taskId: string | null;
  enginePid: number;
  /** Absent only for a migrated legacy marker: liveness is then pid-only. */
  engineStartedAt?: number;
  agentPid: number | null;
  agentStartedAt?: number;
  startedAt: string;
};

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function liveRunDir(projectRoot: string): string {
  return join(legionPaths(projectRoot).cacheDir, "live-spawn");
}

function liveRunPath(projectRoot: string, runId: string): string {
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

async function writeMarker(projectRoot: string, marker: LiveRunMarker, exclusive: boolean): Promise<void> {
  await mkdir(liveRunDir(projectRoot), { recursive: true });
  await writeFile(liveRunPath(projectRoot, marker.runId), `${JSON.stringify(marker)}\n`, {
    encoding: "utf8",
    flag: exclusive ? "wx" : "w",
  });
}

/** Create this run's marker (`wx`: a second spawn can never overwrite a live run's marker). */
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
  await writeMarker(projectRoot, marker, true);
  return marker;
}

/** Record the agent child once it exists. `identity` is null when the OS cannot say (pid-only then). */
export async function recordLiveRunAgent(
  projectRoot: string,
  marker: LiveRunMarker,
  agentPid: number,
): Promise<LiveRunMarker> {
  const startedAt = agentPid === process.pid ? ownProcessStartedAt() : await processIdentity(agentPid);
  const next: LiveRunMarker = {
    ...marker,
    agentPid,
    ...(startedAt !== null ? { agentStartedAt: startedAt } : {}),
  };
  await writeMarker(projectRoot, next, false);
  return next;
}

export async function clearLiveRun(projectRoot: string, runId: string): Promise<void> {
  try {
    await unlink(liveRunPath(projectRoot, runId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Alive with a matching identity. Undeterminable identity keeps the guard (fail closed). */
async function pidHoldsIdentity(pid: number | null, startedAt: number | undefined): Promise<boolean> {
  if (pid === null || !isPidAlive(pid)) return false;
  if (startedAt === undefined) return true;
  const actual = pid === process.pid ? ownProcessStartedAt() : await processIdentity(pid);
  if (actual === null) return true;
  return !startedAfterRecorded(actual, startedAt);
}

export type LiveRunState = { engineAlive: boolean; agentAlive: boolean; live: boolean };

export async function liveRunState(marker: LiveRunMarker): Promise<LiveRunState> {
  const engineAlive = await pidHoldsIdentity(marker.enginePid, marker.engineStartedAt);
  const agentAlive = await pidHoldsIdentity(marker.agentPid, marker.agentStartedAt);
  return { engineAlive, agentAlive, live: engineAlive || agentAlive };
}

/**
 * The legacy single file `cache/live-spawn.json` ({ enginePid, skillId, runId }) is read once and
 * removed. It becomes a per-run marker (pid-only liveness) so an older binary's live run still
 * guards until that engine exits.
 */
async function migrateLegacyMarker(projectRoot: string): Promise<void> {
  const legacy = legacyMarkerPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(legacy, "utf8");
  } catch {
    return;
  }
  const parsed = parseMarker(raw);
  if (parsed && isPidAlive(parsed.enginePid)) {
    try {
      await writeMarker(projectRoot, parsed, true);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  await unlink(legacy).catch(() => undefined);
}

export async function listLiveRunMarkers(projectRoot: string): Promise<LiveRunMarker[]> {
  await migrateLegacyMarker(projectRoot);
  let names: string[];
  try {
    names = await readdir(liveRunDir(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LiveRunMarker[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const marker = parseMarker(await readFile(join(liveRunDir(projectRoot), name), "utf8"));
      if (marker && `${marker.runId}.json` === name) out.push(marker);
    } catch {
      // unreadable marker: ignore, never block on it
    }
  }
  return out;
}

/**
 * Markers whose run is live, and (removed as a side effect) those provably dead: both the engine
 * and the agent are gone or hold a different identity now.
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
