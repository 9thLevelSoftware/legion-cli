import { createLegionEngine, findSkillsDir } from "@9thlevelsoftware/legion-cli-core";
import { parseAdapterFlag } from "./adapter-route.js";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { nextCommand } from "./next.js";

export async function runPlan(opts: CliOpts, flags: { adapter?: string } = {}): Promise<number> {
  const adapter = parseAdapterFlag(flags.adapter);
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  const readiness = await engine.plan(undefined, adapter ? { adapter } : undefined);
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
  const ready = slice.filter((task) => task.status === "ready");
  const first = ready[0];
  const readyBit = first ? ` (${first.id} ${first.title})` : "";
  writeOut(`${slice.length} tasks, ${ready.length} ready${readyBit}.`);
  if (readiness === "FAIL") {
    writeOut(`Next: ${next.run}`);
  } else {
    writeOut(`Next: ${next.run}     (viewer: legion-cli dashboard)`);
  }
  return readiness === "FAIL" ? 1 : 0;
}
