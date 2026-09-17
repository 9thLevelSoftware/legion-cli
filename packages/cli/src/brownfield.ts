import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeErr, writeJson, writeOut } from "./io.js";

export type BrownfieldFlags = {
  effort?: string;
  execute?: boolean;
  resume?: string;
  context?: string[];
  lsp?: boolean;
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
    lsp: Boolean(flags.lsp),
  });

  if (flags.lsp && result.effort < 5) {
    writeErr("--lsp is ignored for effort 1–4 (pass-through to map on effort 5)");
  }

  if (opts.json) {
    writeJson({
      ok: true,
      ...result,
      next: `legion-cli run promote ${result.runId}`,
    });
    return 0;
  }

  writeOut(`Brownfield run ${result.runId}, effort ${result.effort}: architecture + code. execute: ${result.execute}`);
  writeOut(`Wrote .legion-cli/runs/${result.runId}/`);
  writeOut(`Pages: ${result.pages.join(", ")}`);
  writeOut("Not the durable wiki unless promoted (untrusted until wiki trust; re-promote overwrites).");
  if (result.worktreePath) {
    writeOut(`Worktree: ${result.worktreePath} (branch brownfield/${result.runId})`);
    writeOut("Greenfield execute stays in-place; brownfield --execute uses git worktrees.");
  }
  writeOut(`Resume: legion-cli brownfield --resume ${result.runId}`);
  writeOut(`Next: legion-cli run promote ${result.runId}`);
  return 0;
}
