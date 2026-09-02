import { createLegionEngine, findSkillsDir } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { nextCommand } from "./next.js";

export async function runReview(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  const result = await engine.review();
  const state = await engine.getState();
  const slice = await engine.listSliceTasks();
  const next = nextCommand(state, slice);
  const config = await engine.store.readConfig();
  const viewer = `http://${config.dashboard.bind}:${config.dashboard.port}`;
  const passed = result.verdict === "PASS";

  if (opts.json) {
    writeJson({
      ok: passed,
      verdict: result.verdict,
      createdTaskIds: result.createdTaskIds,
      extrasReverted: result.extrasReverted,
      phase: state.phase,
      lastReview: state.lastReview ?? null,
      next: next.run,
      viewer,
    });
    return passed ? 0 : 1;
  }

  if (passed) {
    writeOut("Review PASS.");
  } else if (result.createdTaskIds.length > 0) {
    writeOut(`Review FAIL. Spawn created ${result.createdTaskIds.join(", ")}.`);
  } else {
    writeOut("Review FAIL.");
  }
  writeOut(`Next: ${next.run}`);
  writeOut(`Dashboard: ${viewer}`);
  return passed ? 0 : 1;
}
