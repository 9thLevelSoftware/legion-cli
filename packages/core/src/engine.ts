import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createLegionStore,
  ensureGitignore,
  parseMarkdownDocument,
  PathEscapeError,
  WIKI_PAGE_SCHEMA_VERSION,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  ControlModeSchema,
  QAScoreSchema,
  SCHEMA_VERSION,
  type Assumption,
  type ControlMode,
  type IngestReceipt,
  type LegionConfig,
  type Phase,
  type ProjectFile,
  type QAScore,
  type Readiness,
  type ReviewVerdict,
  type Spec,
  type StateFile,
  type Task,
  type TaskStatus,
} from "@9thlevelsoftware/legion-cli-schema";
import { HINT, refuse } from "./errors.js";
import { assertIngestSourceAllowed } from "./ingest-guard.js";
import { assertCanTransition, assertLegalPhase } from "./phases.js";
import { evaluateReadiness, filesAllowedFailsPlan } from "./readiness.js";
import { isSliceTerminal, p0TasksNotDone, sliceHasOpenWork, sliceTasks } from "./slice.js";
import { assertTaskStatusTransition } from "./tasks.js";
import type {
  Actor,
  ExecuteResult,
  InitOptions,
  QaOptions,
  ReviewResult,
  ShipOptions,
  ShipReceipt,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function stateBody(state: StateFile): string {
  const current = state.currentTaskId ? `Current task: ${state.currentTaskId}.` : "No current task.";
  return `${current}\nPhase: ${state.phase}.\n`;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((name) => name.toLowerCase().endsWith(".md"));
}

type LoadedTask =
  | { ok: true; task: Task }
  | { ok: false; id: string; specId?: string; filesAllowed?: string[] };

function peekTaskFrontmatter(frontmatter: unknown): { specId?: string; filesAllowed?: string[] } {
  if (!frontmatter || typeof frontmatter !== "object") return {};
  const rec = frontmatter as { specId?: unknown; contract?: { filesAllowed?: unknown } };
  const specId = typeof rec.specId === "string" ? rec.specId : undefined;
  const allowed = rec.contract?.filesAllowed;
  const filesAllowed = Array.isArray(allowed)
    ? allowed.filter((path): path is string => typeof path === "string")
    : undefined;
  return { specId, filesAllowed };
}

export class LegionEngine {
  readonly store: LegionStore;

  constructor(projectRoot: string, store?: LegionStore) {
    this.store = store ?? createLegionStore(projectRoot);
  }

  get projectRoot(): string {
    return this.store.projectRoot;
  }

  async init(opts: InitOptions): Promise<void> {
    if (opts.mode === "brownfield") {
      refuse("legion-cli init --mode brownfield is v1", HINT.greenfield);
    }
    if (opts.mode !== undefined && opts.mode !== "greenfield") {
      refuse("legion-cli init is greenfield only in v0", HINT.greenfield);
    }
    const controlMode = this.#parseControlMode(opts.controlMode ?? "guarded");
    if (!opts.name?.trim()) {
      refuse("init requires a product name", HINT.init);
    }
    if (!opts.adapter) {
      refuse("adapter.default is required", "set adapter.default in .legion-cli/config.yaml");
    }

    return this.#mutate(async () => {
      if (await this.store.pathExists(".legion-cli/STATE.md")) {
        refuse("this folder is already a Legion CLI project", "legion-cli status");
      }

      await ensureGitignore(this.projectRoot);
      const paths = this.store.paths;
      await mkdir(paths.decisionsDir, { recursive: true });
      await mkdir(paths.assumptionsDir, { recursive: true });
      await mkdir(paths.specsDir, { recursive: true });
      await mkdir(paths.plansDir, { recursive: true });
      await mkdir(paths.tasksDir, { recursive: true });
      await mkdir(join(paths.qaDir, "scores"), { recursive: true });
      await mkdir(join(paths.designDir, "craft"), { recursive: true });
      await mkdir(paths.auditDir, { recursive: true });
      await mkdir(paths.wikiDir, { recursive: true });
      await mkdir(join(paths.wikiDir, "product"), { recursive: true });

      const project: ProjectFile = {
        schemaVersion: SCHEMA_VERSION.project,
        name: opts.name.trim(),
        mode: "greenfield",
        controlMode,
      };
      await this.store.writeProject(project, "This folder is now a Legion CLI project.\n");

      const state: StateFile = {
        schemaVersion: SCHEMA_VERSION.state,
        phase: "initialized",
        activeSpecId: null,
        currentTaskId: null,
        lastReadiness: null,
        lastReview: null,
        lastQaId: null,
      };
      await this.store.writeState(state, stateBody(state));

      await this.store.writeContext(
        {
          schemaVersion: SCHEMA_VERSION.context,
          standingInstructions: "",
          platforms: [],
        },
        "Standing context for this product.\n",
      );

      const config: LegionConfig = {
        schemaVersion: SCHEMA_VERSION.config,
        adapter: {
          default: opts.adapter,
          ...(opts.generic ? { generic: opts.generic } : {}),
        },
        ingest: { autoCommit: true },
        control_mode: controlMode,
        qa: { mode: "full", passScore: 85 },
        dashboard: { port: 7420, bind: "127.0.0.1" },
        flags: { mcpApps: false, webmcp: false, parallelExecute: false },
      };
      await this.store.writeConfig(config);

      await this.store.writeMarkdown(
        ".legion-cli/wiki/README.md",
        {
          schemaVersion: WIKI_PAGE_SCHEMA_VERSION,
          title: "Wiki",
          aliases: [],
          tags: ["wiki"],
          trust: "reviewed",
          updated: nowIso(),
        },
        "Durable product knowledge lives here.\n",
      );

      await this.store.writeDiscuss(
        { schemaVersion: SCHEMA_VERSION.discuss, decisions: [] },
        "Decisions are captured here before planning.\n",
      );

      await this.store.rebuild();
    });
  }

  async transition(to: Phase): Promise<void> {
    const target = assertLegalPhase(to);
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (target === "initialized") {
        refuse("run legion-cli init", HINT.init);
      }
      if (target === "spec_frozen") {
        refuse("spec freeze requires legion-cli spec approve", HINT.specApprove);
      }
      if (target === "plan_ready" || target === "plan_failed") {
        refuse("plan_ready and plan_failed require legion-cli plan", HINT.plan);
      }
      assertCanTransition(state.phase, target);
      if (target === "ready_to_ship") {
        await this.#assertReadyToShip(state);
      }
      if (target === "shipped") {
        await this.#assertCanShip(state, {});
      }
      await this.#writeState({ ...state, phase: target });
    });
  }

  async approveSpec(specId: string, actor: Actor): Promise<void> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase !== "spec_draft") {
        refuse("spec approve requires phase spec_draft", HINT.spec);
      }
      let spec: Spec;
      let specBody: string;
      try {
        const specDoc = await this.store.readSpec(specId);
        spec = specDoc.data;
        specBody = specDoc.body;
      } catch {
        refuse(`unknown spec ${specId}`, HINT.spec);
      }
      if (spec.status !== "draft") {
        refuse(`spec ${specId} is ${spec.status}, not draft`, HINT.specApprove);
      }
      const frozen: Spec = {
        ...spec,
        status: "frozen",
        frozenAt: nowIso(),
        frozenBy: actor.id,
      };
      await this.store.writeSpec(frozen, specBody);
      const project = await this.store.readProject();
      await this.store.writeProject({ ...project.data, activeSpecId: specId }, project.body);
      await this.#writeState({
        ...state,
        phase: "spec_frozen",
        activeSpecId: specId,
      });
    });
  }

  async newSpec(): Promise<void> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase !== "shipped") {
        refuse("spec new is allowed from shipped", HINT.specNew);
      }
      if (state.activeSpecId) {
        try {
          const specDoc = await this.store.readSpec(state.activeSpecId);
          if (specDoc.data.status !== "superseded") {
            await this.store.writeSpec({ ...specDoc.data, status: "superseded" }, specDoc.body);
          }
        } catch {
          // previous spec may already be gone
        }
      }
      const project = await this.store.readProject();
      await this.store.writeProject({ ...project.data, activeSpecId: null }, project.body);
      await this.#writeState({
        ...state,
        phase: "intent_draft",
        activeSpecId: null,
        currentTaskId: null,
        lastReadiness: null,
        lastReview: null,
        lastQaId: null,
      });
    });
  }

  async ingest(sources: string[], opts?: { noCommit?: boolean }): Promise<IngestReceipt> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("ingest is refused until init", HINT.init);
      }
      for (const source of sources) {
        assertIngestSourceAllowed(this.projectRoot, source);
      }
      const phaseBefore = state.phase;
      let receipt: IngestReceipt;
      try {
        receipt = await this.store.ingest(sources, opts);
      } catch (err) {
        if (err instanceof PathEscapeError) {
          refuse("ingest of file: outside the workspace is refused", HINT.inRepo);
        }
        throw err;
      }
      const after = await this.#readState();
      if (after.phase !== phaseBefore) {
        await this.#writeState({ ...after, phase: phaseBefore });
      }
      return receipt;
    });
  }

  async plan(specId?: string): Promise<Readiness> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase !== "spec_frozen" && state.phase !== "planning" && state.phase !== "plan_failed") {
        refuse("plan requires a frozen spec", HINT.spec);
      }
      const id = specId ?? state.activeSpecId;
      if (!id) {
        refuse("plan requires an active spec", HINT.spec);
      }

      let current: StateFile = { ...state, activeSpecId: id };
      if (current.phase === "spec_frozen" || current.phase === "plan_failed") {
        assertCanTransition(current.phase, "planning");
        current = { ...current, phase: "planning" };
        await this.#writeState(current);
      }

      const spec = (await this.store.readSpec(id)).data;
      const entries = await this.#loadTaskEntries();
      const unreadable = entries.filter(
        (entry): entry is Extract<LoadedTask, { ok: false }> =>
          !entry.ok && (entry.specId === id || entry.specId === undefined),
      );
      const tasks = sliceTasks(
        entries.filter((entry): entry is Extract<LoadedTask, { ok: true }> => entry.ok).map((entry) => entry.task),
        id,
      );
      const hasStories = await this.store.pathExists(`.legion-cli/specs/${id}/stories.yaml`);
      const skipWireframes = !spec.wireframesIndex;
      const openNonBlockingAssumptions = (await this.#listAssumptions()).some(
        (assumption) => assumption.status === "open" && assumption.blocking === false,
      );
      const report = evaluateReadiness({
        spec,
        tasks,
        hasStories,
        skipWireframes,
        openNonBlockingAssumptions,
      });
      const fails = [...report.fails];
      for (const bad of unreadable) {
        fails.push(`${bad.id} is not a valid task`);
        if (bad.filesAllowed && filesAllowedFailsPlan(bad.filesAllowed)) {
          fails.push(`${bad.id} filesAllowed must be concrete paths`);
        }
      }
      const readiness: Readiness = fails.length > 0 ? "FAIL" : report.readiness;
      const phase: Phase = readiness === "FAIL" ? "plan_failed" : "plan_ready";
      assertCanTransition("planning", phase);
      await this.#writeState({
        ...current,
        phase,
        activeSpecId: id,
        lastReadiness: readiness,
      });
      return readiness;
    });
  }

  async execute(taskId: string | "auto" = "auto"): Promise<ExecuteResult> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      const config = await this.#readConfig();
      if (config.control_mode === "advisory") {
        refuse("execute is refused in advisory mode", HINT.advisory);
      }
      if (state.phase === "plan_failed") {
        refuse("execute is refused after readiness FAIL", HINT.planRetry);
      }
      if (state.phase !== "plan_ready" && state.phase !== "executing") {
        refuse("execute requires plan_ready or executing", HINT.plan);
      }

      const slice = sliceTasks(await this.#listTasks(), state.activeSpecId);
      let task: Task | undefined;
      if (taskId === "auto") {
        task = slice.find((candidate) => candidate.status === "ready");
        if (!task) {
          refuse("no ready task in the active spec slice", HINT.blockers);
        }
      } else {
        task = slice.find((candidate) => candidate.id === taskId);
        if (!task) {
          try {
            const loaded = (await this.store.readTask(taskId)).data;
            if (loaded.specId !== state.activeSpecId) {
              refuse(`task ${taskId} is not in the active spec slice`, HINT.blockers);
            }
            task = loaded;
          } catch {
            refuse(`unknown task ${taskId}`, HINT.blockers);
          }
        }
      }

      if (task.status !== "ready") {
        refuse(`task ${task.id} is ${task.status}, not ready`, HINT.blockers);
      }
      if (task.contract.filesAllowed.length === 0 || task.contract.verificationCommands.length === 0) {
        refuse("execute requires a FileContract with filesAllowed and verificationCommands", HINT.plan);
      }

      const nextPhase: Phase = "executing";
      await this.#writeState({
        ...state,
        phase: nextPhase,
        currentTaskId: task.id,
      });
      return { taskId: task.id, phase: nextPhase };
    });
  }

  async review(): Promise<ReviewResult> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      const slice = sliceTasks(await this.#listTasks(), state.activeSpecId);
      this.#assertCanReview(state, slice);
      const before = (await this.#listTasks()).map((task) => task.id);
      // spawn is not wired; PASS only when the (empty) spawn created zero new tasks
      const after = (await this.#listTasks()).map((task) => task.id);
      const createdTaskIds = after.filter((id) => !before.includes(id));
      const verdict = await this.#applyReviewSnapshotsLocked(state, before, after);
      return { verdict, createdTaskIds };
    });
  }

  async snapshotTaskIds(): Promise<string[]> {
    const tasks = await this.#listTasks();
    return tasks.map((task) => task.id).sort();
  }

  /**
   * Models review-spawn comparison: PASS only when after has no ids that before lacked.
   */
  async applyReviewSnapshots(
    beforeTaskIds: readonly string[],
    afterTaskIds: readonly string[],
  ): Promise<ReviewVerdict> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      return this.#applyReviewSnapshotsLocked(state, beforeTaskIds, afterTaskIds);
    });
  }

  async qa(opts: QaOptions): Promise<QAScore> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      const slice = sliceTasks(await this.#listTasks(), state.activeSpecId);
      this.#assertCanQa(state, slice);
      const score = QAScoreSchema.parse(opts.score);
      await this.#writeQaScore(score);
      const next: StateFile = {
        ...state,
        lastQaId: score.id,
      };
      if (score.pass === true && state.lastReview === "PASS") {
        next.phase = "ready_to_ship";
      }
      await this.#writeState(next);
      return score;
    });
  }

  async ship(opts: ShipOptions = {}): Promise<ShipReceipt> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      await this.#assertCanShip(state, opts);
      const specId = state.activeSpecId ?? "";
      const shippedAt = nowIso();
      await this.#writeState({
        ...state,
        phase: "shipped",
        currentTaskId: null,
      });
      return { specId, shippedAt, phase: "shipped" };
    });
  }

  async abandon(message: string): Promise<void> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      assertCanTransition(state.phase, "abandoned");
      await this.#writeState({ ...state, phase: "abandoned", currentTaskId: null });
      void message;
    });
  }

  async setTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    return this.#mutate(async () => {
      const doc = await this.store.readTask(taskId);
      assertTaskStatusTransition(doc.data.status, status);
      const state = await this.#readState();
      const before = sliceTasks(await this.#listTasks(), state.activeSpecId);
      const wasTerminal = isSliceTerminal(before);
      await this.store.writeTask({ ...doc.data, status }, doc.body);
      const after = sliceTasks(await this.#listTasks(), state.activeSpecId);
      if (!wasTerminal || isSliceTerminal(after)) return;
      const next: StateFile = { ...state };
      if (state.lastReview === "PASS") next.lastReview = "FAIL";
      if (state.phase === "ready_to_ship") next.phase = "executing";
      if (next.lastReview !== state.lastReview || next.phase !== state.phase) {
        await this.#writeState(next);
      }
    });
  }

  async expandCurrentTask(_work: string): Promise<never> {
    void _work;
    const state = await this.#readState();
    refuse(
      "extra work becomes a linked ticket, never an in-place expansion",
      HINT.ticket(state.currentTaskId ?? "TSK-x"),
    );
  }

  async listSliceTasks(): Promise<Task[]> {
    const state = await this.#readState();
    return sliceTasks(await this.#listTasks(), state.activeSpecId);
  }

  async getState(): Promise<StateFile> {
    return this.#readState();
  }

  #parseControlMode(mode: string): ControlMode {
    if (mode === "autonomous") {
      refuse("control_mode: autonomous is rejected", HINT.controlMode);
    }
    const parsed = ControlModeSchema.safeParse(mode);
    if (!parsed.success) {
      refuse(`control_mode ${mode} is rejected`, HINT.controlMode);
    }
    return parsed.data;
  }

  async #mutate<T>(fn: () => Promise<T>): Promise<T> {
    return this.store.withLock(fn);
  }

  async #readState(): Promise<StateFile> {
    if (!(await this.store.pathExists(".legion-cli/STATE.md"))) {
      return { schemaVersion: SCHEMA_VERSION.state, phase: "uninitialized" };
    }
    return (await this.store.readState()).data;
  }

  async #writeState(state: StateFile): Promise<void> {
    await this.store.writeState(state, stateBody(state));
  }

  async #readConfig(): Promise<LegionConfig> {
    return this.store.readConfig();
  }

  async #loadTaskEntries(): Promise<LoadedTask[]> {
    const files = await listMarkdownFiles(this.store.paths.tasksDir);
    const entries: LoadedTask[] = [];
    for (const file of files) {
      const id = file.replace(/\.md$/i, "");
      try {
        entries.push({ ok: true, task: (await this.store.readTask(id)).data });
      } catch {
        let specId: string | undefined;
        let filesAllowed: string[] | undefined;
        try {
          const raw = await readFile(join(this.store.paths.tasksDir, file), "utf8");
          const peeked = peekTaskFrontmatter(parseMarkdownDocument(raw).frontmatter);
          specId = peeked.specId;
          filesAllowed = peeked.filesAllowed;
        } catch {
          // unreadable even as frontmatter
        }
        entries.push({ ok: false, id, specId, filesAllowed });
      }
    }
    return entries;
  }

  async #listTasks(): Promise<Task[]> {
    return (await this.#loadTaskEntries())
      .filter((entry): entry is { ok: true; task: Task } => entry.ok)
      .map((entry) => entry.task)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async #listAssumptions(): Promise<Assumption[]> {
    const files = await listMarkdownFiles(this.store.paths.assumptionsDir);
    const out: Assumption[] = [];
    for (const file of files) {
      const id = file.replace(/\.md$/i, "");
      try {
        out.push((await this.store.readAssumption(id)).data);
      } catch {
        continue;
      }
    }
    return out;
  }

  async #writeQaScore(score: QAScore): Promise<void> {
    const dir = join(this.store.paths.qaDir, "scores");
    await mkdir(dir, { recursive: true });
    const abs = join(dir, `${score.id}.json`);
    await writeFile(abs, `${JSON.stringify(score, null, 2)}\n`, "utf8");
  }

  async #readLastQa(state: StateFile): Promise<QAScore | null> {
    if (!state.lastQaId) return null;
    const abs = join(this.store.paths.qaDir, "scores", `${state.lastQaId}.json`);
    try {
      const raw = JSON.parse(await readFile(abs, "utf8"));
      return QAScoreSchema.parse(raw);
    } catch {
      return null;
    }
  }

  #assertCanReview(state: StateFile, slice: Task[]): void {
    if (state.phase !== "executing") {
      refuse("review is allowed on a terminal executing slice", HINT.execute);
    }
    if (!isSliceTerminal(slice) || sliceHasOpenWork(slice)) {
      refuse("review requires a terminal slice (every task done or blocked)", HINT.execute);
    }
  }

  #assertCanQa(state: StateFile, slice: Task[]): void {
    if (state.phase !== "executing") {
      refuse("qa is allowed from executing after review PASS", HINT.execute);
    }
    if (!isSliceTerminal(slice) || sliceHasOpenWork(slice)) {
      refuse("qa is refused while slice tasks are todo/ready/in_progress/verifying", HINT.execute);
    }
    if (state.lastReview !== "PASS") {
      refuse("qa requires lastReview PASS", HINT.review);
    }
    if (p0TasksNotDone(slice).length > 0) {
      refuse("qa is refused while any P0 task is not done", HINT.blockers);
    }
  }

  async #assertReadyToShip(state: StateFile): Promise<void> {
    const slice = sliceTasks(await this.#listTasks(), state.activeSpecId);
    if (state.lastReview !== "PASS") {
      refuse("ready_to_ship requires lastReview PASS", HINT.review);
    }
    const lastQa = await this.#readLastQa(state);
    if (lastQa?.pass !== true) {
      refuse("ready_to_ship requires qa.pass", HINT.qa);
    }
    if (p0TasksNotDone(slice).length > 0) {
      refuse("P0 tasks must be done", HINT.blockers);
    }
  }

  async #assertCanShip(state: StateFile, opts: ShipOptions): Promise<void> {
    const lastQa = await this.#readLastQa(state);
    if (lastQa?.pass !== true && !opts.allowDegradedQa) {
      refuse("ship is refused if last QA pass !== true", HINT.qa);
    }
    if (state.lastReview !== "PASS") {
      refuse("ship is refused if spec review is not PASS", HINT.review);
    }
    const slice = sliceTasks(await this.#listTasks(), state.activeSpecId);
    if (p0TasksNotDone(slice).length > 0) {
      refuse("ship is refused if any P0 task is not done", HINT.blockers);
    }
  }

  async #applyReviewSnapshotsLocked(
    state: StateFile,
    beforeTaskIds: readonly string[],
    afterTaskIds: readonly string[],
  ): Promise<ReviewVerdict> {
    const before = new Set(beforeTaskIds);
    const created = afterTaskIds.filter((id) => !before.has(id));
    const verdict: ReviewVerdict = created.length === 0 ? "PASS" : "FAIL";
    let phase = state.phase;
    if (verdict === "FAIL" && phase === "ready_to_ship") {
      phase = "executing";
    }
    await this.#writeState({
      ...state,
      phase,
      lastReview: verdict,
    });
    return verdict;
  }
}

export function createLegionEngine(projectRoot: string): LegionEngine {
  return new LegionEngine(projectRoot);
}
