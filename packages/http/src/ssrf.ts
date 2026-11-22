import dns from "node:dns/promises";
import { isPrivateOrLocalHost, type HttpAdapterConfig } from "@9thlevelsoftware/legion-cli-schema";
import { HttpAdapterError } from "./errors.js";
import type { SsrfLookup } from "./types.js";

const LOOPBACK_HOSTS = new Set(["localhost", "localhost."]);

async function defaultLookup(hostname: string): Promise<{ address: string; family: number }> {
  return dns.lookup(hostname, { all: false });
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
}

function ipv6Words(host: string): number[] | null {
  let h = normalizeHost(host);
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (dotted?.[1]) {
    const v4 = ipv4Octets(dotted[1]);
    if (!v4) return null;
    const hex = (a: number, b: number) => ((a << 8) | b).toString(16);
    h = `${h.slice(0, -dotted[1].length)}${hex(v4[0]!, v4[1]!)}:${hex(v4[2]!, v4[3]!)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const words = part.split(":").map((w) => (/^[0-9a-f]{1,4}$/.test(w) ? Number.parseInt(w, 16) : Number.NaN));
    return words.some(Number.isNaN) ? null : words;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

export { isPrivateOrLocalHost };

export function isLoopbackHttpHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (LOOPBACK_HOSTS.has(host)) return true;
  const v4 = ipv4Octets(host);
  if (v4) return v4[0] === 127;
  const words = ipv6Words(host);
  if (!words) return false;
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;
  // Anchored IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::/96) only.
  if (words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0)) {
    return ((words[6]! >> 8) & 255) === 127;
  }
  return false;
}

export function parseHttpBaseUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new HttpAdapterError("adapter.http.baseUrl must be a URL");
  }
  if (parsed.username || parsed.password) {
    throw new HttpAdapterError("adapter.http.baseUrl cannot include userinfo");
  }
  return parsed;
}

/** Sync doctor/detect gate. DNS pinning happens at request time. */
export function assertHttpBaseUrlAllowed(config: Pick<HttpAdapterConfig, "baseUrl" | "allowLoopback">): URL {
  const parsed = parseHttpBaseUrl(config.baseUrl);
  if (isLoopbackHttpHost(parsed.hostname)) {
    if (!config.allowLoopback) {
      throw new HttpAdapterError("adapter.http.baseUrl loopback requires allowLoopback");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new HttpAdapterError("adapter.http.baseUrl must be https: (http: loopback only with allowLoopback)");
    }
    return parsed;
  }
  if (parsed.protocol !== "https:") {
    throw new HttpAdapterError("adapter.http.baseUrl must be https: (http: loopback only with allowLoopback)");
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    throw new HttpAdapterError("adapter.http.baseUrl is not a public HTTPS URL");
  }
  return parsed;
}

export async function resolvePublicAddress(
  hostname: string,
  lookupFn: SsrfLookup = defaultLookup,
): Promise<{ address: string; family: number }> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isPrivateOrLocalHost(host)) {
    throw new HttpAdapterError("adapter.http.baseUrl is not a public HTTPS URL");
  }
  const resolved = await lookupFn(host);
  if (isPrivateOrLocalHost(resolved.address)) {
    throw new HttpAdapterError("adapter.http.baseUrl resolved to a private address");
  }
  return resolved;
}

export function loopbackConnectTarget(hostname: string): { address: string; family: number } {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "::1") return { address: "::1", family: 6 };
  return { address: "127.0.0.1", family: 4 };
}

export async function resolveHttpConnectTarget(
  url: URL,
  allowLoopback: boolean,
  lookupFn: SsrfLookup = defaultLookup,
): Promise<{ address: string; family: number }> {
  assertHttpBaseUrlAllowed({ baseUrl: url.toString(), allowLoopback });
  if (allowLoopback && isLoopbackHttpHost(url.hostname)) {
    return loopbackConnectTarget(url.hostname);
  }
  return resolvePublicAddress(url.hostname, lookupFn);
}

export function httpAdapterNotReadyReason(
  config: HttpAdapterConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!config) return "adapter.http is not configured";
  if (!config.model.trim()) return "adapter.http.model is empty";
  const key = env[config.apiKeyEnv];
  if (!key || !key.trim()) {
    return `adapter.http.apiKeyEnv ${config.apiKeyEnv} is unset or empty`;
  }
  try {
    assertHttpBaseUrlAllowed(config);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

export function isHttpAdapterReady(
  config: HttpAdapterConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return httpAdapterNotReadyReason(config, env) === null;
}
