import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseTestReport, reportFailClosed, runCommand, runProjectQa, scoreQa, splitCommand, ZERO_TESTS_REASON } from "../dist/index.js";

test("parses Playwright JSON including screenshot-diff failures", () => {
  const report = {
    suites: [
      {
        title: "e2e",
        specs: [
          {
            title: "board @p0 @visual",
            ok: false,
            tests: [
              {
                status: "unexpected",
                results: [
                  {
                    status: "failed",
                    error: { message: "Error: Screenshot comparison failed:\n- expected\n+ actual" },
                    attachments: [
                      { name: "diff", contentType: "image/png" },
                      { name: "expected", contentType: "image/png" },
                      { name: "actual", contentType: "image/png" },
                    ],
                  },
                ],
              },
            ],
          },
          {
            title: "api @p1",
            ok: true,
            tests: [{ status: "expected", results: [{ status: "passed" }] }],
          },
        ],
      },
    ],
  };
  const tests = parseTestReport(report);
  assert.equal(tests.length, 2);
  assert.equal(tests[0].ok, false);
  assert.equal(tests[0].visualFailure, true);
  assert.equal(tests[0].priority, "P0");
  assert.equal(tests[1].ok, true);
  assert.equal(tests[1].priority, "P1");
});

test("parses node:test NDJSON and Jest JSON", () => {
  const ndjson = [
    JSON.stringify({ type: "test:pass", data: { name: "health @p0" } }),
    JSON.stringify({ type: "test:fail", data: { name: "lists items" } }),
    JSON.stringify({ type: "test:skip", data: { name: "slow @p2" } }),
  ].join("\n");
  const nodeTests = parseTestReport(ndjson);
  assert.equal(nodeTests[0].ok, true);
  assert.equal(nodeTests[0].priority, "P0");
  assert.equal(nodeTests[1].ok, false);
  assert.equal(nodeTests[1].priority, "P1");
  assert.equal(nodeTests[2].skipped, true);

  const jest = parseTestReport({
    success: false,
    numFailedTests: 1,
    testResults: [
      {
        assertionResults: [
          { fullName: "renders board @visual", title: "renders board @visual", status: "failed" },
          { fullName: "ok @p2", title: "ok @p2", status: "passed" },
        ],
      },
    ],
  });
  assert.equal(jest[0].visualFailure, true);
  assert.equal(jest[1].priority, "P2");
});

test("parses every canonical acceptance id from repeated @ac tags", () => {
  const [parsed] = parseTestReport({
    tests: [{ title: "checkout works @ac(AC-01) @ac(AC-02)", status: "passed" }],
  });
  assert.deepEqual(parsed.acceptanceIds, ["AC-01", "AC-02"]);
});

test("runCommand captures JSON from node -e", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-qa-"));
  const payload = { tests: [{ title: "health @p0", status: "passed" }] };
  const script = join(dir, "emit.js");
  await writeFile(script, `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`, "utf8");
  const capture = await runCommand(dir, `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`);
  assert.equal(capture.started, true);
  assert.equal(capture.status, 0);
  assert.equal(JSON.parse(capture.stdout).tests[0].title, "health @p0");
  assert.deepEqual(splitCommand(`pnpm test -- --reporter=json`), ["pnpm", "test", "--", "--reporter=json"]);
});

function playwrightSpec(title, { ok, attachments, error }) {
  return {
    title,
    ok,
    tests: [
      {
        status: ok ? "expected" : "unexpected",
        results: [
          {
            status: ok ? "passed" : "failed",
            error,
            attachments,
          },
        ],
      },
    ],
  };
}

test("generic screenshot attachments are not visual regressions", () => {
  const failed = parseTestReport({
    suites: [
      {
        specs: [
          playwrightSpec("api @p1", {
            ok: false,
            error: { message: "Error: expect(received).toBe(expected)" },
            attachments: [{ name: "screenshot", contentType: "image/png" }],
          }),
        ],
      },
    ],
  });
  assert.equal(failed[0].visualFailure, false);
  const failedScore = scoreQa({
    specId: "spec-checkin",
    mode: "full",
    specHasUi: true,
    playwrightRan: true,
    tests: failed,
    id: "qa-shot",
    createdAt: "2026-09-01T12:00:00Z",
  });
  assert.equal(failedScore.buckets.visual.points, 15);
  assert.equal(failedScore.buckets.visual.regressions, 0);

  const passed = parseTestReport({
    suites: [
      {
        specs: [
          playwrightSpec("api @p1", {
            ok: true,
            attachments: [{ name: "screenshot", contentType: "image/png" }],
          }),
        ],
      },
    ],
  });
  assert.equal(passed[0].visualFailure, false);
  const passedScore = scoreQa({
    specId: "spec-checkin",
    mode: "full",
    specHasUi: true,
    playwrightRan: true,
    tests: passed,
    id: "qa-pass-shot",
    createdAt: "2026-09-01T12:00:00Z",
  });
  assert.equal(passedScore.buckets.visual.points, 15);
});

test("missing unit JSON fail-closes P0 instead of vacuous 100", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-qa-miss-"));
  const script = join(dir, "fail.js");
  await writeFile(script, "process.exit(1)\n", "utf8");
  const result = await runProjectQa({
    projectRoot: dir,
    spec: {
      id: "spec-api",
      acceptance: [{ id: "AC-01", statement: "API returns 200 for health", kind: "test", priority: "P0" }],
      wireframesIndex: null,
    },
    mode: "full",
    unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
    id: "qa-miss",
    createdAt: "2026-09-01T12:00:00Z",
  });
  assert.equal(result.score.pass, false);
  assert.ok(result.score.buckets.p0.failed >= 1);
});

test("Jest success false with empty testResults is not a 100", () => {
  assert.throws(
    () =>
      scoreQa({
        specId: "spec-api",
        mode: "full",
        specHasUi: false,
        playwrightRan: false,
        unitReport: { success: false, numFailedTests: 1, testResults: [] },
        id: "qa-jest-empty",
        createdAt: "2026-09-01T12:00:00Z",
      }),
    (err) => {
      assert.equal(err.message, ZERO_TESTS_REASON);
      return true;
    },
  );
});

test("parses JUnit XML testsuites, failures, errors, skipped, entities, and ignores system-out tags", () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<testsuites tests="5" failures="1" errors="1" skipped="1">',
    '  <testsuite name="suite &amp; core" tests="5">',
    '    <testcase name="health &amp; readiness @p0 @ac(AC-01)" classname="api" time="0.01">',
    '      <system-out><![CDATA[<failure message="not a real failure"/>]]></system-out>',
    "    </testcase>",
    '    <testcase name="self closing pass @ac(AC-02)" time="0.01" />',
    '    <testcase name="renders card @visual @p1" time="0.02">',
    '      <failure message="toHaveScreenshot mismatch: a &gt; b">diff</failure>',
    "    </testcase>",
    '    <testcase name="throws error @p0" time="0.01">',
    '      <error type="AssertionError" message="boom">stack</error>',
    "    </testcase>",
    '    <testcase name="deferred check @p2">',
    '      <skipped message="wip" />',
    "    </testcase>",
    "  </testsuite>",
    "</testsuites>",
  ].join("\n");
  assert.equal(reportFailClosed(xml), false);
  const parsed = parseTestReport(xml);
  assert.equal(parsed.length, 5);
  assert.deepEqual(parsed[0], {
    title: "health & readiness @p0 @ac(AC-01)",
    ok: true,
    skipped: false,
    visualFailure: false,
    priority: "P0",
    acceptanceIds: ["AC-01"],
  });
  assert.equal(parsed[1].ok, true);
  assert.deepEqual(parsed[1].acceptanceIds, ["AC-02"]);
  assert.equal(parsed[2].ok, false);
  assert.equal(parsed[2].visualFailure, true);
  assert.equal(parsed[3].ok, false);
  assert.equal(parsed[3].priority, "P0");
  assert.equal(parsed[4].skipped, true);
  assert.equal(parsed[4].ok, true);
  assert.equal(parsed[4].priority, "P2");

  const emptyXml = '<testsuite name="empty" tests="0"></testsuite>';
  assert.deepEqual(parseTestReport(emptyXml), []);
  assert.equal(reportFailClosed(emptyXml), true);
});

test("runProjectQa scores JUnit XML unit stdout cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-qa-junit-"));
  const script = join(dir, "emit-junit.js");
  const xml = '<testsuites><testsuite name="unit" tests="1"><testcase name="health @p0 @ac(AC-01)"/></testsuite></testsuites>';
  await writeFile(script, `process.stdout.write(${JSON.stringify(xml)});`, "utf8");
  const result = await runProjectQa({
    projectRoot: dir,
    spec: {
      id: "spec-api",
      acceptance: [{ id: "AC-01", statement: "API returns 200 for health", kind: "test", priority: "P0" }],
      wireframesIndex: null,
    },
    mode: "full",
    unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
    id: "qa-junit",
    createdAt: "2026-09-01T12:00:00Z",
  });
  assert.equal(result.score.pass, true);
  assert.equal(result.score.total, 100);
});
