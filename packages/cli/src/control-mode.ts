import { createLegionEngine, HINT } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export async function runControlMode(opts: CliOpts, mode?: string): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const trimmed = mode?.trim();
  if (!trimmed) {
    const current = await engine.getControlMode();
    if (opts.json) {
      writeJson({ control_mode: current });
      return 0;
    }
    writeOut(`control_mode: ${current}`);
    return 0;
  }

  const next = await engine.setControlMode(trimmed);
  if (opts.json) {
    writeJson({ ok: true, control_mode: next, next: HINT.doctor });
    return 0;
  }
  writeOut(`control_mode: ${next}\nNext: ${HINT.doctor}`);
  return 0;
}
