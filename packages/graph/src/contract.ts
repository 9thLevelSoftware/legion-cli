import { isConcretePosixRepoRelativePath, type Task } from "@9thlevelsoftware/legion-cli-schema";

/** Implicit FileContract denylist. Never allowed, even if listed in filesAllowed. */
export const DEFAULT_FILES_FORBIDDEN = [
  ".git/**",
  ".legion-cli/config.yaml",
  ".legion-cli/index/**",
  ".env",
  ".env.*",
] as const;

export function filesAllowedFailsPlan(filesAllowed: readonly string[]): boolean {
  return filesAllowed.length === 0 || filesAllowed.some((path) => !isConcretePosixRepoRelativePath(path));
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
