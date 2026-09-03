import { createLegionEngine, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export async function runAssumeList(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const assumptions = await engine.assumeList();
  if (opts.json) {
    writeJson({ assumptions });
    return 0;
  }
  if (assumptions.length === 0) {
    writeOut("No assumptions.");
    return 0;
  }
  for (const assumption of assumptions) {
    const bits = [assumption.id, assumption.status];
    if (assumption.blocking) bits.push("blocking");
    bits.push(assumption.statement);
    writeOut(bits.join("  "));
  }
  return 0;
}

export async function runAssumeAnswer(
  opts: CliOpts,
  id: string,
  flags: { status?: string },
): Promise<number> {
  const status = flags.status;
  if (status !== "confirmed" && status !== "rejected") {
    refuse("assume answer requires --status confirmed|rejected", HINT.assumeAnswer);
  }
  const trimmed = id.trim();
  if (!trimmed) {
    refuse("assume answer requires an id", HINT.assumeAnswer);
  }
  const engine = createLegionEngine(opts.project);
  const assumption = await engine.assumeAnswer(trimmed, status);
  if (opts.json) {
    writeJson({ ok: true, id: assumption.id, status: assumption.status });
    return 0;
  }
  writeOut(`${status === "confirmed" ? "Confirmed" : "Rejected"} ${assumption.id}.`);
  return 0;
}
