const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"]);

export const DEFAULT_DASHBOARD_PORT = 7420;
export const LOOPBACK_BIND = "127.0.0.1";
export const EXPOSE_BIND = "0.0.0.0";

export function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(normalized);
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function stripHostPort(hostHeader: string): { hostname: string; port: string } {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    const hostname = end === -1 ? trimmed : trimmed.slice(1, end);
    const rest = end === -1 ? "" : trimmed.slice(end + 1);
    const port = rest.startsWith(":") ? rest.slice(1) : "";
    return { hostname, port };
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) return { hostname: trimmed, port: "" };
  return { hostname: trimmed.slice(0, idx), port: trimmed.slice(idx + 1) };
}

export function allowedLoopbackOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
}

function originPort(url: URL, fallback: number): number {
  if (url.port) return Number(url.port);
  if (url.protocol === "https:") return 443;
  if (url.protocol === "http:") return 80;
  return fallback;
}

/** GET/SSE only: loopback origins, or Host-matching origin when --expose. Never CORS *. */
export function originIsAllowed(input: {
  origin: string | undefined;
  hostHeader: string | undefined;
  bind: string;
  port: number;
}): boolean {
  const exposed = input.bind === EXPOSE_BIND;
  if (input.hostHeader) {
    const req = stripHostPort(input.hostHeader);
    if (!exposed && !isLoopbackHost(req.hostname)) return false;
  }

  const origin = input.origin?.trim();
  if (!origin) return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (originPort(url, input.port) !== input.port) return false;

  if (isLoopbackHost(url.hostname)) return true;
  if (!exposed) return false;
  if (!input.hostHeader) return false;

  const req = stripHostPort(input.hostHeader);
  const reqPort = req.port ? Number(req.port) : input.port;
  const originHost = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const reqHost = req.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return originHost === reqHost && reqPort === input.port;
}

export function echoAllowedOrigin(origin: string | undefined, allowed: boolean): string | undefined {
  if (!origin || !allowed) return undefined;
  if (origin === "*") return undefined;
  return origin;
}
