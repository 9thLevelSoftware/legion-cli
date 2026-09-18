import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runPagePath, WIKI_PAGE_SCHEMA_VERSION, wikiRunPagePath, type LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { HINT, refuse } from "../errors.js";
import type { PromoteRunOptions, PromoteRunResult } from "../types.js";
import { runAbs } from "./paths.js";
import { nowIso, parseRunId, readRun, writeRun } from "./state.js";

/** Top-level pages first, in reading order; `intent.md` first so `wiki trust` Next targets it. */
const TOP_ORDER = ["intent.md", "summary.md", "design.md", "findings.md", "assumptions.md", "plan.md", "verify.md"];
const DIR_ORDER = ["analysis", "reviews", "exec", "evidence"];

async function listRunMarkdown(dir: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listRunMarkdown(join(dir, entry.name), childRel)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.md$/i.test(entry.name) || /\.prev\.md$/i.test(entry.name)) continue;
    out.push(childRel);
  }
  return out;
}

export function orderRunPages(pages: readonly string[]): string[] {
  const rank = (page: string): [number, number, string] => {
    const slash = page.indexOf("/");
    if (slash < 0) {
      const top = TOP_ORDER.indexOf(page);
      return [0, top < 0 ? TOP_ORDER.length : top, page];
    }
    const dir = DIR_ORDER.indexOf(page.slice(0, slash));
    return [1, dir < 0 ? DIR_ORDER.length : dir, page];
  };
  return [...pages].sort((a, b) => {
    const [ga, ra, na] = rank(a);
    const [gb, rb, nb] = rank(b);
    return ga - gb || ra - rb || na.localeCompare(nb);
  });
}

/** Copy every markdown page of a run into `.legion-cli/wiki/runs/<id>/`. Untrusted unless `trust`. */
export async function promoteBrownfieldRun(
  store: LegionStore,
  runIdRaw: string,
  opts: PromoteRunOptions = {},
): Promise<PromoteRunResult> {
  if (!(await store.pathExists(".legion-cli/STATE.md"))) {
    refuse("run promote is refused until init", HINT.init);
  }
  const runId = parseRunId(runIdRaw);
  const run = await readRun(store, runId);
  // Re-promote always overwrites wiki body and trust. Ingest skip-if-unchanged does not apply.
  const trust = opts.trust === true ? "reviewed" : "untrusted";
  const pages = orderRunPages(await listRunMarkdown(runAbs(store.projectRoot, runId)));
  if (pages.length === 0) {
    refuse(`run ${runId} has no markdown pages to promote`, HINT.brownfieldResume);
  }
  const copied: string[] = [];
  for (const rel of pages) {
    const sourceStore = runPagePath(runId, rel);
    const body = await readFile(runAbs(store.projectRoot, runId, rel), "utf8");
    const dest = wikiRunPagePath(runId, rel);
    await store.writeWikiPage(
      dest,
      {
        schemaVersion: WIKI_PAGE_SCHEMA_VERSION,
        title: `Brownfield ${runId} ${rel.replace(/\.md$/i, "")}`,
        aliases: [],
        tags: ["brownfield", "run"],
        trust,
        updated: nowIso(),
        source: sourceStore,
      },
      body,
    );
    copied.push(dest);
  }
  await writeRun(store.projectRoot, { ...run, promoted: true });
  await store.rebuild();
  return { runId, pages: copied, trust };
}
