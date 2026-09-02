import { createLegionEngine, findSkillsDir, isSliceTerminal } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { nextCommand } from "./next.js";

export async function runExecute(
  opts: CliOpts,
  flags: { id?: string; untilBlocked?: boolean; fix?: boolean },
): Promise<number> {
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  const result = await engine.execute(flags.id ?? "auto", {
    untilBlocked: Boolean(flags.untilBlocked),
    fix: Boolean(flags.fix),
  });
  const state = await engine.getState();
  const slice = await engine.listSliceTasks();
  const next = nextCommand(state, slice);
  const config = await engine.store.readConfig();
  const viewer = `http://${config.dashboard.bind}:${config.dashboard.port}`;
  const last = result.tasks.at(-1);
  const blocked = result.status === "blocked";

  if (opts.json) {
    writeJson({
      ok: !blocked,
      taskId: result.taskId,
      phase: result.phase,
      status: result.status,
      tasks: result.tasks,
      warnings: result.warnings,
      extrasReverted: last?.extrasReverted ?? [],
      incident: Boolean(last?.incident),
      next: next.run,
      viewer,
    });
    return blocked ? 1 : 0;
  }

  for (const outcome of result.tasks) {
    const task = slice.find((item) => item.id === outcome.taskId);
    writeOut(`Starting ${outcome.taskId}${task ? ` (${task.title})` : ""}.`);
    if (outcome.incident) {
      writeOut("inspect .git");
    }
    if (outcome.extrasReverted.length > 0) {
      writeOut(`FileContract extras reverted: ${outcome.extrasReverted.join(", ")}`);
      if (outcome.ticketId) writeOut(`Filed ${outcome.ticketId} (type: scope).`);
    }
    if (outcome.status === "done") {
      writeOut(`Verification PASS. ${outcome.taskId} done.`);
    } else {
      writeOut(`${outcome.taskId} blocked.`);
    }
  }
  for (const warning of result.warnings) writeOut(warning);
  if (flags.untilBlocked && isSliceTerminal(slice) && !blocked) {
    writeOut(`Slice complete. Next: ${next.run}`);
  } else {
    writeOut(`Next: ${next.run}`);
  }
  writeOut(`Dashboard: ${viewer}`);
  return blocked ? 1 : 0;
}
