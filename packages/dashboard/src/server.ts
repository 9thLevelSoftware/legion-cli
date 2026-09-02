import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  createLegionStore,
  PathEscapeError,
  toFsPath,
} from "@9thlevelsoftware/legion-cli-persist";
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
  WEBMCP_SCRIPT,
  WEBMCP_SCRIPT_PATH,
  webmcpHeaders,
} from "./webmcp.js";

const ALLOW_METHODS = "GET, HEAD, OPTIONS";
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";
const CSP_WEBMCP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

export type DashboardOptions = {
  projectRoot: string;
  host?: string;
  port?: number;
  open?: boolean;
  openBrowser?: (url: string) => void;
  warn?: (message: string) => void;
  pollMs?: number;
};

export type DashboardHandle = {
  url: string;
  host: string;
  port: number;
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

function setSecurityHeaders(
  res: ServerResponse,
  origin: string | undefined,
  webmcp: boolean,
): void {
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
    res.setHeader("Access-Control-Allow-Methods", "GET");
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  headOnly: boolean,
  origin: string | undefined,
  webmcp: boolean,
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

function methodNotAllowed(
  res: ServerResponse,
  origin: string | undefined,
  webmcp: boolean,
): void {
  setSecurityHeaders(res, origin, webmcp);
  res.statusCode = 405;
  res.setHeader("Allow", ALLOW_METHODS);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Method Not Allowed\n");
}

async function serveWireframe(
  projectRoot: string,
  specId: string,
  fileName: string,
  res: ServerResponse,
  headOnly: boolean,
  origin: string | undefined,
  webmcp: boolean,
): Promise<void> {
  const base = basename(fileName);
  if (base !== fileName || fileName.includes("\\") || fileName.includes("\0")) {
    send(res, 404, renderNotFound("unknown wireframe", { webmcp }), "text/html; charset=utf-8", headOnly, origin, webmcp);
    return;
  }
  const storePath = `.legion-cli/specs/${specId}/wireframes/${base}`;
  try {
    const abs = toFsPath(projectRoot, storePath);
    const body = await readFile(abs, "utf8");
    send(res, 200, body, contentTypeFor(base), headOnly, origin, webmcp);
  } catch (err) {
    if (err instanceof PathEscapeError || (err as NodeJS.ErrnoException).code === "ENOENT") {
      send(res, 404, renderNotFound("unknown wireframe", { webmcp }), "text/html; charset=utf-8", headOnly, origin, webmcp);
      return;
    }
    throw err;
  }
}

export async function startDashboard(opts: DashboardOptions): Promise<DashboardHandle> {
  const host = opts.host ?? LOOPBACK_BIND;
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const pollMs = opts.pollMs ?? 1000;
  const warn = opts.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  if (host === EXPOSE_BIND) {
    warn("WARNING: --expose binds 0.0.0.0 (all interfaces)");
  }

  const sseClients = new Set<SseClient>();
  let lastEncoded = "";
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
    const store = createLegionStore(opts.projectRoot);
    const config = await readOptionalConfig(store);
    const webmcp = config?.flags.webmcp === true;
    const htmlOpts = { webmcp };
    if (!allowed) {
      setSecurityHeaders(res, undefined, webmcp);
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden origin\n");
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") {
      setSecurityHeaders(res, cors, webmcp);
      res.statusCode = 204;
      res.setHeader("Allow", ALLOW_METHODS);
      res.end();
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      methodNotAllowed(res, cors, webmcp);
      return;
    }
    const headOnly = method === "HEAD";
    const url = new URL(req.url ?? "/", `http://${hostHeader ?? `${host}:${boundPort}`}`);
    const pathname = decodeURIComponent(url.pathname);

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
      send(res, 200, renderKanban(snapshot, htmlOpts), "text/html; charset=utf-8", headOnly, cors, webmcp);
      return;
    }
    if (pathname === "/spec") {
      send(res, 200, renderSpec(snapshot, htmlOpts), "text/html; charset=utf-8", headOnly, cors, webmcp);
      return;
    }
    if (pathname === "/graph") {
      send(res, 200, renderGraph(snapshot, htmlOpts), "text/html; charset=utf-8", headOnly, cors, webmcp);
      return;
    }
    if (pathname === "/audit") {
      send(res, 200, renderAudit(snapshot, htmlOpts), "text/html; charset=utf-8", headOnly, cors, webmcp);
      return;
    }
    if (pathname === "/api/state") {
      send(res, 200, `${JSON.stringify(snapshot)}\n`, "application/json; charset=utf-8", headOnly, cors, webmcp);
      return;
    }
    if (pathname.startsWith("/spec/wireframes/")) {
      const fileName = pathname.slice("/spec/wireframes/".length);
      const specId = snapshot.activeSpecId;
      if (!specId || !fileName) {
        send(res, 404, renderNotFound("unknown wireframe", htmlOpts), "text/html; charset=utf-8", headOnly, cors, webmcp);
        return;
      }
      await serveWireframe(opts.projectRoot, specId, fileName, res, headOnly, cors, webmcp);
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
      send(res, 200, renderWikiIndex(pages, htmlOpts), "text/html; charset=utf-8", headOnly, cors, webmcp);
      return;
    }
    if (pathname.startsWith("/wiki/")) {
      const pageRef = pathname.slice("/wiki/".length);
      if (!pageRef || pageRef.includes("\0")) {
        send(res, 404, renderNotFound("unknown page", htmlOpts), "text/html; charset=utf-8", headOnly, cors, webmcp);
        return;
      }
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
        send(res, 200, renderWikiPage(shown, links, htmlOpts), "text/html; charset=utf-8", headOnly, cors, webmcp);
      } catch (err) {
        if (err instanceof PathEscapeError) {
          send(res, 404, renderNotFound("unknown page", htmlOpts), "text/html; charset=utf-8", headOnly, cors, webmcp);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        send(res, 404, renderNotFound(message, htmlOpts), "text/html; charset=utf-8", headOnly, cors, webmcp);
      }
      return;
    }

    send(res, 404, renderNotFound("unknown route", htmlOpts), "text/html; charset=utf-8", headOnly, cors, webmcp);
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

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const addr = server.address();
  boundPort = typeof addr === "object" && addr ? addr.port : port;
  const boundHost = typeof addr === "object" && addr ? addr.address : host;
  const url = `http://127.0.0.1:${boundPort}`;

  const tick = async (): Promise<void> => {
    if (closed || sseClients.size === 0) return;
    try {
      const snapshot = await loadSnapshot(opts.projectRoot);
      const encoded = JSON.stringify(snapshot);
      if (encoded !== lastEncoded) {
        lastEncoded = encoded;
        broadcast(`event: state\ndata: ${encoded}\n\n`);
      } else {
        broadcast(`: ping\n\n`);
      }
    } catch {
      broadcast(`: ping\n\n`);
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, pollMs);
  timer.unref?.();

  if (opts.open) {
    (opts.openBrowser ?? openBrowser)(url);
  }

  return {
    url,
    host: boundHost === "::" ? host : boundHost,
    port: boundPort,
    close: async () => {
      closed = true;
      clearInterval(timer);
      for (const client of sseClients) {
        try {
          client.res.end();
        } catch {
          // already closed
        }
      }
      sseClients.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
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
