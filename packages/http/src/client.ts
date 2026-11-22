import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { HttpAdapterError } from "./errors.js";
import { isLoopbackHttpHost, resolveHttpConnectTarget } from "./ssrf.js";
import type { SsrfLookup } from "./types.js";

export const HTTP_CALL_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;
const MAX_RETRY_AFTER_MS = 5_000;
const DEFAULT_TRANSIENT_RETRIES = 2;
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

type HttpHeaders = Record<string, string | string[] | undefined>;

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

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

function header(headers: HttpHeaders, name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

function sanitizeHttpErrorDetail(bytes: Buffer, apiKey: string): string {
  let text = bytes.subarray(0, MAX_ERROR_BODY_BYTES).toString("utf8");
  if (apiKey) text = text.replaceAll(apiKey, "[REDACTED]");
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|xai|key|ghp|AKIA)[A-Za-z0-9_-]{6,}\b/g, "[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|token|secret|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[REDACTED]")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 512 ? `${text.slice(0, 512)}...` : text;
}

function retryAfterMs(headers: HttpHeaders, attempt: number): number {
  const raw = header(headers, "retry-after").trim();
  if (raw) {
    if (/^\d+(?:\.\d+)?$/.test(raw)) {
      return Math.min(Math.max(0, Math.round(Number(raw) * 1000)), MAX_RETRY_AFTER_MS);
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return Math.min(Math.max(0, parsed - Date.now()), MAX_RETRY_AFTER_MS);
    }
  }
  return Math.min(250 * 2 ** attempt, MAX_RETRY_AFTER_MS);
}

class TransientHttpError extends Error {
  readonly waitMs: number;
  constructor(message: string, waitMs: number) {
    super(message);
    this.waitMs = waitMs;
  }
}

async function postJsonPinnedOnce(opts: {
  url: URL;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  payload: Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
  allowLoopback: boolean;
  lookup?: SsrfLookup;
  captureStatus?: boolean;
  rawResponse?: boolean;
  allowTransientRetry: boolean;
  attempt: number;
}): Promise<{ status: number; json: unknown; responseBytes: Uint8Array; responseDigest: string }> {
  if (opts.signal?.aborted) {
    throw new HttpAdapterError("adapter.http request aborted");
  }
  const pinned = await resolveHttpConnectTarget(opts.url, opts.allowLoopback, opts.lookup);
  if (opts.signal?.aborted) {
    throw new HttpAdapterError("adapter.http request aborted");
  }
  const headers: Record<string, string> = {
    Host: opts.url.host,
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
    "Content-Length": String(opts.payload.length),
    Accept: "application/json",
    "User-Agent": "legion-cli-http",
  };
  for (const [key, value] of Object.entries(opts.extraHeaders ?? {})) {
    if (["authorization", "x-api-key"].includes(key.toLowerCase())) continue;
    headers[key] = value;
  }

  const isHttps = opts.url.protocol === "https:";
  const requestFn = isHttps ? https.request : http.request;
  const path = `${opts.url.pathname}${opts.url.search}`;
  const port = opts.url.port ? Number(opts.url.port) : isHttps ? 443 : 80;

  return new Promise((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    };
    const settleResolve = (value: { status: number; json: unknown; responseBytes: Uint8Array; responseDigest: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const req = requestFn(
      {
        host: isLoopbackHttpHost(opts.url.hostname) ? pinned.address : opts.url.hostname,
        servername: isHttps ? opts.url.hostname : undefined,
        port,
        path,
        method: "POST",
        family: pinned.family,
        autoSelectFamily: false,
        headers,
        lookup: pinnedLookup(pinned.address, pinned.family),
      } as https.RequestOptions,
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          req.destroy();
          const location = header(res.headers as HttpHeaders, "location");
          settleReject(
            new HttpAdapterError(
              `adapter.http refused redirect HTTP ${status}${location ? ` to ${location}` : ""}`,
            ),
          );
          return;
        }
        const isErrorBody = !opts.captureStatus && (status < 200 || status >= 300);
        const chunks: Buffer[] = [];
        let size = 0;
        let errorBytes = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (isErrorBody) {
            if (errorBytes < MAX_ERROR_BODY_BYTES) {
              const take = chunk.subarray(0, MAX_ERROR_BODY_BYTES - errorBytes);
              chunks.push(take);
              errorBytes += take.length;
            }
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy();
              settleReject(new HttpAdapterError("adapter.http response exceeded size cap"));
            }
            return;
          }
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy();
            settleReject(new HttpAdapterError("adapter.http response exceeded size cap"));
          } else {
            chunks.push(chunk);
          }
        });
        res.on("error", settleReject);
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          if (isErrorBody) {
            const detail = sanitizeHttpErrorDetail(bytes, opts.apiKey);
            const message = `adapter.http returned HTTP ${status}${detail ? `: ${detail}` : ""}`;
            if (opts.allowTransientRetry && TRANSIENT_STATUSES.has(status)) {
              settleReject(new TransientHttpError(message, retryAfterMs(res.headers as HttpHeaders, opts.attempt)));
              return;
            }
            settleReject(new HttpAdapterError(message));
            return;
          }
          const responseDigest = createHash("sha256").update(bytes).digest("hex");
          if (opts.rawResponse) {
            settleResolve({ status, json: null, responseBytes: bytes, responseDigest });
            return;
          }
          const raw = bytes.toString("utf8");
          try {
            settleResolve({ status, json: raw ? JSON.parse(raw) : {}, responseBytes: bytes, responseDigest });
          } catch (err) {
            settleReject(new HttpAdapterError("adapter.http response is not JSON", { cause: err }));
          }
        });
        res.on("close", () => {
          if (!settled && !res.complete) {
            settleReject(new HttpAdapterError("adapter.http response closed prematurely"));
          }
        });
      },
    );
    onAbort = () => {
      req.destroy();
      settleReject(new HttpAdapterError("adapter.http request aborted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy();
      settleReject(new HttpAdapterError("adapter.http request timed out"));
    });
    req.on("error", settleReject);
    req.write(opts.payload);
    req.end();
  });
}

export async function postJsonPinned(opts: {
  url: URL;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  body?: unknown;
  serializedBody?: Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowLoopback: boolean;
  lookup?: SsrfLookup;
  captureStatus?: boolean;
  rawResponse?: boolean;
  retryTransient?: boolean | number;
}): Promise<{ status: number; json: unknown; responseBytes: Uint8Array; responseDigest: string }> {
  const timeoutMs = opts.timeoutMs ?? HTTP_CALL_TIMEOUT_MS;
  const payload =
    opts.serializedBody === undefined
      ? Buffer.from(JSON.stringify(opts.body), "utf8")
      : Buffer.from(opts.serializedBody);
  const maxRetries = opts.captureStatus
    ? 0
    : typeof opts.retryTransient === "number"
      ? Math.max(0, Math.floor(opts.retryTransient))
      : opts.retryTransient
        ? DEFAULT_TRANSIENT_RETRIES
        : 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await postJsonPinnedOnce({
        url: opts.url,
        apiKey: opts.apiKey,
        extraHeaders: opts.extraHeaders,
        payload,
        timeoutMs,
        signal: opts.signal,
        allowLoopback: opts.allowLoopback,
        lookup: opts.lookup,
        captureStatus: opts.captureStatus,
        rawResponse: opts.rawResponse,
        allowTransientRetry: attempt < maxRetries,
        attempt,
      });
    } catch (err) {
      if (!(err instanceof TransientHttpError)) throw err;
      if (attempt >= maxRetries) throw new HttpAdapterError(err.message);
      try {
        await delay(err.waitMs, undefined, opts.signal ? { signal: opts.signal } : undefined);
      } catch {
        throw new HttpAdapterError("adapter.http request aborted");
      }
    }
  }
}
