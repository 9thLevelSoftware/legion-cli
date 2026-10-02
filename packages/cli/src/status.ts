import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { listTaskSummaries, PersistValidationError } from "@9thlevelsoftware/legion-cli-persist";
import type { AdapterId, LegionConfig, ProjectFile, StateFile } from "@9thlevelsoftware/legion-cli-schema";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { collectBlockers, nextCommand, statusExitCode, type StatusSliceTask } from "./next.js";

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

function formatHuman(input: {
  project: ProjectFile | null;
  state: StateFile;
  next: { run: string; hint: string };
  blockers: { detail: string }[];
  blockersOnly: boolean;
  currentTaskAdapter: AdapterId | null;
}): string {
  const { project, state, next, blockers, blockersOnly, currentTaskAdapter } = input;
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
  workflow: { blocker: string | null; next: string } | null;
}): string {
  const name = input.project?.name ?? "";
  const mode = input.project?.mode ?? "";
  const lines = [
    `name\t${name}`,
    `mode\t${mode}`,
    `phase\t${input.state.phase}`,
    `next\t${input.workflow?.next ?? input.next.run}`,
  ];
  if (input.state.currentTaskId) lines.push(`currentTask\t${input.state.currentTaskId}`);
  if (input.currentTaskAdapter) lines.push(`currentTaskAdapter\t${input.currentTaskAdapter}`);
  if (input.state.lastReadiness) lines.push(`readiness\t${input.state.lastReadiness}`);
  if (input.workflow?.blocker) lines.push(`blocker\t${input.workflow.blocker}`);
  if (input.blockers.length > 0) {
    for (const item of input.blockers) lines.push(`blocker\t${item.detail}`);
  }
  return lines.join("\n");
}

export async function runStatus(opts: CliOpts, jsonExtra?: Record<string, unknown>): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const state = await engine.getState();
  const project = state.phase === "uninitialized" ? null : await readOptionalProject(engine);
  const config = await readOptionalConfig(engine);
  const summaries = state.phase === "uninitialized" ? [] : await listTaskSummaries(opts.project);
  const slice: StatusSliceTask[] = state.activeSpecId
    ? summaries
        .filter((row) => row.ok && row.specId === state.activeSpecId)
        .map((row) => ({ id: row.id, title: row.title, status: row.status as StatusSliceTask["status"] }))
    : [];
  const next = nextCommand(state, slice, project?.mode, config?.control_mode);
  let workflow: Awaited<ReturnType<typeof engine.getWorkflowStatus>> | null = null;
  if (state.phase !== "uninitialized") {
    try {
      workflow = await engine.getWorkflowStatus();
    } catch (err) {
      // Legacy partial artifacts can still be inspected through status. Focused
      // projects must surface corrupt workflow receipts instead of hiding them.
      if (config?.workflow?.profile === "focused") throw err;
      workflow = null;
    }
  }
  const blockers = collectBlockers(state.lastReadiness, state.lastReview, slice);
  if (workflow?.blocker) blockers.push({ kind: "workflow", detail: workflow.blocker });
  const legacyCode = statusExitCode(state.lastReadiness, slice);
  const code =
    workflow?.execution === "blocked" || workflow?.execution === "stale" || workflow?.planApproval === "stale"
      ? 2
      : workflow?.acceptance.failed.length
        ? 1
        : legacyCode;
  const current = summaries.find((row) => row.id === state.currentTaskId);
  const currentTaskAdapter = (current?.adapter as AdapterId | null | undefined) ?? null;
  const workflowNext = workflow
    ? {
        run: workflow.next,
        hint: workflow.next === "legion-cli spec" && workflow.blocker ? workflow.blocker : next.hint,
      }
    : next;

  if (opts.json) {
    writeJson({
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
      ...jsonExtra,
    });
    return code;
  }

  if (opts.plain) {
    writeOut(formatPlain({ project, state, next, blockers, currentTaskAdapter, workflow }));
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
    }),
  );
  return code;
}
