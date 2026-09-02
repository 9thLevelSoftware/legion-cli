import type { Assumption, ControlMode, Phase, Priority, Task } from "@9thlevelsoftware/legion-cli-schema";
import { filesAllowedFailsPlan } from "./contract.js";

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };

const SPEC_WIDE_CREATED_IN = new Set(["intent", "discuss", "spec", "plan"]);

export type ReadyContext = {
  phase: Phase;
  controlMode: ControlMode;
  tasks: readonly Task[];
  assumptions?: readonly Assumption[];
};

function byId(tasks: readonly Task[]): Map<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

function isDoneForDeps(task: Task | undefined): boolean {
  if (!task) return false;
  return task.status === "done" || task.status === "compacted";
}

/** Ancestors via blockedBy, including the task itself. */
export function dependencySubgraph(task: Task, tasks: readonly Task[]): Set<string> {
  const index = byId(tasks);
  const out = new Set<string>();
  const stack = [task.id];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || out.has(id)) continue;
    out.add(id);
    const node = index.get(id);
    if (!node) continue;
    for (const parent of node.blockedBy) stack.push(parent);
  }
  return out;
}

export function unresolvedBlockers(task: Task, tasks: readonly Task[]): string[] {
  const index = byId(tasks);
  return task.blockedBy.filter((id) => !isDoneForDeps(index.get(id)));
}

function hasOpenBlockingAssumption(task: Task, ctx: ReadyContext): boolean {
  const assumptions = ctx.assumptions ?? [];
  if (assumptions.length === 0) return false;
  const subgraph = dependencySubgraph(task, ctx.tasks);
  return assumptions.some((assumption) => {
    if (!assumption.blocking || assumption.status !== "open") return false;
    if (assumption.escalatesTo !== "user") return false;
    if (SPEC_WIDE_CREATED_IN.has(assumption.createdIn)) return true;
    if (assumption.createdIn === task.specId) return true;
    return subgraph.has(assumption.createdIn);
  });
}

/**
 * §4.1: a task is ready iff deps are done, the contract is valid, the phase
 * allows execute, control mode is not advisory, and v0 is serial.
 */
export function isTaskReady(task: Task, ctx: ReadyContext): boolean {
  if (ctx.phase !== "plan_ready" && ctx.phase !== "executing") return false;
  if (ctx.controlMode === "advisory") return false;
  if (task.status !== "todo" && task.status !== "ready") return false;
  if (task.contract.verificationCommands.length < 1) return false;
  if (filesAllowedFailsPlan(task.contract.filesAllowed)) return false;
  if (unresolvedBlockers(task, ctx.tasks).length > 0) return false;
  if (hasOpenBlockingAssumption(task, ctx)) return false;
  if (ctx.tasks.some((other) => other.status === "in_progress" && other.id !== task.id)) {
    return false;
  }
  return true;
}

export function compareReadyOrder(a: Task, b: Task): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  return a.id.localeCompare(b.id);
}

/** Ready tasks, P0 then oldest id. */
export function readyTasks(ctx: ReadyContext): Task[] {
  return ctx.tasks.filter((task) => isTaskReady(task, ctx)).sort(compareReadyOrder);
}

export function pickNextTask(ctx: ReadyContext): Task | undefined {
  return readyTasks(ctx)[0];
}
