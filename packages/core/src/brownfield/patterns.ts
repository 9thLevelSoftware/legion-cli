import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import {
  BrownfieldPatternsFileSchema,
  SCHEMA_VERSION,
  type BrownfieldPatternsFile,
} from "@9thlevelsoftware/legion-cli-schema";
import { HINT, refuse } from "../errors.js";
import type { BrownfieldPatternsOptions, BrownfieldPatternsResult } from "../types.js";
import { PATTERNS_STORE_PATH, storeAbs } from "./paths.js";
import { assertBrownfieldReady, nowIso } from "./state.js";

const MAX_PATTERN_CHARS = 300;

async function readPatterns(abs: string): Promise<BrownfieldPatternsFile> {
  const empty: BrownfieldPatternsFile = { schemaVersion: SCHEMA_VERSION.brownfieldPatterns, patterns: {} };
  if (!existsSync(abs)) return empty;
  let raw: unknown = null;
  try {
    raw = JSON.parse(await readFile(abs, "utf8"));
  } catch {
    raw = null;
  }
  const parsed = BrownfieldPatternsFileSchema.safeParse(raw);
  if (!parsed.success) {
    refuse(`${PATTERNS_STORE_PATH} failed schema validation`, `fix or delete ${PATTERNS_STORE_PATH}`);
  }
  return parsed.data;
}

/**
 * Cross-run, codebase-agnostic lessons ("missing authorization check on object-level access").
 * Lives in the gitignored runs dir, so it does not survive a fresh clone.
 */
export async function patternsRun(
  store: LegionStore,
  opts: BrownfieldPatternsOptions = {},
): Promise<BrownfieldPatternsResult> {
  await assertBrownfieldReady(store);
  const top = opts.top ?? 10;
  if (!Number.isInteger(top) || top < 1) {
    refuse("brownfield patterns --top must be a positive integer", HINT.brownfieldPatterns);
  }
  const abs = storeAbs(store.projectRoot, PATTERNS_STORE_PATH);
  const data = await readPatterns(abs);

  const added: string[] = [];
  const now = nowIso();
  for (const raw of opts.add ?? []) {
    const pattern = raw.replace(/\s+/g, " ").trim();
    if (!pattern) continue;
    if (pattern.length > MAX_PATTERN_CHARS) {
      refuse(`brownfield pattern longer than ${MAX_PATTERN_CHARS} chars; generalize it`, HINT.brownfieldPatterns);
    }
    const entry = data.patterns[pattern] ?? { count: 0, firstSeen: now, lastSeen: now };
    data.patterns[pattern] = { ...entry, count: entry.count + 1, lastSeen: now };
    added.push(pattern);
  }
  if (added.length > 0) {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `${JSON.stringify(BrownfieldPatternsFileSchema.parse(data), null, 2)}\n`, "utf8");
  }
  const ranked = Object.entries(data.patterns)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([pattern, entry]) => ({ pattern, count: entry.count }));
  return { file: PATTERNS_STORE_PATH, added, top: ranked };
}
