import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { EXPOSE_BIND, LOOPBACK_BIND, readLiveServe } from "@9thlevelsoftware/legion-cli-dashboard";
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

async function liveViewer(projectRoot: string): Promise<{ viewer: string; live: boolean }> {
  const live = await readLiveServe(projectRoot);
  if (!live) return { viewer: "legion-cli serve", live: false };
  const host =
    live.bind === EXPOSE_BIND || live.bind === "::" || live.bind === "0.0.0.0" ? LOOPBACK_BIND : live.bind;
  return { viewer: `http://${host}:${live.port}`, live: true };
}

function shouldHintCompact(slice: readonly { status: string }[]): boolean {
  return slice.some((task) => task.status === "done") && !slice.some((task) => task.status === "in_progress");
}

function formatHuman(input: {
  project: ProjectFile | null;
  state: StateFile;
  next: { run: string; hint: string };
  blockers: { detail: string }[];
  viewer: string;
  viewerLive: boolean;
  blockersOnly: boolean;
  currentTaskAdapter: AdapterId | null;
  compactHint: boolean;
}): string {
  const { project, state, next, blockers, viewer, viewerLive, blockersOnly, currentTaskAdapter, compactHint } = input;
  if (blockersOnly) {
    if (blockers.length === 0) return "No blockers.";
    return ["Blockers:", ...blockers.map((item) => `  ${item.detail}`)].join("\n");
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
  if (compactHint) lines.push("Hint: legion-cli context compact");
  lines.push(viewerLive ? `Viewer: ${viewer}  (legion-cli serve)` : `Viewer: ${viewer}`);
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
  if (input.state.lastReadiness) lines.push(`readiness\t${input.state.lastReadiness}`);
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
  const blockers = collectBlockers(state.lastReadiness, state.lastReview, slice);
  const { viewer, live: viewerLive } = await liveViewer(opts.project);
  const code = statusExitCode(state.lastReadiness, slice);
  const current = summaries.find((row) => row.id === state.currentTaskId);
  const currentTaskAdapter = (current?.adapter as AdapterId | null | undefined) ?? null;

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
      next,
      blockers,
      viewer,
      viewerLive,
      ...jsonExtra,
    });
    return code;
  }

  if (opts.plain) {
    writeOut(formatPlain({ project, state, next, blockers, currentTaskAdapter }));
    return code;
  }

  writeOut(
    formatHuman({
      project,
      state,
      next,
      blockers,
      viewer,
      viewerLive,
      blockersOnly: opts.blockers,
      currentTaskAdapter,
      compactHint: shouldHintCompact(slice),
    }),
  );
  return code;
}
