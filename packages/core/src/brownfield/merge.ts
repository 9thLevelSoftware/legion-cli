import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import type { BrownfieldSpecialist } from "@9thlevelsoftware/legion-cli-schema";
import { HINT, refuse } from "../errors.js";
import type {
  BrownfieldBlockingAssumption,
  BrownfieldIgnoredBlock,
  BrownfieldMergeResult,
  BrownfieldSeverity,
} from "../types.js";
import {
  fileKey,
  normConfidence,
  normKey,
  normSeverity,
  normStatus,
  section,
  SEVERITIES,
  severityRank,
  splitBlocks,
  titleOf,
  type Confidence,
} from "./markdown.js";
import { runAbs, runArtifactPaths } from "./paths.js";
import { SPECIALIST_TAGS } from "./roster.js";
import { assertBrownfieldReady, nowIso, readRun, writeRun } from "./state.js";

export type MergedFinding = {
  id: string;
  title: string;
  severity: BrownfieldSeverity;
  location: string;
  sources: string[];
  /** Block body without the heading and without the source's own Severity line. */
  body: string;
};

export type MergedAssumption = {
  id: string;
  statement: string;
  evidence: string;
  confidence: Confidence;
  impact: BrownfieldSeverity;
  status: string;
  question: string;
  answer: string;
  sources: string[];
  blocking: boolean;
};

export type SpecialistInput = { tag: string; text: string };

export type MergeModel = {
  findings: MergedFinding[];
  assumptions: MergedAssumption[];
  perSource: Record<string, { findings: number; assumptions: number }>;
  ignored: BrownfieldIgnoredBlock[];
};

/** Answers the user already recorded in assumptions.md, keyed by normalized statement. */
export type RecordedAnswers = Map<string, { status: string; answer: string }>;

const RESOLVED = new Set(["confirmed", "rejected"]);
const ASSUMPTION_FIELDS = ["confidence", "impact if wrong", "impact", "status"];

export function specialistTag(stem: string): string {
  return SPECIALIST_TAGS[stem as BrownfieldSpecialist] ?? stem.replace(/(^|-)([a-z])/g, (_m, d, c) => `${d}${c.toUpperCase()}`);
}

function stripSeverityLine(raw: string): string {
  return raw
    .split("\n")
    .slice(1)
    .filter((line) => !/^\s*[-*]\s*\*{0,2}severity\*{0,2}\s*:/i.test(line))
    .join("\n")
    .trim();
}

export function isBlocking(asm: Pick<MergedAssumption, "status" | "confidence" | "impact">): boolean {
  if (RESOLVED.has(asm.status)) return false;
  return asm.status === "needs-confirmation" || (asm.confidence === "low" && severityRank(asm.impact) <= 1);
}

export function mergeSpecialists(inputs: readonly SpecialistInput[], recorded: RecordedAnswers = new Map()): MergeModel {
  const findings: MergedFinding[] = [];
  const assumptions: MergedAssumption[] = [];
  const seenFindings = new Map<string, MergedFinding>();
  const seenAssumptions = new Map<string, MergedAssumption>();
  const perSource: MergeModel["perSource"] = {};
  const ignored: BrownfieldIgnoredBlock[] = [];

  for (const { tag, text } of inputs) {
    perSource[tag] = { findings: 0, assumptions: 0 };
    const findingsSection = section(text, "Findings") || section(text, "Issues");
    for (const block of splitBlocks(findingsSection)) {
      if (!("severity" in block.fields)) {
        ignored.push({ source: tag, heading: block.heading, reason: "finding has no Severity field" });
        continue;
      }
      perSource[tag].findings += 1;
      const title = titleOf(block.heading);
      const severity = normSeverity(block.fields.severity);
      const location = block.fields.location ?? block.fields.file ?? "";
      const key = normKey(fileKey(location), title);
      const previous = seenFindings.get(key);
      if (previous) {
        if (severityRank(severity) < severityRank(previous.severity)) previous.severity = severity;
        if (!previous.sources.includes(tag)) previous.sources.push(tag);
        continue;
      }
      const item: MergedFinding = { id: "", title, severity, location, sources: [tag], body: stripSeverityLine(block.raw) };
      seenFindings.set(key, item);
      findings.push(item);
    }

    for (const block of splitBlocks(section(text, "Assumptions"))) {
      if (!ASSUMPTION_FIELDS.some((field) => field in block.fields)) {
        ignored.push({
          source: tag,
          heading: block.heading,
          reason: "assumption has none of Confidence, Impact if wrong, Status",
        });
        continue;
      }
      perSource[tag].assumptions += 1;
      const statement = block.fields.statement || titleOf(block.heading);
      const key = normKey(statement);
      const impact = normSeverity(block.fields["impact if wrong"] ?? block.fields.impact);
      const confidence = normConfidence(block.fields.confidence);
      const status = normStatus(block.fields.status, "provisional");
      const question =
        block.fields["question for user"] ?? block.fields["user question"] ?? block.fields.question ?? "";
      const previous = seenAssumptions.get(key);
      if (previous) {
        // Same assumption from several specialists: keep the most cautious reading.
        if (severityRank(impact) < severityRank(previous.impact)) previous.impact = impact;
        if (["low", "medium", "high"].indexOf(confidence) < ["low", "medium", "high"].indexOf(previous.confidence)) {
          previous.confidence = confidence;
        }
        if (status === "needs-confirmation" && !RESOLVED.has(previous.status)) previous.status = status;
        previous.question ||= question;
        if (!previous.sources.includes(tag)) previous.sources.push(tag);
        continue;
      }
      const item: MergedAssumption = {
        id: "",
        statement,
        evidence: block.fields.evidence ?? "",
        confidence,
        impact,
        status,
        question,
        answer: "",
        sources: [tag],
        blocking: false,
      };
      seenAssumptions.set(key, item);
      assumptions.push(item);
    }
  }

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  findings.forEach((finding, i) => {
    finding.id = `F-${String(i + 1).padStart(3, "0")}`;
  });
  assumptions.forEach((asm, i) => {
    asm.id = `A-${String(i + 1).padStart(3, "0")}`;
    const answered = recorded.get(normKey(asm.statement));
    if (answered && RESOLVED.has(answered.status)) {
      asm.status = answered.status;
      asm.answer = answered.answer;
    }
    asm.blocking = isBlocking(asm);
  });
  return { findings, assumptions, perSource, ignored };
}

/** Read confirmed/rejected answers back out of an existing assumptions.md so re-merging keeps them. */
export function parseRecordedAnswers(assumptionsMarkdown: string): RecordedAnswers {
  const out: RecordedAnswers = new Map();
  for (const block of splitBlocks(assumptionsMarkdown)) {
    const status = normStatus(block.fields.status, "provisional");
    if (!RESOLVED.has(status)) continue;
    const statement = block.fields.statement || titleOf(block.heading);
    out.set(normKey(statement), { status, answer: block.fields.answer ?? "" });
  }
  return out;
}

export function renderFindingsMd(model: MergeModel, runId: string, specialistCount: number): string {
  const counts = severityCounts(model.findings);
  const lines = [
    "# Merged Findings",
    "",
    `Run \`${runId}\` · merged ${nowIso()} · ${model.findings.length} findings from ${specialistCount} specialists`,
    "",
    "| Severity | Count |",
    "|---|---|",
    ...SEVERITIES.map((sev) => `| ${sev} | ${counts[sev]} |`),
    "",
  ];
  for (const sev of SEVERITIES) {
    const group = model.findings.filter((finding) => finding.severity === sev);
    if (group.length === 0) continue;
    lines.push(`## ${sev[0].toUpperCase()}${sev.slice(1)}`, "");
    for (const finding of group) {
      lines.push(`### ${finding.id} [${finding.sources.join(", ")}] ${finding.title}`, `- Severity: ${finding.severity}`);
      if (finding.body) lines.push(finding.body);
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderAssumptionsMd(model: MergeModel, runId: string): string {
  const blocking = model.assumptions.filter((asm) => asm.blocking).length;
  const lines = [
    "# Assumptions Register",
    "",
    `Run \`${runId}\` · ${model.assumptions.length} assumptions · ${blocking} blocking`,
    "",
    "Record a user decision by setting `- Status: confirmed` or `- Status: rejected` and adding `- Answer: …`.",
    "Re-running `legion-cli brownfield merge` keeps recorded answers.",
    "",
  ];
  for (const asm of model.assumptions) {
    lines.push(
      `### ${asm.id}: ${asm.statement}`,
      `- Statement: ${asm.statement}`,
      `- Evidence: ${asm.evidence}`,
      `- Confidence: ${asm.confidence}`,
      `- Impact if wrong: ${asm.impact}`,
      `- Status: ${asm.status}`,
      `- Blocking: ${asm.blocking ? "yes" : "no"}`,
      `- Sources: ${asm.sources.join(", ")}`,
    );
    if (asm.question) lines.push(`- Question for user: ${asm.question}`);
    if (asm.answer) lines.push(`- Answer: ${asm.answer}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function severityCounts(findings: readonly MergedFinding[]): Record<BrownfieldSeverity, number> {
  const counts = { critical: 0, major: 0, minor: 0, nit: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export async function mergeRun(store: LegionStore, runId: string): Promise<BrownfieldMergeResult> {
  await assertBrownfieldReady(store);
  const run = await readRun(store, runId);
  const analysisAbs = runAbs(store.projectRoot, runId, "analysis");
  let names: string[] = [];
  try {
    names = (await readdir(analysisAbs, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    names = [];
  }
  if (names.length === 0) {
    refuse(`brownfield run ${runId} has no specialist outputs in analysis/`, HINT.brownfieldRoster(runId));
  }
  const inputs: SpecialistInput[] = [];
  for (const name of names) {
    inputs.push({ tag: specialistTag(name.replace(/\.md$/i, "")), text: await readFile(join(analysisAbs, name), "utf8") });
  }
  const paths = runArtifactPaths(runId);
  const assumptionsAbs = runAbs(store.projectRoot, runId, "assumptions.md");
  let recorded: RecordedAnswers = new Map();
  try {
    recorded = parseRecordedAnswers(await readFile(assumptionsAbs, "utf8"));
  } catch {
    recorded = new Map();
  }
  const model = mergeSpecialists(inputs, recorded);
  await writeFile(runAbs(store.projectRoot, runId, "findings.md"), renderFindingsMd(model, runId, inputs.length), "utf8");
  await writeFile(assumptionsAbs, renderAssumptionsMd(model, runId), "utf8");
  await writeRun(store.projectRoot, { ...run, phase: "assumptions" });

  const blockingAssumptions: BrownfieldBlockingAssumption[] = model.assumptions
    .filter((asm) => asm.blocking)
    .map((asm) => ({ id: asm.id, statement: asm.statement, evidence: asm.evidence, question: asm.question, sources: asm.sources }));
  const emptySources = Object.entries(model.perSource)
    .filter(([, counts]) => counts.findings === 0 && counts.assumptions === 0)
    .map(([tag]) => tag);
  return {
    runId,
    findingsTotal: model.findings.length,
    bySeverity: severityCounts(model.findings),
    perSource: model.perSource,
    assumptionsTotal: model.assumptions.length,
    blockingAssumptions,
    emptySources,
    ignoredBlocks: model.ignored,
    files: { findings: paths.findings, assumptions: paths.assumptions },
    next:
      blockingAssumptions.length > 0
        ? `ask the user about ${blockingAssumptions.length} blocking assumption(s), record answers in assumptions.md, re-run merge`
        : `legion-cli brownfield state ${runId} phase=design, then launch the design writer`,
  };
}
