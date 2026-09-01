import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { renderSessionBrief } from "@9thlevelsoftware/legion-cli-wiki";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export async function runBrief(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const brief = await engine.brief();
  if (opts.json) {
    writeJson(brief);
    return 0;
  }
  writeOut(renderSessionBrief(brief).trimEnd());
  return 0;
}
