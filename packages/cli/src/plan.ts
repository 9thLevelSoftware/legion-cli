import { createLegionEngine, findSkillsDir } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { nextCommand } from "./next.js";

export async function runPlan(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  const readiness = await engine.plan();
  const state = await engine.getState();
  const report = engine.getLastPlanReport();
  const slice = await engine.listSliceTasks();
  const next = nextCommand(state, slice);
  const fails = report?.fails ?? [];
  const concerns = report?.concerns ?? [];

  if (opts.json) {
    writeJson({
      ok: readiness !== "FAIL",
      readiness,
      phase: state.phase,
      fails,
      concerns,
      next: next.run,
    });
    return readiness === "FAIL" ? 1 : 0;
  }

  writeOut(`Readiness: ${readiness}`);
  if (fails.length > 0) {
    writeOut("Fails:");
    for (const line of fails) writeOut(`  ${line}`);
  }
  if (concerns.length > 0) {
    writeOut("Concerns:");
    for (const line of concerns) writeOut(`  ${line}`);
  }
  writeOut(`Next: ${next.run}`);
  return readiness === "FAIL" ? 1 : 0;
}
