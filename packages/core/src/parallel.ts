import type { FileContract, Task } from "@9thlevelsoftware/legion-cli-schema";

function ownedPaths(contract: FileContract): string[] {
  return [...new Set([...contract.filesAllowed, ...contract.expectedArtifacts])]
    .map((path) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase())
    .filter(Boolean)
    .sort();
}

function pathsConflict(left: string, right: string): boolean {
  if (left.includes("*") || right.includes("*")) return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function contractsAreDisjoint(left: FileContract, right: FileContract): boolean {
  const leftPaths = ownedPaths(left);
  const rightPaths = ownedPaths(right);
  return !leftPaths.some((a) => rightPaths.some((b) => pathsConflict(a, b)));
}

/** Stable greedy batch selection from an already readiness-sorted task list. */
export function selectParallelTasks(ready: readonly Task[], maxWorkers: number): Task[] {
  const limit = Math.max(1, Math.min(4, Math.trunc(maxWorkers)));
  const selected: Task[] = [];
  for (const task of ready) {
    if (selected.length >= limit) break;
    if (selected.every((other) => contractsAreDisjoint(other.contract, task.contract))) {
      selected.push(task);
    }
  }
  return selected;
}
