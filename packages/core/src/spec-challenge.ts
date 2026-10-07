import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  SCHEMA_VERSION,
  SpecChallengeAnalysisOutputSchema,
  SpecChallengeReceiptSchema,
  SpecChallengeSynthesisOutputSchema,
  type DiscussDecision,
  type Spec,
  type SpecChallengeAnalysisOutput,
  type SpecChallengeChange,
  type SpecChallengeConcern,
  type SpecChallengeEvidence,
  type SpecChallengeManualReview,
  type SpecChallengeProposedChange,
  type SpecChallengeReceipt,
  type SpecChallengeSynthesisOutput,
} from "@9thlevelsoftware/legion-cli-schema";
import { toFsPath, writeTextFile, type LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { workflowFingerprint } from "./workflow.js";
import {
  challengeReadableFiles,
  CHALLENGE_REPOSITORY_READ_ROOTS,
  planningInputInventory,
  planningContextRoots,
} from "./spec-challenge-inputs.js";

export const SPEC_CHALLENGE_THINKING_SUFFIX = ".thinking.md";

export type SpecChallengeStatus =
  | "not_started"
  | "analysis_running"
  | "awaiting_resolutions"
  | "synthesis_running"
  | "manual_required"
  | "complete"
  | "stale";

export type SpecChallengeDisposition = "answered" | "dismissed" | "risk_accepted";

export type SpecChallengeResolutionInput = {
  disposition: SpecChallengeDisposition;
  response: string;
};

export type SpecChallengeManualQuestionKey =
  | "measurableSuccess"
  | "failureHandling"
  | "compatibilityAndScope"
  | "acknowledgement";

export type SpecChallengeManualReviewInput = {
  measurableSuccess: string;
  failureHandling: string;
  compatibilityAndScope: string;
  acknowledgement: string;
};

export type SpecChallengeResult = {
  status: SpecChallengeStatus;
  specId: string;
  receiptPath: string;
  receipt: SpecChallengeReceipt | null;
  pendingConcerns: SpecChallengeConcern[];
  changes: SpecChallengeChange[];
  draftDiff: string | null;
  automationError: string | null;
};

export type SpecChallengeBinding = {
  specId: string;
  initialDraftFingerprint: string;
  contextFingerprint: string;
  repositoryFingerprint: string;
  inputFingerprint: string;
};

export type SpecChallengeReadableFingerprints = {
  repositoryFingerprint: string;
  contextFingerprint: string;
};

export type AppliedSpecChallenge = {
  spec: Spec;
  changes: SpecChallengeChange[];
  draftDiff: string;
};

function safeSpecId(specId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(specId)) throw new Error(`invalid spec id ${specId}`);
  return specId;
}

export function specChallengeReceiptPath(specId: string): string {
  return `.legion-cli/workflow/spec-challenge-${safeSpecId(specId)}.yaml`;
}

export function specChallengeThinkingPath(specId: string): string {
  return `.legion-cli/workflow/spec-challenge-${safeSpecId(specId)}${SPEC_CHALLENGE_THINKING_SUFFIX}`;
}

export function specChallengeAnalysisPath(runId: string): string {
  return `.legion-cli/cache/runs/${runId}/analysis.json`;
}

export function specChallengeSynthesisPath(runId: string): string {
  return `.legion-cli/cache/runs/${runId}/synthesis.json`;
}

export async function readSpecChallengeReceipt(
  store: LegionStore,
  specId: string,
): Promise<SpecChallengeReceipt | null> {
  const path = specChallengeReceiptPath(specId);
  if (!(await store.pathExists(path))) return null;
  const receipt = await store.readYaml(path, SpecChallengeReceiptSchema);
  if (receipt.specId !== specId) throw new Error(`spec challenge receipt id mismatch for ${specId}`);
  if (receipt.thinkingPath !== specChallengeThinkingPath(specId)) {
    throw new Error(`spec challenge receipt thinking path mismatch for ${specId}`);
  }
  if (receipt.status === "complete") {
    let manualComplete = false;
    try {
      manualComplete = completeManualReview(receipt.manualReview) !== null;
    } catch {
      manualComplete = false;
    }
    if (!receipt.finalDraftFingerprint ||
        (receipt.generation.status !== "complete" && !(receipt.automationError && manualComplete)) ||
        receipt.synthesis.status !== "complete" ||
        receipt.concerns.some((concern) => !concern.resolution)) {
      throw new Error(`inconsistent completed spec challenge receipt for ${specId}`);
    }
  }
  return receipt;
}

export async function writeSpecChallengeReceipt(
  store: LegionStore,
  receipt: SpecChallengeReceipt,
): Promise<void> {
  if (receipt.thinkingPath !== specChallengeThinkingPath(receipt.specId)) {
    throw new Error(`spec challenge receipt thinking path mismatch for ${receipt.specId}`);
  }
  await store.writeYaml(specChallengeReceiptPath(receipt.specId), SpecChallengeReceiptSchema.parse(receipt));
}

export function createSpecChallengeBinding(input: {
  specId: string;
  spec: { data: Spec; body: string };
  intent: unknown;
  discuss: unknown;
  discovery: string | null;
  repositoryFingerprint: string;
  readableContextFingerprint: string;
}): SpecChallengeBinding {
  const initialDraftFingerprint = workflowFingerprint(input.spec);
  const contextFingerprint = workflowFingerprint({
    intent: input.intent,
    discuss: input.discuss,
    discovery: input.discovery,
    readableContextFingerprint: input.readableContextFingerprint,
  });
  return {
    specId: input.specId,
    initialDraftFingerprint,
    contextFingerprint,
    repositoryFingerprint: input.repositoryFingerprint,
    inputFingerprint: workflowFingerprint({
      initialDraftFingerprint,
      contextFingerprint,
      repositoryFingerprint: input.repositoryFingerprint,
    }),
  };
}

async function fingerprintReadableRoots(
  projectRoot: string,
  roots: readonly string[],
  exclude?: (path: string) => boolean,
): Promise<string> {
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const path of await challengeReadableFiles(projectRoot, roots)) {
    if (exclude?.(path)) continue;
    entries.push({
      path,
      sha256: createHash("sha256").update(await readFile(toFsPath(projectRoot, path))).digest("hex"),
    });
  }
  return workflowFingerprint(entries);
}

export async function specChallengeReadableFingerprints(
  projectRoot: string,
  activeSpecId: string,
  declaredRoots: readonly string[] = [],
  policy2 = false,
): Promise<SpecChallengeReadableFingerprints> {
  const contextRoots = planningContextRoots(activeSpecId);
  const inventory = policy2 ? await planningInputInventory(projectRoot, declaredRoots) : null;
  const [repositoryFingerprint, contextFingerprint] = await Promise.all([
    fingerprintReadableRoots(projectRoot, inventory?.files ?? CHALLENGE_REPOSITORY_READ_ROOTS),
    fingerprintReadableRoots(projectRoot, contextRoots, (path) => path === `.legion-cli/specs/${activeSpecId}/SPEC.md`),
  ]);
  return { repositoryFingerprint, contextFingerprint };
}

export function newSpecChallengeReceipt(binding: SpecChallengeBinding, round: number, now: string): SpecChallengeReceipt {
  return SpecChallengeReceiptSchema.parse({
    schemaVersion: SCHEMA_VERSION.specChallenge,
    specId: binding.specId,
    round,
    status: "analysis_running",
    inputFingerprint: binding.inputFingerprint,
    initialDraftFingerprint: binding.initialDraftFingerprint,
    contextFingerprint: binding.contextFingerprint,
    repositoryFingerprint: binding.repositoryFingerprint,
    finalDraftFingerprint: null,
    generation: { status: "running", runId: null, startedAt: now },
    synthesis: { status: "pending", runId: null },
    concerns: [],
    manualReview: null,
    application: null,
    changes: [],
    draftDiff: null,
    thinkingPath: specChallengeThinkingPath(binding.specId),
    automationError: null,
    createdAt: now,
    updatedAt: now,
  });
}

export function challengeResult(
  specId: string,
  receipt: SpecChallengeReceipt | null,
  status?: SpecChallengeStatus,
): SpecChallengeResult {
  const resolvedStatus = status ?? receipt?.status ?? "not_started";
  return {
    status: resolvedStatus,
    specId,
    receiptPath: specChallengeReceiptPath(specId),
    receipt,
    pendingConcerns: receipt?.concerns.filter((concern) => !concern.resolution) ?? [],
    changes: receipt?.changes ?? [],
    draftDiff: receipt?.draftDiff ?? null,
    automationError: receipt?.automationError ?? null,
  };
}

export function receiptMatchesBinding(receipt: SpecChallengeReceipt, binding: SpecChallengeBinding): boolean {
  if (receipt.contextFingerprint !== binding.contextFingerprint ||
      receipt.repositoryFingerprint !== binding.repositoryFingerprint) return false;
  if (receipt.status === "complete" && receipt.finalDraftFingerprint) {
    return receipt.finalDraftFingerprint === binding.initialDraftFingerprint;
  }
  if (receipt.application) {
    return receipt.initialDraftFingerprint === binding.initialDraftFingerprint ||
      receipt.application.expectedDraftFingerprint === binding.initialDraftFingerprint;
  }
  return receipt.initialDraftFingerprint === binding.initialDraftFingerprint;
}

async function validateEvidence(
  projectRoot: string,
  readableFiles: ReadonlySet<string>,
  evidence: SpecChallengeEvidence,
): Promise<SpecChallengeEvidence> {
  if (evidence.kind === "assumption") return { ...evidence, claim: evidence.claim.trim() };
  const fallback = (): SpecChallengeEvidence => ({
    kind: "assumption",
    claim: `Unsupported citation ${evidence.path}:${evidence.line}: ${evidence.claim.trim()}`,
  });
  if (!readableFiles.has(evidence.path)) return fallback();
  try {
    const abs = toFsPath(projectRoot, evidence.path);
    const lines = (await readFile(abs, "utf8")).split(/\r?\n/);
    const line = lines[evidence.line - 1];
    if (line === undefined || !line.includes(evidence.quote)) return fallback();
    return {
      kind: "repository",
      path: evidence.path,
      line: evidence.line,
      quote: evidence.quote,
      claim: evidence.claim.trim(),
    };
  } catch {
    return fallback();
  }
}

export async function parseSpecChallengeAnalysis(
  projectRoot: string,
  raw: string,
  activeSpecId: string,
  declaredRoots: readonly string[] = [],
  policy2 = false,
): Promise<SpecChallengeConcern[]> {
  let parsed: SpecChallengeAnalysisOutput;
  try {
    parsed = SpecChallengeAnalysisOutputSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new Error(`invalid spec challenge analysis: ${err instanceof Error ? err.message : String(err)}`);
  }
  const readableFiles = new Set(policy2
    ? (await planningInputInventory(projectRoot, [...declaredRoots, ...planningContextRoots(activeSpecId)])).files
    : await challengeReadableFiles(projectRoot, [...CHALLENGE_REPOSITORY_READ_ROOTS, ...planningContextRoots(activeSpecId)]));
  const concerns: SpecChallengeConcern[] = [];
  for (const [index, concern] of parsed.concerns.entries()) {
    const evidence = [];
    for (const item of concern.evidence) evidence.push(await validateEvidence(projectRoot, readableFiles, item));
    concerns.push({
      id: `C-${String(index + 1).padStart(2, "0")}`,
      question: concern.question.trim(),
      whyItMatters: concern.why.trim(),
      evidence,
    });
  }
  return concerns;
}

export function parseSpecChallengeSynthesis(raw: string): SpecChallengeSynthesisOutput {
  try {
    return SpecChallengeSynthesisOutputSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new Error(`invalid spec challenge synthesis: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function groundedInHumanResponse(statement: string, responses: string[]): boolean {
  const exactStatement = statement.trim();
  return responses.some((response) => {
    const exactResponse = response.trim();
    return exactResponse.length >= 8 && exactStatement === exactResponse;
  });
}

function nextAppliedId(prefix: string, occupied: Set<string>): string {
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = `${prefix}-${String(n).padStart(2, "0")}`;
    if (!occupied.has(candidate)) {
      occupied.add(candidate);
      return candidate;
    }
  }
  throw new Error(`unable to allocate ${prefix} id`);
}

export function applySpecChallengeChanges(
  spec: Spec,
  concerns: SpecChallengeConcern[],
  proposed: SpecChallengeProposedChange[],
): AppliedSpecChallenge {
  const byId = new Map(concerns.map((concern) => [concern.id, concern]));
  const next: Spec = structuredClone(spec);
  const applied: SpecChallengeChange[] = [];
  const diff: string[] = [];
  const acceptanceIds = new Set(next.acceptance.map((criterion) => criterion.id));
  const decisionIds = new Set((next.decisions ?? []).map((decision) => decision.id));

  for (const candidate of proposed) {
    const linked = candidate.concernIds.map((id) => byId.get(id));
    if (linked.some((concern) => !concern)) throw new Error(`synthesis references unknown concern`);
    if (linked.some((concern) => !concern?.resolution)) throw new Error(`synthesis references unresolved concern`);
    if (linked.some((concern) => concern?.resolution?.disposition === "dismissed")) {
      throw new Error(`synthesis cannot change the draft for a dismissed concern`);
    }
    const responses = linked.flatMap((concern) => concern?.resolution?.response ? [concern.resolution.response] : []);
    if (!groundedInHumanResponse(candidate.statement, responses)) {
      throw new Error(`synthesis change is not grounded in the recorded human response`);
    }
    const statement = candidate.statement.trim();
    let appliedId: string | undefined;
    if (candidate.section === "acceptance") {
      if (!candidate.kind || !candidate.priority) throw new Error("acceptance challenge changes require kind and priority");
      if (candidate.targetId && !acceptanceIds.has(candidate.targetId)) {
        throw new Error(`unknown acceptance target ${candidate.targetId}`);
      }
      if (next.acceptance.some((criterion) => criterion.statement.trim() === statement)) continue;
      appliedId = nextAppliedId("AC-CH", acceptanceIds);
      next.acceptance.push({ id: appliedId, statement, kind: candidate.kind, priority: candidate.priority });
    } else if (candidate.section === "decision") {
      if ((next.decisions ?? []).some((decision) => decision.statement.trim() === statement)) continue;
      appliedId = nextAppliedId("DEC-CH", decisionIds);
      const decision: DiscussDecision = { id: appliedId, statement, status: "accepted" };
      next.decisions = [...(next.decisions ?? []), decision];
    } else {
      const values = candidate.section === "failureCases"
        ? (next.failureCases ??= [])
        : next[candidate.section];
      if (values.some((value) => value.trim() === statement)) continue;
      values.push(statement);
    }
    applied.push({ ...candidate, ...(appliedId ? { appliedId } : {}) });
    diff.push(`+ ${candidate.section}${appliedId ? ` ${appliedId}` : ""}: ${statement}`);
  }
  return { spec: next, changes: applied, draftDiff: diff.length > 0 ? `${diff.join("\n")}\n` : "(no draft changes)\n" };
}

export function manualReviewChanges(manual: Required<SpecChallengeManualReviewInput>): SpecChallengeProposedChange[] {
  return [
    {
      section: "mustBeTrue",
      statement: manual.measurableSuccess.trim(),
      rationale: "Recorded by the human during the fixed measurable-success review.",
      concernIds: ["MANUAL-SUCCESS"],
    },
    {
      section: "acceptance",
      statement: manual.measurableSuccess.trim(),
      rationale: "Turns the human's measurable-success answer into acceptance evidence.",
      concernIds: ["MANUAL-SUCCESS"],
      kind: "behavior",
      priority: "P0",
    },
    {
      section: "failureCases",
      statement: manual.failureHandling.trim(),
      rationale: "Recorded by the human during the fixed failure-handling review.",
      concernIds: ["MANUAL-FAILURE"],
    },
    {
      section: "mustNotChange",
      statement: manual.compatibilityAndScope.trim(),
      rationale: "Recorded by the human during the fixed compatibility and scope review.",
      concernIds: ["MANUAL-COMPATIBILITY"],
    },
  ];
}

export function applyManualReview(spec: Spec, manual: Required<SpecChallengeManualReviewInput>): AppliedSpecChallenge {
  const changes = manualReviewChanges(manual);
  const next: Spec = structuredClone(spec);
  const applied: SpecChallengeChange[] = [];
  const acceptanceIds = new Set(next.acceptance.map((criterion) => criterion.id));
  const lines: string[] = [];
  for (const change of changes) {
    if (change.section === "acceptance") {
      const appliedId = nextAppliedId("AC-CH", acceptanceIds);
      next.acceptance.push({ id: appliedId, statement: change.statement, kind: "behavior", priority: "P0" });
      applied.push({ ...change, appliedId });
      lines.push(`+ acceptance ${appliedId}: ${change.statement}`);
      continue;
    }
    if (change.section !== "mustBeTrue" && change.section !== "mustNotChange" && change.section !== "failureCases") continue;
    const values = change.section === "failureCases" ? (next.failureCases ??= []) : next[change.section];
    if (!values.some((value) => value.trim().toLowerCase() === change.statement.toLowerCase())) values.push(change.statement);
    applied.push(change);
    lines.push(`+ ${change.section}: ${change.statement}`);
  }
  return { spec: next, changes: applied, draftDiff: `${lines.join("\n")}\n` };
}

const CHALLENGE_BODY_START = "<!-- legion-cli:spec-challenge:start -->";
const CHALLENGE_BODY_END = "<!-- legion-cli:spec-challenge:end -->";

export function specChallengeDraftBody(body: string, applied: AppliedSpecChallenge): string {
  const rendered = [
    CHALLENGE_BODY_START,
    "## Challenge clarifications",
    "",
    ...(applied.changes.length > 0
      ? applied.changes.map((change) => `- **${change.section}${change.appliedId ? ` ${change.appliedId}` : ""}:** ${change.statement}`)
      : ["No draft changes were needed after review."]),
    CHALLENGE_BODY_END,
  ].join("\n");
  const start = body.indexOf(CHALLENGE_BODY_START);
  const end = body.indexOf(CHALLENGE_BODY_END);
  if (start >= 0 && end >= start) {
    return `${body.slice(0, start).trimEnd()}\n\n${rendered}${body.slice(end + CHALLENGE_BODY_END.length)}\n`;
  }
  return `${body.trimEnd()}\n\n${rendered}\n`;
}

export function validateManualAnswer(key: SpecChallengeManualQuestionKey, response: string): string {
  const trimmed = response.trim();
  const min = key === "acknowledgement" ? 12 : 8;
  if (trimmed.length < min) throw new Error(`manual review ${key} requires a substantive response`);
  if (key === "acknowledgement" && trimmed.toLowerCase() !== "i acknowledge") {
    throw new Error("manual review acknowledgement must be exactly 'I acknowledge'");
  }
  return trimmed;
}

export function completeManualReview(manual: SpecChallengeManualReview | null): Required<SpecChallengeManualReviewInput> | null {
  if (!manual?.measurableSuccess || !manual.failureHandling || !manual.compatibilityAndScope || !manual.acknowledgement) {
    return null;
  }
  return {
    measurableSuccess: validateManualAnswer("measurableSuccess", manual.measurableSuccess),
    failureHandling: validateManualAnswer("failureHandling", manual.failureHandling),
    compatibilityAndScope: validateManualAnswer("compatibilityAndScope", manual.compatibilityAndScope),
    acknowledgement: validateManualAnswer("acknowledgement", manual.acknowledgement),
  };
}

export function specChallengeThinking(receipt: SpecChallengeReceipt): string {
  const lines = [
    `# Specification challenge: ${receipt.specId}`,
    "",
    `Round: ${receipt.round}`,
    `Status: ${receipt.status}`,
    "",
  ];
  if (receipt.automationError) lines.push("## Automation", "", receipt.automationError, "");
  if (receipt.concerns.length > 0) {
    lines.push("## Concerns", "");
    for (const concern of receipt.concerns) {
      lines.push(`### ${concern.id}: ${concern.question}`, "", concern.whyItMatters, "", "Evidence:");
      for (const evidence of concern.evidence) {
        lines.push(evidence.kind === "repository"
          ? `- ${evidence.path}:${evidence.line} \`${evidence.quote}\` — ${evidence.claim}`
          : `- Assumption: ${evidence.claim}`);
      }
      lines.push("", `Response: ${concern.resolution?.response ?? "(pending)"}`);
      lines.push(`Disposition: ${concern.resolution?.disposition ?? "pending"}`);
      lines.push(`Rationale: ${concern.resolution?.response ?? "(pending human resolution)"}`, "");
    }
  }
  if (receipt.manualReview) {
    lines.push("## Manual review", "",
      `Measurable success: ${receipt.manualReview.measurableSuccess ?? "(pending)"}`,
      `Failure handling: ${receipt.manualReview.failureHandling ?? "(pending)"}`,
      `Compatibility and scope: ${receipt.manualReview.compatibilityAndScope ?? "(pending)"}`,
      `Acknowledgement: ${receipt.manualReview.acknowledgement ?? "(pending)"}`, "");
  }
  lines.push("## Resulting specification changes", "");
  if (receipt.changes.length > 0) {
    for (const change of receipt.changes) {
      lines.push(
        `- ${change.section}${change.appliedId ? ` ${change.appliedId}` : ""}: ${change.statement}`,
        `  - Concerns: ${change.concernIds.join(", ")}`,
        `  - Rationale: ${change.rationale}`,
      );
    }
    lines.push("");
  } else {
    lines.push(receipt.draftDiff ?? "(pending)", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeSpecChallengeThinking(projectRoot: string, receipt: SpecChallengeReceipt): Promise<void> {
  await writeTextFile(
    toFsPath(projectRoot, specChallengeThinkingPath(receipt.specId)),
    specChallengeThinking(receipt),
    { root: projectRoot },
  );
}
