import dns from "node:dns/promises";
import https from "node:https";
import { MAX_ZIPBALL_BYTES } from "./layout.js";

/** Single-address lookup so fetch never happy-eyeballs to a second IP. */
export type SsrfLookup = (hostname: string) => Promise<{ address: string; family: number }>;

async function defaultLookup(hostname: string): Promise<{ address: string; family: number }> {
  return dns.lookup(hostname, { all: false });
}

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
  // RFC 6598 shared address space (CGNAT), including Alibaba 100.100.100.200 IMDS
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  return false;
}

function hextetsToIpv4(hiHex: string, loHex: string): number[] {
  const hi = Number.parseInt(hiHex, 16);
  const lo = Number.parseInt(loHex, 16);
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** IPv4-mapped (::ffff:…) and IPv4-compatible (::x:x / ::d.d.d.d) embed an IPv4 address. */
function embeddedIpv4(host: string): number[] | null {
  const h = normalizeHost(host);
  const mappedDotted = /(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(h);
  if (mappedDotted?.[1]) return ipv4Octets(mappedDotted[1]);
  const mappedHex = /(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (mappedHex?.[1] && mappedHex[2]) return hextetsToIpv4(mappedHex[1], mappedHex[2]);
  const compatDotted = /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (compatDotted?.[1]) return ipv4Octets(compatDotted[1]);
  const compatHex = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (compatHex?.[1] && compatHex[2]) return hextetsToIpv4(compatHex[1], compatHex[2]);
  return null;
}

function firstHextet(host: string): number | null {
  const h = normalizeHost(host);
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return 0;
  const head = h.split(":")[0] ?? "";
  if (head === "") return 0;
  if (!/^[0-9a-f]{1,4}$/i.test(head)) return null;
  return Number.parseInt(head, 16);
}

function isUnspecifiedIPv6(host: string): boolean {
  const h = normalizeHost(host);
  if (h === "::" || h === "::0") return true;
  return /^(0+:){7}0+$/.test(h);
}

function isPrivateIPv6(host: string): boolean {
  const h = normalizeHost(host);
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (isUnspecifiedIPv6(h)) return true;
  const first = firstHextet(h);
  if (first === null) return false;
  // fe80::/10 link-local (not merely the fe80: prefix)
  if ((first & 0xffc0) === 0xfe80) return true;
  // fc00::/7 unique local
  if ((first & 0xfe00) === 0xfc00) return true;
  return false;
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (PRIVATE_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const mapped = embeddedIpv4(host);
  if (mapped) return isPrivateIPv4(mapped);
  const ipv4 = ipv4Octets(host);
  if (ipv4) return isPrivateIPv4(ipv4);
  if (host.includes(":")) return isPrivateIPv6(host);
  return false;
}

export async function resolvePublicAddress(
  hostname: string,
  lookupFn: SsrfLookup = defaultLookup,
): Promise<{ address: string; family: number }> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isPrivateOrLocalHost(host)) {
    throw new SsrfError("ingest of private-network URL is refused");
  }
  const resolved = await lookupFn(host);
  if (isPrivateOrLocalHost(resolved.address)) {
    throw new SsrfError("ingest of private-network URL is refused");
  }
  return resolved;
}

function assertNoUserinfo(url: URL): void {
  if (url.username !== "" || url.password !== "") {
    throw new SsrfError("fetch refuses URL userinfo");
  }
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
  assertNoUserinfo(url);
  return url;
}

function assertAllowlisted(hostname: string, allowlist: readonly string[] | undefined): void {
  if (!allowlist) return;
  const host = normalizeHost(hostname);
  if (!allowlist.some((allowed) => normalizeHost(allowed) === host)) {
    throw new SsrfError("fetch host is not allowlisted");
  }
}

export type FetchedBinary = {
  body: Buffer;
  finalUrl: string;
  contentType: string;
  status: number;
};

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/** Node 22+ https.request calls lookup with `{ all: true }`; honor that without a second address. */
function pinnedLookup(
  address: string,
  family: number,
): NonNullable<https.RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    const cb = (typeof options === "function" ? options : callback) as LookupCallback | undefined;
    if (!cb) return;
    const all = typeof options === "object" && options !== null && options.all === true;
    if (all) {
      cb(null, [{ address, family }]);
      return;
    }
    cb(null, address, family);
  };
}

type HttpHeaders = Record<string, string | string[] | undefined>;

function header(headers: HttpHeaders, name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

async function httpsGetPinned(
  url: URL,
  address: string,
  family: number,
  maxBytes: number,
  timeoutMs: number,
  accept: string,
): Promise<{ status: number; headers: HttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: url.hostname,
        servername: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        family,
        autoSelectFamily: false,
        headers: {
          Host: url.host,
          "User-Agent": "legion-cli",
          Accept: accept,
        },
        lookup: pinnedLookup(address, family),
      } as https.RequestOptions,
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
            headers: res.headers as HttpHeaders,
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

export type FetchPublicHttpsPinnedOpts = {
  maxBytes: number;
  timeoutMs?: number;
  accept: string;
  hostAllowlist?: readonly string[];
  lookup?: SsrfLookup;
  /** `upgrade` keeps wiki ingest's silent http:→https: redirect behavior. */
  httpRedirect: "refuse" | "upgrade";
};

export async function fetchPublicHttpsPinned(
  source: string,
  opts: FetchPublicHttpsPinnedOpts,
): Promise<FetchedBinary> {
  const maxBytes = opts.maxBytes;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const lookupFn = opts.lookup ?? defaultLookup;
  let current = assertHttpsUrl(source);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertNoUserinfo(current);
    assertAllowlisted(current.hostname, opts.hostAllowlist);
    const pinned = await resolvePublicAddress(current.hostname, lookupFn);
    const res = await httpsGetPinned(
      current,
      pinned.address,
      pinned.family,
      maxBytes,
      timeoutMs,
      opts.accept,
    );
    if (res.status >= 300 && res.status < 400) {
      const location = header(res.headers, "location");
      if (!location) throw new SsrfError("ingest URL redirect missing Location");
      const next = new URL(location, current);
      if (next.protocol === "http:") {
        if (opts.httpRedirect === "refuse") {
          throw new SsrfError("ingest refuses http: URLs");
        }
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
      body: res.body,
      finalUrl: current.toString(),
      contentType: header(res.headers, "content-type"),
      status: res.status,
    };
  }
  throw new SsrfError("ingest URL exceeded redirect limit");
}

export type FetchPublicHttpsBinaryOpts = {
  maxBytes: number;
  timeoutMs?: number;
  accept: "application/zip";
  hostAllowlist: readonly string[];
  lookup?: SsrfLookup;
};

export async function fetchPublicHttpsBinary(
  source: string,
  opts: FetchPublicHttpsBinaryOpts,
): Promise<FetchedBinary> {
  if (opts.accept !== "application/zip") {
    throw new SsrfError("binary fetch requires Accept: application/zip");
  }
  if (opts.hostAllowlist.length === 0) {
    throw new SsrfError("binary fetch requires a host allowlist");
  }
  return fetchPublicHttpsPinned(source, {
    maxBytes: Math.min(opts.maxBytes, MAX_ZIPBALL_BYTES),
    timeoutMs: opts.timeoutMs,
    accept: opts.accept,
    hostAllowlist: opts.hostAllowlist,
    lookup: opts.lookup,
    httpRedirect: "refuse",
  });
}


