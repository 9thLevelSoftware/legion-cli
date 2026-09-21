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
    run: "legion-cli intent",
    hint: "interview me about the product.",
  },
  intent_draft: {
    run: "legion-cli intent",
    hint: "finish the interview (two questions at a time).",
  },
  intent_ready: {
    run: "legion-cli discuss",
    hint: "capture decisions before we plan.",
  },
  discussing: {
    run: "legion-cli spec",
    hint: "write the short contract + wireframes.",
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
    run: "legion-cli execute",
    hint: "do the next ready task.",
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

export type NextContext = {
  mode?: "greenfield" | "brownfield";
  controlMode?: ControlMode;
  /** The newest brownfield run that has not completed, when there is one. */
  brownfieldRun?: { runId: string; phase: string } | null;
};

/** The one exit from a blocked task (KD-5). `next` names it so the board is never a dead end. */
export function blockedP0(slice: readonly Task[]): Task | undefined {
  return (
    slice.find((task) => task.status === "blocked" && task.priority === "P0") ??
    slice.find((task) => task.status === "blocked")
  );
}

export function nextCommand(
  state: StateFile,
  slice: readonly Task[],
  mode?: "greenfield" | "brownfield",
  controlMode?: ControlMode,
  ctx: Pick<NextContext, "brownfieldRun"> = {},
): NextCommand {
  // A brownfield run that never finished is the real next step, whatever the phase says.
  if (ctx.brownfieldRun) {
    return {
      run: `legion-cli brownfield --resume ${ctx.brownfieldRun.runId}`,
      hint: `finish the ${ctx.brownfieldRun.phase} phase of this audit (legion-cli intent turns its findings into a spec).`,
    };
  }
  if (state.phase === "initialized" && mode === "brownfield") {
    return { run: "legion-cli brownfield", hint: "audit this running app (code is evidence)." };
  }
  // A blocked P0 stops the slice: recommend the retry rather than an execute that refuses.
  if (state.phase === "executing" || state.phase === "plan_ready") {
    const blocked = slice.find((task) => task.status === "blocked" && task.priority === "P0");
    if (blocked && !slice.some((task) => task.status === "ready" && task.priority === "P0")) {
      return {
        run: `legion-cli task retry ${blocked.id}`,
        hint: `${blocked.id} is blocked; inspect the quarantine (legion-cli doctor), then retry it.`,
      };
    }
  }
  if (state.phase === "executing" && isSliceTerminal(slice)) {
    if (state.lastReview === "PASS") {
      return { run: "legion-cli qa", hint: "score the product (the slice is done)." };
    }
    return { run: "legion-cli review", hint: "spec-level review; fix tasks or in-place rewrites mean FAIL and re-review." };
  }
  const wouldExecute =
    state.phase === "plan_ready" || (state.phase === "executing" && !isSliceTerminal(slice));
  if (controlMode === "advisory" && wouldExecute) {
    return {
      run: "legion-cli control-mode guarded",
      hint: "advisory blocks execute; set guarded to run tasks.",
    };
  }
  return NEXT_BY_PHASE[state.phase];
}

export function statusExitCode(
  lastReadiness: Readiness | null | undefined,
  slice: readonly Task[],
): number {
  if (slice.some((task) => task.status === "blocked")) return 2;
  if (lastReadiness === "FAIL") return 1;
  return 0;
}

export type Blocker = {
  kind: "task" | "readiness" | "review";
  id?: string;
  detail: string;
};

export function collectBlockers(
  lastReadiness: Readiness | null | undefined,
  lastReview: ReviewVerdict | null | undefined,
  slice: readonly Task[],
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
