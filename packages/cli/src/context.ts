import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export async function runContextCompact(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const result = await engine.compactContext();
  if (opts.json) {
    writeJson(result);
    return 0;
  }
  if (result.compacted.length === 0 && result.skipped.length === 0) {
    writeOut("No done tasks to compact.");
    return 0;
  }
  if (result.compacted.length > 0) {
    writeOut(`Compacted ${result.compacted.length} task${result.compacted.length === 1 ? "" : "s"}.`);
    for (const task of result.compacted) {
      writeOut(`  ${task.id}  ${task.title}`);
    }
    writeOut("Closed logs: .legion-cli/audit/");
  }
  if (result.skipped.length > 0) {
    writeOut("Skipped (in_progress sibling):");
    for (const task of result.skipped) {
      writeOut(`  ${task.id}  ${task.title}`);
    }
  }
  return 0;
}
