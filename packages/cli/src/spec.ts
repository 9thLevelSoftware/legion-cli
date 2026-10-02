import {
  createLegionEngine,
  findSkillsDir,
  HINT,
  prepareDiscovery,
  recordDiscoverySelection,
  refuse,
  type SpecChallengeManualQuestionKey,
  type SpecChallengeResult,
} from "@9thlevelsoftware/legion-cli-core";
import { specPath } from "@9thlevelsoftware/legion-cli-persist";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { runDiscuss } from "./discuss.js";
import { runIntent } from "./intent.js";
import { closePrompt, readLine, slurpStdin } from "./prompt.js";

export type SpecFlags = {
  skipWireframes?: boolean;
  message?: string;
  manualReview?: boolean;
};

function challengeNext(result: SpecChallengeResult): string {
  return result.status === "manual_required"
    ? "legion-cli spec --manual-review"
    : "legion-cli spec";
}

function printChallenge(result: SpecChallengeResult): void {
  if (result.status === "complete") {
    if (result.draftDiff) writeOut(`Challenge draft updates:\n${result.draftDiff}`);
    writeOut("Challenge review is complete. Next: legion-cli spec approve");
    return;
  }
  if (result.automationError) writeOut(`Challenge automation needs manual review: ${result.automationError}`);
  if (result.pendingConcerns.length > 0) {
    writeOut(`${result.pendingConcerns.length} challenge concern(s) remain. Resume: legion-cli spec`);
    return;
  }
  writeOut(`Challenge is pending. Next: ${challengeNext(result)}`);
}

function formatChallengeEvidence(evidence: SpecChallengeResult["pendingConcerns"][number]["evidence"]): string {
  return evidence.map((item) => item.kind === "repository"
    ? `${item.path}:${item.line} — ${item.claim}`
    : `Assumption: ${item.claim}`).join("\n");
}

async function collectManualReview(
  engine: ReturnType<typeof createLegionEngine>,
  specId: string,
  current: SpecChallengeResult,
): Promise<SpecChallengeResult> {
  await slurpStdin();
  const existing: Partial<Record<SpecChallengeManualQuestionKey, string>> = current.receipt?.manualReview ?? {};
  const questions: Array<[SpecChallengeManualQuestionKey, string]> = [
    ["measurableSuccess", "What measurable outcome proves this specification succeeds? "],
    ["failureHandling", "How must the product behave when it fails or is unavailable? "],
    ["compatibilityAndScope", "What compatibility and scope constraints must remain true? "],
    ["acknowledgement", "Acknowledge that challenge automation was unavailable or failed (type I acknowledge): "],
  ];
  let result = current;
  for (const [key, question] of questions) {
    if (existing[key]) continue;
    const response = await readLine(question);
    if (!response) {
      writeOut("A substantive manual review answer is required. Resume: legion-cli spec --manual-review");
      return result;
    }
    result = await engine.recordSpecChallengeManualAnswer(specId, key, response, { id: "user" });
  }
  return engine.finalizeSpecChallenge(specId, { actor: { id: "user" } });
}

async function resolveChallenge(
  engine: ReturnType<typeof createLegionEngine>,
  specId: string,
): Promise<SpecChallengeResult> {
  let result = await engine.prepareSpecChallenge(specId);
  if (result.status === "manual_required" || result.status === "complete") return result;
  for (const concern of result.pendingConcerns) {
    writeOut(`Challenge ${concern.id}: ${concern.question}`);
    writeOut(`Why it matters: ${concern.whyItMatters}`);
    writeOut(`Evidence: ${formatChallengeEvidence(concern.evidence)}`);
    const disposition = await readLine("Resolution [answer/dismiss/risk]: ");
    const response = await readLine("Response or rationale: ");
    const normalized = disposition.trim().toLowerCase();
    const selected = normalized === "answer" || normalized === "answered"
      ? "answered"
      : normalized === "dismiss" || normalized === "dismissed"
        ? "dismissed"
        : normalized === "risk" || normalized === "accept risk" || normalized === "risk_accepted"
          ? "risk_accepted"
          : undefined;
    if (!selected || !response) {
      writeOut("A substantive answer, dismissal rationale, or explicit risk acceptance is required. Resume: legion-cli spec");
      return await engine.readSpecChallenge(specId);
    }
    result = await engine.recordSpecChallengeResolution(specId, concern.id, { disposition: selected, response }, { id: "user" });
  }
  if (result.status === "manual_required" || result.status === "complete") return result;
  return engine.finalizeSpecChallenge(specId, { actor: { id: "user" } });
}

async function runChallenge(
  engine: ReturnType<typeof createLegionEngine>,
  specId: string,
  opts: CliOpts,
  flags: SpecFlags,
): Promise<SpecChallengeResult> {
  if (opts.json) return engine.readSpecChallenge(specId);
  if (flags.manualReview) {
    const current = await engine.readSpecChallenge(specId);
    if (current.status !== "manual_required") {
      refuse("--manual-review is available only after challenge automation failed or was unavailable", HINT.spec);
    }
    return collectManualReview(engine, specId, current);
  }
  return resolveChallenge(engine, specId);
}

export async function runSpecDraft(opts: CliOpts, flags: SpecFlags): Promise<number> {
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  const state = await engine.getState();
  try {
    if (opts.json && (state.phase === "initialized" || state.phase === "intent_draft" || state.phase === "intent_ready" || state.phase === "discussing")) {
      refuse("spec needs an interactive conversation before it can produce JSON", HINT.spec);
    }
    if (state.phase === "spec_frozen" && state.activeSpecId) {
      const path = specPath(state.activeSpecId);
      if (opts.json) {
        const challenge = await engine.readSpecChallenge(state.activeSpecId);
        writeJson({ ok: true, specId: state.activeSpecId, path, phase: "spec_frozen", challenge, next: "legion-cli plan" });
      } else {
        writeOut("Spec is frozen. Next: legion-cli plan");
      }
      return 0;
    }
    if (state.phase === "spec_draft" && state.activeSpecId) {
      const path = specPath(state.activeSpecId);
      const challenge = await runChallenge(engine, state.activeSpecId, opts, flags);
      if (opts.json) writeJson({ ok: true, specId: state.activeSpecId, path, challenge, next: challenge.status === "complete" ? "legion-cli spec approve" : challengeNext(challenge) });
      else printChallenge(challenge);
      return 0;
    }
  if (state.phase === "initialized" || state.phase === "intent_draft") {
    const discovery = await prepareDiscovery(engine);
    if (discovery && !opts.json) {
      writeOut(`Brownfield orientation: ${discovery.path}`);
      for (const finding of discovery.findings) writeOut(`${finding.id} (${finding.priority}): ${finding.statement}`);
    }
    if (discovery?.goal === "audit") {
      if (discovery.selection) {
        if (!opts.json) writeOut(`Selected remediation: ${discovery.selection.goal} (${discovery.selection.affectedArea})`);
      } else {
        await slurpStdin();
        if (!opts.json) writeOut("Select one bounded remediation increment before writing its specification.");
        const goal = await readLine("Remediation goal: ");
        const affectedArea = await readLine("Affected area or module paths: ");
        if (!goal || !affectedArea) {
          refuse("brownfield audit requires a bounded remediation goal and affected area", HINT.spec);
        }
        await recordDiscoverySelection(engine, { goal, affectedArea });
        if (!opts.json) writeOut(`Selected remediation: ${goal} (${affectedArea})`);
      }
    }
    const intentCode = await runIntent({ ...opts, json: false }, { quiet: true, keepPrompt: true });
    if (intentCode !== 0) return intentCode;
  }
  const afterIntent = await engine.getState();
  if (afterIntent.phase === "intent_draft") {
    if (!opts.json) writeOut("Intent is not confirmed. Resume: legion-cli spec");
    return 0;
  }
  if (afterIntent.phase === "intent_ready" || afterIntent.phase === "discussing") {
    await runDiscuss({ ...opts, json: false }, true, true);
  }
  const afterDiscuss = await engine.getState();
  if (afterDiscuss.phase === "intent_ready") {
    if (!opts.json) writeOut("Decisions remain open. Resume: legion-cli spec");
    return 0;
  }
  const spec = await engine.draftSpec({ skipWireframes: flags.skipWireframes });
  const specFile = specPath(spec.id);
  const wire = flags.skipWireframes ? null : `.legion-cli/specs/${spec.id}/wireframes/INDEX.html`;
  const challenge = await runChallenge(engine, spec.id, opts, flags);
  if (opts.json) {
    writeJson({
      ok: true,
      specId: spec.id,
      path: specFile,
      wireframes: wire,
      skipWireframes: Boolean(flags.skipWireframes),
      challenge,
      next: challenge.status === "complete" ? "legion-cli spec approve" : challengeNext(challenge),
    });
    return 0;
  }
  writeOut(`Wrote ${specFile}`);
  if (wire) {
    writeOut(`Wireframes: ${wire}`);
  }
  printChallenge(challenge);
  return 0;
  } finally {
    closePrompt();
  }
}

export async function runSpecShow(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const state = await engine.getState();
  const specId = state.activeSpecId;
  if (!specId) {
    refuse("no active spec", HINT.spec);
  }
  const path = specPath(specId);
  if (opts.json) {
    writeJson({ specId, path });
    return 0;
  }
  writeOut(path);
  return 0;
}

export async function runSpecApprove(opts: CliOpts, flags: SpecFlags): Promise<number> {
  if (flags.skipWireframes) {
    refuse("--skip-wireframes is pre-approve only", HINT.skipWireframes);
  }
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  const state = await engine.getState();
  const specId = state.activeSpecId;
  if (!specId) {
    refuse("no active spec to approve", HINT.spec);
  }
  await engine.approveSpec(specId, { id: "user" }, flags.message ? { message: flags.message } : undefined);
  if (opts.json) {
    writeJson({ ok: true, specId, phase: "spec_frozen", next: "legion-cli plan" });
    return 0;
  }
  writeOut("Spec frozen. Next: legion-cli plan");
  return 0;
}

export async function runSpecNew(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  await engine.newSpec();
  if (opts.json) {
    writeJson({ ok: true, phase: "intent_draft", next: "legion-cli spec" });
    return 0;
  }
  writeOut("Previous spec superseded. Next: legion-cli spec");
  return 0;
}
