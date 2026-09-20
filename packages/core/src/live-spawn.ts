import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendAuditEvent,
  appendDeferredAuditEvent,
  canonicalizePath,
  controlProjectDirPath,
  drainDeferredAuditEvents,
  ensureControlDir,
  isPidAlive,
  ownProcessStartedAt,
  processIdentity,
  retryFsOp,
  startedAfterRecorded,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  MAX_SPAWN_TIMEOUT_MS,
  ResumeFileSchema,
  type AuditEvent,
  type ResumeFile,
  type SkillId,
} from "@9thlevelsoftware/legion-cli-schema";

/** A record that can't be trusted counts as live until it is older than the maximum timeout plus this. */
export const LIVE_RECORD_GRACE_MS = 10 * 60 * 1000;
export const LIVE_MARKER_BASENAME = "live.json";
export const RESUME_BASENAME = "resume.json";

export type LiveMarker = {
  runId: string;
  skillId: SkillId;
  enginePid: number;
  engineStartedAt: number;
  startedAt: string;
  timeoutMs: number;
};

export type LiveSpawn = {
  runId: string;
  skillId: string;
  controlDir: string;
  /** True when this process runs the spawn (liveness from memory, KD-2). */
  owned: boolean;
  /** `live`: a valid record with a live engine. `unreadable`/`orphaned`: fail-closed states. */
  state: "live" | "unreadable" | "orphaned";
  /** Why a fail-closed state is frozen, for `status` and `doctor` (R-6, R-19). */
  detail?: string;
  /** When the freeze lifts on its own (epoch ms), for the fail-closed and orphaned states. */
  expiresAt?: number;
  marker?: LiveMarker;
};

type OwnedSpawn = {
  runId: string;
  skillId: SkillId;
  controlDir: string;
  projectRoot: string;
  audit: AuditEvent[];
  /** The marker this run re-asserts while it is live. */
  marker?: LiveMarker;
  heartbeat?: ReturnType<typeof setInterval>;
};

/** Spawns this process is running, by project. The owning process never trusts disk for liveness. */
const owned = new Map<string, OwnedSpawn>();

/**
 * Control dirs this process created. Between creating one and writing its marker, the dir is
 * markerless — which counts as live for *other* processes (R-17) but must never freeze the
 * process that is about to own it.
 */
const claimed = new Set<string>();

export function claimControlDir(controlDir: string): void {
  claimed.add(controlDir);
}

export function releaseControlDir(controlDir: string): void {
  claimed.delete(controlDir);
}

function projectKey(projectRoot: string): string {
  const canonical = canonicalizePath(projectRoot);
  return process.platform === "win32" || process.platform === "darwin" ? canonical.toLowerCase() : canonical;
}

/** How often the owner re-asserts its live marker while a spawn runs (R-2, R-17). */
export const LIVE_MARKER_HEARTBEAT_MS = 2_000;

export function registerOwnedSpawn(entry: Omit<OwnedSpawn, "audit" | "heartbeat">): void {
  const key = projectKey(entry.projectRoot);
  const record: OwnedSpawn = { ...entry, audit: [] };
  // An unjailed agent runs as the user and can delete the control record. Re-assert it while the
  // run is live so a deletion lifts the freeze for other processes for at most one beat (KD-2's
  // honest limit; the owner itself never trusts disk).
  const beat = setInterval(() => {
    void reassertLiveMarker(record);
  }, LIVE_MARKER_HEARTBEAT_MS);
  beat.unref?.();
  record.heartbeat = beat;
  owned.set(key, record);
}

async function reassertLiveMarker(entry: OwnedSpawn): Promise<void> {
  if (owned.get(projectKey(entry.projectRoot)) !== entry || !entry.marker) return;
  try {
    await stat(join(entry.controlDir, LIVE_MARKER_BASENAME));
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  try {
    await ensureControlDir(entry.projectRoot, entry.runId);
    await writeLiveMarker(entry.controlDir, entry.marker);
  } catch {
    // best effort; the owner's own liveness never depends on disk
  }
}

export function ownedSpawn(projectRoot: string): { runId: string; skillId: SkillId; controlDir: string } | null {
  const entry = owned.get(projectKey(projectRoot));
  return entry ? { runId: entry.runId, skillId: entry.skillId, controlDir: entry.controlDir } : null;
}

/**
 * End the spawn window for `runId`: forget it, drop the live marker, then append the audit events
 * this process buffered and the deferred events other processes wrote (after the P restore).
 */
export async function endOwnedSpawn(projectRoot: string, runId: string): Promise<void> {
  const key = projectKey(projectRoot);
  const entry = owned.get(key);
  if (!entry || entry.runId !== runId) return;
  owned.delete(key);
  releaseControlDir(entry.controlDir);
  if (entry.heartbeat) clearInterval(entry.heartbeat);
  // A marker left behind freezes every other process for this process's lifetime, so the removal
  // retries Windows sharing violations (R-9).
  await retryFsOp(() => rm(join(entry.controlDir, LIVE_MARKER_BASENAME), { force: true })).catch(() => undefined);
  for (const event of entry.audit) {
    await appendAuditEvent(projectRoot, event).catch(() => undefined);
  }
  await drainDeferredAuditEvents(projectRoot, entry.controlDir).catch(() => undefined);
  // Nothing else needs this run's control dir once it finished cleanly; leaving it would make
  // every later freeze check scan it (R-4, R-16). A crashed run keeps its records for replay.
  await rm(entry.controlDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
}

export async function writeLiveMarker(controlDir: string, marker: LiveMarker): Promise<void> {
  await writeFile(join(controlDir, LIVE_MARKER_BASENAME), `${JSON.stringify(marker)}\n`, "utf8");
}

/** Remember the marker to re-assert, without touching disk. */
export function rememberLiveMarker(projectRoot: string, marker: LiveMarker): void {
  const entry = owned.get(projectKey(projectRoot));
  if (entry && entry.runId === marker.runId) entry.marker = marker;
}

export function liveMarkerFor(runId: string, skillId: SkillId, timeoutMs: number): LiveMarker {
  return {
    runId,
    skillId,
    enginePid: process.pid,
    engineStartedAt: ownProcessStartedAt(),
    startedAt: new Date().toISOString(),
    timeoutMs,
  };
}

function validMarker(value: unknown): LiveMarker | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const startedMs = typeof rec.startedAt === "string" ? Date.parse(rec.startedAt) : Number.NaN;
  if (
    typeof rec.runId !== "string" ||
    typeof rec.skillId !== "string" ||
    typeof rec.enginePid !== "number" ||
    !Number.isInteger(rec.enginePid) ||
    rec.enginePid <= 0 ||
    typeof rec.engineStartedAt !== "number" ||
    !Number.isFinite(rec.engineStartedAt) ||
    !Number.isFinite(startedMs) ||
    startedMs > Date.now() + 60_000 ||
    typeof rec.timeoutMs !== "number" ||
    !(rec.timeoutMs > 0) ||
    rec.timeoutMs > MAX_SPAWN_TIMEOUT_MS
  ) {
    return null;
  }
  return rec as unknown as LiveMarker;
}

/**
 * The live spawn for a project, if any (KD-2). This process's own spawn comes from memory. Another
 * process's comes from its control record: valid, engine PID alive and not reused. A record that
 * can't be read or fails validation counts as live until it is older than the maximum timeout
 * plus grace, so the freeze fails closed.
 */
export async function findLiveSpawn(projectRoot: string): Promise<LiveSpawn | null> {
  const mine = owned.get(projectKey(projectRoot));
  if (mine) {
    return { runId: mine.runId, skillId: mine.skillId, controlDir: mine.controlDir, owned: true, state: "live" };
  }
  const projectDir = controlProjectDirPath(projectRoot);
  let runs: string[];
  try {
    runs = await readdir(projectDir);
  } catch (err) {
    // Only "there are no runs" means no freeze; EACCES, ENOTDIR or an I/O error fail closed (R-7).
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return {
      runId: "unknown",
      skillId: "unknown",
      controlDir: projectDir,
      owned: false,
      state: "unreadable",
      detail: `control directory is unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})`,
    };
  }
  for (const runId of runs.sort().reverse()) {
    const live = await runLiveness(projectDir, runId);
    if (live) return live;
  }
  return null;
}

/** Liveness of one control-dir entry, or null when it is provably finished or aged out. */
async function runLiveness(projectDir: string, runId: string): Promise<LiveSpawn | null> {
  const controlDir = join(projectDir, runId);
  const markerPath = join(controlDir, LIVE_MARKER_BASENAME);
  let markerMtime: number | null = null;
  try {
    markerMtime = (await stat(markerPath)).mtimeMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return { runId, skillId: "unknown", controlDir, owned: false, state: "unreadable", detail: `live marker is unreadable (${code})` };
    }
    // The marker is gone. A run dir that is still fresh counts as live: a finished run removes its
    // control dir, so a markerless dir is either a crash or a deleted record (R-2, R-17). A dir
    // this process is about to own is not live yet.
    if (claimed.has(controlDir)) return null;
    const resume = await readResume(controlDir);
    if (resume) {
      // A run whose engine is this process but which is not in memory has finished.
      if (resume.enginePid === process.pid) return null;
      const engineLive =
        typeof resume.enginePid === "number" && isPidAlive(resume.enginePid)
          ? !(await pidReused(resume.enginePid, resume.engineStartedAt))
          : false;
      const agentLive = typeof resume.pid === "number" && resume.pid !== process.pid && isPidAlive(resume.pid);
      const expires = Math.min(Date.parse(resume.startedAt) || Date.now(), Date.now()) + (resume.timeoutMs ?? MAX_SPAWN_TIMEOUT_MS) + LIVE_RECORD_GRACE_MS;
      if ((engineLive || agentLive) && Date.now() < expires) {
        return {
          runId,
          skillId: resume.skillId,
          controlDir,
          owned: false,
          state: "unreadable",
          detail: "the live marker was removed while the run's process was still alive",
          expiresAt: expires,
        };
      }
      return null; // a crashed run: its engine and agent are gone (recovery handles the task)
    }
    const age = await entryAgeMs(controlDir);
    if (age !== null && age < MAX_SPAWN_TIMEOUT_MS + LIVE_RECORD_GRACE_MS) {
      return {
        runId,
        skillId: "unknown",
        controlDir,
        owned: false,
        state: "unreadable",
        detail: "live marker is missing; the run record is still within the timeout window",
        expiresAt: Date.now() + (MAX_SPAWN_TIMEOUT_MS + LIVE_RECORD_GRACE_MS - age),
      };
    }
    return null;
  }
  let marker: LiveMarker | null = null;
  try {
    marker = validMarker(JSON.parse(await readFile(markerPath, "utf8")));
  } catch {
    marker = null;
  }
  if (!marker || marker.runId !== runId) {
    // Clamp the clock: a marker dated in the future must still age out (R-19).
    const age = Date.now() - Math.min(markerMtime, Date.now());
    const window = MAX_SPAWN_TIMEOUT_MS + LIVE_RECORD_GRACE_MS;
    if (age < window) {
      return {
        runId,
        skillId: "unknown",
        controlDir,
        owned: false,
        state: "unreadable",
        detail: "the live marker is unreadable or invalid",
        expiresAt: Date.now() + (window - age),
      };
    }
    return null;
  }
  const startedMs = Math.min(Date.parse(marker.startedAt), Date.now());
  const expiresAt = startedMs + marker.timeoutMs + LIVE_RECORD_GRACE_MS;
  // Our own PID but not in memory: a leftover from this process's earlier run.
  if (marker.enginePid === process.pid) {
    await dropDeadMarker(markerPath);
    return null;
  }
  if (!isPidAlive(marker.enginePid)) {
    // The engine died mid-run, but its agent may still be writing: stay frozen while the recorded
    // agent process lives, and only until the run's own timeout has passed (R-34).
    if (Date.now() < expiresAt && (await agentStillRunning(controlDir))) {
      return {
        runId,
        skillId: marker.skillId,
        controlDir,
        owned: false,
        state: "orphaned",
        detail: "the engine died but its agent process is still running",
        expiresAt,
        marker,
      };
    }
    await dropDeadMarker(markerPath);
    return null;
  }
  const actual = await processIdentity(marker.enginePid);
  if (actual !== null && startedAfterRecorded(actual, marker.engineStartedAt)) {
    await dropDeadMarker(markerPath); // PID reused: the recorded engine is gone (R-16)
    return null;
  }
  return { runId, skillId: marker.skillId, controlDir, owned: false, state: "live", expiresAt, marker };
}

/** Newest mtime of a control dir's own entries (the dir mtime is not updated by writes on win32). */
async function entryAgeMs(controlDir: string): Promise<number | null> {
  let newest: number | null = null;
  try {
    const dirStat = await stat(controlDir);
    newest = Math.min(dirStat.mtimeMs, Date.now());
    for (const name of await readdir(controlDir)) {
      try {
        const st = await stat(join(controlDir, name));
        newest = Math.max(newest, Math.min(st.mtimeMs, Date.now()));
      } catch {
        // raced with a delete
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return 0; // unreadable: treat as fresh, i.e. fail closed
  }
  return Date.now() - newest;
}

/** A marker proven dead is removed so later commands stop re-checking it (R-16). */
async function dropDeadMarker(markerPath: string): Promise<void> {
  await retryFsOp(() => rm(markerPath, { force: true })).catch(() => undefined);
}

async function readResume(controlDir: string): Promise<ResumeFile | null> {
  try {
    const parsed = ResumeFileSchema.safeParse(JSON.parse(await readFile(join(controlDir, RESUME_BASENAME), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function pidReused(pid: number, recordedStartedAt: number | undefined): Promise<boolean> {
  if (typeof recordedStartedAt !== "number") return false;
  const actual = await processIdentity(pid);
  return actual !== null && startedAfterRecorded(actual, recordedStartedAt);
}

async function agentStillRunning(controlDir: string): Promise<boolean> {
  const resume = await readResume(controlDir);
  const pid = resume?.pid;
  return typeof pid === "number" && pid !== process.pid && isPidAlive(pid);
}

export function frozenMessage(live: Pick<LiveSpawn, "skillId" | "runId" | "state" | "detail" | "expiresAt">): string {
  const head = `an agent run (${live.skillId} ${live.runId}) is in progress; wait for it to finish (legion-cli status)`;
  if (live.state === "live" || !live.detail) return head;
  const until = live.expiresAt ? `; the freeze lifts at ${new Date(live.expiresAt).toISOString()}` : "";
  return `${head} — ${live.detail}${until}`;
}

/** One line per live or stale run, for `status` and `doctor` (R-6, R-19). */
export function describeLiveSpawn(live: LiveSpawn): string {
  const parts = [`${live.skillId} ${live.runId}`, live.state];
  if (live.marker) parts.push(`engine pid ${live.marker.enginePid}`, `started ${live.marker.startedAt}`);
  if (live.expiresAt) parts.push(`freeze lifts ${new Date(live.expiresAt).toISOString()}`);
  if (live.detail) parts.push(live.detail);
  parts.push(live.owned ? "this process" : live.controlDir);
  return parts.join("  ");
}


/**
 * Where an audit event goes (KD-15): into the owning spawn's memory buffer, into another
 * process's live run's deferred file, or straight into `.legion-cli/audit/`.
 */
export async function recordAuditEvent(projectRoot: string, event: AuditEvent, live?: LiveSpawn | null): Promise<void> {
  const mine = owned.get(projectKey(projectRoot));
  if (mine) {
    mine.audit.push(event);
    return;
  }
  const other = live === undefined ? await findLiveSpawn(projectRoot) : live;
  if (other && !other.owned) {
    await appendDeferredAuditEvent(other.controlDir, event);
    return;
  }
  await appendAuditEvent(projectRoot, event);
}
