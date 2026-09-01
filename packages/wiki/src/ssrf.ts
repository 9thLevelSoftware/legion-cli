import { lookup } from "node:dns/promises";
import https from "node:https";
import { MAX_INGEST_FILE_BYTES } from "@9thlevelsoftware/legion-cli-persist";

const PRIVATE_HOSTS = new Set(["localhost", "metadata.google.internal"]);
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("fe80:") || h.startsWith("fe80::")) return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

function stripMappedIpv6(host: string): string {
  const h = host.toLowerCase();
  if (h.startsWith("::ffff:")) return h.slice("::ffff:".length);
  return host;
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = stripMappedIpv6(hostname.replace(/^\[|\]$/g, "")).toLowerCase();
  if (PRIVATE_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const ipv4 = ipv4Octets(host);
  if (ipv4) return isPrivateIPv4(ipv4);
  if (host.includes(":")) return isPrivateIPv6(host);
  return false;
}

export function isUrlSource(source: string): boolean {
  return /^(https?|file):/i.test(source);
}

export function isGithubSource(source: string): boolean {
  return /^github:/i.test(source);
}

export function fileUrlToPath(source: string): string {
  const url = new URL(source);
  let pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
  return pathname;
}

export async function resolvePublicAddress(
  hostname: string,
): Promise<{ address: string; family: number }> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isPrivateOrLocalHost(host)) {
    throw new SsrfError("ingest of private-network URL is refused");
  }
  const resolved = await lookup(host, { all: false });
  if (isPrivateOrLocalHost(resolved.address)) {
    throw new SsrfError("ingest of private-network URL is refused");
  }
  return resolved;
}

function assertHttpsUrl(source: string): URL {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new SsrfError("ingest refuses invalid URL");
  }
  if (url.protocol === "http:") {
    throw new SsrfError("ingest refuses http: URLs");
  }
  if (url.protocol !== "https:") {
    throw new SsrfError("ingest refuses invalid URL");
  }
  return url;
}

type Fetched = { body: string; finalUrl: string; contentType: string; status: number };

async function httpsGetPinned(
  url: URL,
  address: string,
  family: number,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ status: number; headers: httpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: url.hostname,
        servername: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Host: url.host,
          "User-Agent": "legion-cli",
          Accept: "text/*, application/json, application/xml",
        },
        lookup(_hostname, _options, callback) {
          callback(null, address, family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new SsrfError("ingest URL exceeded size cap"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as httpHeaders,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new SsrfError("ingest URL timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

type httpHeaders = Record<string, string | string[] | undefined>;

function header(headers: httpHeaders, name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

export async function fetchPublicHttps(
  source: string,
  opts?: { maxBytes?: number; timeoutMs?: number },
): Promise<Fetched> {
  const maxBytes = opts?.maxBytes ?? MAX_INGEST_FILE_BYTES;
  const timeoutMs = opts?.timeoutMs ?? FETCH_TIMEOUT_MS;
  let current = assertHttpsUrl(source);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const pinned = await resolvePublicAddress(current.hostname);
    const res = await httpsGetPinned(current, pinned.address, pinned.family, maxBytes, timeoutMs);
    if (res.status >= 300 && res.status < 400) {
      const location = header(res.headers, "location");
      if (!location) throw new SsrfError("ingest URL redirect missing Location");
      const next = new URL(location, current);
      if (next.protocol === "http:") {
        next.protocol = "https:";
      }
      if (next.protocol !== "https:") {
        throw new SsrfError("ingest refuses http: URLs");
      }
      current = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new SsrfError(`ingest URL returned HTTP ${res.status}`);
    }
    return {
      body: res.body.toString("utf8"),
      finalUrl: current.toString(),
      contentType: header(res.headers, "content-type"),
      status: res.status,
    };
  }
  throw new SsrfError("ingest URL exceeded redirect limit");
}
