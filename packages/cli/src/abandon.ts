import { createLegionEngine, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { closePrompt, promptIfTty } from "./prompt.js";

export type AbandonFlags = {
  message?: string;
};

export async function runAbandon(opts: CliOpts, flags: AbandonFlags): Promise<number> {
  let message = flags.message?.trim() ?? "";
  if (!message) {
    message = (await promptIfTty("Why abandon this spec? "))?.trim() ?? "";
  }
  if (!message) {
    refuse("abandon requires a message", HINT.abandon);
  }
  const engine = createLegionEngine(opts.project);
  try {
    await engine.abandon(message);
    if (opts.json) {
      writeJson({ ok: true, phase: "abandoned", message, next: "legion-cli spec new" });
      return 0;
    }
    writeOut("Spec abandoned.");
    return 0;
  } finally {
    closePrompt();
  }
}
