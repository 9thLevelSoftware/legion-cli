import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export async function runWikiTrust(opts: CliOpts, page: string): Promise<number> {
  const engine = createLegionEngine(opts.project);
  await engine.wikiTrust(page);
  if (opts.json) {
    writeJson({ ok: true, page, trust: "reviewed" });
    return 0;
  }
  writeOut(`Trusted ${page}. Future briefs will include its body.`);
  return 0;
}
