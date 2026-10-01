import { randomUUID } from "node:crypto";
import {
  computeQaPass,
  QAScoreSchema,
  SCHEMA_VERSION,
  type QAScore,
  type AcceptanceCriterion,
  type Spec,
} from "@9thlevelsoftware/legion-cli-schema";
import { parseTestReport, reportFailClosed, type ParsedTest } from "./reports.js";
import { isVisualTitle, specHasUi } from "./tags.js";

export type QaMode = "full" | "no-browser";

export type ScoreQaInput = {
  specId: string;
  mode: QaMode;
  specHasUi: boolean;
  playwrightRan: boolean;
  tests?: ParsedTest[];
  unitReport?: unknown;
  playwrightReport?: unknown;
  id?: string;
  createdAt?: string;
  evidencePaths?: string[];
  /** Crashed/missing reporter JSON: force P0 failed rather than a vacuous 40. */
  failClosed?: boolean;
  /** Command/report-level failures that remain blocking even when parsed tests pass. */
  reportFailures?: number;
  acceptance?: readonly AcceptanceCriterion[];
  specHash?: string;
  sourceHash?: string;
  /** Criteria explicitly completed in the governed no-browser checklist. */
  manualPassedCriterionIds?: readonly string[];
};

const NO_BROWSER_CAP = 70;

/** Named refusal: a report with no tests is not a vacuous pass. */
export const ZERO_TESTS_REASON = "zero-tests report is not a pass";

function passRate(passed: number, failed: number): number {
  const denom = passed + failed;
  return denom === 0 ? 1 : passed / denom;
}

function bucketCounts(tests: readonly ParsedTest[], priority: ParsedTest["priority"]): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const test of tests) {
    // @visual tests are the visual bucket; keep P0/P1/P2 as functional score.
    if (test.priority !== priority || test.skipped || isVisualTitle(test.title)) continue;
    if (test.ok) passed += 1;
    else failed += 1;
  }
  return { passed, failed };
}

type CriterionResult = QAScore["criteria"][number];

function criterionResults(
  acceptance: readonly AcceptanceCriterion[],
  tests: readonly ParsedTest[],
  manualPassedCriterionIds: readonly string[] = [],
): CriterionResult[] {
  const manualPassed = new Set(manualPassedCriterionIds);
  return acceptance.map((criterion) => {
    const linked = tests.filter((test) => test.acceptanceIds.includes(criterion.id));
    let outcome: CriterionResult["outcome"] = "missing";
    if (linked.some((test) => !test.skipped && !test.ok)) outcome = "failed";
    else if (linked.some((test) => !test.skipped && test.ok)) outcome = "passed";
    else if (manualPassed.has(criterion.id)) outcome = "passed";
    else if (linked.length > 0) outcome = "skipped";
    return { id: criterion.id, priority: criterion.priority, outcome };
  });
}

function criterionBucketCounts(
  criteria: readonly CriterionResult[],
  priority: CriterionResult["priority"],
): { passed: number; failed: number } {
  const selected = criteria.filter((criterion) => criterion.priority === priority);
  return {
    passed: selected.filter((criterion) => criterion.outcome === "passed").length,
    failed: selected.filter((criterion) => criterion.outcome !== "passed").length,
  };
}

function visualRegressions(opts: {
  tests: readonly ParsedTest[];
  specHasUi: boolean;
  mode: QaMode;
  playwrightRan: boolean;
}): number {
  if (!opts.specHasUi) return 0;
  let regressions = 0;
  for (const test of opts.tests) {
    if (test.skipped || test.ok) continue;
    if (test.visualFailure || isVisualTitle(test.title)) regressions += 1;
  }
  // Schema: visual points are 15 iff regressions==0. A UI spec without a full
  // Playwright run must score visual 0, so record a synthetic regression.
  if (opts.mode !== "full" || !opts.playwrightRan) return Math.max(regressions, 1);
  return regressions;
}

export function scoreQa(input: ScoreQaInput): QAScore {
  const unitTests = input.unitReport !== undefined ? parseTestReport(input.unitReport) : [];
  const pwTests = input.playwrightReport !== undefined ? parseTestReport(input.playwrightReport) : [];
  const tests = input.tests ?? [...unitTests, ...pwTests];
  const failClosed =
    input.failClosed === true ||
    (input.tests === undefined && input.unitReport !== undefined && reportFailClosed(input.unitReport));

  if (tests.length === 0) {
    throw new Error(ZERO_TESTS_REASON);
  }

  const criteria = input.acceptance
    ? criterionResults(input.acceptance, tests, input.manualPassedCriterionIds)
    : [];
  const p0 = input.acceptance ? criterionBucketCounts(criteria, "P0") : bucketCounts(tests, "P0");
  const commandReportFailures = Math.max(input.reportFailures ?? 0, failClosed ? 1 : 0);
  if (commandReportFailures > 0) p0.failed = Math.max(p0.failed, 1);
  const p1 = input.acceptance ? criterionBucketCounts(criteria, "P1") : bucketCounts(tests, "P1");
  const p2 = input.acceptance ? criterionBucketCounts(criteria, "P2") : bucketCounts(tests, "P2");
  const p1Rate = passRate(p1.passed, p1.failed);
  const p2Rate = passRate(p2.passed, p2.failed);
  const regressions = visualRegressions({
    tests,
    specHasUi: input.specHasUi,
    mode: input.mode,
    playwrightRan: input.playwrightRan,
  });

  const buckets = {
    p0: { points: p0.failed === 0 ? 40 : 0, max: 40 as const, failed: p0.failed },
    p1: { points: Math.round(30 * p1Rate), max: 30 as const, passRate: p1Rate },
    p2: { points: Math.round(15 * p2Rate), max: 15 as const, passRate: p2Rate },
    visual: { points: regressions === 0 ? 15 : 0, max: 15 as const, regressions },
  };
  const sum = buckets.p0.points + buckets.p1.points + buckets.p2.points + buckets.visual.points;
  const total = input.mode === "no-browser" ? Math.min(sum, NO_BROWSER_CAP) : sum;
  const reportFailures =
    tests.filter((test) => !test.skipped && !test.ok).length + commandReportFailures;
  const missingCriterionIds = criteria.filter((item) => item.outcome === "missing").map((item) => item.id);
  const failedCriterionIds = criteria.filter((item) => item.outcome === "failed").map((item) => item.id);
  const skippedCriterionIds = criteria.filter((item) => item.outcome === "skipped").map((item) => item.id);
  const score = {
    schemaVersion: SCHEMA_VERSION.qa,
    id: input.id ?? `qa-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    specId: input.specId,
    mode: input.mode,
    buckets,
    total,
    pass: computeQaPass({ mode: input.mode, total, buckets, reportFailures }),
    evidencePaths: input.evidencePaths ?? [],
    createdAt: input.createdAt ?? new Date().toISOString(),
    criteria,
    missingCriterionIds,
    failedCriterionIds,
    skippedCriterionIds,
    reportFailures,
    specHash: input.specHash ?? "0".repeat(64),
    sourceHash: input.sourceHash ?? "0".repeat(64),
  };
  return QAScoreSchema.parse(score);
}

export function scoreSpecReports(opts: {
  spec: Pick<Spec, "id" | "acceptance" | "wireframesIndex">;
  mode: QaMode;
  playwrightRan: boolean;
  unitReport?: unknown;
  playwrightReport?: unknown;
  id?: string;
  createdAt?: string;
  evidencePaths?: string[];
  failClosed?: boolean;
  reportFailures?: number;
  specHash?: string;
  sourceHash?: string;
  manualPassedCriterionIds?: readonly string[];
}): QAScore {
  return scoreQa({
    specId: opts.spec.id,
    mode: opts.mode,
    specHasUi: specHasUi(opts.spec),
    playwrightRan: opts.playwrightRan,
    unitReport: opts.unitReport,
    playwrightReport: opts.playwrightReport,
    id: opts.id,
    createdAt: opts.createdAt,
    evidencePaths: opts.evidencePaths,
    failClosed: opts.failClosed,
    reportFailures: opts.reportFailures,
    acceptance: opts.spec.acceptance,
    specHash: opts.specHash,
    sourceHash: opts.sourceHash,
    manualPassedCriterionIds: opts.manualPassedCriterionIds,
  });
}

export function formatQaScore(score: QAScore): string {
  const { p0, p1, p2, visual } = score.buckets;
  const evidence = [
    score.missingCriterionIds.length ? `missing ${score.missingCriterionIds.join(",")}` : "",
    score.failedCriterionIds.length ? `failed ${score.failedCriterionIds.join(",")}` : "",
    score.skippedCriterionIds.length ? `skipped ${score.skippedCriterionIds.join(",")}` : "",
  ].filter(Boolean);
  return `QA score ${score.total}  (P0 ${p0.points}/${p0.max}, P1 ${p1.points}/${p1.max}, P2 ${p2.points}/${p2.max}, visual ${visual.points}/${visual.max}, regressions ${visual.regressions})${evidence.length ? `; ${evidence.join("; ")}` : ""}`;
}

/** Reconstructs the score from the exact persisted reporter inputs. */
export function scorePersistedReports(opts: Parameters<typeof scoreSpecReports>[0]): QAScore {
  try {
    return scoreSpecReports(opts);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ZERO_TESTS_REASON) throw err;
    return scoreQa({
      specId: opts.spec.id,
      mode: opts.mode,
      specHasUi: specHasUi(opts.spec),
      playwrightRan: opts.playwrightRan,
      tests: [{
        title: `${ZERO_TESTS_REASON} @p0`,
        ok: false,
        skipped: false,
        visualFailure: false,
        priority: "P0",
        acceptanceIds: [],
      }],
      acceptance: opts.spec.acceptance,
      id: opts.id,
      createdAt: opts.createdAt,
      evidencePaths: opts.evidencePaths,
      failClosed: true,
      reportFailures: opts.reportFailures,
      specHash: opts.specHash,
      sourceHash: opts.sourceHash,
      manualPassedCriterionIds: opts.manualPassedCriterionIds,
    });
  }
}

export const QA_NO_BROWSER_CAP = NO_BROWSER_CAP;
