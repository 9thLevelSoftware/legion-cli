import { createLegionEngine, findSkillsDir } from "@9thlevelsoftware/legion-cli-core";
import { parseAdapterFlag } from "./adapter-route.js";
import { confirmAllowNoSandbox, startingTaskLine } from "./execute.js";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { nextCommand } from "./next.js";
import { closePrompt, slurpStdin } from "./prompt.js";

export async function runFix(
  opts: CliOpts,
  bug: string,
  flags: { adapter?: string; allowNoSandbox?: boolean } = {},
): Promise<number> {
  const adapter = parseAdapterFlag(flags.adapter);
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  try {
    if (flags.allowNoSandbox) {
      await slurpStdin();
      await confirmAllowNoSandbox("fix");
    }
  const config = await engine.store.readConfig();
  if (config.workflow?.profile === "focused") {
    const task = await engine.proposeFix(bug);
    const next = "legion-cli plan approve";
    if (opts.json) {
      writeJson({ ok: true, taskId: task.id, status: "proposed", next });
      return 0;
    }
    writeOut(`Filed ${task.id} as a proposed amendment. Review and approve the updated plan before execution.`);
    writeOut(`Next: ${next}`);
    return 0;
  }
  const task = await engine.fix(bug);
  const executed = await engine.execute(task.id, {
    fix: true,
    allowNoSandbox: Boolean(flags.allowNoSandbox),
    ...(adapter ? { adapter } : {}),
  });
  const state = await engine.getState();
  const slice = await engine.listSliceTasks();
  const next = nextCommand(state, slice);
  const viewer = `http://${config.dashboard.bind}:${config.dashboard.port}`;
  const green = executed.status === "done";
  const testPath = task.contract.filesAllowed[0] ?? "";

  if (opts.json) {
    writeJson({
      ok: green,
      taskId: task.id,
      testPath,
      status: executed.status,
      extrasReverted: executed.tasks.at(-1)?.extrasReverted ?? [],
      next: next.run,
      viewer,
    });
    return green ? 0 : 1;
  }

  writeOut(`Filed ${task.id} (type: bug). Reproducing test is RED: ${testPath}`);
  const last = executed.tasks.at(-1);
  writeOut(startingTaskLine(task.id, task.title, last?.adapterId));
  if (green) {
    writeOut(`${task.id} GREEN. Test stays in git.`);
  } else {
    writeOut(`${task.id} did not go GREEN.`);
  }
  writeOut(`Next: ${next.run}`);
  writeOut(`Dashboard: ${viewer}`);
  return green ? 0 : 1;
  } finally {
    closePrompt();
  }
}
