import { appendFile, mkdir, readFile } from "node:fs/promises";
import { AuditEventSchema, SCHEMA_VERSION, type AuditEvent, type Phase } from "@9thlevelsoftware/legion-cli-schema";
import { abandonReceiptPath, auditDayPath, auditEventsPath, legionPaths, shipReceiptPath } from "./layout.js";
import { writeTextFile } from "./markdown.js";
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

export function auditDayFromTs(ts: string): string {
  return ts.slice(0, 10);
}

async function appendAuditDay(projectRoot: string, event: AuditEvent): Promise<void> {
  const day = auditDayFromTs(event.ts);
  const store = auditDayPath(day);
  const abs = toFsPath(projectRoot, store);
  const line = formatAuditDayLine(event);
  let existing = "";
  try {
    existing = await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing === "") {
    await writeTextFile(abs, `# ${day}\n\n${line}`);
    return;
  }
  const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
  await writeTextFile(abs, `${prefix}${line}`);
}

export function formatAuditDayLine(event: AuditEvent): string {
  const task = event.taskId ? ` task=${event.taskId}` : "";
  return `- ${event.ts} ${event.type} phase=${event.phase}${task} actor=${event.actor}\n`;
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
