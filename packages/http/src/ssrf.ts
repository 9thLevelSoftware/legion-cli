import dns from "node:dns/promises";
import { isPrivateOrLocalHost, type HttpAdapterConfig } from "@9thlevelsoftware/legion-cli-schema";
import { HttpAdapterError } from "./errors.js";
import type { SsrfLookup } from "./types.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

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

function hextetsToIpv4(hiHex: string, loHex: string): number[] {
  const hi = Number.parseInt(hiHex, 16);
  const lo = Number.parseInt(loHex, 16);
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
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

export { isPrivateOrLocalHost };

export function isLoopbackHttpHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (LOOPBACK_HOSTS.has(host)) return true;
  const embedded = embeddedIpv4(host);
  return embedded?.[0] === 127;
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
