import { ASSURANCE_PLAN_PATH, createLegionEngine, findSkillsDir, refuse } from "@9thlevelsoftware/legion-cli-core";
import { parseAdapterFlag } from "./adapter-route.js";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { nextCommand } from "./next.js";

export async function runPlan(opts: CliOpts, flags: { adapter?: string; profile?: string } = {}): Promise<number> {
  if (flags.adapter && flags.profile) refuse("plan --adapter and --profile are mutually exclusive", "legion-cli plan --profile <name>");
  const adapter = parseAdapterFlag(flags.adapter);
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  const readiness = await engine.plan(undefined, { ...(adapter ? { adapter } : {}), ...(flags.profile ? { profile: flags.profile } : {}) });
  const state = await engine.getState();
  const report = engine.getLastPlanReport();
  const slice = await engine.listSliceTasks();
  const next = nextCommand(state, slice);
  const fails = report?.fails ?? [];
  const concerns = report?.concerns ?? [];

  if (opts.json) {
    writeJson({
      ok: readiness !== "FAIL",
      readiness,
      phase: state.phase,
      fails,
      concerns,
      next: next.run,
    });
    return readiness === "FAIL" ? 1 : 0;
  }

  writeOut(`Readiness: ${readiness}`);
  if (fails.length > 0) {
    writeOut("Fails:");
    for (const line of fails) writeOut(`  ${line}`);
  }
  if (concerns.length > 0) {
    writeOut("Concerns:");
    for (const line of concerns) writeOut(`  ${line}`);
  }
  const ready = slice.filter((task) => task.status === "ready");
  const first = ready[0];
  const readyBit = first ? ` (${first.id} ${first.title})` : "";
  writeOut(`${slice.length} tasks, ${ready.length} ready${readyBit}.`);
  if (readiness === "FAIL") {
    writeOut(`Next: ${next.run}`);
  } else {
    writeOut(`Next: ${next.run}`);
  }
  return readiness === "FAIL" ? 1 : 0;
}

export async function runPlanApprove(opts: CliOpts, flags: { checks?: string[]; assurance?: string; assuranceOff?: boolean } = {}): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const receipt = await engine.approvePlan(
    { id: "user" },
    {
      ...(flags.checks?.length ? { verificationCommands: flags.checks } : {}),
      ...(flags.assurance !== undefined ? { assuranceManifestPath: flags.assurance } : {}),
      ...(flags.assuranceOff ? { assuranceOff: true } : {}),
    },
  );
  const workflow = await engine.store.pathExists(ASSURANCE_PLAN_PATH) ? await engine.getWorkflowStatus() : null;
  const next = workflow?.next ?? "legion-cli execute";
  if (opts.json) writeJson({ ok: true, receipt, ...(workflow?.assurance ? { assurance: workflow.assurance } : {}), next });
  else {
    if (workflow?.assurance) {
      const informationFlowLabels = {
        "not-enforced": "not enforced",
        pending: "pending governed execution evidence",
        partial: "partially governed",
        enforced: "enforced by completed governed runs",
      } as const;
      writeOut(`Assurance: ${workflow.assurance.mode}; information-flow ${informationFlowLabels[workflow.assurance.informationFlow]}.`);
    }
    writeOut(`Plan approved. Next: ${next}`);
  }
  return 0;
}

export async function runPlanAcceptance(
  opts: CliOpts,
  flags: { pass?: string[]; fail?: string[]; notApplicable?: string[]; note?: string },
): Promise<number> {
  const entries = [
    ...(flags.pass ?? []).map((id) => ({ id, status: "passed" as const })),
    ...(flags.fail ?? []).map((id) => ({ id, status: "failed" as const })),
    ...(flags.notApplicable ?? []).map((id) => ({ id, status: "not_applicable" as const })),
  ];
  if (entries.length === 0) throw new Error("plan acceptance requires --pass, --fail, or --not-applicable");
  const engine = createLegionEngine(opts.project);
  const receipt = await engine.recordAcceptance(
    entries.map((entry) => ({ ...entry, ...(flags.note ? { note: flags.note } : {}) })),
    { id: "user" },
  );
  const workflow = await engine.getWorkflowStatus();
  if (opts.json) writeJson({ ok: workflow.acceptance.failed.length === 0, receipt, workflow, next: workflow.next });
  else writeOut(`Acceptance evidence recorded. Next: ${workflow.next}`);
  return 0;
}

export async function runPlanEvidence(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const report = await engine.getPlanEvidence();
  const next = (await engine.getWorkflowStatus()).next;
  if (opts.json) writeJson({ ...report, next });
  else {
    writeOut(`Evidence: ${report.adopted ? `adopted; policy ${report.policyStatus}; trace ${report.traceStatus}` : "assurance not adopted"}`);
    for (const criterion of report.criteria) {
      writeOut(`  ${criterion.acceptanceId}: ${criterion.status}; checks ${criterion.checkIds.join(", ") || "none"}`);
      // Core attaches detail only for observations labeled public; IDs, statuses and codes always render.
      for (const observation of criterion.observations) writeOut(`    ${observation.checkId}/${observation.id}: ${observation.status} (${observation.code})${observation.detail === undefined ? "" : ` — ${JSON.stringify(observation.detail)}`}`);
    }
    for (const check of report.checks) writeOut(`  ${check.checkId}: ${check.result}; ${check.decision} — ${check.reason}`);
    if (report.blocker) writeOut(`Blocker: ${report.blocker}`);
    writeOut(`Next: ${next}`);
  }
  return 0;
}

export async function runPlanImpact(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const report = await engine.getPlanImpact();
  const next = (await engine.getWorkflowStatus()).next;
  if (opts.json) writeJson({ ...report, next });
  else {
    writeOut(`Impact: ${report.adopted ? "declared dependencies and observed inputs (not inferred runtime reads)" : "assurance not adopted"}`);
    for (const impact of report.impacts) writeOut(`  ${impact.path}: units ${impact.unitIds.join(", ") || "none"}; tasks ${impact.taskIds.join(", ") || "none"}; checks ${impact.checkIds.join(", ") || "none"}; criteria ${impact.acceptanceIds.join(", ") || "none"}`);
    for (const check of report.checks) writeOut(`  ${check.checkId}: ${check.decision} — ${check.reason}`);
    if (report.blocker) writeOut(`Blocker: ${report.blocker}`);
    writeOut(`Next: ${next}`);
  }
  return 0;
}
