import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { sliceTasks } from "@9thlevelsoftware/legion-cli-core";
import { unresolvedBlockers } from "@9thlevelsoftware/legion-cli-graph";
import {
  AUDIT_VIEW_CAP,
  createLegionStore,
  invalidTaskMessage,
  listTaskFiles,
  readAuditEvents,
  toFsPath,
  type LegionStore,
  type TaskFileEntry,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  IngestReceiptSchema,
  SCHEMA_VERSION,
  type AdapterId,
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
  /** Raw Task.adapter from frontmatter; omit when unset. Not a live resolve. */
  adapter?: AdapterId;
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
  blockers: Array<{ kind: "task" | "readiness" | "review" | "invalid"; id?: string; detail: string }>;
  /** Set when STATE.md exists but could not be read even after retries; phase is then a placeholder. */
  stateError: string | null;
  /** Task files that are not valid tasks: listed, never dropped (fail closed). */
  invalidTasks: Array<{ file: string; error: string }>;
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

export const STATE_UNREADABLE = "state unreadable (retrying)";

/** The store's reader already retries; a failure here is shown, not mistaken for "uninitialized". */
async function readState(store: LegionStore): Promise<{ state: StateFile; error: string | null }> {
  if (!(await store.pathExists(".legion-cli/STATE.md"))) return { state: UNINITIALIZED, error: null };
  try {
    return { state: (await store.readState()).data, error: null };
  } catch {
    return { state: UNINITIALIZED, error: STATE_UNREADABLE };
  }
}

function validTasks(entries: readonly TaskFileEntry[]): Task[] {
  return entries
    .filter((entry): entry is Extract<TaskFileEntry, { ok: true }> => entry.ok)
    .map((entry) => entry.task)
    .sort((a, b) => a.id.localeCompare(b.id));
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
    ...(task.adapter ? { adapter: task.adapter } : {}),
  };
}

function collectBlockers(
  state: StateFile,
  tasks: readonly DashboardTask[],
  invalid: readonly Extract<TaskFileEntry, { ok: false }>[],
): DashboardSnapshot["blockers"] {
  const blockers: DashboardSnapshot["blockers"] = [];
  for (const entry of invalid) {
    blockers.push({ kind: "invalid", id: entry.id, detail: invalidTaskMessage(entry) });
  }
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
  const events: AuditEvent[] = await readAuditEvents(store.projectRoot, { cap: AUDIT_VIEW_CAP });

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

  const { state, error: stateError } = await readState(store);
  const project = state.phase === "uninitialized" ? null : await readOptionalProject(store);
  const entries = await listTaskFiles(store.projectRoot);
  const invalid = entries.filter((entry): entry is Extract<TaskFileEntry, { ok: false }> => !entry.ok);
  const allTasks = validTasks(entries);
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
    blockers: collectBlockers(state, tasks, invalid),
    stateError,
    invalidTasks: invalid.map((entry) => ({ file: entry.file, error: entry.error })),
    graph: { nodes: tasks.map((task) => task.id), edges },
    audit: await loadAuditEvents(store, state.phase),
    ...specView,
  };
}
