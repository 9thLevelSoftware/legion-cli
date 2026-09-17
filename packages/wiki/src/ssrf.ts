import {
  fetchPublicHttpsPinned,
  MAX_INGEST_FILE_BYTES,
  type SsrfLookup,
} from "@9thlevelsoftware/legion-cli-persist";

export {
  isPrivateOrLocalHost,
  resolvePublicAddress,
  SsrfError,
  type SsrfLookup,
} from "@9thlevelsoftware/legion-cli-persist";

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

type Fetched = { body: string; finalUrl: string; contentType: string; status: number };

/** UTF-8 wiki ingest wrapper over persist pinning. http: redirects still upgrade. */
export async function fetchPublicHttps(
  source: string,
  opts?: { maxBytes?: number; timeoutMs?: number; lookup?: SsrfLookup },
): Promise<Fetched> {
  const fetched = await fetchPublicHttpsPinned(source, {
    maxBytes: opts?.maxBytes ?? MAX_INGEST_FILE_BYTES,
    timeoutMs: opts?.timeoutMs,
    accept: "text/*, application/json, application/xml",
    lookup: opts?.lookup,
    httpRedirect: "upgrade",
  });
  return {
    body: fetched.body.toString("utf8"),
    finalUrl: fetched.finalUrl,
    contentType: fetched.contentType,
    status: fetched.status,
  };
}
