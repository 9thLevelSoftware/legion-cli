import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export type SearchFlags = {
  includeUntrusted?: boolean;
  mentions?: boolean;
};

export async function runSearch(opts: CliOpts, query: string, flags: SearchFlags): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const hits = await engine.search(query, {
    includeUntrusted: flags.includeUntrusted,
    mentions: flags.mentions,
  });
  if (opts.json) {
    writeJson({ query, hits });
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
  writeOut(lines.join("\n"));
  return 0;
}
