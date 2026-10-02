import {
  isSliceTerminal,
  type Phase,
  type Task,
} from "@9thlevelsoftware/legion-cli-core";
import {
  ADAPTER_ID_HELP,
  type ControlMode,
  type Readiness,
  type ReviewVerdict,
  type StateFile,
} from "@9thlevelsoftware/legion-cli-schema";

export type NextCommand = {
  run: string;
  hint: string;
};

export const ADVISORY_EXECUTION_NEXT: NextCommand = {
  run: "legion-cli control-mode guarded",
  hint: "advisory blocks execute; set guarded to run tasks.",
};

export function formatReadyTaskLine(
  task: Pick<Task, "id" | "title" | "priority"> & { adapter?: string },
): string {
  const adapterBit = task.adapter ? `  ${task.adapter}` : "";
  return `  ${task.id}  ${task.title}  ${task.priority}${adapterBit}`;
}

const NEXT_BY_PHASE: Record<Phase, NextCommand> = {
  uninitialized: {
    run: `legion-cli init --name <product> --adapter ${ADAPTER_ID_HELP}`,
    hint: "start a product in this folder.",
  },
  initialized: {
    run: "legion-cli spec",
    hint: "capture the problem and write an approvable spec.",
  },
  intent_draft: {
    run: "legion-cli spec",
    hint: "continue the product conversation and draft the spec.",
  },
  intent_ready: {
    run: "legion-cli spec",
    hint: "record the remaining decisions and draft the spec.",
  },
  discussing: {
    run: "legion-cli spec",
    hint: "write the short contract.",
  },
  spec_draft: {
    run: "legion-cli spec approve",
    hint: "freeze the spec.",
  },
  spec_frozen: {
    run: "legion-cli plan",
    hint: "break into tasks I can see on the board.",
  },
  planning: {
    run: "legion-cli plan",
    hint: "finish planning.",
  },
  plan_failed: {
    run: "legion-cli plan",
    hint: "fix the FAIL list, then plan again.",
  },
  plan_ready: {
    run: "legion-cli plan approve",
    hint: "approve this implementation plan before execution.",
  },
  executing: {
    run: "legion-cli execute",
    hint: "do the next ready task.",
  },
  ready_to_ship: {
    run: "legion-cli ship",
    hint: "final human review; stage the diff.",
  },
  shipped: {
    run: "legion-cli spec new",
    hint: "start the next increment.",
  },
  abandoned: {
    run: "legion-cli spec new",
    hint: "this spec was abandoned.",
  },
};

export type StatusSliceTask = Pick<Task, "id" | "title" | "status">;

export function nextCommand(
  state: StateFile,
  slice: readonly StatusSliceTask[],
  mode?: "greenfield" | "brownfield",
  controlMode?: ControlMode,
): NextCommand {
  if (controlMode === "advisory" && (state.phase === "plan_ready" || state.phase === "executing")) {
    return ADVISORY_EXECUTION_NEXT;
  }
  if (state.phase === "executing" && isSliceTerminal(slice)) {
    return { run: "legion-cli execute", hint: "finish workflow verification and record acceptance evidence." };
  }
  return NEXT_BY_PHASE[state.phase];
}

export function statusExitCode(
  lastReadiness: Readiness | null | undefined,
  slice: readonly StatusSliceTask[],
): number {
  if (slice.some((task) => task.status === "blocked")) return 2;
  if (lastReadiness === "FAIL") return 1;
  return 0;
}

export type Blocker = {
  kind: "task" | "readiness" | "review" | "workflow" | "audit";
  id?: string;
  detail: string;
};

export function collectBlockers(
  lastReadiness: Readiness | null | undefined,
  lastReview: ReviewVerdict | null | undefined,
  slice: readonly StatusSliceTask[],
): Blocker[] {
  const blockers: Blocker[] = [];
  if (lastReadiness === "FAIL") {
    blockers.push({ kind: "readiness", detail: "readiness FAIL" });
  }
  if (lastReview === "FAIL") {
    blockers.push({ kind: "review", detail: "lastReview FAIL" });
  }
  for (const task of slice) {
    if (task.status === "blocked") {
      blockers.push({ kind: "task", id: task.id, detail: `${task.id} blocked  ${task.title}` });
    }
  }
  return blockers;
}
