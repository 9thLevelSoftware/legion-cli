import { isVisualTitle, priorityFromTitle } from "./tags.js";
import type { Priority } from "@9thlevelsoftware/legion-cli-schema";

export type ParsedTest = {
  title: string;
  ok: boolean;
  skipped: boolean;
  visualFailure: boolean;
  priority: Priority;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function visualFailureFromResult(result: Record<string, unknown>): boolean {
  const error = asRecord(result.error);
  const message = typeof error?.message === "string" ? error.message : "";
  if (/toHaveScreenshot|toMatchSnapshot|screenshot comparison|snapshot comparison/i.test(message)) return true;
  for (const raw of asArray(result.attachments)) {
    const attachment = asRecord(raw);
    if (!attachment) continue;
    const name = typeof attachment.name === "string" ? attachment.name : "";
    // Default Playwright failure screenshots are named "screenshot"; only diffs count.
    if (/^(diff|expected|actual)$/i.test(name)) return true;
  }
  return false;
}

function pushTest(acc: ParsedTest[], title: string, ok: boolean, skipped: boolean, visualFailure: boolean): void {
  const trimmed = title.trim();
  acc.push({
    title: trimmed,
    ok,
    skipped,
    visualFailure: visualFailure || (isVisualTitle(trimmed) && !ok && !skipped),
    priority: priorityFromTitle(trimmed),
  });
}

function parsePlaywrightSpec(spec: unknown, suiteTitle: string, acc: ParsedTest[]): void {
  const rec = asRecord(spec);
  if (!rec) return;
  const title = [suiteTitle, typeof rec.title === "string" ? rec.title : ""].filter(Boolean).join(" ").trim();
  const tests = asArray(rec.tests);
  let ok = rec.ok !== false;
  let skipped = tests.length > 0;
  let visualFailure = false;
  if (tests.length === 0) {
    skipped = false;
    pushTest(acc, title, ok, false, isVisualTitle(title) && !ok);
    return;
  }
  for (const raw of tests) {
    const test = asRecord(raw);
    if (!test) continue;
    const status = typeof test.status === "string" ? test.status : "";
    const expected = typeof test.expectedStatus === "string" ? test.expectedStatus : "";
    const results = asArray(test.results).map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
    const testSkipped = status === "skipped" || expected === "skipped";
    if (!testSkipped) skipped = false;
    const failed =
      status === "unexpected" ||
      results.some((result) => result.status === "failed" || result.status === "timedOut");
    if (failed) ok = false;
    for (const result of results) {
      if (visualFailureFromResult(result)) visualFailure = true;
    }
  }
  if (isVisualTitle(title) && !ok && !skipped) visualFailure = true;
  pushTest(acc, title, ok, skipped, visualFailure);
}

function walkPlaywrightSuite(suite: unknown, parentTitle: string, acc: ParsedTest[]): void {
  const rec = asRecord(suite);
  if (!rec) return;
  const title = [parentTitle, typeof rec.title === "string" ? rec.title : ""].filter(Boolean).join(" ").trim();
  for (const spec of asArray(rec.specs)) parsePlaywrightSpec(spec, title, acc);
  for (const child of asArray(rec.suites)) walkPlaywrightSuite(child, title, acc);
}

function parseJest(report: Record<string, unknown>, acc: ParsedTest[]): boolean {
  const suites = asArray(report.testResults);
  if (suites.length === 0 && !("numFailedTests" in report) && !("success" in report)) return false;
  if (suites.length === 0 && ("numFailedTests" in report || "success" in report)) return true;
  for (const raw of suites) {
    const suite = asRecord(raw);
    if (!suite) continue;
    for (const rawAssert of asArray(suite.assertionResults)) {
      const assertion = asRecord(rawAssert);
      if (!assertion) continue;
      const title =
        (typeof assertion.fullName === "string" && assertion.fullName) ||
        (typeof assertion.title === "string" && assertion.title) ||
        "";
      const status = typeof assertion.status === "string" ? assertion.status : "";
      const skipped = status === "pending" || status === "skipped" || status === "todo";
      const ok = status === "passed" || skipped;
      pushTest(acc, title, ok, skipped, isVisualTitle(title) && !ok && !skipped);
    }
  }
  return true;
}

function parseSimpleTests(report: Record<string, unknown>, acc: ParsedTest[]): boolean {
  const tests = asArray(report.tests);
  if (tests.length === 0 && !("tests" in report)) return false;
  for (const raw of tests) {
    const test = asRecord(raw);
    if (!test) continue;
    const title = typeof test.title === "string" ? test.title : typeof test.name === "string" ? test.name : "";
    const status = typeof test.status === "string" ? test.status : "";
    const skipped = status === "skipped" || status === "pending" || test.skipped === true;
    const ok = test.ok === true || status === "passed" || status === "ok" || skipped;
    const failed = test.ok === false || status === "failed" || status === "fail";
    pushTest(
      acc,
      title,
      skipped ? true : failed ? false : ok,
      skipped,
      test.visualFailure === true || (isVisualTitle(title) && failed && !skipped),
    );
  }
  return true;
}

function parseNdjson(text: string, acc: ParsedTest[]): boolean {
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof event.type === "string" ? event.type : "";
    const data = asRecord(event.data) ?? event;
    if (type !== "test:pass" && type !== "test:fail" && type !== "test:skip") continue;
    const title = typeof data.name === "string" ? data.name : typeof data.title === "string" ? data.title : "";
    if (!title) continue;
    found = true;
    const skipped = type === "test:skip";
    const ok = type !== "test:fail";
    pushTest(acc, title, ok, skipped, isVisualTitle(title) && type === "test:fail");
  }
  return found;
}

/** Pull a JSON value out of mixed tool stdout (pnpm logs + reporter). */
export function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const start = trimmed.search(/[\[{]/);
  if (start >= 0) {
    const slice = trimmed.slice(start);
    try {
      return JSON.parse(slice);
    } catch {
      // try last object
    }
    const lastBrace = trimmed.lastIndexOf("}");
    const firstBrace = trimmed.indexOf("{");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        // NDJSON handled by caller
      }
    }
  }
  return null;
}

/** Missing JSON, or a failure report with no tests, is not a vacuous pass. */
export function reportFailClosed(input: unknown): boolean {
  if (input === undefined) return false;
  if (input === null) return true;
  if (typeof input === "string") {
    const ndjson: ParsedTest[] = [];
    if (parseNdjson(input, ndjson) && ndjson.length > 0) return false;
    const payload = extractJsonPayload(input);
    if (payload === null) return true;
    return reportFailClosed(payload);
  }
  const rec = asRecord(input);
  if (!rec) return true;
  if (rec.error === "no reporter json") return true;
  const hasSuites = Array.isArray(rec.suites) || Array.isArray(rec.specs);
  const hasSimple = "tests" in rec;
  const testResults = asArray(rec.testResults);
  if (hasSuites || hasSimple || testResults.length > 0) return false;
  if (rec.success === false) return true;
  if (typeof rec.numFailedTests === "number" && rec.numFailedTests > 0) return true;
  return false;
}

export function parseTestReport(input: unknown): ParsedTest[] {
  const acc: ParsedTest[] = [];
  if (typeof input === "string") {
    if (parseNdjson(input, acc)) return acc;
    const payload = extractJsonPayload(input);
    if (payload !== null && payload !== input) return parseTestReport(payload);
    return acc;
  }
  if (Array.isArray(input)) {
    for (const item of input) acc.push(...parseTestReport(item));
    return acc;
  }
  const rec = asRecord(input);
  if (!rec) return acc;
  if (Array.isArray(rec.suites) || Array.isArray(rec.specs)) {
    if (Array.isArray(rec.suites)) {
      for (const suite of rec.suites) walkPlaywrightSuite(suite, "", acc);
    }
    if (Array.isArray(rec.specs)) parsePlaywrightSpec(rec, "", acc);
    if (acc.length > 0 || Array.isArray(rec.suites)) return acc;
  }
  if (parseJest(rec, acc)) return acc;
  if (parseSimpleTests(rec, acc)) return acc;
  return acc;
}
