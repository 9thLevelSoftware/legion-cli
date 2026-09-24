import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { LegionRefuseError } from "@9thlevelsoftware/legion-cli-core";
import {
  createLegionStore,
  isPidAlive,
  PathEscapeError,
  readAuditCursor,
  readAuditDelta,
  serveJsonPath,
  toFsPath,
  type AuditCursor,
} from "@9thlevelsoftware/legion-cli-persist";
import { SCHEMA_VERSION, ServeFileSchema, type ServeFile } from "@9thlevelsoftware/legion-cli-schema";
import {
  backlinks,
  loadWikiLinks,
  loadWikiPages,
  showPage,
} from "@9thlevelsoftware/legion-cli-wiki";
import {
  DEFAULT_DASHBOARD_PORT,
  EXPOSE_BIND,
  LOOPBACK_BIND,
  echoAllowedOrigin,
  headerValue,
  originIsAllowed,
  writeOriginIsAllowed,
} from "./origin.js";
import { openBrowser } from "./open.js";
import {
  renderAudit,
  renderGraph,
  renderKanban,
  renderNotFound,
  renderSpec,
  renderWikiIndex,
  renderWikiPage,
} from "./html.js";
import { loadSnapshot, readOptionalConfig } from "./snapshot.js";
import {
  WRITE_TOKEN_HEADER,
  createDashboardEngine,
  dispatchEngineWrite,
  EngineWriteError,
  mintWriteToken,
  readJsonBody,
  writeTokenMatches,
} from "./write.js";
import {
  WEBMCP_SCRIPT,
  WEBMCP_SCRIPT_PATH,
  webmcpHeaders,
} from "./webmcp.js";

const VIEW_METHODS = "GET, HEAD, OPTIONS";
const ALLOW_METHODS = "GET, HEAD, POST, OPTIONS";
const ALLOW_HEADERS = "X-Legion-Cli-Token, Content-Type";
const MCP_PATH = "/mcp";
const MCP_ALLOW_METHODS = "GET, HEAD, POST, DELETE, OPTIONS";
const MCP_ALLOW_HEADERS = "Content-Type, Accept, MCP-Session-Id, MCP-Protocol-Version";
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";
const CSP_WEBMCP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

export type McpHttpHandler = (opts: {
  req: IncomingMessage;
  res: ServerResponse;
  projectRoot: string;
}) => Promise<void>;

export type DashboardOptions = {
  projectRoot: string;
  host?: string;
  port?: number;
  open?: boolean;
  openBrowser?: (url: string) => void;
  warn?: (message: string) => void;
  pollMs?: number;
  mcpHttp?: boolean;
  webmcp?: boolean;
  handleMcpHttp?: McpHttpHandler;
  occupy?: boolean;
  onClose?: () => Promise<void>;
};

export type DashboardHandle = {
  url: string;
  host: string;
  port: number;
  token: string;
  webmcp: boolean;
  close(): Promise<void>;
};

type SseClient = {
  res: ServerResponse;
  write(chunk: string): void;
};

function contentTypeFor(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function setSecurityHeaders(res: ServerResponse, origin: string | undefined, webmcp = false): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", webmcp ? CSP_WEBMCP : CSP);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (webmcp) {
    for (const [header, value] of Object.entries(webmcpHeaders())) {
      res.setHeader(header, value);
    }
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS);
    res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS);
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  headOnly: boolean,
  origin: string | undefined,
  webmcp = false,
): void {
  setSecurityHeaders(res, origin, webmcp);
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  const payload = Buffer.from(body, "utf8");
  res.setHeader("Content-Length", payload.length);
  if (headOnly || status === 204) {
    res.end();
    return;
  }
  res.end(payload);
}

function methodNotAllowed(res: ServerResponse, origin: string | undefined, webmcp = false): void {
  setSecurityHeaders(res, origin, webmcp);
  res.statusCode = 405;
  res.setHeader("Allow", VIEW_METHODS);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Method Not Allowed\n");
}

function forbidden(
  res: ServerResponse,
  origin: string | undefined,
  message: string,
  webmcp = false,
): void {
  setSecurityHeaders(res, origin, webmcp);
  res.statusCode = 403;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(`${message}\n`);
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  origin: string | undefined,
  webmcp = false,
): void {
  send(
    res,
    status,
    `${JSON.stringify(payload)}\n`,
    "application/json; charset=utf-8",
    false,
    origin,
    webmcp,
  );
}

async function serveWireframe(
  projectRoot: string,
  specId: string,
  fileName: string,
  res: ServerResponse,
  headOnly: boolean,
  origin: string | undefined,
  webmcp = false,
): Promise<void> {
  const base = basename(fileName);
  if (base !== fileName || fileName.includes("\\") || fileName.includes("\0")) {
    send(
      res,
      404,
      renderNotFound("unknown wireframe", webmcp),
      "text/html; charset=utf-8",
      headOnly,
      origin,
      webmcp,
    );
    return;
  }
  const storePath = `.legion-cli/specs/${specId}/wireframes/${base}`;
  try {
    const abs = toFsPath(projectRoot, storePath);
    const body = await readFile(abs, "utf8");
    send(res, 200, body, contentTypeFor(base), headOnly, origin, webmcp);
  } catch (err) {
    if (err instanceof PathEscapeError || (err as NodeJS.ErrnoException).code === "ENOENT") {
      send(
        res,
        404,
        renderNotFound("unknown wireframe", webmcp),
        "text/html; charset=utf-8",
        headOnly,
        origin,
        webmcp,
      );
      return;
    }
    throw err;
  }
}

function tokenSha256(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function readServeFile(projectRoot: string): Promise<{ file: ServeFile; raw: string } | null> {
  let raw: string;
  try {
    raw = await readFile(toFsPath(projectRoot, serveJsonPath()), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LegionRefuseError(
      `unreadable serve.json: ${(err as Error).message}`,
      "legion-cli status",
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    throw new LegionRefuseError("unreadable serve.json: invalid JSON", "legion-cli status");
  }
  const parsed = ServeFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new LegionRefuseError("unreadable serve.json: invalid schema", "legion-cli status");
  }
  return { file: parsed.data, raw };
}

export async function readLiveServe(projectRoot: string): Promise<ServeFile | null> {
  const record = await readServeFile(projectRoot);
  if (!record || !isPidAlive(record.file.pid)) return null;
  return record.file;
}

function serveFileBody(input: {
  projectRoot: string;
  port: number;
  bind: string;
  mcpHttp: boolean;
  token: string;
}): string {
  const file = ServeFileSchema.parse({
    schemaVersion: SCHEMA_VERSION.serve,
    port: input.port,
    bind: input.bind,
    mcpPath: MCP_PATH,
    mcpHttp: input.mcpHttp,
    tokenSha256: tokenSha256(input.token),
    startedAt: new Date().toISOString(),
    pid: process.pid,
  });
  return `${JSON.stringify(file, null, 2)}\n`;
}

async function claimServeSlot(input: {
  projectRoot: string;
  port: number;
  bind: string;
  mcpHttp: boolean;
  token: string;
}): Promise<void> {
  const path = toFsPath(input.projectRoot, serveJsonPath());
  await mkdir(dirname(path), { recursive: true });
  const body = serveFileBody(input);
  try {
    await writeFile(path, body, { encoding: "utf8", flag: "wx" });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const existing = await readServeFile(input.projectRoot);
  if (existing && isPidAlive(existing.file.pid)) {
    throw new LegionRefuseError(
      `serve is already running on ${existing.file.bind}:${existing.file.port} (pid ${existing.file.pid})`,
      "legion-cli status",
    );
  }
  if (existing) {
    let currentRaw: string;
    try {
      currentRaw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      currentRaw = "";
    }
    if (currentRaw && currentRaw !== existing.raw) {
      throw new LegionRefuseError("serve is already running", "legion-cli status");
    }
    if (currentRaw === existing.raw) {
      await unlink(path);
    }
  }
  try {
    await writeFile(path, body, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LegionRefuseError("serve is already running", "legion-cli status");
    }
    throw err;
  }
}

async function removeOwnServeFile(projectRoot: string, pid: number): Promise<void> {
  try {
    const current = await readServeFile(projectRoot);
    if (current && current.file.pid !== pid) return;
    await unlink(toFsPath(projectRoot, serveJsonPath()));
  } catch (err) {
    if (err instanceof LegionRefuseError) return;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function startDashboard(opts: DashboardOptions): Promise<DashboardHandle> {
  const host = opts.host ?? LOOPBACK_BIND;
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const pollMs = opts.pollMs ?? 1000;
  const warn = opts.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const token = mintWriteToken();
  const occupy = opts.occupy === true;
  const mcpHttp = opts.mcpHttp === true;
  if (mcpHttp && !opts.handleMcpHttp) {
    throw new Error("mcpHttp requires handleMcpHttp");
  }
  if (mcpHttp && host === EXPOSE_BIND) {
    throw new LegionRefuseError(
      "MCP HTTP is loopback-only; --expose would bind unauthenticated /mcp on 0.0.0.0",
      "legion-cli serve --no-mcp-http --expose",
    );
  }
  const engine = createDashboardEngine(opts.projectRoot);
  const config = await readOptionalConfig(createLegionStore(opts.projectRoot));
  const webmcp = opts.webmcp === true || config?.flags.webmcp === true;
  const sseClients = new Set<SseClient>();
  let lastEncoded = "";
  let lastRestEncoded = "";
  let lastAuditCursor: AuditCursor = { size: 0, mtimeMs: 0 };
  let closed = false;
  let boundPort = port;

  const broadcast = (chunk: string): void => {
    for (const client of sseClients) {
      try {
        client.write(chunk);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const originHeader = headerValue(req.headers.origin);
    const hostHeader = headerValue(req.headers.host);
    const allowed = originIsAllowed({
      origin: originHeader,
      hostHeader,
      bind: host,
      port: boundPort,
    });
    const cors = echoAllowedOrigin(originHeader, allowed);
    if (!allowed) {
      forbidden(res, undefined, "Forbidden origin", webmcp);
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${hostHeader ?? `${host}:${boundPort}`}`);
    const pathname = decodeURIComponent(url.pathname);
    const mcpRoute = mcpHttp && pathname === MCP_PATH;

    if (method === "OPTIONS") {
      setSecurityHeaders(res, cors, webmcp);
      res.statusCode = 204;
      res.setHeader("Allow", mcpRoute ? MCP_ALLOW_METHODS : ALLOW_METHODS);
      if (mcpRoute) {
        res.setHeader("Access-Control-Allow-Methods", MCP_ALLOW_METHODS);
        res.setHeader("Access-Control-Allow-Headers", MCP_ALLOW_HEADERS);
      }
      res.end();
      return;
    }

    if (mcpRoute) {
      if (cors) {
        res.setHeader("Access-Control-Allow-Origin", cors);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", MCP_ALLOW_METHODS);
        res.setHeader("Access-Control-Allow-Headers", MCP_ALLOW_HEADERS);
      }
      if (!opts.handleMcpHttp) {
        send(res, 501, "MCP HTTP is not attached\n", "text/plain; charset=utf-8", false, cors, webmcp);
        return;
      }
      await opts.handleMcpHttp({ req, res, projectRoot: opts.projectRoot });
      return;
    }

    if (method === "POST") {
      if (!pathname.startsWith("/engine/")) {
        methodNotAllowed(res, cors, webmcp);
        return;
      }
      if (
        !writeOriginIsAllowed({
          origin: originHeader,
          hostHeader,
          bind: host,
          port: boundPort,
        })
      ) {
        forbidden(res, undefined, "Forbidden origin", webmcp);
        return;
      }
      const engineMethod = pathname.slice("/engine/".length);
      if (engineMethod.includes("/") || engineMethod.includes("\\") || !/^[A-Za-z]+$/.test(engineMethod)) {
        sendJson(res, 404, { error: "unknown engine method" }, cors, webmcp);
        return;
      }
      if (!writeTokenMatches(token, headerValue(req.headers[WRITE_TOKEN_HEADER]))) {
        forbidden(res, cors, "Forbidden token", webmcp);
        return;
      }
      try {
        const body = await readJsonBody(req);
        const payload = await dispatchEngineWrite(engine, engineMethod, body);
        sendJson(res, 200, payload, cors, webmcp);
      } catch (err) {
        if (err instanceof EngineWriteError) {
          sendJson(res, err.status, err.payload, cors, webmcp);
          if (err.status === 413) req.destroy();
          return;
        }
        throw err;
      }
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      methodNotAllowed(res, cors, webmcp);
      return;
    }
    const headOnly = method === "HEAD";

    if (pathname === WEBMCP_SCRIPT_PATH) {
      if (!webmcp) {
        send(res, 404, "Not found\n", "text/plain; charset=utf-8", headOnly, cors, webmcp);
        return;
      }
      send(res, 200, WEBMCP_SCRIPT, "text/javascript; charset=utf-8", headOnly, cors, webmcp);
      return;
    }

    if (pathname === "/events") {
      if (headOnly) {
        setSecurityHeaders(res, cors, webmcp);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.end();
        return;
      }
      let initial = "retry: 2000\n\n";
      try {
        const snapshot = await loadSnapshot(opts.projectRoot);
        lastEncoded = JSON.stringify(snapshot);
        lastRestEncoded = JSON.stringify({ ...snapshot, audit: [] });
        lastAuditCursor = await readAuditCursor(opts.projectRoot);
        initial += `event: state\ndata: ${lastEncoded}\n\n`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        initial += `event: error\ndata: ${JSON.stringify({ error: message })}\n\n`;
      }
      setSecurityHeaders(res, cors, webmcp);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      const client: SseClient = {
        res,
        write(chunk: string) {
          res.write(chunk);
        },
      };
      sseClients.add(client);
      req.on("close", () => {
        sseClients.delete(client);
      });
      res.write(initial);
      return;
    }

    const snapshot = await loadSnapshot(opts.projectRoot);

    if (pathname === "/") {
      send(res, 200, renderKanban(snapshot, webmcp), "text/html; charset=utf-8", headOnly, cors, webmcp);
      return;
    }
    if (pathname === "/spec") {
      send(res, 200, renderSpec(snapshot, false), "text/html; charset=utf-8", headOnly, cors, false);
      return;
    }
    if (pathname === "/graph") {
      send(res, 200, renderGraph(snapshot, false), "text/html; charset=utf-8", headOnly, cors, false);
      return;
    }
    if (pathname === "/audit") {
      send(res, 200, renderAudit(snapshot, false), "text/html; charset=utf-8", headOnly, cors, false);
      return;
    }
    if (pathname === "/api/state") {
      send(
        res,
        200,
        `${JSON.stringify(snapshot)}\n`,
        "application/json; charset=utf-8",
        headOnly,
        cors,
        webmcp,
      );
      return;
    }
    if (pathname.startsWith("/spec/wireframes/")) {
      const fileName = pathname.slice("/spec/wireframes/".length);
      const specId = snapshot.activeSpecId;
      if (!specId || !fileName) {
        send(
          res,
          404,
          renderNotFound("unknown wireframe", false),
          "text/html; charset=utf-8",
          headOnly,
          cors,
          false,
        );
        return;
      }
      await serveWireframe(opts.projectRoot, specId, fileName, res, headOnly, cors, false);
      return;
    }
    if (pathname === "/wiki" || pathname === "/wiki/") {
      let pages: Array<{ id: string; title: string; path: string; trust: string }> = [];
      try {
        pages = loadWikiPages(opts.projectRoot).map((page) => ({
          id: page.id,
          title: page.title,
          path: page.path,
          trust: page.trust,
        }));
      } catch {
        pages = [];
      }
      send(res, 200, renderWikiIndex(pages, false), "text/html; charset=utf-8", headOnly, cors, false);
      return;
    }
    if (pathname.startsWith("/wiki/")) {
      const pageRef = pathname.slice("/wiki/".length);
      if (!pageRef || pageRef.includes("\0")) {
        send(
          res,
          404,
          renderNotFound("unknown page", false),
          "text/html; charset=utf-8",
          headOnly,
          cors,
          false,
        );
        return;
      }
      const store = createLegionStore(opts.projectRoot);
      try {
        const shown = await showPage(store, pageRef);
        let links: string[] = [];
        try {
          links = backlinks(loadWikiLinks(opts.projectRoot), pageRef);
          if (shown.kind === "wiki") {
            const id = shown.path.replace(/^\.legion-cli\/wiki\//, "").replace(/\.md$/i, "");
            links = backlinks(loadWikiLinks(opts.projectRoot), id);
          }
        } catch {
          links = [];
        }
        send(
          res,
          200,
          renderWikiPage(shown, links, false),
          "text/html; charset=utf-8",
          headOnly,
          cors,
          false,
        );
      } catch (err) {
        if (err instanceof PathEscapeError) {
          send(
            res,
            404,
            renderNotFound("unknown page", false),
            "text/html; charset=utf-8",
            headOnly,
            cors,
            false,
          );
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        send(
          res,
          404,
          renderNotFound(message, false),
          "text/html; charset=utf-8",
          headOnly,
          cors,
          false,
        );
      }
      return;
    }

    send(
      res,
      404,
      renderNotFound("unknown route", false),
      "text/html; charset=utf-8",
      headOnly,
      cors,
      false,
    );
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      res.end("Internal Server Error\n");
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      const nextPort = port > 0 && port < 65535 ? port + 1 : DEFAULT_DASHBOARD_PORT + 1;
      throw new LegionRefuseError(
        `port ${port} is already in use`,
        `legion-cli serve --port ${nextPort}`,
      );
    }
    throw err;
  }

  const addr = server.address();
  boundPort = typeof addr === "object" && addr ? addr.port : port;
  const boundHost = typeof addr === "object" && addr ? addr.address : host;
  const url = `http://127.0.0.1:${boundPort}`;

  const tick = async (): Promise<void> => {
    if (closed || sseClients.size === 0) return;
    try {
      const cursor = await readAuditCursor(opts.projectRoot);
      const snapshot = await loadSnapshot(opts.projectRoot);
      const encoded = JSON.stringify(snapshot);
      if (encoded === lastEncoded) {
        broadcast(`: ping\n\n`);
        return;
      }
      const restEncoded = JSON.stringify({ ...snapshot, audit: [] });
      if (restEncoded === lastRestEncoded && cursor.size !== lastAuditCursor.size) {
        const delta = await readAuditDelta(opts.projectRoot, lastAuditCursor);
        broadcast(`event: audit-delta\ndata: ${JSON.stringify({ events: delta.events, cursor: delta.cursor })}\n\n`);
      }
      lastEncoded = encoded;
      lastRestEncoded = restEncoded;
      lastAuditCursor = cursor;
      broadcast(`event: state\ndata: ${encoded}\n\n`);
    } catch {
      broadcast(`: ping\n\n`);
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, pollMs);
  timer.unref?.();

  if (host === EXPOSE_BIND) {
    warn(
      "WARNING: --expose binds 0.0.0.0 (all interfaces). Write token is not in GET HTML; printed on stderr.",
    );
  }
  warn(`Write token: ${token}`);

  if (occupy) {
    try {
      await claimServeSlot({
        projectRoot: opts.projectRoot,
        port: boundPort,
        bind: host,
        mcpHttp,
        token,
      });
    } catch (err) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((closeErr) => (closeErr ? reject(closeErr) : resolve()));
      });
      throw err;
    }
  }

  if (opts.open) {
    (opts.openBrowser ?? openBrowser)(url);
  }

  return {
    url,
    host: boundHost === "::" ? host : boundHost,
    port: boundPort,
    token,
    webmcp,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await opts.onClose?.();
      for (const client of sseClients) {
        try {
          client.res.end();
        } catch {
          // already closed
        }
        try {
          client.res.destroy();
        } catch {
          // already destroyed
        }
      }
      sseClients.clear();
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (occupy) await removeOwnServeFile(opts.projectRoot, process.pid);
    },
  };
}

export async function resolveDashboardListen(
  projectRoot: string,
  flags: { port?: number; expose?: boolean },
): Promise<{ host: string; port: number }> {
  const store = createLegionStore(projectRoot);
  const config = await readOptionalConfig(store);
  return {
    host: flags.expose ? EXPOSE_BIND : LOOPBACK_BIND,
    port: flags.port ?? config?.dashboard.port ?? DEFAULT_DASHBOARD_PORT,
  };
}
