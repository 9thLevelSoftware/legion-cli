import { createLegionEngine, HINT, refuse, type ShipPreview } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { closePrompt, isNo, isYes, readLine, slurpStdin } from "./prompt.js";

export type ShipFlags = {
  allowDegradedQa?: boolean;
  pr?: boolean;
  commit?: boolean;
};

async function confirmShip(preview: ShipPreview, json: boolean): Promise<boolean> {
  if (!json) {
    writeOut(`Staged: ${preview.stagedDisplay}`);
    writeOut(`Unrelated files unchanged: ${preview.unrelatedUnchanged ? "yes" : "no"}`);
    if (preview.diff.trim()) writeOut(preview.diff.trimEnd());
    writeOut("Acceptance criteria met?  [Y/n]");
  }
  const answer = await readLine("> ");
  if (isNo(answer)) return false;
  if (answer === "" || isYes(answer)) return true;
  refuse("ship needs Y or n", HINT.ship);
}

export async function runShip(opts: CliOpts, flags: ShipFlags): Promise<number> {
  const engine = createLegionEngine(opts.project);
  try {
    await slurpStdin();
    const receipt = await engine.ship({
      allowDegradedQa: Boolean(flags.allowDegradedQa),
      commit: Boolean(flags.commit),
      pr: Boolean(flags.pr),
      actor: "user",
      confirm: (preview) => confirmShip(preview, opts.json),
    });
    if (opts.json) {
      writeJson({
        ok: true,
        receipt,
        next: flags.commit || flags.pr ? "legion-cli spec new" : "legion-cli ship --pr --commit",
      });
      return 0;
    }
    writeOut("Ship receipt written. Optional: legion-cli ship --pr --commit");
    if (receipt.committed && receipt.commitSha) {
      writeOut(`Commit: ${receipt.commitSha}`);
    }
    if (receipt.prUrl) {
      writeOut(`PR: ${receipt.prUrl}`);
    }
    return 0;
  } finally {
    closePrompt();
  }
}
