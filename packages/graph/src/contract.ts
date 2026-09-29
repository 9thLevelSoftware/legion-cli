import {
  isConcretePosixRepoRelativePath,
  normalizePathKey,
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

/** Plan-time FileContract SoT (KD-11 gate 1). Tasks do not own `.legion-cli/**`. */
export function isEngineSoTPath(posixPath: string): boolean {
  return posixPath === ".legion-cli" || posixPath.startsWith(".legion-cli/");
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

/** expectedArtifacts is a subset of filesAllowed (same concrete + SoT checks). */
export function expectedArtifactsFailsPlan(
  filesAllowed: readonly string[],
  expectedArtifacts: readonly string[],
): boolean {
  const allowed = new Set(filesAllowed.map(normalizePathKey));
  return expectedArtifacts.some(
    (path) =>
      !isConcretePosixRepoRelativePath(path) ||
      isImplicitForbiddenPath(path) ||
      !allowed.has(normalizePathKey(path)),
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
  // Keys are normalised, and a path also overlaps any directory prefix or descendant another
  // task owns (`src` vs `src/a.ts`).
  const owners = new Map<string, string>();
  const descendants = new Map<string, string>();
  const overlaps: string[] = [];
  for (const task of tasks) {
    for (const path of task.contract.filesAllowed) {
      const key = normalizePathKey(path);
      const parts = key.split("/");
      const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
      const previous =
        [key, ...ancestors].map((k) => owners.get(k)).find((o) => o !== undefined && o !== task.id) ??
        (descendants.get(key) !== task.id ? descendants.get(key) : undefined);
      if (previous) {
        overlaps.push(`${path} (${previous}, ${task.id})`);
        continue;
      }
      owners.set(key, task.id);
      for (const ancestor of ancestors) descendants.set(ancestor, task.id);
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
