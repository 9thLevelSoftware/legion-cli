import { isVisualTitle, priorityFromTitle } from "./tags.js";
import type { Priority } from "@9thlevelsoftware/legion-cli-schema";

export type ParsedTest = {
  title: string;
  ok: boolean;
  skipped: boolean;
  visualFailure: boolean;
  priority: Priority;
  acceptanceIds: string[];
};

export function acceptanceIdsFromTitle(title: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of title.matchAll(/@ac\(\s*([A-Za-z0-9][A-Za-z0-9._:-]*)\s*\)/gi)) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

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
    acceptanceIds: acceptanceIdsFromTitle(trimmed),
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

const VISUAL_FAILURE_MESSAGE_RE =
  /toHaveScreenshot|toMatchSnapshot|screenshot comparison|snapshot comparison/i;

function decodeXmlEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|quot|apos|lt|gt|amp);/g,
    (match, dec?: string, hex?: string) => {
      if (dec) {
        const code = Number.parseInt(dec, 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      if (hex) {
        const code = Number.parseInt(hex, 16);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      switch (match) {
        case "&quot;":
          return '"';
        case "&apos;":
          return "'";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&amp;":
          return "&";
        default:
          return match;
      }
    },
  );
}

function findXmlTagClose(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < xml.length; i += 1) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function parseXmlAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /\b([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(raw)) !== null) {
    const key = match[1]?.toLowerCase();
    if (!key) continue;
    attrs[key] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function parseJunitXml(text: string, acc: ParsedTest[]): boolean {
  if (!/<(?:testsuites|testsuite)\b/i.test(text)) return false;
  let sawSuite = false;
  let currentCase: {
    title: string;
    statusAttr: string;
    failed: boolean;
    skipped: boolean;
    visualFailure: boolean;
    failureText: string;
  } | null = null;
  let ignoredDepth = 0;
  let inFailureTag = false;

  const finalizeCase = (): void => {
    if (!currentCase) return;
    const statusSkipped =
      currentCase.statusAttr === "skipped" ||
      currentCase.statusAttr === "disabled" ||
      currentCase.statusAttr === "ignored" ||
      currentCase.statusAttr === "pending";
    const statusFailed =
      currentCase.statusAttr === "failed" || currentCase.statusAttr === "error";
    const skipped = currentCase.skipped || statusSkipped;
    const failed = !skipped && (currentCase.failed || statusFailed);
    const ok = !failed;
    const visualFailure =
      currentCase.visualFailure ||
      (failed && VISUAL_FAILURE_MESSAGE_RE.test(currentCase.failureText)) ||
      (isVisualTitle(currentCase.title) && failed);
    pushTest(acc, currentCase.title, ok, skipped, visualFailure);
    currentCase = null;
    ignoredDepth = 0;
    inFailureTag = false;
  };

  let pos = 0;
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    if (lt < 0) {
      if (currentCase && ignoredDepth === 0 && inFailureTag) {
        currentCase.failureText += decodeXmlEntities(text.slice(pos));
      }
      break;
    }
    if (lt > pos && currentCase && ignoredDepth === 0 && inFailureTag) {
      currentCase.failureText += decodeXmlEntities(text.slice(pos, lt));
    }
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      pos = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      const body = text.slice(lt + 9, end < 0 ? text.length : end);
      if (currentCase && ignoredDepth === 0 && inFailureTag) {
        currentCase.failureText += body;
      }
      pos = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<?", lt) || text.startsWith("<!", lt)) {
      const end = findXmlTagClose(text, lt + 2);
      pos = end < 0 ? text.length : end + 1;
      continue;
    }
    const end = findXmlTagClose(text, lt + 1);
    if (end < 0) break;
    const inside = text.slice(lt + 1, end).trim();
    pos = end + 1;
    if (!inside) continue;

    if (inside.startsWith("/")) {
      const closeName = inside.slice(1).trim().toLowerCase();
      if (currentCase) {
        if (closeName === "testcase") {
          finalizeCase();
        } else if (closeName === "system-out" || closeName === "system-err") {
          if (ignoredDepth > 0) ignoredDepth -= 1;
        } else if ((closeName === "failure" || closeName === "error") && ignoredDepth === 0) {
          inFailureTag = false;
        }
      }
      continue;
    }

    const selfClosing = inside.endsWith("/");
    const content = selfClosing ? inside.slice(0, -1).trim() : inside;
    const nameMatch = /^([A-Za-z_][\w:.-]*)([\s\S]*)$/.exec(content);
    if (!nameMatch) continue;
    const tagName = nameMatch[1]!.toLowerCase();
    const attrText = nameMatch[2] ?? "";

    if (tagName === "testsuite" || tagName === "testsuites") {
      sawSuite = true;
      continue;
    }
    if (tagName === "testcase" && !currentCase) {
      const attrs = parseXmlAttributes(attrText);
      const title = attrs.name || attrs.classname || "";
      currentCase = {
        title,
        statusAttr: (attrs.status ?? "").toLowerCase(),
        failed: false,
        skipped: false,
        visualFailure: false,
        failureText: "",
      };
      if (selfClosing) finalizeCase();
      continue;
    }
    if (currentCase) {
      if (tagName === "system-out" || tagName === "system-err") {
        if (!selfClosing) ignoredDepth += 1;
        continue;
      }
      if (ignoredDepth > 0) continue;
      if (tagName === "skipped") {
        currentCase.skipped = true;
      } else if (tagName === "failure" || tagName === "error") {
        currentCase.failed = true;
        const attrs = parseXmlAttributes(attrText);
        if (
          VISUAL_FAILURE_MESSAGE_RE.test(attrs.message ?? "") ||
          VISUAL_FAILURE_MESSAGE_RE.test(attrs.type ?? "")
        ) {
          currentCase.visualFailure = true;
        }
        if (!selfClosing) inFailureTag = true;
      }
    }
  }
  return sawSuite;
}

/** Pull a JUnit XML document out of stdout when present. */
export function extractJunitXmlPayload(text: string): string | null {
  if (!/<(?:testsuites|testsuite)\b/i.test(text)) return null;
  const trimmed = text.trim();
  if (/^(?:<\?xml\b|<(?:testsuites|testsuite)\b)/i.test(trimmed)) return trimmed;
  const start = trimmed.search(/<(?:testsuites|testsuite)\b/i);
  if (start < 0) return null;
  const endSuites = trimmed.lastIndexOf("</testsuites>");
  const endSuite = trimmed.lastIndexOf("</testsuite>");
  const end = endSuites >= 0 ? endSuites + "</testsuites>".length : endSuite >= 0 ? endSuite + "</testsuite>".length : trimmed.length;
  return trimmed.slice(start, Math.max(start, end)).trim() || null;
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
    const junit: ParsedTest[] = [];
    if (parseJunitXml(input, junit)) return junit.length === 0;
    const payload = extractJsonPayload(input);
    if (payload === null) return true;
    return reportFailClosed(payload);
  }
  const rec = asRecord(input);
  if (!rec) return true;
  if (rec.error === "no reporter json") return true;
  if (typeof rec.numTotalTests === "number" && rec.numTotalTests === 0) return true;
  const parsed = parseTestReport(rec);
  if (parsed.length === 0) return true;
  return false;
}

export function parseTestReport(input: unknown): ParsedTest[] {
  const acc: ParsedTest[] = [];
  if (typeof input === "string") {
    if (parseNdjson(input, acc)) return acc;
    if (parseJunitXml(input, acc)) return acc;
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
