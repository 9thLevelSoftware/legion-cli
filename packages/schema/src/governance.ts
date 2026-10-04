import { PhaseSchema, TaskStatusSchema, type Phase, type TaskStatus } from "./versions.js";
import { GovernanceProjectionSchema, type GovernanceAction, type GovernanceFrame, type GovernanceProjection } from "./governance-records.js";
import { normalizePathKey } from "./paths.js";

export const LEGAL_PHASE_TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  uninitialized: ["initialized"],
  initialized: ["intent_draft"],
  intent_draft: ["intent_ready"],
  intent_ready: ["discussing"],
  discussing: ["spec_draft"],
  spec_draft: ["spec_frozen"],
  spec_frozen: ["planning", "abandoned"],
  planning: ["plan_failed", "plan_ready", "abandoned"],
  plan_failed: ["spec_draft", "planning", "abandoned"],
  plan_ready: ["executing", "abandoned"],
  executing: ["executing", "ready_to_ship", "shipped", "abandoned"],
  ready_to_ship: ["shipped", "executing", "abandoned"],
  shipped: ["intent_draft"],
  abandoned: ["intent_draft"],
};

export const UNDO_ONLY_PHASE_TRANSITIONS: Readonly<Partial<Record<Phase, readonly Phase[]>>> = {
  shipped: ["executing"],
};

/** The one edge `ship-rollback` may write: a ship that failed after recording `shipped`. */
export const SHIP_ROLLBACK_PHASE_TRANSITIONS: Readonly<Partial<Record<Phase, readonly Phase[]>>> = {
  shipped: ["ready_to_ship", "executing"],
};

export const LEGAL_TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ["ready", "blocked"],
  ready: ["in_progress", "blocked", "todo"],
  in_progress: ["verifying", "blocked"],
  verifying: ["done", "blocked"],
  blocked: ["todo", "ready"],
  done: ["compacted", "todo"],
  compacted: [],
};

export const OPEN_TASK_STATUSES = ["todo", "ready", "in_progress", "verifying"] as const;

export function canTransition(from: Phase, to: Phase): boolean {
  return LEGAL_PHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return LEGAL_TASK_TRANSITIONS[from].includes(to);
}

export function statusAfterUndoDependency(from: TaskStatus): TaskStatus | null {
  if (from === "ready") return "todo";
  if (from === "in_progress" || from === "verifying") return "blocked";
  return null;
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "done" || status === "blocked" || status === "compacted";
}

export function validateGovernancePhase(value: string): Phase | null {
  const parsed = PhaseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function validateGovernanceTaskStatus(value: string): TaskStatus | null {
  const parsed = TaskStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function validateGovernanceProjection(value: unknown) {
  return GovernanceProjectionSchema.safeParse(value);
}

/**
 * Write-scope overlap: keys are normalised, and a path also overlaps any directory prefix or
 * descendant another entry owns (`src` vs `src/a.ts`). owners: exact key -> every entry that lists
 * it. below: directory key -> every entry that owns something under it. Both hold all owners, so
 * the result does not depend on path order.
 */
export function overlappingWritePaths(entries: readonly { id: string; paths: readonly string[] }[]): string[] {
  const owners = new Map<string, Set<string>>();
  const below = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, id: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(id);
    map.set(key, set);
  };
  const overlaps: string[] = [];
  for (const entry of entries) {
    for (const path of entry.paths) {
      const key = normalizePathKey(path);
      const parts = key.split("/");
      const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
      const others = new Set<string>();
      for (const k of [key, ...ancestors]) for (const o of owners.get(k) ?? []) others.add(o);
      for (const o of below.get(key) ?? []) others.add(o);
      others.delete(entry.id);
      for (const other of [...others].sort()) overlaps.push(`${path} (${other}, ${entry.id})`);
      add(owners, key, entry.id);
      for (const ancestor of ancestors) add(below, ancestor, entry.id);
    }
  }
  return overlaps;
}

export function governanceOutcomeBlocks(outcome: GovernanceFrame["outcome"]): boolean {
  return outcome === "failed" || outcome === "incomplete";
}

export type GovernanceViolationCode =
  | "advisory-execution" | "duplicate-claim" | "overlapping-active-writes" | "completion-without-checks"
  | "stale-authority-use" | "implicit-retry" | "preview-mismatch" | "rollback-claims-delivery"
  | "illegal-phase-transition" | "illegal-task-transition" | "refused-changed-state";
export type GovernanceViolation = { sequence: number; code: GovernanceViolationCode; detail: string };

const ACTIVE_TASK_STATUSES: Readonly<Partial<Record<TaskStatus, true>>> = { in_progress: true, verifying: true };
const AUTHORITY_ACTIONS: Readonly<Partial<Record<GovernanceAction, true>>> = {
  "task-start": true, "integration-start": true, "review-start": true, "acceptance-record": true,
  "ship-prepare": true, "ship-confirm": true, "ship-complete": true,
};

/** Structural JSON equality, independent of key order (projections are parsed JSON). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, i) => sameJson(item, other[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

/**
 * Semantic rules over a chain-valid frame sequence. Each end frame is paired with its begin by
 * `correlationId`; rules read the begin's `before` and the end's `after`. Returns every violation
 * in frame order; an empty array means the trace obeys the governance boundary model.
 */
export function validateGovernanceFrames(frames: readonly GovernanceFrame[]): GovernanceViolation[] {
  const violations: GovernanceViolation[] = [];
  const begins = new Map<string, GovernanceFrame>();
  const traceHasPrepare = frames.some((frame) => frame.action === "ship-prepare");
  let prepared: GovernanceProjection["ship"] | undefined;
  for (const frame of frames) {
    if (frame.boundary === "begin") {
      begins.set(frame.correlationId, frame);
      continue;
    }
    const begin = begins.get(frame.correlationId);
    begins.delete(frame.correlationId);
    const after = frame.after;
    if (!begin || !after) continue;
    const before = begin.before;
    const { action, outcome, sequence } = frame;
    const success = outcome === "success";
    const add = (code: GovernanceViolationCode, detail: string) => violations.push({ sequence, code, detail });
    const active = after.tasks.filter((task) => ACTIVE_TASK_STATUSES[task.status]);
    const priorStatus = new Map(before.tasks.map((task) => [task.id, task.status]));

    if (after.controlMode === "advisory" && active.length) add("advisory-execution", `${action} left active tasks under advisory control: ${active.map((task) => task.id).join(", ")}`);
    if (action === "task-start" && success && before.controlMode === "advisory") add("advisory-execution", "task-start succeeded under advisory control");

    if (action === "claim-acquire" && success && before.claim.liveness === "live" && after.claim.owner !== before.claim.owner) add("duplicate-claim", "claim-acquire replaced a live claim owner");

    const overlaps = overlappingWritePaths(active.map((task) => ({ id: task.id, paths: task.writes })));
    if (overlaps.length) add("overlapping-active-writes", `active tasks overlap: ${overlaps.join("; ")}`);

    if (action === "task-complete" && success) {
      for (const task of after.tasks) {
        const from = priorStatus.get(task.id);
        if (task.status === "done" && from !== "done" && from !== "verifying") add("completion-without-checks", `${task.id} completed from ${from ?? "absent"} without verification`);
      }
    }
    const shipped = success && before.phase !== "shipped" && after.phase === "shipped";
    if (shipped && (before.integration !== "passed" || before.review !== "passed" || before.components.some((component) => component.status !== "passed"))) {
      add("completion-without-checks", `${action} reached shipped without passed integration, components, and review`);
    }

    if (success && AUTHORITY_ACTIONS[action] && before.approval.freshness !== "current") add("stale-authority-use", `${action} used ${before.approval.freshness} approval authority`);
    if (action === "acceptance-record" && success && (before.integration !== "passed" || before.review !== "passed")) add("stale-authority-use", "acceptance recorded without passed integration and review");
    if (shipped && (action === "ship-confirm" || action === "ship-complete") && before.acceptance.some((entry) => entry.status !== "passed" || entry.freshness !== "current")) {
      add("stale-authority-use", `${action} reached shipped without current passed acceptance`);
    }

    if ((success || outcome === "failed") && !(begin.explicitRetry && frame.explicitRetry)) {
      if (action === "integration-start" && (before.integration === "failed" || before.components.some((component) => component.status === "failed"))) add("implicit-retry", "integration-start reran failed checks without explicit retry");
      if (action === "review-start" && before.review === "failed") add("implicit-retry", "review-start reran a failed review without explicit retry");
    }

    if (action === "ship-prepare" && success) prepared = after.ship;
    if (success && (action === "ship-confirm" || (action === "ship-complete" && traceHasPrepare))) {
      if (!prepared) add("preview-mismatch", `${action} has no prepared preview`);
      else if (action === "ship-confirm" && !after.ship.confirmed) add("preview-mismatch", "ship-confirm did not record confirmation");
      else if (after.ship.confirmationId !== prepared.confirmationId || after.ship.previewFingerprint !== prepared.previewFingerprint) add("preview-mismatch", `${action} changed the prepared preview`);
    }

    if (action === "ship-rollback" && success && (after.ship.status === "complete" || after.phase === "shipped")) add("rollback-claims-delivery", "ship-rollback still claims a completed delivery");

    if (success && before.phase !== after.phase && !canTransition(before.phase, after.phase) &&
        !(action === "undo" && UNDO_ONLY_PHASE_TRANSITIONS[before.phase]?.includes(after.phase)) &&
        !(action === "ship-rollback" && SHIP_ROLLBACK_PHASE_TRANSITIONS[before.phase]?.includes(after.phase))) {
      add("illegal-phase-transition", `${action} moved phase ${before.phase} -> ${after.phase}`);
    }

    for (const task of after.tasks) {
      const from = priorStatus.get(task.id);
      if (from === undefined || from === task.status || canTransitionTaskStatus(from, task.status)) continue;
      if (action === "undo" && statusAfterUndoDependency(from) === task.status) continue;
      // Starting an eligible todo task walks todo -> ready -> in_progress inside one task-start boundary.
      if (action === "task-start" && from === "todo" && task.status === "in_progress") continue;
      add("illegal-task-transition", `${action} moved ${task.id} ${from} -> ${task.status}`);
    }

    if (outcome === "refused" && !sameJson(before, after)) add("refused-changed-state", `${action} was refused after changing governed state`);
  }
  return violations;
}
