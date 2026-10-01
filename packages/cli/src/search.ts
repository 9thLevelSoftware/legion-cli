import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeJsonLine, writeOut } from "./io.js";

export type SearchFlags = {
  includeUntrusted?: boolean;
  mentions?: boolean;
  limit?: number;
};

export async function runSearch(
  opts: CliOpts,
  query: string,
  flags: SearchFlags,
  jsonExtra?: Record<string, unknown>,
  output?: { jsonLines?: boolean },
): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const allHits = await engine.search(query, {
    includeUntrusted: flags.includeUntrusted,
    mentions: flags.mentions,
  });
  const limit = flags.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error("search --limit must be a positive integer");
  }
  const hits = limit === undefined ? allHits : allHits.slice(0, limit);
  const truncated = hits.length < allHits.length;
  if (opts.json) {
    const payload = { query, hits, truncated, total: allHits.length, ...jsonExtra };
    if (output?.jsonLines) writeJsonLine(payload);
    else writeJson(payload);
    return 0;
  }
  if (hits.length === 0) {
    writeOut("No matches.");
    return 0;
  }
  const lines: string[] = [];
  for (const hit of hits) {
    const via = hit.via === "fts" ? "" : ` [${hit.via}]`;
    const trust = hit.trust === "untrusted" ? " untrusted" : "";
    lines.push(`${hit.title}  ${hit.path}${via}${trust}`);
    if (hit.snippet) {
      for (const snippetLine of hit.snippet.split("\n")) {
        lines.push(`  ${snippetLine}`);
      }
    }
  }
  if (truncated) lines.push(`(showing ${hits.length} of ${allHits.length}; rerun without --limit for all matches)`);
  writeOut(lines.join("\n"));
  return 0;
}
