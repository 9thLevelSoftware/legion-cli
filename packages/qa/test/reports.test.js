import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseTestReport, runCommand, splitCommand } from "../dist/index.js";

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

test("runCommand captures JSON from node -e", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-qa-"));
  const payload = { tests: [{ title: "health @p0", status: "passed" }] };
  const script = join(dir, "emit.js");
  await writeFile(script, `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`, "utf8");
  const capture = runCommand(dir, `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`);
  assert.equal(capture.started, true);
  assert.equal(capture.status, 0);
  assert.equal(JSON.parse(capture.stdout).tests[0].title, "health @p0");
  assert.deepEqual(splitCommand(`pnpm test -- --reporter=json`), ["pnpm", "test", "--", "--reporter=json"]);
});
