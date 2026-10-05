import { fakeArtifactsFromEnv } from "./fake-artifacts.js";
import { createLegionEngine, findSkillsDir } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

type MapFlags = {
  refresh?: boolean;
};

function mapLspMode(argv: readonly string[]): "require" | "off" | "auto" {
  const lastLsp = argv.lastIndexOf("--lsp");
  const lastNo = argv.lastIndexOf("--no-lsp");
  if (lastLsp === -1 && lastNo === -1) return "auto";
  return lastNo > lastLsp ? "off" : "require";
}

export async function runMap(opts: CliOpts, flags: MapFlags, argv: readonly string[] = process.argv): Promise<number> {
  const engine = createLegionEngine(opts.project, {
    skillsDir: findSkillsDir(),
    fakeArtifacts: fakeArtifactsFromEnv(),
  });
  const result = await engine.map({
    refresh: Boolean(flags.refresh),
    lsp: mapLspMode(argv),
  });
  if (opts.json) {
    writeJson({ ok: true, ...result });
    return 0;
  }
  writeOut(`Map: ${result.path}`);
  writeOut(`backend: ${result.backend}`);
  writeOut(`modules: ${result.modules}`);
  writeOut(`changed: ${result.changed.length}`);
  writeOut(`Next: ${result.next}`);
  return 0;
}
