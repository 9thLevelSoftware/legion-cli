import { createLegionEngine, HINT } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export type PromoteFlags = {
  trust?: boolean;
};

function wikiTrustNext(pages: string[]): string {
  const first = pages[0];
  if (!first) return HINT.wikiTrust;
  const id = first.replace(/^\.legion-cli\/wiki\//, "").replace(/\.md$/i, "");
  return `legion-cli wiki trust ${id}`;
}

export async function runPromote(opts: CliOpts, runId: string, flags: PromoteFlags = {}): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const result = await engine.promoteRun(runId, { trust: Boolean(flags.trust) });
  const next = result.trust === "reviewed" ? "legion-cli spec" : wikiTrustNext(result.pages);

  if (opts.json) {
    writeJson({
      ok: true,
      runId: result.runId,
      pages: result.pages,
      trust: result.trust,
      next,
    });
    return 0;
  }

  writeOut(`Promoted run ${result.runId} into the wiki (${result.trust}).`);
  for (const page of result.pages) writeOut(`  ${page}`);
  if (result.trust === "untrusted") {
    writeOut("Pages stay untrusted until wiki trust.");
  }
  writeOut(`Next: ${next}`);
  return 0;
}
