import dns from "node:dns/promises";
import type { HttpAdapterConfig } from "@9thlevelsoftware/legion-cli-schema";
import { HttpAdapterError } from "./errors.js";
import type { SsrfLookup } from "./types.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const PRIVATE_HOSTS = new Set(["localhost", "metadata.google.internal"]);

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

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
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
  if ((first & 0xffc0) === 0xfe80) return true;
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

export function isLoopbackHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(unwrapped);
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
