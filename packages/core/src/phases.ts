import { PhaseSchema, type Phase } from "@9thlevelsoftware/legion-cli-schema";
import { HINT, refuse } from "./errors.js";

/** CONCERNS is lastReadiness on plan_ready, not a phase. */
export const PHASES: readonly Phase[] = PhaseSchema.options;

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
  executing: ["executing", "ready_to_ship", "abandoned"],
  ready_to_ship: ["shipped", "executing", "abandoned"],
  shipped: ["intent_draft"],
  abandoned: [],
};

export function canTransition(from: Phase, to: Phase): boolean {
  return LEGAL_PHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertLegalPhase(phase: string): Phase {
  const parsed = PhaseSchema.safeParse(phase);
  if (!parsed.success) {
    refuse(`unknown phase ${phase}`, HINT.spec);
  }
  return parsed.data;
}

export function hintForIllegalTransition(from: Phase, to: Phase): string {
  if (to === "initialized") return HINT.init;
  if (to === "spec_frozen") return HINT.specApprove;
  if (to === "planning" || to === "plan_ready" || to === "plan_failed") return HINT.plan;
  if (to === "executing") {
    return from === "plan_failed" ? HINT.planRetry : HINT.plan;
  }
  if (to === "ready_to_ship") return HINT.qa;
  if (to === "shipped") return HINT.qa;
  if (to === "intent_draft" && from === "shipped") return HINT.specNew;
  return HINT.spec;
}

export function assertCanTransition(from: Phase, to: Phase): void {
  if (from === to && to === "executing") return;
  if (!canTransition(from, to)) {
    refuse(`cannot transition from ${from} to ${to}`, hintForIllegalTransition(from, to));
  }
}
