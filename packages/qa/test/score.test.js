import assert from "node:assert/strict";
import test from "node:test";

import {
  formatQaScore,
  parseTestReport,
  scoreQa,
  scoreSpecReports,
  specHasUi,
  tagFromPriority,
  ZERO_TESTS_REASON,
} from "../dist/index.js";

const spec = {
  id: "spec-checkin",
  acceptance: [{ id: "AC-01", statement: "Tap in or out on a phone", kind: "behavior", priority: "P0" }],
  wireframesIndex: "wireframes/INDEX.html",
};

const noUiSpec = {
  id: "spec-api",
  acceptance: [{ id: "AC-01", statement: "API returns 200 for health", kind: "test", priority: "P0" }],
  wireframesIndex: null,
};

test("tagFromPriority maps AC.priority onto @p0/@p1/@p2", () => {
  assert.equal(tagFromPriority("P0"), "@p0");
  assert.equal(tagFromPriority("P1"), "@p1");
  assert.equal(tagFromPriority("P2"), "@p2");
});

test("untagged tests count as P1", () => {
  const tests = parseTestReport({
    tests: [
      { title: "health @p0", status: "passed" },
      { title: "lists items", status: "passed" },
      { title: "optional filter @p2", status: "passed" },
    ],
  });
  assert.equal(tests[1].priority, "P1");
  const score = scoreQa({
    specId: "spec-api",
    mode: "full",
    specHasUi: false,
    playwrightRan: false,
    tests,
    id: "qa-1",
    createdAt: "2026-09-01T12:00:00Z",
  });
  assert.equal(score.buckets.p0.points, 40);
  assert.equal(score.buckets.p1.points, 30);
  assert.equal(score.buckets.p2.points, 15);
  assert.equal(score.buckets.visual.points, 15);
  assert.equal(score.total, 100);
  assert.equal(score.pass, true);
});

test("golden 94 line retains bucket score but failed reports block the gate", () => {
  const tests = [
    ...Array.from({ length: 1 }, () => ({ title: "p0 @p0", ok: true, skipped: false, visualFailure: false, priority: "P0" })),
    ...Array.from({ length: 9 }, () => ({ title: "p1 @p1", ok: true, skipped: false, visualFailure: false, priority: "P1" })),
    { title: "p1 fail @p1", ok: false, skipped: false, visualFailure: false, priority: "P1" },
    ...Array.from({ length: 4 }, () => ({ title: "p2 @p2", ok: true, skipped: false, visualFailure: false, priority: "P2" })),
    { title: "p2 fail @p2", ok: false, skipped: false, visualFailure: false, priority: "P2" },
  ];
  const score = scoreQa({
    specId: spec.id,
    mode: "full",
    specHasUi: true,
    playwrightRan: true,
    tests,
    id: "qa-1",
    createdAt: "2026-09-01T12:00:00Z",
  });
  assert.equal(score.total, 94);
  assert.equal(score.buckets.p0.points, 40);
  assert.equal(score.buckets.p1.points, 27);
  assert.equal(score.buckets.p2.points, 12);
  assert.equal(score.buckets.visual.points, 15);
  assert.equal(score.buckets.visual.regressions, 0);
  assert.equal(score.pass, false);
  assert.equal(
    formatQaScore(score),
    "QA score 94  (P0 40/40, P1 27/30, P2 12/15, visual 15/15, regressions 0)",
  );
});

test("visual regression cannot ship even when P0+P1+P2 = 85", () => {
  const tests = [
    { title: "p0 @p0", ok: true, skipped: false, visualFailure: false, priority: "P0" },
    { title: "p1 @p1", ok: true, skipped: false, visualFailure: false, priority: "P1" },
    { title: "p2 @p2", ok: true, skipped: false, visualFailure: false, priority: "P2" },
    { title: "snapshot @visual", ok: false, skipped: false, visualFailure: true, priority: "P1" },
  ];
  const score = scoreQa({
    specId: spec.id,
    mode: "full",
    specHasUi: true,
    playwrightRan: true,
    tests,
    id: "qa-visual",
    createdAt: "2026-09-01T12:00:00Z",
  });
  assert.equal(score.buckets.p0.points + score.buckets.p1.points + score.buckets.p2.points, 85);
  assert.equal(score.buckets.visual.points, 0);
  assert.equal(score.buckets.visual.regressions > 0, true);
  assert.equal(score.total, 85);
  assert.equal(score.pass, false);
});

test("no-browser caps total at 70 and cannot pass", () => {
  const score = scoreQa({
    specId: noUiSpec.id,
    mode: "no-browser",
    specHasUi: false,
    playwrightRan: false,
    tests: [
      { title: "p0 @p0", ok: true, skipped: false, visualFailure: false, priority: "P0" },
      { title: "p1 @p1", ok: true, skipped: false, visualFailure: false, priority: "P1" },
      { title: "p2 @p2", ok: true, skipped: false, visualFailure: false, priority: "P2" },
    ],
    id: "qa-deg",
    createdAt: "2026-09-01T12:00:00Z",
  });
  assert.equal(score.total, 70);
  assert.equal(score.pass, false);
});

test("UI spec without Playwright in full mode scores visual 0", () => {
  const score = scoreQa({
    specId: spec.id,
    mode: "full",
    specHasUi: true,
    playwrightRan: false,
    tests: [{ title: "p0 @p0", ok: true, skipped: false, visualFailure: false, priority: "P0" }],
    id: "qa-nui",
    createdAt: "2026-09-01T12:00:00Z",
  });
  assert.equal(score.buckets.visual.points, 0);
  assert.equal(score.buckets.visual.regressions > 0, true);
  assert.equal(score.pass, false);
});

test("no UI ACs and no wireframes awards visual 15 without Playwright", () => {
  assert.equal(specHasUi(noUiSpec), false);
  const score = scoreQa({
    specId: noUiSpec.id,
    mode: "full",
    specHasUi: false,
    playwrightRan: false,
    tests: [{ title: "p0 @p0", ok: true, skipped: false, visualFailure: false, priority: "P0" }],
    id: "qa-nau",
    createdAt: "2026-09-01T12:00:00Z",
  });
  assert.equal(score.buckets.visual.points, 15);
  assert.equal(score.buckets.visual.regressions, 0);
});

test("zero-tests report is refused with a named reason", () => {
  assert.throws(
    () =>
      scoreQa({
        specId: noUiSpec.id,
        mode: "full",
        specHasUi: false,
        playwrightRan: false,
        unitReport: { success: true, numTotalTests: 0, testResults: [] },
        id: "qa-zero",
        createdAt: "2026-09-01T12:00:00Z",
      }),
    (err) => {
      assert.equal(err.message, ZERO_TESTS_REASON);
      return true;
    },
  );
});

test("P0 failure zeros the P0 bucket", () => {
  const score = scoreQa({
    specId: noUiSpec.id,
    mode: "full",
    specHasUi: false,
    playwrightRan: false,
    tests: [{ title: "broken @p0", ok: false, skipped: false, visualFailure: false, priority: "P0" }],
    id: "qa-p0",
    createdAt: "2026-09-01T12:00:00Z",
  });
  assert.equal(score.buckets.p0.points, 0);
  assert.equal(score.buckets.p0.failed, 1);
  assert.equal(score.pass, false);
});

test("criterion coverage comes from declared SPEC priorities and reports missing and skipped ids", () => {
  const score = scoreSpecReports({
    spec: {
      id: "spec-coverage",
      acceptance: [
        { id: "AC-01", statement: "critical", kind: "test", priority: "P0" },
        { id: "AC-02", statement: "important", kind: "test", priority: "P1" },
        { id: "AC-03", statement: "optional", kind: "test", priority: "P2" },
        { id: "AC-04", statement: "also optional", kind: "test", priority: "P2" },
      ],
      wireframesIndex: null,
    },
    mode: "full",
    playwrightRan: false,
    unitReport: {
      tests: [
        { title: "covers two @ac(AC-01) @ac(AC-02)", status: "passed" },
        { title: "deferred @ac(AC-03)", status: "skipped" },
        { title: "passing but untagged", status: "passed" },
      ],
    },
    id: "qa-coverage",
    createdAt: "2026-09-30T12:00:00Z",
    specHash: "a".repeat(64),
    sourceHash: "b".repeat(64),
  });
  assert.equal(score.schemaVersion, "legion-cli-qa/v2");
  assert.deepEqual(score.criteria, [
    { id: "AC-01", priority: "P0", outcome: "passed" },
    { id: "AC-02", priority: "P1", outcome: "passed" },
    { id: "AC-03", priority: "P2", outcome: "skipped" },
    { id: "AC-04", priority: "P2", outcome: "missing" },
  ]);
  assert.deepEqual(score.missingCriterionIds, ["AC-04"]);
  assert.deepEqual(score.skippedCriterionIds, ["AC-03"]);
  assert.deepEqual(score.failedCriterionIds, []);
  assert.equal(score.buckets.p2.passRate, 0);
  assert.equal(score.specHash, "a".repeat(64));
  assert.equal(score.sourceHash, "b".repeat(64));
});

test("an untagged pass cannot cover missing P0 acceptance evidence", () => {
  const score = scoreSpecReports({
    spec: {
      id: "spec-p0",
      acceptance: [{ id: "AC-01", statement: "critical", kind: "test", priority: "P0" }],
      wireframesIndex: null,
    },
    mode: "full",
    playwrightRan: false,
    unitReport: { tests: [{ title: "critical behavior passes", status: "passed" }] },
    id: "qa-missing-p0",
    createdAt: "2026-09-30T12:00:00Z",
    specHash: "a".repeat(64),
    sourceHash: "b".repeat(64),
  });
  assert.equal(score.pass, false);
  assert.equal(score.buckets.p0.failed, 1);
  assert.deepEqual(score.missingCriterionIds, ["AC-01"]);
});

test("an untagged real report failure remains blocking evidence", () => {
  const score = scoreSpecReports({
    spec: {
      id: "spec-failure",
      acceptance: [{ id: "AC-01", statement: "critical", kind: "test", priority: "P0" }],
      wireframesIndex: null,
    },
    mode: "full",
    playwrightRan: false,
    unitReport: {
      tests: [
        { title: "critical @ac(AC-01)", status: "passed" },
        { title: "unrelated regression", status: "failed" },
      ],
    },
    id: "qa-regression",
    createdAt: "2026-09-30T12:00:00Z",
    specHash: "a".repeat(64),
    sourceHash: "b".repeat(64),
  });
  assert.equal(score.reportFailures, 1);
  assert.equal(score.pass, false);
});

test("no-browser checklist evidence covers a missing criterion but cannot override a linked failure", () => {
  const manual = scoreSpecReports({
    spec: noUiSpec,
    mode: "no-browser",
    playwrightRan: false,
    unitReport: { tests: [{ title: "unlinked smoke", status: "passed" }] },
    manualPassedCriterionIds: ["AC-01"],
  });
  assert.equal(manual.criteria[0].outcome, "passed");
  assert.equal(manual.buckets.p0.failed, 0);

  const failed = scoreSpecReports({
    spec: noUiSpec,
    mode: "no-browser",
    playwrightRan: false,
    unitReport: { tests: [{ title: "health @ac(AC-01)", status: "failed" }] },
    manualPassedCriterionIds: ["AC-01"],
  });
  assert.equal(failed.criteria[0].outcome, "failed");
  assert.equal(failed.reportFailures, 1);
});
