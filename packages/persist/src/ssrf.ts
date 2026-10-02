import dns from "node:dns/promises";
import https from "node:https";
import { isPrivateOrLocalHost } from "@9thlevelsoftware/legion-cli-schema";
import { MAX_ZIPBALL_BYTES } from "./layout.js";

/** Single-address lookup so fetch never happy-eyeballs to a second IP. */
export type SsrfLookup = (hostname: string) => Promise<{ address: string; family: number }>;

async function defaultLookup(hostname: string): Promise<{ address: string; family: number }> {
  return dns.lookup(hostname, { all: false });
}

const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export { isPrivateOrLocalHost };

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
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


