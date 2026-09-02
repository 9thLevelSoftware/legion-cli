import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  createLegionEngine,
  LegionRefuseError,
  type LegionEngine,
  type NewTicket,
} from "@9thlevelsoftware/legion-cli-core";

const MAX_BODY_BYTES = 64 * 1024;

export const WRITE_TOKEN_HEADER = "x-legion-cli-token";
export const ENGINE_WRITE_METHODS = new Set(["ticket", "wikiTrust", "qaChecklist"]);

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

function parseTicket(body: unknown): NewTicket {
  const rec = asRecord(body);
  if (typeof rec.title !== "string" || rec.title.trim().length === 0) {
    throw new EngineWriteError(400, { error: "ticket requires title" });
  }
  const type = rec.type === "fix" || rec.type === "bug" || rec.type === "feature" ? rec.type : undefined;
  const priority =
    rec.priority === "P0" || rec.priority === "P1" || rec.priority === "P2" ? rec.priority : undefined;
  return {
    title: rec.title,
    parentId: typeof rec.parentId === "string" ? rec.parentId : undefined,
    fromAgent: Boolean(rec.fromAgent),
    type,
    priority,
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
        fail(new EngineWriteError(413, { error: "payload too large" }));
        req.destroy();
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
    if (method === "ticket") {
      const ticket = await engine.fileTicket(parseTicket(body));
      return { ok: true, id: ticket.id, parentId: ticket.parentId ?? null, next: "legion-cli next" };
    }
    if (method === "wikiTrust") {
      const pageId = parsePageId(body);
      await engine.wikiTrust(pageId);
      return { ok: true, page: pageId, trust: "reviewed" };
    }
    const ticks = parseTicks(body);
    await engine.qaChecklist(ticks);
    const state = await engine.getState();
    return {
      ok: true,
      specId: state.activeSpecId,
      ticks,
      next: "legion-cli qa --mode no-browser",
    };
  } catch (err) {
    if (err instanceof EngineWriteError) throw err;
    if (err instanceof LegionRefuseError) {
      throw new EngineWriteError(400, { error: err.message, next: err.nextHint });
    }
    throw err;
  }
}
