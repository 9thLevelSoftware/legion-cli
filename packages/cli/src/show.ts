import { createLegionEngine, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import { showPage, type ShownPage } from "@9thlevelsoftware/legion-cli-wiki";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export async function runShow(opts: CliOpts, page: string): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const state = await engine.getState();
  if (state.phase === "uninitialized") {
    refuse("Show needs a Legion CLI project first", HINT.init);
  }
  let shown: ShownPage;
  try {
    shown = await showPage(engine.store, page);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    refuse(message, HINT.show);
  }
  if (opts.json) {
    writeJson(shown);
    return 0;
  }
  const header = [
    `${shown.kind}: ${shown.title}`,
    `path: ${shown.path}`,
    shown.trust ? `trust: ${shown.trust}` : "",
    "",
  ].filter((line) => line !== "");
  writeOut([...header, shown.body.replace(/\n+$/, "")].join("\n"));
  return 0;
}
