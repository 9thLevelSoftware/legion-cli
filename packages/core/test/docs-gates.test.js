import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const docsPath = join(repoRoot, "docs", "design", "product-engineering-cli.md");
const enginePath = join(repoRoot, "packages", "core", "src", "engine.ts");

/** Hard: Yes rows must have a detector in engine.ts refusal sites. */
const HARD_GATE_DETECTORS = {
  "Intent confirmation": /intent confirmation requires/,
  "Product decisions": /spec requires decisions captured/,
  "Spec approval": /spec freeze requires legion-cli spec approve/,
  Scope: /FileContract extra|outside SkillContract/,
  Deletion: /FileContract extra/,
  "Skipping QA / degraded QA": /allow-degraded-qa/,
  "Final-product review": /ship cancelled/,
};

function parseGateTable(markdown) {
  const section = markdown.split("#### 2.4 Human gates")[1]?.split("#### 2.5")[0];
  assert.ok(section, "docs must contain #### 2.4 Human gates");
  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    if (cells[0] === "Gate" || /^-+$/.test(cells[0].replaceAll(" ", ""))) continue;
    rows.push({ gate: cells[0], how: cells[1], hard: cells[2] });
  }
  return rows;
}

function isHardYes(hard) {
  return /^yes\b/i.test(hard.replace(/\*/g, "").trim());
}

test("Hard: Yes gate rows have an engine.ts detector", () => {
  const docs = readFileSync(docsPath, "utf8");
  const engine = readFileSync(enginePath, "utf8");
  const rows = parseGateTable(docs);
  assert.ok(rows.length >= 8, "gate table is present");
  const hardRows = rows.filter((row) => isHardYes(row.hard));
  for (const row of hardRows) {
    const detector = HARD_GATE_DETECTORS[row.gate];
    assert.ok(detector, `Hard: Yes row "${row.gate}" has no detector in engine.ts`);
    assert.match(
      engine,
      detector,
      `Hard: Yes row "${row.gate}" detector does not match engine.ts refusal sites`,
    );
  }
});
