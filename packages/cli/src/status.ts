import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import type { AdapterId, LegionConfig, ProjectFile, StateFile } from "@9thlevelsoftware/legion-cli-schema";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { collectBlockers, nextCommand, statusExitCode } from "./next.js";

async function readCurrentTaskAdapter(
  engine: ReturnType<typeof createLegionEngine>,
  currentTaskId: string | null | undefined,
): Promise<AdapterId | null> {
  if (!currentTaskId) return null;
  try {
    return (await engine.store.readTask(currentTaskId)).data.adapter ?? null;
  } catch {
    return null;
  }
}

async function readOptionalProject(engine: ReturnType<typeof createLegionEngine>): Promise<ProjectFile | null> {
  if (!(await engine.store.pathExists(".legion-cli/PROJECT.md"))) return null;
  return (await engine.store.readProject()).data;
}

async function readOptionalConfig(engine: ReturnType<typeof createLegionEngine>): Promise<LegionConfig | null> {
  if (!(await engine.store.pathExists(".legion-cli/config.yaml"))) return null;
  try {
    return await engine.store.readConfig();
  } catch {
    return null;
  }
}

function viewerUrl(config: LegionConfig | null): string {
  const port = config?.dashboard.port ?? 7420;
  const bind = config?.dashboard.bind ?? "127.0.0.1";
  return `http://${bind}:${port}`;
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
  blockersOnly: boolean;
  currentTaskAdapter: AdapterId | null;
  compactHint: boolean;
}): string {
  const { project, state, next, blockers, viewer, blockersOnly, currentTaskAdapter, compactHint } = input;
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
  lines.push(`Viewer: ${viewer}  (legion-cli dashboard)`);
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

export async function runStatus(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const state = await engine.getState();
  const project = state.phase === "uninitialized" ? null : await readOptionalProject(engine);
  const config = await readOptionalConfig(engine);
  const slice = state.phase === "uninitialized" ? [] : await engine.listSliceTasks();
  const next = nextCommand(state, slice, project?.mode);
  const blockers = collectBlockers(state.lastReadiness, state.lastReview, slice);
  const viewer = viewerUrl(config);
  const code = statusExitCode(state.lastReadiness, slice);
  const currentTaskAdapter = await readCurrentTaskAdapter(engine, state.currentTaskId);

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
      blockersOnly: opts.blockers,
      currentTaskAdapter,
      compactHint: shouldHintCompact(slice),
    }),
  );
  return code;
}
