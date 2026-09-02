import { createLegionEngine, findSkillsDir } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { nextCommand } from "./next.js";

export async function runVerify(opts: CliOpts, flags: { id?: string }): Promise<number> {
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  const result = await engine.verify(flags.id);
  const state = await engine.getState();
  const slice = await engine.listSliceTasks();
  const next = nextCommand(state, slice);
  const config = await engine.store.readConfig();
  const viewer = `http://${config.dashboard.bind}:${config.dashboard.port}`;

  if (opts.json) {
    writeJson({
      ok: true,
      taskId: result.taskId ?? null,
      spawned: result.spawned,
      notesPath: result.notesPath ?? null,
      createdTaskIds: result.createdTaskIds,
      extrasReverted: result.extrasReverted,
      lastReview: state.lastReview ?? null,
      next: next.run,
      viewer,
    });
    return 0;
  }

  if (result.notesPath) {
    writeOut(`Walkthrough notes: ${result.notesPath} (optional; not a ship gate).`);
  } else {
    writeOut("Verify complete (optional notes; not a ship gate).");
  }
  for (const id of result.createdTaskIds) {
    writeOut(`Filed ${id} (type: fix).`);
  }
  writeOut(`Next: ${next.run}`);
  writeOut(`Dashboard: ${viewer}`);
  return 0;
}
