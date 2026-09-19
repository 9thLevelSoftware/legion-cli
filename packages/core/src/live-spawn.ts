import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendAuditEvent,
  appendDeferredAuditEvent,
  canonicalizePath,
  controlProjectDirPath,
  drainDeferredAuditEvents,
  isPidAlive,
  ownProcessStartedAt,
  processIdentity,
  startedAfterRecorded,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  MAX_SPAWN_TIMEOUT_MS,
  ResumeFileSchema,
  type AuditEvent,
  type SkillId,
} from "@9thlevelsoftware/legion-cli-schema";
import { HINT, refuse } from "./errors.js";

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
};

type OwnedSpawn = {
  runId: string;
  skillId: SkillId;
  controlDir: string;
  projectRoot: string;
  audit: AuditEvent[];
};

/** Spawns this process is running, by project. The owning process never trusts disk for liveness. */
const owned = new Map<string, OwnedSpawn>();

function projectKey(projectRoot: string): string {
  const canonical = canonicalizePath(projectRoot);
  return process.platform === "win32" || process.platform === "darwin" ? canonical.toLowerCase() : canonical;
}

export function registerOwnedSpawn(entry: Omit<OwnedSpawn, "audit">): void {
  owned.set(projectKey(entry.projectRoot), { ...entry, audit: [] });
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
  await rm(join(entry.controlDir, LIVE_MARKER_BASENAME), { force: true }).catch(() => undefined);
  for (const event of entry.audit) {
    await appendAuditEvent(projectRoot, event).catch(() => undefined);
  }
  await drainDeferredAuditEvents(projectRoot, entry.controlDir).catch(() => undefined);
}

export async function writeLiveMarker(controlDir: string, marker: LiveMarker): Promise<void> {
  await writeFile(join(controlDir, LIVE_MARKER_BASENAME), `${JSON.stringify(marker)}\n`, "utf8");
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
  if (mine) return { runId: mine.runId, skillId: mine.skillId, controlDir: mine.controlDir, owned: true };
  const projectDir = controlProjectDirPath(projectRoot);
  let runs: string[];
  try {
    runs = await readdir(projectDir);
  } catch {
    return null;
  }
  for (const runId of runs.sort().reverse()) {
    const controlDir = join(projectDir, runId);
    const markerPath = join(controlDir, LIVE_MARKER_BASENAME);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(markerPath)).mtimeMs;
    } catch {
      continue;
    }
    let marker: LiveMarker | null = null;
    try {
      marker = validMarker(JSON.parse(await readFile(markerPath, "utf8")));
    } catch {
      marker = null;
    }
    if (!marker || marker.runId !== runId) {
      if (Date.now() - mtimeMs < MAX_SPAWN_TIMEOUT_MS + LIVE_RECORD_GRACE_MS) {
        return { runId, skillId: "unknown", controlDir, owned: false };
      }
      continue;
    }
    // Our own PID but not in memory: a leftover from this process's earlier run.
    if (marker.enginePid === process.pid) continue;
    if (!isPidAlive(marker.enginePid)) {
      // The engine died mid-run, but its agent may still be writing: stay frozen while the
      // recorded agent process lives (crash replay is `task retry` / doctor, PR 6).
      if (await agentStillRunning(controlDir)) return { runId, skillId: marker.skillId, controlDir, owned: false };
      continue;
    }
    const actual = await processIdentity(marker.enginePid);
    if (actual !== null && startedAfterRecorded(actual, marker.engineStartedAt)) continue; // PID reused
    return { runId, skillId: marker.skillId, controlDir, owned: false };
  }
  return null;
}

async function agentStillRunning(controlDir: string): Promise<boolean> {
  try {
    const parsed = ResumeFileSchema.safeParse(JSON.parse(await readFile(join(controlDir, RESUME_BASENAME), "utf8")));
    if (!parsed.success) return false;
    const pid = parsed.data.pid;
    return typeof pid === "number" && pid !== process.pid && isPidAlive(pid);
  } catch {
    return false;
  }
}

export function frozenMessage(live: Pick<LiveSpawn, "skillId" | "runId">): string {
  return `an agent run (${live.skillId} ${live.runId}) is in progress; wait for it to finish (legion-cli status)`;
}

/**
 * The freeze (KD-2): refuse any engine write while an agent spawn is live. `finishRunId` is the
 * owning finish path's in-memory token.
 */
export async function refuseIfFrozen(projectRoot: string, opts: { finishRunId?: string } = {}): Promise<void> {
  const live = await findLiveSpawn(projectRoot);
  if (!live) return;
  if (live.owned && opts.finishRunId === live.runId) return;
  refuse(frozenMessage(live), HINT.status);
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
