import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuditEventSchema, SCHEMA_VERSION, type AuditEvent, type Phase } from "@9thlevelsoftware/legion-cli-schema";
import { abandonReceiptPath, auditDayPath, auditEventsPath, legionPaths, shipReceiptPath } from "./layout.js";
import { toFsPath } from "./paths.js";

export { abandonReceiptPath, auditDayPath, auditEventsPath, shipReceiptPath };

export async function appendAuditEvent(
  projectRoot: string,
  event: Omit<AuditEvent, "schemaVersion"> & { schemaVersion?: AuditEvent["schemaVersion"] },
): Promise<AuditEvent> {
  const parsed = AuditEventSchema.parse({
    schemaVersion: event.schemaVersion ?? SCHEMA_VERSION.audit,
    ts: event.ts,
    type: event.type,
    phase: event.phase,
    taskId: event.taskId ?? null,
    actor: event.actor,
    data: event.data,
  });
  const paths = legionPaths(projectRoot);
  await mkdir(paths.auditDir, { recursive: true });
  const jsonl = toFsPath(projectRoot, auditEventsPath());
  await appendFile(jsonl, `${JSON.stringify(parsed)}\n`, "utf8");
  await appendAuditDay(projectRoot, parsed);
  return parsed;
}

export const DEFERRED_AUDIT_BASENAME = "deferred-audit.jsonl";

/**
 * KD-15 / R-41: while another process's agent run is live, this process never writes into
 * `.legion-cli/audit/` (it is in the protected set). Its events go to the run's control dir,
 * outside the project; the owning finish appends them after the protected-set restore.
 */
export async function appendDeferredAuditEvent(
  controlDir: string,
  event: Omit<AuditEvent, "schemaVersion"> & { schemaVersion?: AuditEvent["schemaVersion"] },
): Promise<AuditEvent> {
  const parsed = AuditEventSchema.parse({
    schemaVersion: event.schemaVersion ?? SCHEMA_VERSION.audit,
    ts: event.ts,
    type: event.type,
    phase: event.phase,
    taskId: event.taskId ?? null,
    actor: event.actor,
    data: event.data,
  });
  await appendFile(join(controlDir, DEFERRED_AUDIT_BASENAME), `${JSON.stringify(parsed)}\n`, "utf8");
  return parsed;
}

/**
 * The only event a non-owning process produces while frozen is a refusal. Everything else in a
 * deferred file was written by something that is not an engine verb — an agent runs as the user
 * and can append to the control dir — so only refusals are drained (R-18).
 */
export const DEFERRABLE_AUDIT_TYPES = new Set(["refuse"]);

/** Caps on a deferred file, so an agent cannot drown the audit log (R-18). */
export const MAX_DEFERRED_AUDIT_BYTES = 256 * 1024;
export const MAX_DEFERRED_AUDIT_EVENTS = 500;

/**
 * Append the deferred events to the project audit log, then drop the file.
 *
 * Deferred content is never trusted: the file sits in the control dir, which an unjailed agent can
 * write. Every drained event is re-stamped as `actor: "deferred"` with `data.deferred: true` and
 * the control dir it came from, its type must be one the freeze can legitimately produce, and an
 * unparseable or future timestamp is replaced by the drain time. Doctor's integrity checks read
 * only events the engine itself wrote (R-18).
 */
export async function drainDeferredAuditEvents(projectRoot: string, controlDir: string): Promise<number> {
  let count = 0;
  for (const name of await deferredFiles(controlDir)) {
    const file = join(controlDir, name);
    // Rename first: an append that lands after the read is then kept for the next drain, not
    // deleted with the file (R-10).
    const claimed = `${file}.${process.pid}.draining`;
    try {
      await rename(file, claimed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    let raw: string;
    try {
      raw = await readFile(claimed, "utf8");
    } catch {
      await unlink(claimed).catch(() => undefined);
      continue;
    }
    if (raw.length > MAX_DEFERRED_AUDIT_BYTES) raw = raw.slice(0, MAX_DEFERRED_AUDIT_BYTES);
    const now = Date.now();
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (count >= MAX_DEFERRED_AUDIT_EVENTS) break;
      try {
        const parsed = AuditEventSchema.safeParse(JSON.parse(line) as unknown);
        if (!parsed.success) continue;
        const event = parsed.data;
        if (!DEFERRABLE_AUDIT_TYPES.has(event.type)) continue;
        const ts = Date.parse(event.ts);
        await appendAuditEvent(projectRoot, {
          ...event,
          ts: Number.isFinite(ts) && ts <= now ? event.ts : new Date(now).toISOString(),
          actor: "deferred",
          data: { ...event.data, deferred: true, controlDir },
        });
        count += 1;
      } catch {
        continue;
      }
    }
    await unlink(claimed).catch(() => undefined);
  }
  return count;
}

async function deferredFiles(controlDir: string): Promise<string[]> {
  try {
    return (await readdir(controlDir)).filter((name) => name.startsWith(DEFERRED_AUDIT_BASENAME));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function auditDayFromTs(ts: string): string {
  return ts.slice(0, 10);
}

async function appendAuditDay(projectRoot: string, event: AuditEvent): Promise<void> {
  const day = auditDayFromTs(event.ts);
  const store = auditDayPath(day);
  const abs = toFsPath(projectRoot, store);
  const line = formatAuditDayLine(event);
  await mkdir(dirname(abs), { recursive: true });
  try {
    // The header is written only by whoever creates the day file.
    await writeFile(abs, `# ${day}\n\n${line}`, { encoding: "utf8", flag: "wx" });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  await appendFile(abs, line, "utf8");
}

export function formatAuditDayLine(event: AuditEvent): string {
  const task = event.taskId ? ` task=${event.taskId}` : "";
  const adapter = typeof event.data.adapterId === "string" ? ` adapter=${event.data.adapterId}` : "";
  const sandbox = typeof event.data.backend === "string" ? ` sandbox=${event.data.backend}` : "";
  return `- ${event.ts} ${event.type} phase=${event.phase}${task} actor=${event.actor}${adapter}${sandbox}\n`;
}

export async function readAuditEvents(projectRoot: string): Promise<AuditEvent[]> {
  const jsonl = toFsPath(projectRoot, auditEventsPath());
  let raw: string;
  try {
    raw = await readFile(jsonl, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const events: AuditEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = AuditEventSchema.safeParse(JSON.parse(line) as unknown);
      if (parsed.success) events.push(parsed.data);
    } catch {
      continue;
    }
  }
  return events;
}

export type LocalMetrics = {
  refusesByType: Record<string, number>;
  qa: { runs: number; passes: number; passRate: number | null };
  execute: { runs: number; meanDurationMs: number | null };
  timeouts: number;
};

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function summarizeAuditMetrics(events: readonly AuditEvent[]): LocalMetrics {
  const refusesByType: Record<string, number> = {};
  let qaRuns = 0;
  let qaPasses = 0;
  let executeRuns = 0;
  let executeDurationSum = 0;
  let executeDurationCount = 0;
  let timeouts = 0;

  for (const event of events) {
    if (event.type === "refuse") {
      const kind =
        typeof event.data.kind === "string" && event.data.kind.trim() ? event.data.kind.trim() : "other";
      refusesByType[kind] = (refusesByType[kind] ?? 0) + 1;
      continue;
    }
    if (event.type === "qa") {
      qaRuns += 1;
      if (event.data.pass === true) qaPasses += 1;
      continue;
    }
    if (event.type === "execute") {
      executeRuns += 1;
      const ms = asFiniteNumber(event.data.durationMs);
      if (ms !== null) {
        executeDurationSum += ms;
        executeDurationCount += 1;
      }
      continue;
    }
    if (event.type === "timeout") timeouts += 1;
  }

  return {
    refusesByType,
    qa: {
      runs: qaRuns,
      passes: qaPasses,
      passRate: qaRuns === 0 ? null : qaPasses / qaRuns,
    },
    execute: {
      runs: executeRuns,
      meanDurationMs: executeDurationCount === 0 ? null : executeDurationSum / executeDurationCount,
    },
    timeouts,
  };
}

export function shipReceiptBody(input: {
  specId: string;
  shippedAt: string;
  qaMode: string | null;
  qaScore: number | null;
  qaPass: boolean;
  allowDegradedQa: boolean;
  staged: string[];
  committed: boolean;
  commitSha?: string;
  prUrl?: string;
}): string {
  const lines = [
    `# Ship receipt`,
    "",
    `- specId: ${input.specId}`,
    `- shippedAt: ${input.shippedAt}`,
    `- qa.mode: ${input.qaMode ?? "none"}`,
    `- qa.total: ${input.qaScore ?? "none"}`,
    `- qa.pass: ${input.qaPass}`,
    `- allowDegradedQa: ${input.allowDegradedQa}`,
    `- staged: ${input.staged.join(", ") || "(none)"}`,
    `- committed: ${input.committed}`,
  ];
  if (input.commitSha) lines.push(`- commit: ${input.commitSha}`);
  if (input.prUrl) lines.push(`- pr: ${input.prUrl}`);
  lines.push("");
  return lines.join("\n");
}

export function abandonReceiptBody(input: { specId: string; abandonedAt: string; message: string; phase: Phase }): string {
  return [
    `# Abandon receipt`,
    "",
    `- specId: ${input.specId}`,
    `- abandonedAt: ${input.abandonedAt}`,
    `- fromPhase: ${input.phase}`,
    `- message: ${input.message}`,
    "",
  ].join("\n");
}
