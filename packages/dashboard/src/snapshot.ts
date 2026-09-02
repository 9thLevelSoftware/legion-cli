import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { unresolvedBlockers } from "@9thlevelsoftware/legion-cli-graph";
import {
  createLegionStore,
  toFsPath,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  AuditEventSchema,
  IngestReceiptSchema,
  SCHEMA_VERSION,
  type AuditEvent,
  type LegionConfig,
  type Phase,
  type ProjectFile,
  type Spec,
  type StateFile,
  type Task,
  type TaskStatus,
} from "@9thlevelsoftware/legion-cli-schema";
import { ensureWikiIndex } from "@9thlevelsoftware/legion-cli-wiki";

export const LIFECYCLE_PATH: Phase[] = [
  "uninitialized",
  "initialized",
  "intent_draft",
  "intent_ready",
  "discussing",
  "spec_draft",
  "spec_frozen",
  "planning",
  "plan_ready",
  "executing",
  "ready_to_ship",
  "shipped",
];

export const KANBAN_COLUMNS: TaskStatus[] = [
  "todo",
  "ready",
  "in_progress",
  "verifying",
  "blocked",
  "done",
];

export type DashboardTask = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Task["priority"];
  specId: string;
  blockedBy: string[];
  blocks: string[];
  unresolved: string[];
};

export type DashboardSnapshot = {
  readOnly: true;
  project: Pick<ProjectFile, "name" | "mode" | "controlMode"> | null;
  phase: Phase;
  activeSpecId: string | null;
  currentTaskId: string | null;
  lastReadiness: StateFile["lastReadiness"];
  lastReview: StateFile["lastReview"];
  path: { steps: Phase[]; current: Phase };
  currentTask: DashboardTask | null;
  tasks: DashboardTask[];
  blockers: Array<{ kind: "task" | "readiness" | "review"; id?: string; detail: string }>;
  graph: { nodes: string[]; edges: Array<{ from: string; to: string }> };
  audit: AuditEvent[];
  spec: { id: string; title: string; status: Spec["status"]; body: string } | null;
  prd: string | null;
  wireframesIndex: string | null;
};

const UNINITIALIZED: StateFile = {
  schemaVersion: SCHEMA_VERSION.state,
  phase: "uninitialized",
};

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function readOptionalProject(store: LegionStore): Promise<ProjectFile | null> {
  if (!(await store.pathExists(".legion-cli/PROJECT.md"))) return null;
  try {
    return (await store.readProject()).data;
  } catch {
    return null;
  }
}

export async function readOptionalConfig(store: LegionStore): Promise<LegionConfig | null> {
  if (!(await store.pathExists(".legion-cli/config.yaml"))) return null;
  try {
    return await store.readConfig();
  } catch {
    return null;
  }
}

async function readState(store: LegionStore): Promise<StateFile> {
  if (!(await store.pathExists(".legion-cli/STATE.md"))) return UNINITIALIZED;
  try {
    return (await store.readState()).data;
  } catch {
    return UNINITIALIZED;
  }
}

async function listTasks(store: LegionStore): Promise<Task[]> {
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

function toDashboardTask(task: Task, all: readonly Task[]): DashboardTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    specId: task.specId,
    blockedBy: task.blockedBy,
    blocks: task.blocks,
    unresolved: unresolvedBlockers(task, all),
  };
}

function sliceTasks(tasks: readonly Task[], activeSpecId: string | null | undefined): Task[] {
  if (!activeSpecId) return [...tasks];
  const slice = tasks.filter((task) => task.specId === activeSpecId);
  return slice.length > 0 ? slice : [...tasks];
}

function collectBlockers(
  state: StateFile,
  tasks: readonly DashboardTask[],
): DashboardSnapshot["blockers"] {
  const blockers: DashboardSnapshot["blockers"] = [];
  if (state.lastReadiness === "FAIL") {
    blockers.push({ kind: "readiness", detail: "readiness FAIL" });
  }
  if (state.lastReview === "FAIL") {
    blockers.push({ kind: "review", detail: "lastReview FAIL" });
  }
  for (const task of tasks) {
    if (task.status === "blocked") {
      blockers.push({ kind: "task", id: task.id, detail: `${task.id} blocked  ${task.title}` });
    }
  }
  return blockers;
}

async function loadAuditEvents(store: LegionStore, phase: Phase): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  const jsonl = join(store.paths.auditDir, "events.jsonl");
  try {
    const raw = await readFile(jsonl, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = AuditEventSchema.safeParse(JSON.parse(line) as unknown);
        if (parsed.success) events.push(parsed.data);
      } catch {
        continue;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // unreadable jsonl is treated as empty so the viewer still serves
    }
  }

  const files = await listMarkdown(store.paths.auditDir);
  for (const file of files) {
    if (!/^ingest-/i.test(file)) continue;
    const id = file.replace(/^ingest-/i, "").replace(/\.md$/i, "");
    try {
      const doc = await store.readIngestReceipt(id);
      const receipt = IngestReceiptSchema.parse(doc.data);
      let ts = receipt.id;
      try {
        const info = await stat(join(store.paths.auditDir, file));
        ts = info.mtime.toISOString();
      } catch {
        ts = new Date(0).toISOString();
      }
      events.push({
        schemaVersion: SCHEMA_VERSION.audit,
        ts,
        type: "ingest",
        phase,
        actor: "cli",
        data: {
          id: receipt.id,
          sources: receipt.sources,
          pagesCreated: receipt.pagesCreated,
        },
      });
    } catch {
      continue;
    }
  }

  return events.sort((a, b) => a.ts.localeCompare(b.ts) || a.type.localeCompare(b.type));
}

async function loadSpecView(
  store: LegionStore,
  specId: string | null | undefined,
): Promise<Pick<DashboardSnapshot, "spec" | "prd" | "wireframesIndex">> {
  if (!specId) return { spec: null, prd: null, wireframesIndex: null };
  try {
    const doc = await store.readSpec(specId);
    let prd: string | null = null;
    const prdStore = `.legion-cli/specs/${doc.data.id}/prd.md`;
    if (await store.pathExists(prdStore)) {
      prd = await readFile(toFsPath(store.projectRoot, prdStore), "utf8");
    }
    return {
      spec: {
        id: doc.data.id,
        title: doc.data.title,
        status: doc.data.status,
        body: doc.body,
      },
      prd,
      wireframesIndex: doc.data.wireframesIndex ?? null,
    };
  } catch {
    return { spec: null, prd: null, wireframesIndex: null };
  }
}

export async function loadSnapshot(
  projectRoot: string,
  opts?: { rebuild?: boolean },
): Promise<DashboardSnapshot> {
  const store = createLegionStore(projectRoot);
  // MCP Apps HTML reuses this loader but must not take the engine lock.
  if (opts?.rebuild !== false && (await store.pathExists(".legion-cli/STATE.md"))) {
    try {
      await ensureWikiIndex(store);
    } catch {
      // missing index is still a valid viewer
    }
  }

  const state = await readState(store);
  const project = state.phase === "uninitialized" ? null : await readOptionalProject(store);
  const allTasks = await listTasks(store);
  const shown = sliceTasks(allTasks, state.activeSpecId);
  const tasks = shown.map((task) => toDashboardTask(task, shown));
  const current = tasks.find((task) => task.id === state.currentTaskId) ?? null;
  const edges: Array<{ from: string; to: string }> = [];
  for (const task of tasks) {
    for (const parent of task.blockedBy) {
      edges.push({ from: parent, to: task.id });
    }
  }
  const specView = await loadSpecView(store, state.activeSpecId);
  return {
    readOnly: true,
    project: project
      ? { name: project.name, mode: project.mode, controlMode: project.controlMode }
      : null,
    phase: state.phase,
    activeSpecId: state.activeSpecId ?? null,
    currentTaskId: state.currentTaskId ?? null,
    lastReadiness: state.lastReadiness ?? null,
    lastReview: state.lastReview ?? null,
    path: { steps: LIFECYCLE_PATH, current: state.phase },
    currentTask: current,
    tasks,
    blockers: collectBlockers(state, tasks),
    graph: { nodes: tasks.map((task) => task.id), edges },
    audit: await loadAuditEvents(store, state.phase),
    ...specView,
  };
}
