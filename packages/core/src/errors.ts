export class LegionRefuseError extends Error {
  readonly nextHint: string;

  constructor(message: string, nextHint: string) {
    super(message);
    this.name = "LegionRefuseError";
    this.nextHint = nextHint;
  }
}

export const HINT = {
  init: "legion-cli init",
  spec: "legion-cli spec or legion-cli spec approve",
  specApprove: "legion-cli spec approve",
  plan: "legion-cli plan",
  planRetry: "fix the FAIL list, then legion-cli plan",
  blockers: "legion-cli status --blockers",
  advisory: "legion-cli",
  execute: "legion-cli next / legion-cli execute",
  review: "legion-cli review",
  qa: "legion-cli qa",
  specNew: "legion-cli spec new",
  concretePaths: "concrete paths",
  inRepo: "in-repo path",
  noCommit: "legion-cli ingest --no-commit",
  show: "legion-cli show <page>",
  controlMode: "guarded or surgical",
  greenfield: "greenfield, or wait for v1",
  ticket: (taskId: string) => `legion-cli ticket create --parent ${taskId}`,
} as const;

export function refuse(message: string, nextHint: string): never {
  throw new LegionRefuseError(message, nextHint);
}
