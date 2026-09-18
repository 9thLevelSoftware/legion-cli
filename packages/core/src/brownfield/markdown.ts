import type { BrownfieldSeverity } from "../types.js";

/**
 * Deterministic markdown parsing shared by merge, review-status, and pr-plan.
 * Formats are the ones the brownfield skill tells agents to write:
 *   ## Section
 *   ### Heading
 *   - Field: value        (also `* **Field**: value`; continuation lines append)
 */

export const SEVERITIES: readonly BrownfieldSeverity[] = ["critical", "major", "minor", "nit"];
export const CONFIDENCE = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export type Block = {
  heading: string;
  /** Lower-cased field name → value. */
  fields: Record<string, string>;
  raw: string;
};

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function isFence(line: string): boolean {
  return /^\s{0,3}(```|~~~)/.test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Body of the first `## <name>` section (case-insensitive; tolerates `## 4. Name` / `## 4) Name`)
 * up to the next `## ` heading outside a code fence. Empty string when absent.
 */
export function section(text: string, name: string): string {
  const lines = normalizeNewlines(text).split("\n");
  const head = new RegExp(`^##\\s+(?:\\d+[.)]\\s*)?${escapeRegExp(name)}\\b`, "i");
  let start = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) inFence = !inFence;
    if (!inFence && head.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";
  inFence = false;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (isFence(lines[i])) inFence = !inFence;
    if (!inFence && /^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const FIELD_RE = /^\s*[-*]\s*\*{0,2}([A-Za-z][A-Za-z /-]*?)\*{0,2}\s*:\s*(.*)$/;

/** Split text into `### ` blocks (headings inside code fences are ignored). */
export function splitBlocks(text: string): Block[] {
  const lines = normalizeNewlines(text).split("\n");
  const starts: number[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) inFence = !inFence;
    if (!inFence && /^###\s+\S/.test(lines[i])) starts.push(i);
  }
  const blocks: Block[] = [];
  for (let b = 0; b < starts.length; b++) {
    const from = starts[b];
    const to = b + 1 < starts.length ? starts[b + 1] : lines.length;
    const blockLines = lines.slice(from, to);
    const heading = blockLines[0].replace(/^###\s+/, "").trim();
    const fields: Record<string, string> = {};
    let last: string | null = null;
    let fence = false;
    for (const line of blockLines.slice(1)) {
      if (isFence(line)) {
        fence = !fence;
        continue;
      }
      if (fence) continue;
      const match = FIELD_RE.exec(line);
      if (match) {
        last = match[1].trim().toLowerCase();
        fields[last] = match[2].trim();
        continue;
      }
      if (last && line.trim() && !line.trimStart().startsWith("#")) {
        fields[last] = `${fields[last]} ${line.trim()}`.trim();
      }
    }
    blocks.push({ heading, fields, raw: blockLines.join("\n").trim() });
  }
  return blocks;
}

const LEGACY_SEVERITY: [RegExp, BrownfieldSeverity][] = [
  [/\bblocker\b/, "critical"],
  [/\b(bug|high)\b/, "major"],
  [/\b(medium|suggestion)\b/, "minor"],
  [/\b(low|info|informational)\b/, "nit"],
];

/** Map a severity string to the four-level scale. Unknown text maps to `minor`. */
export function normSeverity(value: string | undefined): BrownfieldSeverity {
  const text = (value ?? "").toLowerCase();
  for (const severity of SEVERITIES) {
    if (new RegExp(`\\b${severity}\\b`).test(text)) return severity;
  }
  for (const [re, severity] of LEGACY_SEVERITY) {
    if (re.test(text)) return severity;
  }
  return "minor";
}

export function severityRank(severity: BrownfieldSeverity): number {
  return SEVERITIES.indexOf(severity);
}

/** First word of a field value, lower-cased, stripped of markdown punctuation. */
export function firstWord(value: string | undefined, fallback: string): string {
  const word = (value ?? "").trim().split(/\s+/)[0] ?? "";
  const cleaned = word.toLowerCase().replace(/^[`*|]+|[.,`*|]+$/g, "");
  return cleaned || fallback;
}

export function normConfidence(value: string | undefined): Confidence {
  const word = firstWord(value, "medium");
  return (CONFIDENCE as readonly string[]).includes(word) ? (word as Confidence) : "medium";
}

/** Normalized status word: `needs_confirmation` → `needs-confirmation`. */
export function normStatus(value: string | undefined, fallback: string): string {
  return firstWord(value, fallback).replaceAll("_", "-");
}

export function normKey(...parts: (string | undefined)[]): string {
  return parts
    .map((part) => part ?? "")
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** File portion of a location like `src/a.ts:12`, `` `src/a.ts` (line 3) ``, or `src/a.ts#L3`. */
export function fileKey(location: string | undefined): string {
  const trimmed = (location ?? "").trim().replace(/^`+|`+$/g, "");
  return (trimmed.split(/[:#\s(`]/)[0] ?? "").toLowerCase().replaceAll("\\", "/");
}

/** Strip `[Tag]` and `F-001:` / `R-3.` / `A-2 -` prefixes from a heading. */
export function titleOf(heading: string): string {
  let title = heading.trim();
  for (let i = 0; i < 3; i++) {
    const before = title;
    title = title.replace(/^\[[^\]]+\]\s*/, "");
    title = title.replace(/^[A-Z]{1,3}-?\d+\s*(?:[:.\-]\s*|\s+(?=\[))/, "");
    if (title === before) break;
  }
  return title.trim();
}
