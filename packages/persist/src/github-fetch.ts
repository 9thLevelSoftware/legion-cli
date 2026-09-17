import { PersistError } from "./errors.js";
import { MAX_ZIPBALL_BYTES } from "./layout.js";
import {
  fetchPublicHttpsBinary,
  type FetchedBinary,
  type SsrfLookup,
} from "./ssrf.js";

const OWNER_REPO_PART = /^[A-Za-z0-9_.-]+$/;

export const GITHUB_ZIPBALL_HOSTS = [
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
] as const;

export type GithubRepoRef = {
  owner: string;
  repo: string;
  ref?: string;
};

export function parseGithubRepoSource(source: string): GithubRepoRef {
  const match = /^github:([^@]+)(?:@(.+))?$/i.exec(source.trim());
  if (!match) {
    throw new PersistError("github: source must be github:owner/repo[@ref]");
  }
  const spec = match[1] ?? "";
  const ref = match[2];
  const slash = spec.indexOf("/");
  if (slash <= 0 || spec.includes("/", slash + 1)) {
    throw new PersistError("github: source must be github:owner/repo[@ref]");
  }
  const owner = spec.slice(0, slash);
  const repo = spec.slice(slash + 1);
  if (!OWNER_REPO_PART.test(owner) || !OWNER_REPO_PART.test(repo)) {
    throw new PersistError("github: owner/repo must match [A-Za-z0-9_.-]+");
  }
  if (ref !== undefined && ref.length === 0) {
    throw new PersistError("github: zipball fetch requires @tag");
  }
  return { owner, repo, ref };
}

function encodeRefPath(ref: string): string {
  const segments = ref.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) {
    throw new PersistError("github: ref is invalid");
  }
  if (ref.includes("\\") || ref.includes("\0")) {
    throw new PersistError("github: ref is invalid");
  }
  return segments.map((part) => encodeURIComponent(part)).join("/");
}

export function githubZipballUrl(
  source: string | GithubRepoRef,
  opts?: { allowBranch?: boolean },
): string {
  const parsed = typeof source === "string" ? parseGithubRepoSource(source) : source;
  if (!parsed.ref) {
    throw new PersistError("github: zipball fetch requires @tag");
  }
  const kind = opts?.allowBranch ? "heads" : "tags";
  return `https://github.com/${parsed.owner}/${parsed.repo}/archive/refs/${kind}/${encodeRefPath(parsed.ref)}.zip`;
}

export async function fetchGithubZipball(
  source: string,
  opts?: {
    lookup?: SsrfLookup;
    allowBranch?: boolean;
    maxBytes?: number;
    timeoutMs?: number;
  },
): Promise<FetchedBinary> {
  const url = githubZipballUrl(source, { allowBranch: opts?.allowBranch });
  return fetchPublicHttpsBinary(url, {
    maxBytes: opts?.maxBytes ?? MAX_ZIPBALL_BYTES,
    timeoutMs: opts?.timeoutMs,
    accept: "application/zip",
    hostAllowlist: GITHUB_ZIPBALL_HOSTS,
    lookup: opts?.lookup,
  });
}
