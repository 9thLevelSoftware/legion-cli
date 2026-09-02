import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export async function runPromote(opts: CliOpts, runId: string): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const result = await engine.promoteRun(runId);

  if (opts.json) {
    writeJson({
      ok: true,
      runId: result.runId,
      pages: result.pages,
      next: "legion-cli spec",
    });
    return 0;
  }

  writeOut(`Promoted run ${result.runId} into the wiki.`);
  for (const page of result.pages) writeOut(`  ${page}`);
  writeOut("Next: legion-cli spec");
  return 0;
}
