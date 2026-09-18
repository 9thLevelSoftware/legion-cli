import { createLegionEngine, findSkillsDir } from "@9thlevelsoftware/legion-cli-core";
import type { FakeArtifact } from "@9thlevelsoftware/legion-cli-agents";
import { parseAdapterFlag } from "./adapter-route.js";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { nextCommand } from "./next.js";

export type WireframeFlags = {
  restyle?: boolean;
  spawn?: boolean;
  adapter?: string;
};

/** Test seam: fake adapter artifacts when LEGION_CLI_ADAPTER=fake. */
function wireframeFakeArtifacts(): FakeArtifact[] | undefined {
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

export async function runWireframe(opts: CliOpts, flags: WireframeFlags): Promise<number> {
  const adapter = parseAdapterFlag(flags.adapter);
  const engine = createLegionEngine(opts.project, {
    skillsDir: findSkillsDir(),
    fakeArtifacts: wireframeFakeArtifacts(),
  });
  const result = await engine.wireframe({
    restyle: Boolean(flags.restyle),
    spawn: Boolean(flags.spawn),
    ...(adapter ? { adapter } : {}),
  });
  const state = await engine.getState();
  const slice = await engine.listSliceTasks();
  const next = nextCommand(state, slice);
  const nextRun = result.status === "draft" ? "legion-cli spec approve" : next.run;

  if (opts.json) {
    writeJson({
      ok: true,
      specId: result.specId,
      status: result.status,
      index: result.index,
      pages: result.pages,
      restyled: result.restyled,
      next: nextRun,
    });
    return 0;
  }

  if (result.restyled) {
    writeOut(`Restyled ${result.index}`);
  } else {
    writeOut(`Wrote ${result.index}`);
  }
  writeOut(`${result.pages.length} screens.`);
  writeOut(`Next: ${nextRun}`);
  return 0;
}
