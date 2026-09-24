import { appendFile, mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuditEventSchema, SCHEMA_VERSION, type AuditEvent, type Phase } from "@9thlevelsoftware/legion-cli-schema";
import { EngineLockedError } from "./errors.js";
import { abandonReceiptPath, auditDayPath, auditEventsPath, legionPaths, shipReceiptPath } from "./layout.js";
import { persistWork } from "./markdown.js";
import { toFsPath } from "./paths.js";
import { appendAuditChainLine } from "./pre-image.js";
import { createLegionStore } from "./store.js";

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
  const store = createLegionStore(projectRoot);
  if (store.holdsLock()) return appendAuditEventLocked(projectRoot, parsed);
  try {
    // timeout 0: re-enter if we hold it; never wait out a refusal that already hit EngineLockedError
    return await store.withLock(() => appendAuditEventLocked(projectRoot, parsed), { timeoutMs: 0 });
  } catch (err) {
    if (err instanceof EngineLockedError) return appendAuditEventLocked(projectRoot, parsed);
    throw err;
  }
}

async function appendAuditEventLocked(projectRoot: string, parsed: AuditEvent): Promise<AuditEvent> {
  const paths = legionPaths(projectRoot);
  await mkdir(paths.auditDir, { recursive: true });
  const jsonl = toFsPath(projectRoot, auditEventsPath());
  const line = JSON.stringify(parsed);
  await appendFile(jsonl, `${line}\n`, "utf8");
  await appendAuditChainLine(projectRoot, line);
  await appendAuditDay(projectRoot, parsed);
  return parsed;
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
  await retainAuditDayFiles(projectRoot, Date.now(), day);
}

export function formatAuditDayLine(event: AuditEvent): string {
  const task = event.taskId ? ` task=${event.taskId}` : "";
  const adapter = typeof event.data.adapterId === "string" ? ` adapter=${event.data.adapterId}` : "";
  const sandbox = typeof event.data.backend === "string" ? ` sandbox=${event.data.backend}` : "";
  return `- ${event.ts} ${event.type} phase=${event.phase}${task} actor=${event.actor}${adapter}${sandbox}\n`;
}

export const AUDIT_VIEW_CAP = 200;
export const AUDIT_RETENTION_DAYS = 30;

export type AuditReadOpts = {
  /** Last N valid events. Omit to read the whole log. */
  cap?: number;
  /** Exclusive start byte offset for a delta read. */
  afterOffset?: number;
};

export type AuditCursor = {
  size: number;
  mtimeMs: number;
};

export type AuditReadResult = {
  events: AuditEvent[];
  cursor: AuditCursor;
  bytesRead: number;
  unchanged: boolean;
};

function parseAuditLine(line: string): AuditEvent | null {
  if (!line.trim()) return null;
  try {
    const parsed = AuditEventSchema.safeParse(JSON.parse(line) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseAuditLines(text: string): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const event = parseAuditLine(line);
    if (event) events.push(event);
  }
  return events;
}

async function auditJsonlStat(projectRoot: string): Promise<AuditCursor | null> {
  const jsonl = toFsPath(projectRoot, auditEventsPath());
  try {
    const st = await stat(jsonl);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function readAuditSlice(
  projectRoot: string,
  start: number,
  length: number,
): Promise<{ text: string; bytesRead: number }> {
  if (length <= 0) return { text: "", bytesRead: 0 };
  const jsonl = toFsPath(projectRoot, auditEventsPath());
  const handle = await open(jsonl, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    persistWork.auditBytesRead += bytesRead;
    return { text: buf.subarray(0, bytesRead).toString("utf8"), bytesRead };
  } finally {
    await handle.close();
  }
}

export async function readAuditCursor(projectRoot: string): Promise<AuditCursor> {
  return (await auditJsonlStat(projectRoot)) ?? { size: 0, mtimeMs: 0 };
}

/**
 * Incremental jsonl read. `cap` reads from the tail; `afterOffset` reads only new bytes.
 * events.jsonl stays append-only (PR 2 chain).
 */
export async function readAuditEventsDetailed(
  projectRoot: string,
  opts?: AuditReadOpts,
): Promise<AuditReadResult> {
  const cursor = await readAuditCursor(projectRoot);
  if (cursor.size === 0) {
    return { events: [], cursor, bytesRead: 0, unchanged: true };
  }
  if (opts?.afterOffset !== undefined) {
    const start = Math.max(0, opts.afterOffset);
    if (start >= cursor.size) {
      return { events: [], cursor, bytesRead: 0, unchanged: true };
    }
    const { text, bytesRead } = await readAuditSlice(projectRoot, start, cursor.size - start);
    const events = parseAuditLines(text);
    return { events, cursor, bytesRead, unchanged: false };
  }
  if (opts?.cap === undefined) {
    const { text, bytesRead } = await readAuditSlice(projectRoot, 0, cursor.size);
    return { events: parseAuditLines(text), cursor, bytesRead, unchanged: false };
  }
  const cap = Math.max(1, opts.cap);
  let chunk = Math.min(cursor.size, Math.max(4096, cap * 256));
  while (true) {
    const start = Math.max(0, cursor.size - chunk);
    const { text, bytesRead } = await readAuditSlice(projectRoot, start, cursor.size - start);
    const events = parseAuditLines(text);
    if (events.length >= cap || start === 0) {
      return { events: events.slice(-cap), cursor, bytesRead, unchanged: false };
    }
    chunk = Math.min(cursor.size, chunk * 2);
  }
}

export async function readAuditEvents(projectRoot: string, opts?: AuditReadOpts): Promise<AuditEvent[]> {
  return (await readAuditEventsDetailed(projectRoot, opts)).events;
}

export async function readAuditDelta(projectRoot: string, from: AuditCursor): Promise<AuditReadResult> {
  return readAuditEventsDetailed(projectRoot, { afterOffset: from.size });
}

/** Drop `YYYY-MM-DD.md` shards older than AUDIT_RETENTION_DAYS. Never rewrites events.jsonl. */
export async function retainAuditDayFiles(
  projectRoot: string,
  nowMs = Date.now(),
  keepDay?: string,
): Promise<number> {
  const dir = legionPaths(projectRoot).auditDir;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  const cutoff = nowMs - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    const match = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name);
    if (!match) continue;
    if (keepDay && match[1] === keepDay) continue;
    const dayStart = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(dayStart) || dayStart >= cutoff) continue;
    try {
      await unlink(join(dir, name));
      removed += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return removed;
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
