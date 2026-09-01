import { toPosixPath } from "@9thlevelsoftware/legion-cli-persist";
import type { FileContract } from "@9thlevelsoftware/legion-cli-schema";

function posixify(path: string): string {
  return toPosixPath(path).replace(/^\.\/+/, "");
}

function looksLikeSshKey(posix: string): boolean {
  const lower = posix.toLowerCase();
  if (lower.includes("/.ssh/") || lower.startsWith(".ssh/") || lower.includes(".ssh/")) return true;
  if (/(^|\/)id_rsa(\.pub)?$/.test(lower)) return true;
  if (/(^|\/)id_ed25519(\.pub)?$/.test(lower)) return true;
  if (/(^|\/)authorized_keys$/.test(lower)) return true;
  return false;
}

function looksLikeGitPath(posix: string): boolean {
  return posix === ".git" || posix.startsWith(".git/") || posix.split("/").includes(".git");
}

function looksLikeEnv(posix: string): boolean {
  const base = posix.split("/").pop() ?? posix;
  return base === ".env" || base.startsWith(".env.");
}

function looksLikeIndexOrConfig(posix: string): boolean {
  return (
    posix === ".legion-cli/config.yaml" ||
    posix === ".legion-cli/index" ||
    posix.startsWith(".legion-cli/index/")
  );
}

/** Paths FileContract must refuse even if an ingested page asks for them. */
export function isForbiddenSpawnPath(path: string, contract?: FileContract): boolean {
  const raw = path.trim();
  if (raw.length === 0) return true;
  if (raw.startsWith("~") || raw.includes("~")) return true;
  const posix = posixify(raw);
  if (posix.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(posix)) return true;
  if (looksLikeGitPath(posix)) return true;
  if (looksLikeSshKey(posix) || looksLikeSshKey(raw.replaceAll("\\", "/"))) return true;
  if (looksLikeEnv(posix)) return true;
  if (looksLikeIndexOrConfig(posix)) return true;

  if (contract) {
    const allowed = new Set([...contract.filesAllowed, ...contract.expectedArtifacts]);
    if (!allowed.has(posix)) return true;
  }
  return false;
}

export function assertSpawnPathAllowed(path: string, contract?: FileContract): void {
  if (isForbiddenSpawnPath(path, contract)) {
    throw new Error(`FileContract refuses path: ${path}`);
  }
}
