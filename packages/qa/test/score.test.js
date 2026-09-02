import assert from "node:assert/strict";
import test from "node:test";

import {
  formatQaScore,
  parseTestReport,
  scoreQa,
  specHasUi,
  tagFromPriority,
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

test("golden 94 line: visual 15/15, regressions 0", () => {
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
  assert.equal(score.pass, true);
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
