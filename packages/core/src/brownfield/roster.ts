import { readFile } from "node:fs/promises";
import type { BrownfieldRoster, BrownfieldSpecialist } from "@9thlevelsoftware/legion-cli-schema";
import type { LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import type { BrownfieldEffort, BrownfieldRosterResult } from "../types.js";
import { section } from "./markdown.js";
import { runAbs, runArtifactPaths } from "./paths.js";
import { assertBrownfieldReady, readRun, writeRun } from "./state.js";

/** Display tags used in merged findings (`[Architecture, Code]`). */
export const SPECIALIST_TAGS: Record<BrownfieldSpecialist, string> = {
  architecture: "Architecture",
  "product-intent": "Product-Intent",
  code: "Code",
  "code-2": "Code-2",
  tests: "Tests",
  security: "Security",
  performance: "Performance",
  documentation: "Documentation",
};

/** Keyword signals that add a specialist at any effort. */
export const SIGNALS: Record<"security" | "tests" | "documentation" | "performance", RegExp> = {
  security:
    /\b(auth\w*|security|secure|secrets?|api[ -]?keys?|tokens?|passwords?|encrypt\w*|permissions?|owasp|injection|xss|csrf|pii|payments?|checkout|login)\b/i,
  tests:
    /\b(tests?|testing|coverage|flaky|regressions?|ci|business rules?|algorithms?|calculations?|wrong (numbers|results|totals))\b/i,
  documentation: /\b(readme|docs?|documentation|adrs?|openapi|swagger|runbooks?|onboarding)\b/i,
  performance: /\b(slow|latency|performance|perf|scal\w+|timeouts?|memory|n\+1|throughput|load)\b/i,
};

const OPTIONAL_ORDER: BrownfieldSpecialist[] = ["tests", "security", "performance", "documentation"];

/** Intent sections that carry the user's own words. The rest of the template would signal everything. */
const SIGNAL_SECTIONS = ["Goal", "User Goal", "Symptoms", "Constraints"];

export function signalText(context: string, intentMarkdown: string): string {
  const parts = [context];
  for (const name of SIGNAL_SECTIONS) {
    const body = section(intentMarkdown, name);
    if (body.trim()) parts.push(body);
  }
  return parts.join("\n");
}

/** Per-PR reviewer slots during execute, e.g. `["general", "tests", "security"]`. */
export function reviewerSlots(effort: BrownfieldEffort, text: string): string[] {
  const total = effort;
  const matched: string[] = [];
  if (SIGNALS.security.test(text) || effort >= 4) matched.push("security");
  if (SIGNALS.tests.test(text) || effort >= 3) matched.push("tests");
  if (effort >= 5) matched.push("plan-alignment");
  const specialists = matched.slice(0, Math.max(total - 1, 0));
  const generals = total - specialists.length;
  const slots: string[] = [];
  for (let i = 0; i < generals; i++) slots.push(i === 0 ? "general" : `general-${i + 1}`);
  return [...slots, ...specialists];
}

export function computeRoster(
  effort: BrownfieldEffort,
  text: string,
  execute: boolean,
  outputPath: (specialist: BrownfieldSpecialist) => string,
): BrownfieldRoster {
  const pass1: BrownfieldSpecialist[] = ["architecture", ...(effort >= 2 ? (["product-intent"] as const) : [])];
  const mandated: BrownfieldSpecialist[] = [];
  if (effort >= 2) mandated.push("tests");
  if (effort >= 3) mandated.push("documentation");
  if (effort >= 4) mandated.push("security");
  if (effort >= 5) mandated.push("performance");
  const addedBySignal = (Object.keys(SIGNALS) as (keyof typeof SIGNALS)[])
    .filter((key) => SIGNALS[key].test(text) && !mandated.includes(key))
    .sort((a, b) => OPTIONAL_ORDER.indexOf(a) - OPTIONAL_ORDER.indexOf(b));
  const optional = [...new Set([...mandated, ...addedBySignal])].sort(
    (a, b) => OPTIONAL_ORDER.indexOf(a) - OPTIONAL_ORDER.indexOf(b),
  );
  const pass2: BrownfieldSpecialist[] = ["code", ...(effort >= 5 ? (["code-2"] as const) : []), ...optional];
  const outputs: Record<string, string> = {};
  for (const specialist of [...pass1, ...pass2]) outputs[specialist] = outputPath(specialist);
  return {
    effort,
    pass1,
    pass2,
    addedBySignal,
    injectDoctrine: effort >= 3,
    designReviewers: effort >= 4 ? 2 : 1,
    executeReviewersDefault: execute ? reviewerSlots(effort, text) : [],
    outputs,
  };
}

export async function rosterRun(store: LegionStore, runId: string): Promise<BrownfieldRosterResult> {
  await assertBrownfieldReady(store);
  const run = await readRun(store, runId);
  let intent = "";
  try {
    intent = await readFile(runAbs(store.projectRoot, runId, "intent.md"), "utf8");
  } catch {
    intent = "";
  }
  const analysisDir = runArtifactPaths(runId).analysisDir;
  const roster = computeRoster(
    run.effort as BrownfieldEffort,
    signalText(run.context, intent),
    run.execute,
    (specialist) => `${analysisDir}/${specialist}.md`,
  );
  const phase = run.phase === "intent" ? "plan" : run.phase;
  await writeRun(store.projectRoot, { ...run, roster, phase });
  return {
    runId,
    ...roster,
    next: `write plan.md (focus bullets per specialist), then launch pass 1: ${roster.pass1.join(", ")}`,
  };
}
