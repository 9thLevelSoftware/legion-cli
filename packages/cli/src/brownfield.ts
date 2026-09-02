import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export type BrownfieldFlags = {
  effort?: string;
  execute?: boolean;
  resume?: string;
  context?: string[];
};

export async function runBrownfield(opts: CliOpts, flags: BrownfieldFlags): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const effortRaw = flags.effort?.trim();
  const effort = effortRaw === undefined || effortRaw === "" ? undefined : Number(effortRaw);
  const result = await engine.brownfield({
    effort,
    execute: Boolean(flags.execute),
    resume: flags.resume,
    context: (flags.context ?? []).join(" ").trim(),
  });

  if (opts.json) {
    writeJson({
      ok: true,
      ...result,
      next: `legion-cli run promote ${result.runId}`,
    });
    return 0;
  }

  writeOut(`Brownfield run ${result.runId}, effort 1: architecture + code. execute: ${result.execute}`);
  writeOut(`Wrote .legion-cli/runs/${result.runId}/`);
  writeOut(`Pages: ${result.pages.join(", ")}`);
  writeOut("Not the durable wiki unless promoted.");
  if (result.worktreePath) {
    writeOut(`Worktree: ${result.worktreePath} (branch brownfield/${result.runId})`);
    writeOut("Greenfield execute stays in-place; brownfield --execute uses git worktrees.");
  }
  writeOut(`Resume: legion-cli brownfield --resume ${result.runId}`);
  writeOut(`Next: legion-cli run promote ${result.runId}`);
  return 0;
}
