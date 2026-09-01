import type { Task } from "@9thlevelsoftware/legion-cli-schema";
import { isTerminalTaskStatus, OPEN_TASK_STATUSES } from "./tasks.js";

/** Slice (v0) = every task whose specId matches STATE.activeSpecId. */
export function sliceTasks(tasks: readonly Task[], activeSpecId: string | null | undefined): Task[] {
  if (!activeSpecId) return [];
  return tasks.filter((task) => task.specId === activeSpecId).sort((a, b) => a.id.localeCompare(b.id));
}

export function isSliceTerminal(tasks: readonly Task[]): boolean {
  return tasks.length > 0 && tasks.every((task) => isTerminalTaskStatus(task.status));
}

export function sliceHasOpenWork(tasks: readonly Task[]): boolean {
  return tasks.some((task) => (OPEN_TASK_STATUSES as readonly string[]).includes(task.status));
}

export function p0TasksNotDone(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => task.priority === "P0" && task.status !== "done");
}
