import { undoLastTask } from "@9thlevelsoftware/legion-cli-core";
import { createLegionStore } from "@9thlevelsoftware/legion-cli-persist";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export type UndoOpts = CliOpts & {
  task?: string;
};

export async function runUndo(opts: UndoOpts): Promise<number> {
  const store = createLegionStore(opts.project);
  const result = await undoLastTask({
    projectRoot: opts.project,
    store,
    taskId: opts.task,
  });

  if (opts.json) {
    writeJson(result);
    return 0;
  }

  writeOut(result.message);
  writeOut("Next: legion-cli status");
  return 0;
}
