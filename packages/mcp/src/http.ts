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
  body?: Buffer;
};

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

type ProjectScope = {
  sessions: Map<string, McpSession>;
  open: Set<ServerResponse>;
};

const scopes = new Map<string, ProjectScope>();
const hitsBySocket = new WeakMap<Socket, number[]>();

function scopeFor(projectRoot: string): ProjectScope {
  let scope = scopes.get(projectRoot);
  if (!scope) {
    scope = { sessions: new Map(), open: new Set() };
    scopes.set(projectRoot, scope);
  }
  return scope;
}

function trackResponse(scope: ProjectScope, res: ServerResponse): void {
  scope.open.add(res);
  const done = () => {
    scope.open.delete(res);
  };
  res.once("close", done);
  res.once("finish", done);
}

function endOpenResponses(scope: ProjectScope): void {
  for (const res of scope.open) {
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
  scope.open.clear();
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

async function readBody(req: IncomingMessage, provided?: Buffer): Promise<Buffer> {
  if (provided) {
    if (provided.length > MCP_HTTP_MAX_BODY_BYTES) {
      throw Object.assign(new Error("payload too large"), { status: 413 });
    }
    return provided;
  }
  return await new Promise<Buffer>((resolve, reject) => {
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
      if (size > MCP_HTTP_MAX_BODY_BYTES) {
        req.pause();
        fail(Object.assign(new Error("payload too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", fail);
  });
}

function drainRequest(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on("end", resolve);
    req.on("close", resolve);
    req.on("error", () => resolve());
    req.resume();
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

async function createSession(projectRoot: string, scope: ProjectScope): Promise<McpSession> {
  const session: McpSession = {
    transport: undefined as unknown as StreamableHTTPServerTransport,
    server: undefined as unknown as McpServer,
  };
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      scope.sessions.set(id, session);
    },
    onsessionclosed: (id) => {
      scope.sessions.delete(id);
    },
  });
  const server = await createLegionMcpServer({ projectRoot });
  session.transport = transport;
  session.server = server;
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) scope.sessions.delete(id);
    void server.close();
  };
  await server.connect(transport);
  return session;
}

async function handleWithSdk(
  session: McpSession,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
): Promise<void> {
  await session.transport.handleRequest(req, res, parsedBody);
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

  const scope = scopeFor(projectRoot);
  trackResponse(scope, res);
  const sessionId = sessionHeader(req);
  const existing = sessionId ? scope.sessions.get(sessionId) : undefined;

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
      await handleWithSdk(existing, req, res);
      return;
    }
    writeStandaloneSse(res, false);
    return;
  }

  let parsedBody: unknown;
  try {
    if (method === "POST") {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MCP_HTTP_MAX_BODY_BYTES) {
        await drainRequest(req);
        jsonRpcError(res, 413, -32000, "payload too large");
        return;
      }
      const raw = await readBody(req, opts.body);
      parsedBody = parseJsonBody(raw);
    } else if (opts.body && opts.body.length > 0) {
      parsedBody = parseJsonBody(opts.body);
    }
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    if (status === 413) {
      jsonRpcError(res, 413, -32000, "payload too large");
      req.resume();
      return;
    }
    jsonRpcError(res, 400, -32700, "Parse error");
    return;
  }

  if (existing) {
    await handleWithSdk(existing, req, res, parsedBody);
    return;
  }

  if (method === "POST" && isInit(parsedBody)) {
    if (scope.sessions.size >= MCP_HTTP_MAX_SESSIONS) {
      jsonRpcError(res, 429, -32000, "too many MCP sessions");
      return;
    }
    const session = await createSession(projectRoot, scope);
    await handleWithSdk(session, req, res, parsedBody);
    return;
  }

  if (method === "DELETE") {
    jsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  jsonRpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
}

export async function closeMcpHttp(projectRoot?: string): Promise<void> {
  const targets = projectRoot ? [scopes.get(projectRoot)] : [...scopes.values()];
  if (projectRoot) scopes.delete(projectRoot);
  else scopes.clear();
  await Promise.all(
    targets.map(async (scope) => {
      if (!scope) return;
      endOpenResponses(scope);
      const sessions = [...scope.sessions.values()];
      scope.sessions.clear();
      await Promise.all(
        sessions.map(async (session) => {
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
    }),
  );
}
