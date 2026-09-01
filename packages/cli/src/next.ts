import {
  isSliceTerminal,
  type Phase,
  type Task,
} from "@9thlevelsoftware/legion-cli-core";
import type { Readiness, ReviewVerdict, StateFile } from "@9thlevelsoftware/legion-cli-schema";

export type NextCommand = {
  run: string;
  hint: string;
};

const NEXT_BY_PHASE: Record<Phase, NextCommand> = {
  uninitialized: {
    run: "legion-cli init --name <product> --adapter claude|generic|fake",
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

export function nextCommand(state: StateFile, slice: readonly Task[]): NextCommand {
  if (state.phase === "executing" && isSliceTerminal(slice)) {
    if (state.lastReview === "PASS") {
      return { run: "legion-cli qa", hint: "score the product (the slice is done)." };
    }
    return { run: "legion-cli review", hint: "spec-level review; fix tasks mean FAIL and re-review." };
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
