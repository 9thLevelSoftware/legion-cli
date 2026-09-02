import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isTaskReady } from "@9thlevelsoftware/legion-cli-graph";
import {
  createLegionStore,
  type LegionReader,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  AuditEventSchema,
  ADAPTER_ID_HELP,
  SCHEMA_VERSION,
  type AuditEvent,
  type ControlMode,
  type LegionConfig,
  type Phase,
  type ProjectFile,
  type StateFile,
  type Task,
} from "@9thlevelsoftware/legion-cli-schema";
import {
  backlinks,
  buildSessionBrief,
  loadWikiLinks,
  loadWikiPages,
  searchWiki,
  showPage,
  wikiIndexReady,
} from "@9thlevelsoftware/legion-cli-wiki";

export class McpReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpReadError";
  }
}

const UNINITIALIZED: StateFile = {
  schemaVersion: SCHEMA_VERSION.state,
  phase: "uninitialized",
};

const NEXT_BY_PHASE: Record<Phase, { run: string; hint: string }> = {
  uninitialized: {
    run: `legion-cli init --name <product> --adapter ${ADAPTER_ID_HELP}`,
    hint: "start a product in this folder.",
  },
  initialized: { run: "legion-cli intent", hint: "interview me about the product." },
  intent_draft: { run: "legion-cli intent", hint: "finish the interview (two questions at a time)." },
  intent_ready: { run: "legion-cli discuss", hint: "capture decisions before we plan." },
  discussing: { run: "legion-cli spec", hint: "write the short contract + wireframes." },
  spec_draft: { run: "legion-cli spec approve", hint: "freeze the spec." },
  spec_frozen: { run: "legion-cli plan", hint: "break into tasks I can see on the board." },
  planning: { run: "legion-cli plan", hint: "finish planning." },
  plan_failed: { run: "legion-cli plan", hint: "fix the FAIL list, then plan again." },
  plan_ready: { run: "legion-cli execute", hint: "do the next ready task." },
  executing: { run: "legion-cli execute", hint: "do the next ready task." },
  ready_to_ship: { run: "legion-cli ship", hint: "final human review; stage the diff." },
  shipped: { run: "legion-cli spec new", hint: "start the next increment." },
  abandoned: { run: "legion-cli spec new", hint: "this spec was abandoned." },
};

function isTerminalTaskStatus(status: Task["status"]): boolean {
  return status === "done" || status === "blocked" || status === "compacted";
}

function sliceTasks(tasks: readonly Task[], activeSpecId: string | null | undefined): Task[] {
  if (!activeSpecId) return [];
  return tasks.filter((task) => task.specId === activeSpecId).sort((a, b) => a.id.localeCompare(b.id));
}

function isSliceTerminal(tasks: readonly Task[]): boolean {
  return tasks.length > 0 && tasks.every((task) => isTerminalTaskStatus(task.status));
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function createReaderStore(projectRoot: string): LegionReader {
  return createLegionStore(projectRoot);
}

function requireWikiIndex(store: LegionReader): void {
  if (!wikiIndexReady(store.projectRoot)) {
    throw new McpReadError("run index rebuild");
  }
}

export async function readState(store: LegionReader): Promise<StateFile> {
  if (!(await store.pathExists(".legion-cli/STATE.md"))) return UNINITIALIZED;
  return (await store.readState()).data;
}

async function assertInitialized(store: LegionReader): Promise<StateFile> {
  const state = await readState(store);
  if (state.phase === "uninitialized") {
    throw new McpReadError("mcp is refused until init");
  }
  return state;
}

export async function listTasks(store: LegionReader): Promise<Task[]> {
  const files = await listMarkdown(store.paths.tasksDir);
  const tasks: Task[] = [];
  for (const file of files) {
    const id = file.replace(/\.md$/i, "");
    try {
      tasks.push((await store.readTask(id)).data);
    } catch {
      continue;
    }
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

async function readOptionalProject(store: LegionReader): Promise<ProjectFile | null> {
  if (!(await store.pathExists(".legion-cli/PROJECT.md"))) return null;
  return (await store.readProject()).data;
}

export async function readOptionalConfig(store: LegionReader): Promise<LegionConfig | null> {
  if (!(await store.pathExists(".legion-cli/config.yaml"))) return null;
  try {
    return await store.readConfig();
  } catch {
    return null;
  }
}

export async function readFeatureFlags(store: LegionReader): Promise<{
  mcpApps: boolean;
  webmcp: boolean;
  parallelExecute: boolean;
}> {
  const config = await readOptionalConfig(store);
  return {
    mcpApps: config?.flags.mcpApps === true,
    webmcp: config?.flags.webmcp === true,
    parallelExecute: config?.flags.parallelExecute === true,
  };
}

function viewerUrl(config: LegionConfig | null): string {
  const port = config?.dashboard.port ?? 7420;
  const bind = config?.dashboard.bind ?? "127.0.0.1";
  return `http://${bind}:${port}`;
}

function nextCommand(state: StateFile, slice: readonly Task[]): { run: string; hint: string } {
  if (state.phase === "executing" && isSliceTerminal(slice)) {
    if (state.lastReview === "PASS") {
      return { run: "legion-cli qa", hint: "score the product (the slice is done)." };
    }
    return { run: "legion-cli review", hint: "spec-level review; fix tasks mean FAIL and re-review." };
  }
  return NEXT_BY_PHASE[state.phase];
}

export async function readStatus(store: LegionReader) {
  const state = await readState(store);
  const project = state.phase === "uninitialized" ? null : await readOptionalProject(store);
  const config = await readOptionalConfig(store);
  const slice = state.phase === "uninitialized" ? [] : sliceTasks(await listTasks(store), state.activeSpecId);
  const blockers: Array<{ kind: "task" | "readiness" | "review"; id?: string; detail: string }> = [];
  if (state.lastReadiness === "FAIL") blockers.push({ kind: "readiness", detail: "readiness FAIL" });
  if (state.lastReview === "FAIL") blockers.push({ kind: "review", detail: "lastReview FAIL" });
  for (const task of slice) {
    if (task.status === "blocked") {
      blockers.push({ kind: "task", id: task.id, detail: `${task.id} blocked  ${task.title}` });
    }
  }
  return {
    name: project?.name ?? null,
    mode: project?.mode ?? null,
    phase: state.phase,
    currentTaskId: state.currentTaskId ?? null,
    activeSpecId: state.activeSpecId ?? null,
    lastReadiness: state.lastReadiness ?? null,
    lastReview: state.lastReview ?? null,
    lastQaId: state.lastQaId ?? null,
    next: nextCommand(state, slice),
    blockers,
    viewer: viewerUrl(config),
  };
}

export async function readSearch(
  store: LegionReader,
  q: string,
  opts?: { includeUntrusted?: boolean; mentions?: boolean },
) {
  await assertInitialized(store);
  requireWikiIndex(store);
  return searchWiki(store.projectRoot, q, opts);
}

export async function readShow(store: LegionReader, page: string) {
  await assertInitialized(store);
  return showPage(store, page, { rebuild: false });
}

export async function readBrief(store: LegionReader) {
  await assertInitialized(store);
  return buildSessionBrief(store, { rebuild: false });
}

export async function readCurrentTask(store: LegionReader) {
  const state = await assertInitialized(store);
  if (!state.currentTaskId) return { currentTask: null };
  try {
    return { currentTask: (await store.readTask(state.currentTaskId)).data };
  } catch {
    return { currentTask: { id: state.currentTaskId, missing: true } };
  }
}

export async function readTaskGraph(store: LegionReader, specId?: string) {
  const state = await assertInitialized(store);
  const tasks = await listTasks(store);
  const active = specId ?? state.activeSpecId ?? null;
  const slice = sliceTasks(tasks, active);
  const config = await readOptionalConfig(store);
  const controlMode: ControlMode = config?.control_mode ?? "guarded";
  const readyCtx = { phase: state.phase, controlMode, tasks: slice };
  return {
    specId: active,
    phase: state.phase,
    tasks: slice.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      type: task.type,
      priority: task.priority,
      blockedBy: task.blockedBy,
      blocks: task.blocks,
      ready: isTaskReady(task, readyCtx),
    })),
  };
}

export async function readAuditTrail(store: LegionReader, limit = 100): Promise<AuditEvent[]> {
  await assertInitialized(store);
  const cap = Math.min(Math.max(limit, 1), 1000);
  const abs = join(store.paths.auditDir, "events.jsonl");
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const events: AuditEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = AuditEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) events.push(parsed.data);
    } catch {
      continue;
    }
  }
  return events.slice(-cap);
}

function matchWikiPageId(pages: ReturnType<typeof loadWikiPages>, ref: string): string {
  const needle = ref.replaceAll("\\", "/").replace(/^\/+/, "").replace(/^\.\//, "");
  const withMd = needle.endsWith(".md") ? needle : `${needle}.md`;
  const page = pages.find((entry) => {
    if (entry.id === needle || entry.id === needle.replace(/\.md$/i, "")) return true;
    if (entry.path === needle || entry.path === withMd) return true;
    if (entry.path === `.legion-cli/wiki/${withMd}` || entry.path === `.legion-cli/wiki/${needle}`) return true;
    if (entry.path.endsWith(`/${withMd}`) || entry.path.endsWith(`/${needle}`)) return true;
    if (entry.title === ref) return true;
    return false;
  });
  return page?.id ?? needle.replace(/\.md$/i, "");
}

export async function readWikiBacklinks(store: LegionReader, page: string) {
  await assertInitialized(store);
  requireWikiIndex(store);
  const pages = loadWikiPages(store.projectRoot);
  const links = loadWikiLinks(store.projectRoot);
  const pageId = matchWikiPageId(pages, page);
  const ids = backlinks(links, pageId);
  const byId = new Map(pages.map((entry) => [entry.id, entry]));
  return {
    page: pageId,
    backlinks: ids.map((id) => {
      const entry = byId.get(id);
      return entry
        ? { id: entry.id, path: entry.path, title: entry.title, trust: entry.trust }
        : { id };
    }),
  };
}
