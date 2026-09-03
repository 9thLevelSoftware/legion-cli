import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export async function runIndexRebuild(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  await engine.indexRebuild();
  if (opts.json) {
    writeJson({ ok: true });
    return 0;
  }
  writeOut("Rebuilt search index.");
  return 0;
}
