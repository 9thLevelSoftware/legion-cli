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
  doctor: "legion-cli doctor",
  amend: "legion-cli task amend",
  blockers: "legion-cli status --blockers",
  advisory: "legion-cli",
  execute: "legion-cli next / legion-cli execute",
  verify: "legion-cli verify",
  review: "legion-cli review",
  qa: "legion-cli qa",
  qaChecklist: "legion-cli qa checklist",
  fix: "legion-cli fix <bug>",
  degradedQa: "legion-cli ship --allow-degraded-qa",
  ship: "legion-cli ship",
  shipCommit: "git repository required for --commit/--pr",
  shipPr: "install GitHub CLI (gh)",
  shipPrRetry: "legion-cli ship --pr --commit",
  abandon: "legion-cli abandon --message",
  specNew: "legion-cli spec new",
  intent: "legion-cli intent",
  discuss: "legion-cli discuss",
  intentConfirm: "confirm the printed intent brief (Y)",
  skipWireframes: "--skip-wireframes is pre-approve only",
  concretePaths: "concrete paths",
  inRepo: "in-repo path",
  noCommit: "legion-cli ingest --no-commit",
  show: "legion-cli show <page>",
  controlMode: "guarded or surgical",
  greenfield: "greenfield, or wait for v1",
  designGenerate: "legion-cli design-system generate",
  initMode: "legion-cli init --mode greenfield|brownfield",
  brownfield: "legion-cli brownfield --effort 1",
  brownfieldResume: "legion-cli brownfield --resume <id>",
  promote: "legion-cli run promote <id>",
  gitRepo: "git init (brownfield requires a git repository)",
  ticket: (taskId: string) => `legion-cli ticket create --parent ${taskId}`,
  packet: "legion-cli packet new --title <title>",
  packetRespond: (id = "<id>") => `legion-cli packet respond ${id}`,
} as const;

export function refuseKind(nextHint: string): string {
  const match = /legion-cli\s+([a-z0-9-]+)/i.exec(nextHint);
  if (match?.[1]) return match[1];
  if (/concrete paths/i.test(nextHint)) return "plan";
  if (/in-repo path/i.test(nextHint)) return "ingest";
  if (/greenfield/i.test(nextHint)) return "init";
  if (/guarded or surgical/i.test(nextHint)) return "control-mode";
  if (nextHint.trim() === "legion-cli") return "status";
  return "other";
}

export function refuse(message: string, nextHint: string): never {
  throw new LegionRefuseError(message, nextHint);
}
