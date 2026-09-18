import { isConcretePosixRepoRelativePath, type Task } from "@9thlevelsoftware/legion-cli-schema";

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

/** Plan-time FileContract SoT (KD-11 gate 1). Tasks do not own `.legion-cli/**`. */
export function isEngineSoTPath(posixPath: string): boolean {
  return posixPath === ".legion-cli" || posixPath.startsWith(".legion-cli/");
}

/** Plan-time FileContract denylist. Broader than DEFAULT_FILES_FORBIDDEN. */
export function isImplicitForbiddenPath(posixPath: string): boolean {
  if (posixPath === ".git" || posixPath.startsWith(".git/")) return true;
  if (isEngineSoTPath(posixPath)) return true;
  if (
    posixPath.split("/").some((part) => {
      const lower = part.toLowerCase();
      return lower === ".env" || lower.startsWith(".env.");
    })
  ) {
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

/** expectedArtifacts is a subset of filesAllowed (same concrete + SoT checks). */
export function expectedArtifactsFailsPlan(
  filesAllowed: readonly string[],
  expectedArtifacts: readonly string[],
): boolean {
  const allowed = new Set(filesAllowed);
  return expectedArtifacts.some(
    (path) => !isConcretePosixRepoRelativePath(path) || isImplicitForbiddenPath(path) || !allowed.has(path),
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
  const owners = new Map<string, string>();
  const overlaps: string[] = [];
  for (const task of tasks) {
    for (const path of task.contract.filesAllowed) {
      const previous = owners.get(path);
      if (previous && previous !== task.id) {
        overlaps.push(`${path} (${previous}, ${task.id})`);
      } else {
        owners.set(path, task.id);
      }
    }
  }
  return overlaps;
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
