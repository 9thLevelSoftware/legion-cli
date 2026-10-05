import {
  ASSURANCE_PLAN_PATH,
  createLegionEngine,
  LegionRefuseError,
  listRunRecoveryStatuses,
  type RunRecoveryStatus,
  type WorkflowStatus,
} from "@9thlevelsoftware/legion-cli-core";
import { EXPOSE_BIND, LOOPBACK_BIND, readLiveServe } from "@9thlevelsoftware/legion-cli-dashboard";
import {
  AuditTamperError,
  listTaskSummaries,
  PersistValidationError,
  verifyAuditChain,
} from "@9thlevelsoftware/legion-cli-persist";
import type { AdapterId, LegionConfig, ProjectFile, StateFile } from "@9thlevelsoftware/legion-cli-schema";
import type { CliOpts } from "./io.js";
import { writeJson, writeJsonLine, writeOut } from "./io.js";
import { ADVISORY_EXECUTION_NEXT, collectBlockers, nextCommand, statusExitCode, type StatusSliceTask } from "./next.js";

async function readOptionalProject(engine: ReturnType<typeof createLegionEngine>): Promise<ProjectFile | null> {
  if (!(await engine.store.pathExists(".legion-cli/PROJECT.md"))) return null;
  return (await engine.store.readProject()).data;
}

async function readOptionalConfig(engine: ReturnType<typeof createLegionEngine>): Promise<LegionConfig | null> {
  if (!(await engine.store.pathExists(".legion-cli/config.yaml"))) return null;
  try {
    return await engine.store.readConfig();
  } catch (err) {
    if (err instanceof PersistValidationError) throw err;
    return null;
  }
}

async function liveViewer(projectRoot: string): Promise<{ viewer: string; live: boolean }> {
  const live = await readLiveServe(projectRoot);
  if (!live) return { viewer: "legion-cli serve", live: false };
  const host =
    live.bind === EXPOSE_BIND || live.bind === "::" || live.bind === "0.0.0.0" ? LOOPBACK_BIND : live.bind;
  return { viewer: `http://${host}:${live.port}`, live: true };
}

function formatHuman(input: {
  project: ProjectFile | null;
  state: StateFile;
  next: { run: string; hint: string };
  blockers: { detail: string }[];
  blockersOnly: boolean;
  currentTaskAdapter: AdapterId | null;
  run: RunRecoveryStatus | null;
}): string {
  const { project, state, next, blockers, blockersOnly, currentTaskAdapter, run } = input;
  if (blockersOnly) {
    const details = blockers.map((item) => item.detail);
    if (details.length === 0) return "No blockers.";
    return ["Blockers:", ...details.map((detail) => `  ${detail}`)].join("\n");
  }

  const lines: string[] = [];
  if (state.phase === "uninitialized" || !project) {
    lines.push("phase: uninitialized");
    lines.push(`Next up: ${next.hint}`);
    lines.push(`Run:  ${next.run}`);
    lines.push("Supported command: pnpm exec legion-cli");
    return lines.join("\n");
  }

  lines.push(`${project.name}  ·  ${project.mode}  ·  phase: ${state.phase}`);
  if (state.currentTaskId) {
    const adapterBit = currentTaskAdapter ? ` (${currentTaskAdapter})` : "";
    lines.push(`Current task: ${state.currentTaskId}${adapterBit}`);
  }
  if (state.lastReadiness) lines.push(`Readiness: ${state.lastReadiness}`);
  if (state.lastReview) lines.push(`Review: ${state.lastReview}`);
  if (run) {
    lines.push(`Execution run: ${run.runId}  ·  ${run.stage}  ·  owner ${run.ownerStatus}`);
    lines.push(`Logs: ${run.logs.stdout}${run.logs.stderr ? `; ${run.logs.stderr}` : ""}`);
    if (run.interruptionReason) lines.push(`Interrupted: ${run.interruptionReason}`);
    if (run.recoveryCommand) lines.push(`Recover: ${run.recoveryCommand}`);
  }
  lines.push(`Next up: ${next.hint}`);
  lines.push(`Run:  ${next.run}`);
  if (blockers.length > 0) {
    lines.push("Blockers:");
    for (const item of blockers) lines.push(`  ${item.detail}`);
  }
  return lines.join("\n");
}

function formatPlain(input: {
  project: ProjectFile | null;
  state: StateFile;
  next: { run: string };
  blockers: { detail: string }[];
  currentTaskAdapter: AdapterId | null;
  run: RunRecoveryStatus | null;
}): string {
  const name = input.project?.name ?? "";
  const mode = input.project?.mode ?? "";
  const lines = [
    `name\t${name}`,
    `mode\t${mode}`,
    `phase\t${input.state.phase}`,
    `next\t${input.next.run}`,
  ];
  if (input.state.currentTaskId) lines.push(`currentTask\t${input.state.currentTaskId}`);
  if (input.currentTaskAdapter) lines.push(`currentTaskAdapter\t${input.currentTaskAdapter}`);
  if (input.run) {
    lines.push(`runId\t${input.run.runId}`);
    lines.push(`runStage\t${input.run.stage}`);
    lines.push(`runOwner\t${input.run.ownerStatus}`);
    if (input.run.recoveryCommand) lines.push(`recovery\t${input.run.recoveryCommand}`);
  }
  if (input.state.lastReadiness) lines.push(`readiness\t${input.state.lastReadiness}`);
  if (input.blockers.length > 0) {
    for (const item of input.blockers) lines.push(`blocker\t${item.detail}`);
  }
  return lines.join("\n");
}

/**
 * Full replay of the audit chain (routine appends verify only the tail). Null when sound; the
 * message when a stored line was edited or removed, or chain.json/events.jsonl is unreadable.
 * A crash gap is healable and not reported.
 */
export async function auditChainProblem(projectRoot: string): Promise<string | null> {
  try {
    await verifyAuditChain(projectRoot, { allowExtend: true });
    return null;
  } catch (err) {
    if (err instanceof AuditTamperError) return err.message;
    const message = err instanceof Error ? err.message : String(err);
    return `audit chain unreadable: ${message}`;
  }
}

export async function runStatus(
  opts: CliOpts,
  jsonExtra?: Record<string, unknown>,
  output?: { jsonLines?: boolean },
  engineOverride?: ReturnType<typeof createLegionEngine>,
): Promise<number> {
  const engine = engineOverride ?? createLegionEngine(opts.project);
  const state = await engine.getState();
  const project = state.phase === "uninitialized" ? null : await readOptionalProject(engine);
  const config = await readOptionalConfig(engine);
  const summaries = state.phase === "uninitialized" ? [] : await listTaskSummaries(opts.project);
  const slice: StatusSliceTask[] = state.activeSpecId
    ? summaries
        .filter((row) => row.ok && row.specId === state.activeSpecId)
        .map((row) => ({ id: row.id, title: row.title, status: row.status as StatusSliceTask["status"] }))
    : [];
  let workflow: WorkflowStatus | null = null;
  const assuranceAdopted = await engine.store.pathExists(ASSURANCE_PLAN_PATH);
  const legacyExecuting = state.phase === "executing" && config?.workflow?.profile !== "focused" && !assuranceAdopted;
  if (state.phase !== "uninitialized" && !legacyExecuting) {
    try {
      workflow = await engine.getWorkflowStatus();
    } catch (err) {
      const auditFailure = err instanceof AuditTamperError || (err instanceof LegionRefuseError && /audit chain/i.test(err.message));
      if (!auditFailure && config?.workflow?.profile === "focused") throw err;
      // Corrupt audit history is reported below as a status blocker, not as an empty status response.
      workflow = null;
    }
  }
  if (workflow?.assurance?.coverage?.some((criterion) => criterion.status === "unknown") && workflow.assurance.traceStatus === "valid") {
    workflow = { ...workflow, assurance: { ...workflow.assurance, traceStatus: "incomplete" } };
  }
  const blockers = collectBlockers(state.lastReadiness, state.lastReview, slice);
  if (workflow?.blocker) blockers.push({ kind: "workflow", detail: workflow.blocker });
  const auditProblem = state.phase === "uninitialized" ? null : await auditChainProblem(opts.project);
  if (auditProblem) {
    blockers.push({ kind: "audit", detail: `audit chain: ${auditProblem} (run \`legion-cli doctor\`)` });
  }
  const { viewer, live: viewerLive } = await liveViewer(opts.project);
  const legacyCode = statusExitCode(state.lastReadiness, slice);
  const code =
    workflow?.execution === "blocked" || workflow?.execution === "stale" || workflow?.planApproval === "stale"
      ? 2
      : workflow?.assurance?.coverage?.some((criterion) => criterion.status === "unknown") || workflow?.assurance?.traceStatus === "incomplete"
        ? 2
        : workflow?.acceptance.failed.length
          ? 1
          : legacyCode;
  const next = nextCommand(state, slice, project?.mode, config?.control_mode);
  const current = summaries.find((row) => row.id === state.currentTaskId);
  const currentTaskAdapter = (current?.adapter as AdapterId | null | undefined) ?? null;
  const runs = state.phase === "uninitialized" ? [] : await listRunRecoveryStatuses(opts.project);
  const run = runs.find((item) => item.taskId === state.currentTaskId) ?? runs[0] ?? null;
  const pendingGovernedActions =
    workflow?.assurance?.mode === "information-flow" ? await engine.getPendingGovernedActions() : [];
  const advisoryBlocksNext = config?.control_mode === "advisory" && (
    workflow?.next === "legion-cli execute" ||
    workflow?.next.startsWith("legion-cli execute ") ||
    (config.workflow?.profile !== "focused" && next.run === ADVISORY_EXECUTION_NEXT.run)
  );
  const workflowNext = advisoryBlocksNext
    ? ADVISORY_EXECUTION_NEXT
    : legacyExecuting
      ? { run: "legion-cli plan approve", hint: "approve the implementation plan before execution." }
      : workflow
        ? {
            run: workflow.next,
            hint: workflow.next === "legion-cli spec" && workflow.blocker ? workflow.blocker : next.hint,
          }
        : next;
  if (opts.json) {
    const payload = {
      name: project?.name ?? null,
      mode: project?.mode ?? null,
      phase: state.phase,
      currentTaskId: state.currentTaskId ?? null,
      currentTaskAdapter,
      activeSpecId: state.activeSpecId ?? null,
      lastReadiness: state.lastReadiness ?? null,
      lastReview: state.lastReview ?? null,
      next: workflowNext,
      blockers,
      viewer,
      viewerLive,
      runs,
      pendingGovernedActions,
      ...(workflow?.assurance ? { assurance: workflow.assurance } : {}),
      ...jsonExtra,
    };
    if (output?.jsonLines) writeJsonLine(payload);
    else writeJson(payload);
    return code;
  }
  if (workflow?.assurance) {
    const informationFlowLabels = {
      "not-enforced": "not enforced",
      pending: "pending governed execution evidence",
      partial: "partially governed",
      enforced: "enforced by completed governed runs",
    } as const;
    writeOut(`Assurance approval: ${workflow.assurance.status} (${workflow.assurance.mode ?? "unknown"}; information-flow ${informationFlowLabels[workflow.assurance.informationFlow]})`);
    if (workflow.assurance.traceStatus) writeOut(`Trace: ${workflow.assurance.traceStatus}; policy ${workflow.assurance.policyStatus}`);
    if (workflow.assurance.coverage) {
      const coverage = workflow.assurance.coverage;
      writeOut(`Coverage: ${coverage.filter((criterion) => criterion.status === "covered").length} covered; ${coverage.filter((criterion) => criterion.status === "failed").length} failed; ${coverage.filter((criterion) => criterion.status === "unknown").length} unknown.`);
      // Core attaches detail only for observations labeled public; IDs, statuses and codes always render.
      for (const observation of coverage.flatMap((criterion) => criterion.observations).filter((entry) => entry.status !== "passed")) {
        writeOut(`Observation ${observation.checkId}/${observation.id}: ${observation.status} (${observation.code})${observation.detail === undefined ? "" : ` — ${JSON.stringify(observation.detail)}`}`);
      }
    }
    for (const check of workflow.assurance.checks ?? []) writeOut(`Check ${check.checkId}: ${check.result}; ${check.decision} — ${check.reason}`);
  }

  for (const action of pendingGovernedActions) {
    writeOut(`Pending governed action: run=${action.runId} action=${action.actionId} kind=${action.actionKind} target=${action.target} sink=${action.sinkId} classification=${action.confidentiality} integrity=${action.integrity} value=${action.valueDigest} request=${action.requestDigest}`);
    writeOut(`Approve exactly this action with: legion-cli execute approve-action --run ${action.runId} --action ${action.actionId} --value-digest ${action.valueDigest} --sink ${action.sinkId} --reason "<reason>"`);
  }

  if (opts.plain) {
    writeOut(formatPlain({ project, state, next: workflowNext, blockers, currentTaskAdapter, run }));
    return code;
  }

  writeOut(
    formatHuman({
      project,
      state,
      next: workflowNext,
      blockers,
      blockersOnly: opts.blockers,
      currentTaskAdapter,
      run,
    }),
  );
  return code;
}
