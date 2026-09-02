import { type TaskStatus } from "@9thlevelsoftware/legion-cli-schema";
import { refuse } from "./errors.js";

/**
 * todo → ready → in_progress → verifying → done → compacted
 *                  ↘ blocked
 */
export const LEGAL_TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ["ready", "blocked"],
  ready: ["in_progress", "blocked"],
  in_progress: ["verifying", "blocked"],
  verifying: ["done", "blocked"],
  blocked: ["todo", "ready"],
  done: ["compacted"],
  compacted: [],
};

export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return LEGAL_TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskStatusTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTaskStatus(from, to)) {
    refuse(`cannot move task from ${from} to ${to}`, "legion-cli status --blockers");
  }
}

export const OPEN_TASK_STATUSES = ["todo", "ready", "in_progress", "verifying"] as const;

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "done" || status === "blocked" || status === "compacted";
}
