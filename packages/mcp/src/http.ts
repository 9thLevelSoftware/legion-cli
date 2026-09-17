import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLegionMcpServer } from "./server.js";

export const MCP_HTTP_PATH = "/mcp";
export const MCP_HTTP_MAX_BODY_BYTES = 1024 * 1024;
export const MCP_HTTP_RATE_PER_SEC = 30;
export const MCP_HTTP_MAX_SESSIONS = 32;

export type HandleMcpHttpOpts = {
  req: IncomingMessage;
  res: ServerResponse;
  projectRoot: string;
};

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

const sessions = new Map<string, McpSession>();
const openResponses = new Set<ServerResponse>();
const hitsBySocket = new WeakMap<Socket, number[]>();

function trackResponse(res: ServerResponse): void {
  openResponses.add(res);
  const done = () => {
    openResponses.delete(res);
  };
  res.once("close", done);
  res.once("finish", done);
}

function endOpenResponses(): void {
  for (const res of openResponses) {
    try {
      if (!res.writableEnded) res.end();
    } catch {
      // already closed
    }
    try {
      res.destroy();
    } catch {
      // already destroyed
    }
  }
  openResponses.clear();
}

function sessionHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers["mcp-session-id"];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function acceptHeader(req: IncomingMessage): string {
  const raw = req.headers.accept;
  if (Array.isArray(raw)) return raw.join(",");
  return raw ?? "";
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function rateLimitOk(socket: Socket | undefined): boolean {
  if (!socket) return true;
  const now = Date.now();
  const hits = (hitsBySocket.get(socket) ?? []).filter((ts) => now - ts < 1000);
  if (hits.length >= MCP_HTTP_RATE_PER_SEC) {
    hitsBySocket.set(socket, hits);
    return false;
  }
  hits.push(now);
  hitsBySocket.set(socket, hits);
  return true;
}

async function readCappedBody(req: IncomingMessage): Promise<Buffer | "too-large"> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MCP_HTTP_MAX_BODY_BYTES) {
    return "too-large";
  }
  return await new Promise<Buffer | "too-large">((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (value: Buffer | "too-large") => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MCP_HTTP_MAX_BODY_BYTES) {
        req.pause();
        done("too-large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function parseJsonBody(raw: Buffer): unknown {
  const text = raw.toString("utf8").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

function isInit(body: unknown): boolean {
  if (Array.isArray(body)) return body.some((item) => isInitializeRequest(item));
  return isInitializeRequest(body);
}

function writeStandaloneSse(res: ServerResponse, headOnly: boolean): void {
  if (res.headersSent) return;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  if (headOnly) {
    res.end();
    return;
  }
  res.end("retry: 15000\n: connected\n\n");
}

async function createSession(projectRoot: string): Promise<McpSession> {
  let server!: McpServer;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server });
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });
  server = await createLegionMcpServer({ projectRoot });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) sessions.delete(id);
    void server.close();
  };
  await server.connect(transport);
  return { transport, server };
}

/**
 * Streamable HTTP MCP at /mcp: GET SSE, POST JSON-RPC, DELETE session.
 * Uses SDK StreamableHTTPServerTransport.handleRequest when a session exists
 * or the POST is initialize. GET without a session is still 200 event-stream.
 */
export async function handleMcpHttp(opts: HandleMcpHttpOpts): Promise<void> {
  const { req, res, projectRoot } = opts;
  const method = (req.method ?? "GET").toUpperCase();

  if (!rateLimitOk(req.socket)) {
    if (!res.headersSent) {
      res.statusCode = 429;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Retry-After", "1");
      res.end("Too Many Requests\n");
    }
    req.resume();
    return;
  }

  if (method === "HEAD") {
    writeStandaloneSse(res, true);
    return;
  }

  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    if (!res.headersSent) {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD, POST, DELETE");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }),
      );
    }
    return;
  }

  trackResponse(res);

  let parsedBody: unknown;
  if (method === "POST" || method === "DELETE") {
    let raw: Buffer | "too-large";
    try {
      raw = await readCappedBody(req);
    } catch (err) {
      jsonRpcError(res, 400, -32700, err instanceof Error ? err.message : "Parse error");
      return;
    }
    if (raw === "too-large") {
      jsonRpcError(res, 413, -32000, "payload too large");
      req.destroy();
      return;
    }
    if (method === "POST") {
      try {
        parsedBody = parseJsonBody(raw);
      } catch {
        jsonRpcError(res, 400, -32700, "Parse error");
        return;
      }
    }
  }

  const sessionId = sessionHeader(req);
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  if (sessionId && !existing) {
    jsonRpcError(res, 404, -32001, "Session not found");
    return;
  }

  if (method === "GET") {
    if (!acceptHeader(req).includes("text/event-stream")) {
      jsonRpcError(res, 406, -32000, "Not Acceptable: Client must accept text/event-stream");
      return;
    }
    if (existing) {
      await existing.transport.handleRequest(req, res);
      return;
    }
    writeStandaloneSse(res, false);
    return;
  }

  if (existing) {
    await existing.transport.handleRequest(req, res, parsedBody);
    return;
  }

  if (method === "POST" && isInit(parsedBody)) {
    if (sessions.size >= MCP_HTTP_MAX_SESSIONS) {
      jsonRpcError(res, 429, -32000, "too many MCP sessions");
      return;
    }
    const session = await createSession(projectRoot);
    await session.transport.handleRequest(req, res, parsedBody);
    return;
  }

  if (method === "DELETE") {
    jsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  jsonRpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
}

export async function closeMcpHttp(): Promise<void> {
  endOpenResponses();
  const live = [...sessions.values()];
  sessions.clear();
  await Promise.all(
    live.map(async (session) => {
      try {
        await session.transport.close();
      } catch {
        // already closed
      }
      try {
        await session.server.close();
      } catch {
        // already closed
      }
    }),
  );
}
