import { PathEscapeError, resolveProjectPath, toProjectRelativePosix } from "@9thlevelsoftware/legion-cli-persist";
import { HINT, refuse } from "./errors.js";

const PRIVATE_HOSTS = new Set(["localhost", "metadata.google.internal"]);

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
  if (a === 172 && b >= 16 && b <= 31) return true;
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

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
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

function fileUrlToPath(source: string): string {
  const url = new URL(source);
  let pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
  return pathname;
}

export function assertIngestSourceAllowed(projectRoot: string, source: string): void {
  if (!isUrlSource(source)) return;

  if (/^http:/i.test(source)) {
    refuse("ingest refuses http: URLs", HINT.inRepo);
  }

  if (/^file:/i.test(source)) {
    try {
      const abs = resolveProjectPath(projectRoot, fileUrlToPath(source));
      toProjectRelativePosix(projectRoot, abs);
    } catch (err) {
      if (err instanceof PathEscapeError) {
        refuse("ingest of file: outside the workspace is refused", HINT.inRepo);
      }
      refuse("ingest of file: outside the workspace is refused", HINT.inRepo);
    }
    return;
  }

  let hostname = "";
  try {
    hostname = new URL(source).hostname;
  } catch {
    refuse("ingest refuses invalid URL", HINT.inRepo);
  }
  if (isPrivateOrLocalHost(hostname)) {
    refuse("ingest of private-network URL is refused", HINT.inRepo);
  }
}
