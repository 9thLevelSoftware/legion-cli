import type { FakeArtifact } from "@9thlevelsoftware/legion-cli-agents";
import {
  createLegionEngine,
  findSkillsDir,
  type MapLspMode,
  type MapOptions,
} from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export type MapFlags = {
  refresh?: boolean;
  lsp?: boolean;
  noLsp?: boolean;
};

/** Test seam: fake adapter artifacts when LEGION_CLI_ADAPTER=fake. */
function mapFakeArtifacts(): FakeArtifact[] | undefined {
  if (process.env.LEGION_CLI_ADAPTER !== "fake") return undefined;
  const raw = process.env.LEGION_CLI_FAKE_ARTIFACTS?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as FakeArtifact[]) : undefined;
  } catch {
    return undefined;
  }
}

export function mapLspMode(flags: MapFlags, argv: readonly string[]): MapLspMode {
  const lastLsp = argv.lastIndexOf("--lsp");
  const lastNo = argv.lastIndexOf("--no-lsp");
  if (lastLsp === -1 && lastNo === -1) {
    if (flags.noLsp) return "off";
    if (flags.lsp) return "require";
    return "auto";
  }
  return lastNo > lastLsp ? "off" : "require";
}

export async function runMap(opts: CliOpts, flags: MapFlags, argv: readonly string[] = process.argv): Promise<number> {
  const engine = createLegionEngine(opts.project, {
    skillsDir: findSkillsDir(),
    fakeArtifacts: mapFakeArtifacts(),
  });
  const mapOpts: MapOptions = {
    refresh: Boolean(flags.refresh),
    lsp: mapLspMode(flags, argv),
  };
  const result = await engine.map(mapOpts);
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
