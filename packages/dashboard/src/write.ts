import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  createLegionEngine,
  HINT,
  LegionRefuseError,
  type AcceptanceEvidenceInput,
  type LegionEngine,
  type NewTicket,
} from "@9thlevelsoftware/legion-cli-core";
import { EngineLockedError } from "@9thlevelsoftware/legion-cli-persist";

const MAX_BODY_BYTES = 64 * 1024;

export const WRITE_TOKEN_HEADER = "x-legion-cli-token";
export const ENGINE_WRITE_METHODS = new Set(["ticket", "wikiTrust", "qaChecklist", "planAcceptance"]);

export class EngineWriteError extends Error {
  readonly status: number;
  readonly payload: Record<string, unknown>;

  constructor(status: number, payload: Record<string, unknown>) {
    super(typeof payload.error === "string" ? payload.error : "engine write failed");
    this.name = "EngineWriteError";
    this.status = status;
    this.payload = payload;
  }
}

export function mintWriteToken(): string {
  return randomBytes(32).toString("hex");
}

export function writeTokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createDashboardEngine(projectRoot: string): LegionEngine {
  return createLegionEngine(projectRoot);
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new EngineWriteError(400, { error: "JSON object body required" });
  }
  return body as Record<string, unknown>;
}

function parseTicketEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new EngineWriteError(400, { error: `${label} must be ${allowed.join(" | ")}` });
}

function parseTicket(body: unknown): NewTicket {
  const rec = asRecord(body);
  if (typeof rec.title !== "string" || rec.title.trim().length === 0) {
    throw new EngineWriteError(400, { error: "ticket requires title" });
  }
  return {
    title: rec.title,
    parentId: typeof rec.parentId === "string" ? rec.parentId : undefined,
    fromAgent: Boolean(rec.fromAgent),
    type: parseTicketEnum(rec.type, ["feature", "fix", "bug"], "type"),
    priority: parseTicketEnum(rec.priority, ["P0", "P1", "P2"], "priority"),
    notes: typeof rec.notes === "string" ? rec.notes : undefined,
  };
}

function parsePageId(body: unknown): string {
  const rec = asRecord(body);
  const page =
    typeof rec.pageId === "string" ? rec.pageId : typeof rec.page === "string" ? rec.page : "";
  if (!page.trim()) {
    throw new EngineWriteError(400, { error: "wikiTrust requires pageId" });
  }
  return page.trim();
}

function parseTicks(body: unknown): string[] {
  const rec = asRecord(body);
  if (!Array.isArray(rec.ticks)) {
    throw new EngineWriteError(400, { error: "qaChecklist requires ticks" });
  }
  return rec.ticks.filter((id): id is string => typeof id === "string");
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new EngineWriteError(400, { error: `planAcceptance ${field} must be a string` });
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseAcceptanceEntry(raw: unknown): AcceptanceEvidenceInput {
  const rec = asRecord(raw);
  const rawId =
    typeof rec.id === "string" ? rec.id : typeof rec.criterionId === "string" ? rec.criterionId : "";
  const id = rawId.trim();
  if (!id) {
    throw new EngineWriteError(400, { error: "planAcceptance requires id or criterionId" });
  }
  const status = parseTicketEnum(
    rec.status,
    ["passed", "failed", "not_applicable"],
    "status",
  );
  if (!status) {
    throw new EngineWriteError(400, {
      error: "planAcceptance requires status (passed | failed | not_applicable)",
    });
  }
  const note = optionalNonEmptyString(rec.note, "note");
  const methodId = optionalNonEmptyString(rec.methodId, "methodId");
  const evidenceRef = optionalNonEmptyString(rec.evidenceRef, "evidenceRef");
  const evidenceDigest = optionalNonEmptyString(rec.evidenceDigest, "evidenceDigest");
  return {
    id,
    status,
    ...(note !== undefined ? { note } : {}),
    ...(methodId !== undefined ? { methodId } : {}),
    ...(evidenceRef !== undefined ? { evidenceRef } : {}),
    ...(evidenceDigest !== undefined ? { evidenceDigest } : {}),
  };
}

function parsePlanAcceptance(body: unknown): AcceptanceEvidenceInput[] {
  const rec = asRecord(body);
  if (Object.hasOwn(rec, "entries") && rec.entries !== undefined) {
    if (!Array.isArray(rec.entries) || rec.entries.length === 0) {
      throw new EngineWriteError(400, { error: "planAcceptance requires non-empty entries" });
    }
    return rec.entries.map(parseAcceptanceEntry);
  }
  return [parseAcceptanceEntry(rec)];
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        fail(new EngineWriteError(413, { error: "payload too large" }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
  });
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new EngineWriteError(400, { error: "invalid JSON" });
  }
}

export async function dispatchEngineWrite(
  engine: LegionEngine,
  method: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  if (!ENGINE_WRITE_METHODS.has(method)) {
    throw new EngineWriteError(404, { error: "unknown engine method" });
  }
  try {
    const live = await engine.peekLiveSpawn();
    if (live) {
      throw new EngineWriteError(409, {
        error: `dashboard write is refused while ${live.taskId} is in_progress`,
        next: HINT.status,
      });
    }
    if (method === "ticket") {
      const ticket = await engine.fileTicket(parseTicket(body));
      return { ok: true, id: ticket.id, parentId: ticket.parentId ?? null, next: "legion-cli next" };
    }
    if (method === "wikiTrust") {
      const pageId = parsePageId(body);
      await engine.wikiTrust(pageId);
      return { ok: true, page: pageId, trust: "reviewed" };
    }
    if (method === "qaChecklist") {
      const ticks = parseTicks(body);
      await engine.qaChecklist(ticks);
      const state = await engine.getState();
      return {
        ok: true,
        specId: state.activeSpecId,
        ticks,
        next: "legion-cli qa --mode no-browser",
      };
    }
    if (method === "planAcceptance") {
      const entries = parsePlanAcceptance(body);
      const receipt = await engine.recordAcceptance(entries, { id: "dashboard" });
      const workflow = await engine.getWorkflowStatus();
      return {
        ok: workflow.acceptance.failed.length === 0,
        specId: receipt.specId,
        receipt,
        workflow,
        next: workflow.next,
      };
    }
    throw new EngineWriteError(404, { error: "unknown engine method" });
  } catch (err) {
    if (err instanceof EngineWriteError) throw err;
    if (err instanceof EngineLockedError) {
      throw new EngineWriteError(409, { error: err.message, next: HINT.status });
    }
    if (err instanceof LegionRefuseError) {
      const conflict = /in_progress/i.test(err.message);
      throw new EngineWriteError(conflict ? 409 : 400, { error: err.message, next: err.nextHint });
    }
    throw err;
  }
}
