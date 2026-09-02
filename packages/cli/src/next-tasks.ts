import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { formatReadyTaskLine } from "./next.js";

export async function runNextTasks(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const ready = await engine.nextTasks();
  if (opts.json) {
    writeJson({
      ready: ready.map((task) => ({
        id: task.id,
        title: task.title,
        priority: task.priority,
        status: task.status,
        ...(task.adapter ? { adapter: task.adapter } : {}),
      })),
      next: ready[0] ? `legion-cli execute ${ready[0].id}` : "legion-cli status --blockers",
    });
    return 0;
  }
  if (ready.length === 0) {
    writeOut("No ready tasks.");
    writeOut("Run:  legion-cli status --blockers");
    return 0;
  }
  writeOut("Ready:");
  for (const task of ready) {
    writeOut(formatReadyTaskLine(task));
  }
  writeOut(`Run:  legion-cli execute ${ready[0].id}`);
  return 0;
}
