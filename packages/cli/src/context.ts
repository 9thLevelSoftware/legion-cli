import { createLegionEngine, type GovernanceInspection } from "@9thlevelsoftware/legion-cli-core";
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

/** Statuses under which governed writes may proceed: validation passes and `status` is the next step. */
const USABLE_GOVERNANCE: Record<GovernanceInspection["current"]["status"], boolean> = {
  "valid": true,
  "not-adopted": true,
  "incomplete": false,
  "invalid": false,
  "interrupted-epoch": false,
};

async function readGovernance(opts: CliOpts): Promise<{ inspection: GovernanceInspection; usable: boolean; currentLine: string }> {
  const inspection = await createLegionEngine(opts.project).inspectGovernance();
  const { current } = inspection;
  return {
    inspection,
    usable: USABLE_GOVERNANCE[current.status],
    currentLine: `Current: ${current.approvalId ?? "no approval"} (${current.adopted ? "adopted" : "not adopted"}): ${current.status}`,
  };
}

export async function runContextTrace(opts: CliOpts): Promise<number> {
  const { inspection, usable, currentLine } = await readGovernance(opts);
  if (opts.json) {
    writeJson(inspection);
    return 0;
  }
  if (inspection.epochs.length === 0) writeOut("No governance epochs recorded.");
  for (const epoch of inspection.epochs) {
    const last = epoch.lastAction ? `; last ${epoch.lastAction}/${epoch.lastOutcome}` : "";
    writeOut(`  #${epoch.sequence}  ${epoch.approvalId ?? "no approval"}  ${epoch.adopted ? "adopted" : "not adopted"}  ${epoch.status}; ${epoch.frames} frame${epoch.frames === 1 ? "" : "s"}${last}`);
  }
  writeOut(currentLine);
  writeOut(`Next: ${usable ? "legion-cli status" : "legion-cli plan approve"}`);
  return 0;
}

export async function runContextTraceValidate(opts: CliOpts): Promise<number> {
  const { inspection, usable: ok, currentLine } = await readGovernance(opts);
  if (opts.json) {
    writeJson({ ok, current: inspection.current, epochs: inspection.epochs });
    return ok ? 0 : 1;
  }
  for (const epoch of inspection.epochs) {
    writeOut(`  #${epoch.sequence}  ${epoch.approvalId ?? "no approval"}: ${epoch.status}`);
    for (const violation of epoch.violations) {
      writeOut(`    frame ${violation.sequence} ${violation.code}: ${violation.detail}`);
    }
  }
  writeOut(currentLine);
  writeOut(ok ? "Governance trace valid." : `Governance trace ${inspection.current.status}. Next: legion-cli plan approve`);
  return ok ? 0 : 1;
}
