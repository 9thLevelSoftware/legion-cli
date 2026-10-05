import {
  isConcretePosixRepoRelativePath,
  normalizePathKey,
  overlappingWritePaths,
  type Task,
} from "@9thlevelsoftware/legion-cli-schema";

/**
 * Revert-safe implicit denylist (KD-11 gate 3). Merged into filesForbidden.
 * Do **not** put engine SoT (STATE.md, tasks/*.md) here — plan/review/verify
 * must still persist TSK-*.md under SkillContract.allowedRoots.
 */
export const DEFAULT_FILES_FORBIDDEN = [
  ".git/**",
  ".legion-cli/config.yaml",
  ".legion-cli/index/**",
  ".env",
  ".env.*",
] as const;

/** Plan-time FileContract SoT (KD-11 gate 1). Tasks do not own `.legion-cli/**` (normalised form). */
export function isEngineSoTPath(posixPath: string): boolean {
  const key = normalizePathKey(posixPath);
  return key === ".legion-cli" || key.startsWith(".legion-cli/");
}

/** Plan-time FileContract denylist. Broader than DEFAULT_FILES_FORBIDDEN. */
export function isImplicitForbiddenPath(posixPath: string): boolean {
  // Compare the normalised form: NTFS ignores case and trailing dots/spaces, and 8.3 names alias.
  const key = normalizePathKey(posixPath);
  const segments = key.split("/");
  const first = segments[0] ?? "";
  if (first === ".git" || /^git~\d+$/.test(first)) return true;
  if (segments.some((part) => part === ".git" || /^git~\d+$/.test(part))) return true;
  if (isEngineSoTPath(key) || /^legion~\d+$/.test(first)) return true;
  if (segments.some((part) => part === ".env" || part.startsWith(".env.") || /^env~\d+(\.|$)/.test(part))) {
    return true;
  }
  return false;
}

export function filesAllowedFailsPlan(filesAllowed: readonly string[]): boolean {
  return (
    filesAllowed.length === 0 ||
    filesAllowed.some((path) => !isConcretePosixRepoRelativePath(path) || isImplicitForbiddenPath(path))
  );
}

/**
 * Allow-side key, as in core's `allowKey`: only as loose as the filesystem. The subset check is
 * an allow, so folding case or trailing dots on Linux would admit a path the contract never named.
 */
function allowKey(path: string): string {
  if (process.platform === "win32") return normalizePathKey(path);
  if (process.platform === "darwin") return path.toLowerCase();
  return path;
}

/** expectedArtifacts is a subset of filesAllowed (same concrete + SoT checks). */
export function expectedArtifactsFailsPlan(
  filesAllowed: readonly string[],
  expectedArtifacts: readonly string[],
): boolean {
  const allowed = new Set(filesAllowed.map(allowKey));
  return expectedArtifacts.some(
    (path) =>
      !isConcretePosixRepoRelativePath(path) ||
      isImplicitForbiddenPath(path) ||
      !allowed.has(allowKey(path)),
  );
}

export function fileContractFailsPlan(
  filesAllowed: readonly string[],
  expectedArtifacts: readonly string[],
): boolean {
  return filesAllowedFailsPlan(filesAllowed) || expectedArtifactsFailsPlan(filesAllowed, expectedArtifacts);
}

/** v0 serial exclusive: two tasks must not share a filesAllowed path. */
export function overlappingFilesAllowed(tasks: readonly Task[]): string[] {
  return overlappingWritePaths(tasks.map((t) => ({ id: t.id, paths: t.contract.filesAllowed })));
}

export function mergeFilesForbidden(filesForbidden: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of [...DEFAULT_FILES_FORBIDDEN, ...filesForbidden]) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}
