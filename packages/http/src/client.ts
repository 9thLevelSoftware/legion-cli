import http from "node:http";
import https from "node:https";
import { HttpAdapterError } from "./errors.js";
import { isLoopbackHttpHost, resolveHttpConnectTarget } from "./ssrf.js";
import type { SsrfLookup } from "./types.js";

export const HTTP_CALL_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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

export async function postJsonPinned(opts: {
  url: URL;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowLoopback: boolean;
  lookup?: SsrfLookup;
}): Promise<{ status: number; json: unknown }> {
  if (opts.signal?.aborted) {
    throw new HttpAdapterError("adapter.http request aborted");
  }
  const timeoutMs = opts.timeoutMs ?? HTTP_CALL_TIMEOUT_MS;
  const pinned = await resolveHttpConnectTarget(opts.url, opts.allowLoopback, opts.lookup);
  if (opts.signal?.aborted) {
    throw new HttpAdapterError("adapter.http request aborted");
  }
  const payload = Buffer.from(JSON.stringify(opts.body), "utf8");
  const headers: Record<string, string> = {
    Host: opts.url.host,
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
    "Content-Length": String(payload.length),
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
          reject(
            new HttpAdapterError(
              `adapter.http refused redirect HTTP ${status}${location ? ` to ${location}` : ""}`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy();
            reject(new HttpAdapterError("adapter.http response exceeded size cap"));
          } else {
            chunks.push(chunk);
          }
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            reject(new HttpAdapterError(`adapter.http returned HTTP ${status}`));
            return;
          }
          try {
            resolve({ status, json: raw ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(new HttpAdapterError("adapter.http response is not JSON", { cause: err }));
          }
        });
      },
    );
    const onAbort = () => {
      req.destroy();
      reject(new HttpAdapterError("adapter.http request aborted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new HttpAdapterError("adapter.http request timed out"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
