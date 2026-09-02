import {
  computeQaPass,
  QAScoreSchema,
  SCHEMA_VERSION,
  type QAScore,
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
};

const NO_BROWSER_CAP = 70;

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

  const p0 = bucketCounts(tests, "P0");
  if (failClosed) p0.failed = Math.max(p0.failed, 1);
  const p1 = bucketCounts(tests, "P1");
  const p2 = bucketCounts(tests, "P2");
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
  const score = {
    schemaVersion: SCHEMA_VERSION.qa,
    id: input.id ?? `qa-${Date.now().toString(36)}`,
    specId: input.specId,
    mode: input.mode,
    buckets,
    total,
    pass: computeQaPass({ mode: input.mode, total, buckets }),
    evidencePaths: input.evidencePaths ?? [],
    createdAt: input.createdAt ?? new Date().toISOString(),
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
  });
}

export function formatQaScore(score: QAScore): string {
  const { p0, p1, p2, visual } = score.buckets;
  return `QA score ${score.total}  (P0 ${p0.points}/${p0.max}, P1 ${p1.points}/${p1.max}, P2 ${p2.points}/${p2.max}, visual ${visual.points}/${visual.max}, regressions ${visual.regressions})`;
}

export const QA_NO_BROWSER_CAP = NO_BROWSER_CAP;
