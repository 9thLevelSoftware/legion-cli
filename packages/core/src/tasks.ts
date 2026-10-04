import { type TaskStatus } from "@9thlevelsoftware/legion-cli-schema";
import { canTransitionTaskStatus } from "@9thlevelsoftware/legion-cli-schema";
import { refuse } from "./errors.js";

/**
 * todo → ready → in_progress → verifying → done → compacted
 *                  ↘ blocked
 * ready → todo when amend/assume invalidates graph-ready (KD-10).
 */
export function assertTaskStatusTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTaskStatus(from, to)) {
    refuse(`cannot move task from ${from} to ${to}`, "legion-cli status --blockers");
  }
}
