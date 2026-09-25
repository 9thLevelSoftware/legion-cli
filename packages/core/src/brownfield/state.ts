import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isGitRepo, runResumePath, type LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import {
  BrownfieldDagSchema,
  BrownfieldRunIdSchema,
  BrownfieldRunPhaseSchema,
  BrownfieldRunSchema,
  type BrownfieldRun,
  type BrownfieldRunPhase,
} from "@9thlevelsoftware/legion-cli-schema";
import { HINT, refuse } from "../errors.js";
import type { BrownfieldEffort } from "../types.js";
import { DAG_FILE, runAbs, storeAbs } from "./paths.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newRunId(): string {
  return randomBytes(4).toString("hex");
}

export function parseRunId(raw: string): string {
  const parsed = BrownfieldRunIdSchema.safeParse(String(raw ?? "").trim().toLowerCase());
  if (!parsed.success) {
    refuse("brownfield run id must be 8 hex chars", HINT.brownfieldResume);
  }
  return parsed.data;
}

export function parseEffort(raw: number | undefined, fallback: BrownfieldEffort = 2): BrownfieldEffort {
  const effort = raw ?? fallback;
  if (!Number.isInteger(effort) || effort < 1 || effort > 5) {
    refuse("brownfield --effort must be 1–5", HINT.brownfield);
  }
  return effort as BrownfieldEffort;
}

/** Refuse before `legion-cli init`, and outside a git repository. */
export async function assertBrownfieldReady(store: LegionStore, action = "brownfield"): Promise<void> {
  if (!(await store.pathExists(".legion-cli/STATE.md"))) {
    refuse(`${action} is refused until init`, HINT.init);
  }
  if (!isGitRepo(store.projectRoot)) {
    refuse(`${action} requires a git repository`, HINT.gitRepo);
  }
}

export async function readRun(store: LegionStore, runId: string): Promise<BrownfieldRun> {
  const storePath = runResumePath(runId);
  if (!(await store.pathExists(storePath))) {
    refuse(`brownfield run ${runId} not found`, HINT.brownfieldResume);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(storeAbs(store.projectRoot, storePath), "utf8"));
  } catch {
    refuse(`brownfield run ${runId}: resume.json is not valid JSON`, HINT.brownfieldResume);
  }
  const parsed = BrownfieldRunSchema.safeParse(raw);
  if (!parsed.success || parsed.data.runId !== runId) {
    refuse(`brownfield run ${runId}: resume.json failed schema validation`, HINT.brownfieldResume);
  }
  return parsed.data;
}

export async function writeRun(projectRoot: string, run: BrownfieldRun): Promise<BrownfieldRun> {
  const next = BrownfieldRunSchema.parse({ ...run, updatedAt: nowIso() });
  const abs = storeAbs(projectRoot, runResumePath(next.runId));
  if (existsSync(abs)) {
    let prev: BrownfieldRun;
    try {
      prev = BrownfieldRunSchema.parse(JSON.parse(await readFile(abs, "utf8")));
    } catch {
      refuse(`brownfield run ${next.runId}: resume.json is not valid JSON`, HINT.brownfieldResume);
    }
    assertBrownfieldCanTransition(prev.phase, next.phase, HINT.brownfieldState(next.runId));
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/** Parse `key=value` pairs. Values are JSON when they parse, else the raw string. */
export function parseKeyValuePairs(pairs: readonly string[], hint: string): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      refuse(`expected key=value, got ${JSON.stringify(pair)}`, hint);
    }
    const key = pair.slice(0, eq).trim();
    const rawValue = pair.slice(eq + 1);
    let value: unknown = rawValue;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }
    out.push([key, value]);
  }
  return out;
}

const SETTABLE_STATE_KEYS = new Set([
  "phase",
  "execute",
  "context",
  "designReviewRounds",
  "assumptionRounds",
  "baseBranch",
]);

/**
 * Documented skill loops (design ↔ review) and forward skips are legal.
 * complete can enter execute so pr-plan can start implementation after a finished audit.
 * execute/verify still need a design review (assertPhaseAllowed).
 */
export const LEGAL_BROWNFIELD_PHASE_TRANSITIONS: Readonly<
  Record<BrownfieldRunPhase, readonly BrownfieldRunPhase[]>
> = {
  intent: ["plan", "analysis", "assumptions", "design", "review", "present", "execute", "verify", "complete"],
  plan: ["intent", "analysis", "assumptions", "design", "review", "present", "execute", "verify", "complete"],
  analysis: ["intent", "plan", "assumptions", "design", "review", "present", "execute", "verify", "complete"],
  assumptions: ["intent", "plan", "analysis", "design", "review", "present", "execute", "verify", "complete"],
  design: ["intent", "plan", "analysis", "assumptions", "review", "present", "execute", "verify", "complete"],
  review: ["intent", "plan", "analysis", "assumptions", "design", "present", "execute", "verify", "complete"],
  present: ["intent", "plan", "analysis", "assumptions", "design", "review", "execute", "verify", "complete"],
  execute: ["intent", "plan", "analysis", "assumptions", "design", "review", "present", "verify", "complete"],
  verify: ["intent", "plan", "analysis", "assumptions", "design", "review", "present", "execute", "complete"],
  complete: ["execute"],
};

export function canTransitionBrownfield(from: BrownfieldRunPhase, to: BrownfieldRunPhase): boolean {
  if (from === to) return true;
  return LEGAL_BROWNFIELD_PHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertBrownfieldCanTransition(from: BrownfieldRunPhase, to: BrownfieldRunPhase, hint: string): void {
  if (!canTransitionBrownfield(from, to)) {
    refuse(`cannot transition brownfield from ${from} to ${to}`, hint);
  }
}

/** Apply `state <id> key=value` updates. Only whitelisted keys and `meta.<key>` are writable. */
export function applyStateSet(run: BrownfieldRun, pairs: [string, unknown][], hint: string): BrownfieldRun {
  const next: BrownfieldRun = { ...run, meta: { ...run.meta } };
  for (const [key, value] of pairs) {
    if (key.startsWith("meta.") && key.length > "meta.".length) {
      next.meta[key.slice("meta.".length)] = value;
      continue;
    }
    if (!SETTABLE_STATE_KEYS.has(key)) {
      refuse(
        `brownfield state: ${key} is not settable (use phase, execute, context, designReviewRounds, assumptionRounds, baseBranch, or meta.<key>)`,
        hint,
      );
    }
    if (key === "phase") {
      const phase = BrownfieldRunPhaseSchema.safeParse(value);
      if (!phase.success) {
        refuse(`brownfield state: phase must be one of ${BrownfieldRunPhaseSchema.options.join("|")}`, hint);
      }
      assertBrownfieldCanTransition(next.phase, phase.data, hint);
      next.phase = phase.data;
      continue;
    }
    (next as Record<string, unknown>)[key] = key === "context" ? String(value) : value;
  }
  const parsed = BrownfieldRunSchema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refuse(`brownfield state: invalid ${issue?.path.join(".") || "value"} (${issue?.message ?? "schema"})`, hint);
  }
  return parsed.data;
}

async function completedNodeCount(projectRoot: string, runId: string): Promise<number> {
  const abs = runAbs(projectRoot, runId, DAG_FILE);
  if (!existsSync(abs)) return 0;
  try {
    const parsed = BrownfieldDagSchema.safeParse(JSON.parse(await readFile(abs, "utf8")));
    return parsed.success ? parsed.data.nodes.filter((node) => node.status === "completed").length : 0;
  } catch {
    return 0;
  }
}

/**
 * Extra gates on top of LEGAL_BROWNFIELD_PHASE_TRANSITIONS: execute/verify need a design review,
 * and verify needs a completed PR.
 */
export async function assertPhaseAllowed(
  projectRoot: string,
  runId: string,
  phase: string,
  hint: string,
  action = "brownfield state",
): Promise<void> {
  if (phase !== "execute" && phase !== "verify") return;
  if (!existsSync(runAbs(projectRoot, runId, "reviews", "design-review.md"))) {
    refuse(`${action}: phase=${phase} needs reviews/design-review.md (run the design review first)`, hint);
  }
  if (phase === "verify" && (await completedNodeCount(projectRoot, runId)) === 0) {
    refuse(
      "brownfield state: phase=verify needs at least one completed DAG node; with none, skip verify and set phase=complete (references/execute.md § Verify)",
      hint,
    );
  }
}
