import { isSpawnable, resolveAdapter, type FakeArtifact } from "@9thlevelsoftware/legion-cli-agents";
import {
  isTaskReady,
  mergeFilesForbidden,
  overlappingFilesAllowed,
  pickNextTask,
  readyTasks,
} from "@9thlevelsoftware/legion-cli-graph";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createLegionStore,
  DECISION_FILE_SCHEMA_VERSION,
  packetPath,
  parseMarkdownDocument,
  PathEscapeError,
  PersistError,
  ensureGitignore,
  WIKI_PAGE_SCHEMA_VERSION,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  buildSessionBrief,
  ensureWikiIndex,
  isForbiddenSpawnPath,
  materializeIngestSources,
  searchWiki,
  SsrfError,
  trustWikiPage,
  wrapUntrustedContent,
  type SearchHit,
} from "@9thlevelsoftware/legion-cli-wiki";
import {
  checklistComplete,
  readChecklist,
  runProjectQa,
  writeChecklist,
} from "@9thlevelsoftware/legion-cli-qa";
import {
  ControlModeSchema,
  QAScoreSchema,
  SCHEMA_VERSION,
  type Assumption,
  type ControlMode,
  type DiscussDecision,
  type IngestReceipt,
  type IntentAnswersFile,
  type LegionConfig,
  type Packet,
  type Phase,
  type ProjectFile,
  type QAScore,
  type Readiness,
  type ReviewVerdict,
  type FileContract,
  type SessionBrief,
  type Spec,
  type StateFile,
  type Task,
  type TaskStatus,
} from "@9thlevelsoftware/legion-cli-schema";
import { copyShippedCraft, isBrandViolationBlockingFreeze } from "@9thlevelsoftware/legion-cli-design-system";
import { HINT, LegionRefuseError, refuse } from "./errors.js";
import { assertIngestSourceAllowed } from "./ingest-guard.js";
import { decisionFileName, templateDecisions } from "./discuss.js";
import {
  applyIntentAnswers,
  emptyIntentAnswers,
  intentProgress,
  intentWikiBody,
  prdBody,
  specIdFromName,
} from "./intent.js";
import { assertCanTransition, assertLegalPhase } from "./phases.js";
import { evaluateReadiness, filesAllowedFailsPlan, type ReadinessReport } from "./readiness.js";
import { isSliceTerminal, p0TasksNotDone, sliceHasOpenWork, sliceTasks } from "./slice.js";
import { HEAD_MOVED_WARNING } from "./revert.js";
import { findSkillsDir, optionalSkillSpawn } from "./spawn.js";
import { buildSpecFromIntent, specMarkdownBody } from "./spec-build.js";
import { assertTaskStatusTransition } from "./tasks.js";
import {
  ensureRegressionTest,
  fixFilesAllowed,
  regressionTestPath,
  regressionVerifyCommand,
} from "./fix.js";
import { nextPacketId, packetFromInput, packetMarkdownBody } from "./packets.js";
import { nextTaskId, parseExtraJson, taskMarkdownBody, ticketFromInput } from "./tickets.js";
import type {
  Actor,
  AmendTaskOptions,
  BrownfieldOptions,
  BrownfieldResult,
  DecisionInput,
  ExecuteOptions,
  ExecuteResult,
  IngestOpts,
  ExecuteTaskResult,
  InitOptions,
  IntentState,
  LegionEngineOptions,
  NewPacket,
  NewTicket,
  PromoteRunResult,
  PacketRespondInput,
  PacketResult,
  QaOptions,
  ReviewResult,
  ShipOptions,
  ShipReceipt,
  VerifyResult,
} from "./types.js";
import { promoteBrownfieldRun, runBrownfield } from "./brownfield.js";
import { runVerificationCommands } from "./verify.js";
import {
  palettePresent,
  renderWireframeIndex,
  renderWireframeScreen,
  uniqueScreenPages,
} from "./wireframes.js";

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
  readonly #skillsDir?: string;
  readonly #fakeArtifacts: FakeArtifact[];
  readonly #fakeThrowAfterWrite: boolean;
  #lastPlanReport: ReadinessReport | null = null;

  constructor(projectRoot: string, store?: LegionStore, options?: LegionEngineOptions) {
    this.store = store ?? createLegionStore(projectRoot);
    this.#skillsDir = options?.skillsDir;
    this.#fakeArtifacts = options?.fakeArtifacts ?? [];
    this.#fakeThrowAfterWrite = Boolean(options?.fakeThrowAfterWrite);
  }

  get projectRoot(): string {
    return this.store.projectRoot;
  }

  async init(opts: InitOptions): Promise<void> {
    const mode = opts.mode ?? "greenfield";
    if (mode !== "greenfield" && mode !== "brownfield") {
      refuse("init mode must be greenfield or brownfield", HINT.initMode);
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
      await mkdir(paths.packetsDir, { recursive: true });
      await mkdir(join(paths.qaDir, "scores"), { recursive: true });
      await mkdir(join(paths.designDir, "craft"), { recursive: true });
      await copyShippedCraft(join(paths.designDir, "craft"));
      await mkdir(paths.auditDir, { recursive: true });
      await mkdir(paths.wikiDir, { recursive: true });
      await mkdir(join(paths.wikiDir, "product"), { recursive: true });
      await mkdir(paths.runsDir, { recursive: true });

      const project: ProjectFile = {
        schemaVersion: SCHEMA_VERSION.project,
        name: opts.name.trim(),
        mode,
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
      const answers = await this.#loadIntentAnswers();
      if (await isBrandViolationBlockingFreeze(this.projectRoot, spec, answers.mapped.screens)) {
        refuse("brand violation blocks spec freeze for UI work", HINT.designGenerate);
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
      await this.store.writeIntentAnswers(emptyIntentAnswers());
      await this.store.writeDiscuss(
        { schemaVersion: SCHEMA_VERSION.discuss, decisions: [] },
        "Decisions are captured here before planning.\n",
      );
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

  async ingest(sources: string[], opts?: IngestOpts): Promise<IngestReceipt> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("ingest is refused until init", HINT.init);
      }
      if (sources.length === 0 && !opts?.transcript && !opts?.diff) {
        refuse("ingest requires a file, URL, --transcript, or --diff", HINT.inRepo);
      }
      for (const source of sources) {
        assertIngestSourceAllowed(this.projectRoot, source);
      }
      if (opts?.transcript) {
        assertIngestSourceAllowed(this.projectRoot, opts.transcript);
      }
      const phaseBefore = state.phase;
      let receipt: IngestReceipt;
      try {
        const materialized = await materializeIngestSources({
          projectRoot: this.projectRoot,
          sources,
          transcript: opts?.transcript,
          diff: opts?.diff,
        });
        receipt = await this.store.ingest(materialized.files, {
          noCommit: opts?.noCommit,
          documents: materialized.documents,
        });
      } catch (err) {
        if (err instanceof PathEscapeError) {
          refuse("ingest of file: outside the workspace is refused", HINT.inRepo);
        }
        if (err instanceof SsrfError) {
          refuse(err.message, HINT.inRepo);
        }
        if (err instanceof PersistError && /git repository/.test(err.message)) {
          refuse("ingest auto-commit requires a git repository", HINT.noCommit);
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

  async wikiTrust(pageId: string): Promise<void> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("wiki trust is refused until init", HINT.init);
      }
      try {
        await trustWikiPage(this.store, pageId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        refuse(message, HINT.show);
      }
    });
  }

  async brief(): Promise<SessionBrief> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("brief is refused until init", HINT.init);
      }
      return buildSessionBrief(this.store);
    });
  }

  async search(q: string, opts?: { includeUntrusted?: boolean; mentions?: boolean }): Promise<SearchHit[]> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("search is refused until init", HINT.init);
      }
      await ensureWikiIndex(this.store);
      return searchWiki(this.projectRoot, q, opts);
    });
  }

  /** Execute-spawn helper: wrap untrusted bodies if they are injected at all. */
  wrapUntrustedForSpawn(source: string, body: string): string {
    return wrapUntrustedContent(source, body);
  }

  spawnPathForbidden(path: string): boolean {
    return isForbiddenSpawnPath(path);
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

      const config = await this.#readConfig();
      await this.#assertPlanSpawnable(config);

      let current: StateFile = { ...state, activeSpecId: id };
      if (current.phase === "spec_frozen" || current.phase === "plan_failed") {
        assertCanTransition(current.phase, "planning");
        current = { ...current, phase: "planning" };
        await this.#writeState(current);
      }

      const spawnFails: string[] = [];
      let runId: string | undefined;
      try {
        const result = await optionalSkillSpawn({
          projectRoot: this.projectRoot,
          config,
          skillId: "plan",
          specId: id,
          promptBody: [
            `Active spec: ${id}`,
            `Read .legion-cli/specs/${id}/SPEC.md.`,
            `Write .legion-cli/plans/${id}.md and .legion-cli/tasks/TSK-*.md with FileContracts.`,
            "Every task needs verificationCommands and exclusive concrete filesAllowed.",
            "If you discover extra work, write extra.json in the run cache; do not expand filesAllowed.",
            "Do not write src/** or other product files.",
          ].join("\n"),
          skillsDir: this.#skillsDir,
          fakeArtifacts: this.#fakeArtifacts,
          throwAfterWrite: this.#fakeThrowAfterWrite,
          required: true,
        });
        runId = result.runId;
        if (result.revert?.incident) {
          await this.#fileExtrasFromRun(runId, id);
          refuse("inspect .git — spawn touched .git/", HINT.plan);
        }
        if (result.revert && result.revert.extrasReverted.length > 0) {
          spawnFails.push(
            `plan spawn wrote files outside SkillContract; reverted: ${result.revert.extrasReverted.join(", ")}`,
          );
        }
        if (result.error) {
          spawnFails.push(result.error instanceof Error ? result.error.message : String(result.error));
        }
      } catch (err) {
        if (err instanceof LegionRefuseError) throw err;
        spawnFails.push(err instanceof Error ? err.message : String(err));
      }
      if (runId) {
        await this.#fileExtrasFromRun(runId, id);
      }

      await this.#clampPlanTaskStatuses(id);

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
      const fails = [...spawnFails, ...report.fails];
      for (const bad of unreadable) {
        fails.push(`${bad.id} is not a valid task`);
        if (bad.filesAllowed && filesAllowedFailsPlan(bad.filesAllowed)) {
          fails.push(`${bad.id} filesAllowed must be concrete paths`);
        }
      }
      const concerns = fails.length > 0 ? [] : report.concerns;
      const readiness: Readiness = fails.length > 0 ? "FAIL" : report.readiness;
      const phase: Phase = readiness === "FAIL" ? "plan_failed" : "plan_ready";
      assertCanTransition("planning", phase);
      this.#lastPlanReport = { readiness, fails, concerns };
      await this.#writeState({
        ...current,
        phase,
        activeSpecId: id,
        lastReadiness: readiness,
      });
      if (readiness !== "FAIL") {
        await this.#promoteReadyTasks(id, phase, config.control_mode);
      }
      return readiness;
    });
  }

  getLastPlanReport(): ReadinessReport | null {
    return this.#lastPlanReport;
  }

  async nextTasks(): Promise<Task[]> {
    const state = await this.#readState();
    let controlMode: ControlMode = "guarded";
    try {
      controlMode = (await this.#readConfig()).control_mode;
    } catch {
      // uninitialized / missing config
    }
    const slice = sliceTasks(await this.#listTasks(), state.activeSpecId);
    return readyTasks({
      phase: state.phase,
      controlMode,
      tasks: slice,
      assumptions: await this.#listAssumptions(),
    });
  }

  async fileTicket(input: NewTicket): Promise<Task> {
    return this.#mutate(() => this.#fileTicketLocked(input));
  }

  async newPacket(input: NewPacket): Promise<PacketResult> {
    return this.#mutate(() => this.#newPacketLocked(input));
  }

  async respondPacket(input: PacketRespondInput): Promise<PacketResult> {
    return this.#mutate(() => this.#respondPacketLocked(input));
  }

  async amendTask(id: string, contract: FileContract, opts?: AmendTaskOptions): Promise<void> {
    return this.#mutate(async () => {
      const doc = await this.store.readTask(id);
      const nextBlockedBy = opts?.blockedBy ?? doc.data.blockedBy;
      const nextBlocks = opts?.blocks ?? doc.data.blocks;
      const depsChanged =
        JSON.stringify(nextBlockedBy) !== JSON.stringify(doc.data.blockedBy) ||
        JSON.stringify(nextBlocks) !== JSON.stringify(doc.data.blocks);
      if (depsChanged && !opts?.allowDeps) {
        refuse("changing blockedBy/blocks requires --allow-deps", HINT.amend);
      }
      if (filesAllowedFailsPlan(contract.filesAllowed)) {
        refuse("filesAllowed must be concrete paths", HINT.concretePaths);
      }
      if (contract.verificationCommands.length === 0) {
        refuse("amend requires verificationCommands", HINT.plan);
      }
      const merged: FileContract = {
        ...contract,
        filesForbidden: mergeFilesForbidden(contract.filesForbidden),
      };
      const others = (await this.#listTasks()).filter((task) => task.id !== id);
      const overlaps = overlappingFilesAllowed([{ ...doc.data, contract: merged }, ...others]);
      if (overlaps.length > 0) {
        refuse(`overlapping filesAllowed ${overlaps[0]}`, HINT.amend);
      }
      await this.store.writeTask(
        {
          ...doc.data,
          contract: merged,
          blockedBy: nextBlockedBy,
          blocks: nextBlocks,
        },
        doc.body,
      );
    });
  }

  async execute(taskId: string | "auto" = "auto", opts?: ExecuteOptions): Promise<ExecuteResult> {
    return this.#mutate(async () => {
      const config = await this.#readConfig();
      if (config.control_mode === "advisory") {
        refuse("execute is refused in advisory mode", HINT.advisory);
      }
      const outcomes: ExecuteTaskResult[] = [];
      const warnings: string[] = [];
      let nextId: string | "auto" = taskId;
      while (true) {
        const outcome = await this.#executeOneLocked(nextId, { fix: Boolean(opts?.fix), config });
        outcomes.push(outcome);
        if (outcome.headMoved && !warnings.includes(HEAD_MOVED_WARNING)) {
          warnings.push(HEAD_MOVED_WARNING);
        }
        if (outcome.status === "blocked" || outcome.incident) break;
        if (!opts?.untilBlocked) break;
        const state = await this.#readState();
        const slice = sliceTasks(await this.#listTasks(), state.activeSpecId);
        const ready = pickNextTask({
          phase: state.phase,
          controlMode: config.control_mode,
          tasks: slice,
          assumptions: await this.#listAssumptions(),
        });
        if (!ready) break;
        nextId = ready.id;
      }
      const state = await this.#readState();
      const last = outcomes.at(-1);
      return {
        taskId: last?.taskId ?? "",
        phase: state.phase,
        status: last?.status ?? "blocked",
        tasks: outcomes,
        warnings,
      };
    });
  }

  async verify(taskId?: string): Promise<VerifyResult> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("verify is refused until init", HINT.init);
      }
      if (state.phase !== "executing" && state.phase !== "ready_to_ship") {
        refuse("verify is optional walkthrough notes during executing", HINT.execute);
      }
      const specId = state.activeSpecId;
      if (!specId) {
        refuse("verify requires an active spec", HINT.spec);
      }
      const slice = sliceTasks(await this.#listTasks(), specId);
      let task: Task | undefined;
      if (taskId) {
        task = slice.find((candidate) => candidate.id === taskId);
        if (!task) {
          refuse(`task ${taskId} is not in the active spec slice`, HINT.blockers);
        }
      }

      const config = await this.#readConfig();
      const before = await this.snapshotTaskIds();
      const result = await optionalSkillSpawn({
        projectRoot: this.projectRoot,
        config,
        skillId: "verify",
        specId,
        taskId: task?.id,
        promptBody: [
          "Optional walkthrough notes. This is not a ship gate.",
          `Active spec: ${specId}`,
          task ? `Task: ${task.id} ${task.title}` : "Walk the slice tasks.",
          "Write notes to .legion-cli/qa/verify.md (or .legion-cli/qa/verify/<taskId>.md).",
          "If you find fix work, file type: fix child tasks under .legion-cli/tasks/ or extra.json.",
          "Do not git add or git commit. Do not write packets.",
        ].join("\n"),
        skillsDir: this.#skillsDir,
        fakeArtifacts: this.#fakeArtifacts,
        throwAfterWrite: this.#fakeThrowAfterWrite,
      });
      if (result.runId) {
        await this.#fileExtrasFromRun(result.runId, specId, { type: "fix", parentId: task?.id });
      }
      const after = await this.snapshotTaskIds();
      const createdTaskIds = after.filter((id) => !before.includes(id));
      if (createdTaskIds.length > 0) {
        await this.#clampSpawnedTaskStatuses(createdTaskIds);
        await this.#promoteReadyTasks(specId, "executing", config.control_mode);
      }
      if (result.spawned) {
        await this.#refuseSpawnContract("verify", result.revert, result.error, createdTaskIds, before, after);
      }
      if (createdTaskIds.length > 0) {
        await this.#failLastReviewLocked();
      }
      return {
        taskId: task?.id,
        spawned: result.spawned,
        notesPath: await this.#findVerifyNotes(task?.id),
        createdTaskIds,
        extrasReverted: result.revert?.extrasReverted ?? [],
      };
    });
  }

  async review(): Promise<ReviewResult> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      const slice = sliceTasks(await this.#listTasks(), state.activeSpecId);
      this.#assertCanReview(state, slice);
      const specId = state.activeSpecId;
      if (!specId) {
        refuse("review requires an active spec", HINT.spec);
      }
      const config = await this.#readConfig();
      await this.#assertReviewSpawnable(config);

      const before = await this.snapshotTaskIds();
      const result = await optionalSkillSpawn({
        projectRoot: this.projectRoot,
        config,
        skillId: "review",
        specId,
        promptBody: [
          "Spec-level review of a terminal slice.",
          `Active spec: ${specId}`,
          `Read .legion-cli/specs/${specId}/SPEC.md and .legion-cli/tasks/*.md.`,
          "Write notes to .legion-cli/qa/review.md.",
          "If the slice does not meet the spec, file tasks under .legion-cli/tasks/ (type: fix) or extra.json.",
          "Creating any new task id FAILs this review. Zero new tasks is PASS.",
          "Do not git add or git commit. Do not write packets.",
        ].join("\n"),
        skillsDir: this.#skillsDir,
        fakeArtifacts: this.#fakeArtifacts,
        throwAfterWrite: this.#fakeThrowAfterWrite,
        required: true,
      });
      if (result.runId) {
        await this.#fileExtrasFromRun(result.runId, specId);
      }
      const after = await this.snapshotTaskIds();
      const createdTaskIds = after.filter((id) => !before.includes(id));
      if (createdTaskIds.length > 0) {
        await this.#clampSpawnedTaskStatuses(createdTaskIds);
        await this.#promoteReadyTasks(specId, "executing", config.control_mode);
      }
      await this.#refuseSpawnContract("review", result.revert, result.error, createdTaskIds, before, after);
      const verdict = await this.#applyReviewSnapshotsLocked(await this.#readState(), before, after);
      return { verdict, createdTaskIds, extrasReverted: result.revert?.extrasReverted ?? [] };
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

  async qa(opts: QaOptions = {}): Promise<QAScore> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      const slice = sliceTasks(await this.#listTasks(), state.activeSpecId);
      this.#assertCanQa(state, slice);
      const specId = state.activeSpecId;
      if (!specId) {
        refuse("qa requires an active spec", HINT.spec);
      }
      const spec = (await this.store.readSpec(specId)).data;
      const config = await this.#readConfig();
      const mode = opts.mode ?? config.qa.mode;
      if (mode === "no-browser") {
        const receipt = await readChecklist(this.projectRoot);
        if (!checklistComplete(spec, receipt)) {
          refuse("no-browser qa requires legion-cli qa checklist", HINT.qaChecklist);
        }
      }
      const score = opts.score
        ? QAScoreSchema.parse(opts.score)
        : (
            await runProjectQa({
              projectRoot: this.projectRoot,
              spec,
              mode,
              unitCommand: config.qa.unitCommand,
            })
          ).score;
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

  async qaChecklist(ticks: string[]): Promise<void> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      const specId = state.activeSpecId;
      if (!specId) {
        refuse("qa checklist requires an active spec", HINT.spec);
      }
      const spec = (await this.store.readSpec(specId)).data;
      const valid = new Set(spec.acceptance.map((ac) => ac.id));
      const unique = [...new Set(ticks.map((id) => id.trim()).filter(Boolean))];
      const unknown = unique.find((id) => !valid.has(id));
      if (unknown) {
        refuse(`unknown acceptance criterion ${unknown}`, HINT.qaChecklist);
      }
      await writeChecklist(this.projectRoot, {
        specId,
        ticks: unique,
        updatedAt: nowIso(),
      });
    });
  }

  async fix(bug: string): Promise<Task> {
    return this.#mutate(async () => {
      const title = bug.trim();
      if (!title) {
        refuse("fix requires a bug description", HINT.fix);
      }
      const state = await this.#readState();
      if (state.phase !== "executing" && state.phase !== "ready_to_ship" && state.phase !== "plan_ready") {
        refuse("fix requires plan_ready, executing, or ready_to_ship", HINT.execute);
      }
      const specId = state.activeSpecId;
      if (!specId) {
        refuse("fix requires an active spec", HINT.spec);
      }
      const testPath = regressionTestPath(title);
      await ensureRegressionTest(this.projectRoot, testPath, title);
      const verifyCmd = regressionVerifyCommand(testPath);
      const red = runVerificationCommands(this.projectRoot, [verifyCmd]);
      if (red[0]?.ok) {
        refuse("this does not reproduce", HINT.fix);
      }
      await this.#failLastReviewLocked();
      const filesAllowed = fixFilesAllowed(this.projectRoot, testPath);
      return this.#fileTicketLocked({
        title,
        type: "bug",
        priority: "P0",
        notes: "Playwright-before-fix: reproducing test must stay RED until execute goes GREEN.",
        contract: {
          filesAllowed,
          expectedArtifacts: [testPath],
          verificationCommands: [verifyCmd],
        },
      });
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

  async beginIntent(): Promise<IntentState> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("intent is refused until init", HINT.init);
      }
      if (state.phase === "initialized") {
        assertCanTransition(state.phase, "intent_draft");
        await this.#writeState({ ...state, phase: "intent_draft" });
      } else if (state.phase !== "intent_draft") {
        refuse("intent interview is already finished", HINT.discuss);
      }
      return this.#intentState();
    });
  }

  async getIntentState(): Promise<IntentState> {
    const state = await this.#readState();
    const progress = intentProgress(await this.#loadIntentAnswers());
    return {
      phase: state.phase,
      answers: progress.answers,
      mapped: progress.answers.mapped,
      nextQuestions: progress.nextQuestions,
      readyToConfirm: progress.readyToConfirm,
      canFinishEarly: progress.canFinishEarly,
      brief: progress.brief,
    };
  }

  async intentTurn(answers: string[]): Promise<IntentState> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("intent is refused until init", HINT.init);
      }
      let current = state;
      if (current.phase === "initialized") {
        assertCanTransition(current.phase, "intent_draft");
        current = { ...current, phase: "intent_draft" };
        await this.#writeState(current);
      }
      if (current.phase !== "intent_draft") {
        refuse("intent interview is already finished", HINT.discuss);
      }
      const existing = await this.#loadIntentAnswers();
      const progress = intentProgress(existing);
      if (progress.nextQuestions.length === 0) {
        return this.#intentStateFrom(current, existing);
      }
      const trimmed = answers.map((item) => item.trim());
      if (trimmed.length === 0 || trimmed.every((item) => item.length === 0)) {
        refuse("intent requires answers", HINT.intent);
      }
      const questions = progress.nextQuestions;
      const applied = applyIntentAnswers(existing, questions, trimmed);
      await this.store.writeIntentAnswers(applied.file);
      await this.#applyIntentSideEffects(applied.side);
      return this.#intentStateFrom(current, applied.file);
    });
  }

  async confirmIntent(actor: Actor, opts?: { done?: boolean }): Promise<void> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase !== "intent_draft") {
        refuse("intent confirmation requires phase intent_draft", HINT.intent);
      }
      const answers = await this.#loadIntentAnswers();
      const progress = intentProgress(answers);
      const allowed = progress.readyToConfirm || (Boolean(opts?.done) && progress.canFinishEarly);
      if (!allowed) {
        refuse("intent confirmation requires rounds 1–4 or --done after round 2", HINT.intentConfirm);
      }
      void actor;
      const project = await this.store.readProject();
      const specId = await this.#allocateSpecId(project.data.name);
      await this.#writeIntentArtifacts(answers, specId);
      await this.#optionalSpawn("interview", specId, [
        "Rewrite .legion-cli/specs/*/prd.md from the intent answers.",
        "Do not ask new questions.",
        `Intent answers are at .legion-cli/wiki/product/intent-answers.yaml.`,
      ].join("\n"));
      assertCanTransition("intent_draft", "intent_ready");
      await this.#writeState({ ...state, phase: "intent_ready" });
    });
  }

  async startDiscuss(): Promise<DiscussDecision[]> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase !== "intent_ready" && state.phase !== "discussing") {
        refuse("discuss requires intent_ready", HINT.intent);
      }
      let current = state;
      if (current.phase === "intent_ready") {
        assertCanTransition(current.phase, "discussing");
        current = { ...current, phase: "discussing" };
        await this.#writeState(current);
      }
      const mapped = (await this.#loadIntentAnswers()).mapped;
      const context = (await this.store.readContext()).data;
      let discuss = await this.#loadDiscuss();
      if (discuss.decisions.length === 0) {
        discuss = { schemaVersion: SCHEMA_VERSION.discuss, decisions: templateDecisions(mapped, context) };
        await this.store.writeDiscuss(discuss, "Proposed decisions. Human accepts or rejects each.\n");
      }
      const priorStatus = new Map(discuss.decisions.map((item) => [item.id, item.status]));
      const project = await this.store.readProject();
      const specId = await this.#allocateSpecId(project.data.name, { allowExistingDraft: true });
      await this.#optionalSpawn(
        "discuss",
        specId,
        "Propose decisions in .legion-cli/discuss/DISCUSS.md with status proposed. Do not accept them.",
      );
      discuss = await this.#loadDiscuss();
      if (discuss.decisions.length === 0) {
        discuss = { schemaVersion: SCHEMA_VERSION.discuss, decisions: templateDecisions(mapped, context) };
      }
      const reset = discuss.decisions.map((item) => {
        const prior = priorStatus.get(item.id);
        if (prior === "accepted" || prior === "rejected") return { ...item, status: prior };
        return { ...item, status: "proposed" as const };
      });
      await this.store.writeDiscuss(
        { schemaVersion: SCHEMA_VERSION.discuss, decisions: reset },
        "Proposed decisions. Human accepts or rejects each.\n",
      );
      return reset.filter((item) => item.status === "proposed");
    });
  }

  async discuss(decisions: DecisionInput[]): Promise<DiscussDecision[]> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase !== "discussing") {
        refuse("discuss requires phase discussing", HINT.discuss);
      }
      const doc = await this.#loadDiscuss();
      const byId = new Map(doc.decisions.map((item) => [item.id, item]));
      for (const input of decisions) {
        const existing = byId.get(input.id);
        if (!existing) {
          refuse(`unknown decision ${input.id}`, HINT.discuss);
        }
        const next: DiscussDecision = { ...existing, status: input.status };
        byId.set(input.id, next);
        await this.store.writeDecision(
          decisionFileName(next.id, next.statement),
          {
            schemaVersion: DECISION_FILE_SCHEMA_VERSION,
            id: next.id,
            status: next.status,
            summary: next.statement,
          },
          `${next.status === "accepted" ? "Accepted" : "Rejected"}: ${next.statement}\n`,
        );
      }
      const merged = doc.decisions.map((item) => byId.get(item.id) ?? item);
      await this.store.writeDiscuss(
        { schemaVersion: SCHEMA_VERSION.discuss, decisions: merged },
        "Decisions captured before planning.\n",
      );
      return merged.filter((item) => item.status === "proposed");
    });
  }

  async draftSpec(opts?: { skipWireframes?: boolean }): Promise<Spec> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "spec_frozen" || this.#isPostFreeze(state.phase)) {
        if (opts?.skipWireframes) {
          refuse("--skip-wireframes is pre-approve only", HINT.skipWireframes);
        }
        refuse("spec is already frozen", HINT.specApprove);
      }
      if (state.phase !== "discussing" && state.phase !== "spec_draft") {
        refuse("spec requires decisions captured", HINT.discuss);
      }
      const skipWireframes = Boolean(opts?.skipWireframes);
      const project = await this.store.readProject();
      const specId = state.activeSpecId ?? (await this.#allocateSpecId(project.data.name));
      const answers = await this.#loadIntentAnswers();
      const extraAcceptance = (await this.#listAssumptions())
        .filter((item) => item.createdIn === "intent" && item.blocking === false)
        .map((item, i) => ({
          id: `AC-P1-${String(i + 1).padStart(2, "0")}`,
          statement: item.statement,
          kind: "behavior" as const,
          priority: "P1" as const,
        }));
      const spec = buildSpecFromIntent({
        specId,
        title: project.data.name,
        mapped: answers.mapped,
        extraAcceptance,
        skipWireframes,
      });
      await this.store.writeSpec(spec, specMarkdownBody(spec));
      await mkdir(join(this.store.paths.specsDir, specId), { recursive: true });
      await writeFile(join(this.store.paths.specsDir, specId, "prd.md"), prdBody(answers.mapped), "utf8");
      if (!skipWireframes) {
        await this.#writeWireframes(spec, answers.mapped.screens);
      }
      let current = state;
      if (current.phase === "discussing") {
        assertCanTransition(current.phase, "spec_draft");
        current = { ...current, phase: "spec_draft", activeSpecId: specId };
        await this.#writeState(current);
      } else {
        await this.#writeState({ ...current, activeSpecId: specId });
      }
      await this.store.writeProject({ ...project.data, activeSpecId: specId }, project.body);
      await this.#optionalSpawn(
        "spec",
        specId,
        [
          `Fill .legion-cli/specs/${specId}/SPEC.md from the intent answers if needed.`,
          "You may replace inner markup of wireframe HTML files.",
          "Keep the palette: background #f5f5f0, ink #222, accent #c45c26, muted #888.",
          "Do not set status to frozen. The human runs legion-cli spec approve.",
        ].join("\n"),
      );
      if (!skipWireframes) {
        await this.#ensureWireframePalette(specId, answers.mapped.screens);
      }
      return this.#forceSpecDraft(specId, spec);
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

  async brownfield(opts: BrownfieldOptions = {}): Promise<BrownfieldResult> {
    return this.#mutate(() => runBrownfield(this.store, opts));
  }

  async promoteRun(runId: string): Promise<PromoteRunResult> {
    return this.#mutate(() => promoteBrownfieldRun(this.store, runId));
  }

  async #executeOneLocked(
    taskId: string | "auto",
    opts: { fix: boolean; config: LegionConfig },
  ): Promise<ExecuteTaskResult> {
    const state = await this.#readState();
    if (state.phase === "plan_failed") {
      refuse("execute is refused after readiness FAIL", HINT.planRetry);
    }
    if (state.phase !== "plan_ready" && state.phase !== "executing") {
      refuse("execute requires plan_ready or executing", HINT.plan);
    }

    const task = await this.#resolveExecuteTask(taskId, state, opts.config);
    if (task.contract.filesAllowed.length === 0 || task.contract.verificationCommands.length === 0) {
      refuse("execute requires a FileContract with filesAllowed and verificationCommands", HINT.plan);
    }

    await this.#assertExecuteSpawnable(opts.config);
    if (state.phase !== "executing") {
      assertCanTransition(state.phase, "executing");
    }

    const extraAllowed = [...task.contract.filesAllowed, ...task.contract.expectedArtifacts];
    const promptBody = [
      `Task: ${task.id} ${task.title}`,
      `Priority: ${task.priority}`,
      opts.fix ? "This is a fix run. Keep the reproducing test. Do not delete tests." : "",
      `Read .legion-cli/specs/${task.specId}/SPEC.md.`,
      "Write only the files listed in FileContract. Do not git add or git commit.",
      "Copy AC.priority into new test names as @p0/@p1/@p2.",
      "",
      "## FileContract",
      "filesAllowed:",
      ...task.contract.filesAllowed.map((path) => `- ${path}`),
      "expectedArtifacts:",
      ...task.contract.expectedArtifacts.map((path) => `- ${path}`),
      "verificationCommands:",
      ...task.contract.verificationCommands.map((cmd) => `- ${cmd}`),
      "filesForbidden:",
      ...task.contract.filesForbidden.map((path) => `- ${path}`),
    ]
      .filter((line) => line !== "")
      .join("\n");

    const result = await optionalSkillSpawn({
      projectRoot: this.projectRoot,
      config: opts.config,
      skillId: "execute",
      specId: task.specId,
      taskId: task.id,
      promptBody,
      extraAllowedRoots: extraAllowed,
      filesForbidden: task.contract.filesForbidden,
      skillsDir: this.#skillsDir,
      fakeArtifacts: this.#fakeArtifacts,
      throwAfterWrite: this.#fakeThrowAfterWrite,
      required: true,
    });

    const revert = result.revert;
    const extras = revert?.extrasReverted ?? [];
    const incident = Boolean(revert?.incident);
    const headMoved = Boolean(revert?.headMoved);
    const runId = result.runId;

    if (runId) {
      await this.#fileExtrasFromRun(runId, task.specId);
    }

    if (incident || extras.length > 0) {
      let ticketId: string | undefined;
      if (extras.length > 0) {
        const ticket = await this.#fileTicketLocked(
          {
            title:
              extras.length === 1
                ? `FileContract extra: ${extras[0]}`
                : `FileContract extras: ${extras.join(", ")}`,
            parentId: task.id,
            fromAgent: true,
            type: "bug",
            notes: "type: scope. Spawn wrote paths outside FileContract; extras were reverted.",
          },
          task.specId,
        );
        ticketId = ticket.id;
      }
      await this.#transitionTaskTo(task.id, "blocked");
      await this.#writeState({
        ...(await this.#readState()),
        phase: "executing",
        currentTaskId: task.id,
      });
      return {
        taskId: task.id,
        status: "blocked",
        runId,
        extrasReverted: extras,
        incident,
        headMoved,
        ticketId,
      };
    }

    if (result.error) {
      await this.#transitionTaskTo(task.id, "blocked");
      return {
        taskId: task.id,
        status: "blocked",
        runId,
        extrasReverted: extras,
        incident,
        headMoved,
      };
    }

    await this.#transitionTaskTo(task.id, "verifying");

    const verification = runVerificationCommands(this.projectRoot, task.contract.verificationCommands);
    const verificationPass = verification.length > 0 && verification.every((run) => run.ok);

    if (verificationPass) {
      await this.#transitionTaskTo(task.id, "done");
      await this.#promoteReadyTasks(task.specId, "executing", opts.config.control_mode);
    } else {
      await this.#transitionTaskTo(task.id, "blocked");
    }

    await this.#writeState({
      ...(await this.#readState()),
      phase: "executing",
      currentTaskId: task.id,
    });

    return {
      taskId: task.id,
      status: verificationPass ? "done" : "blocked",
      runId,
      extrasReverted: extras,
      incident,
      headMoved,
      verificationPass,
    };
  }

  async #resolveExecuteTask(taskId: string | "auto", state: StateFile, config: LegionConfig): Promise<Task> {
    const slice = sliceTasks(await this.#listTasks(), state.activeSpecId);
    if (taskId === "auto") {
      const picked = pickNextTask({
        phase: state.phase,
        controlMode: config.control_mode,
        tasks: slice,
        assumptions: await this.#listAssumptions(),
      });
      if (!picked) {
        refuse("no ready task in the active spec slice", HINT.blockers);
      }
      return (await this.store.readTask(picked.id)).data;
    }

    let task = slice.find((candidate) => candidate.id === taskId);
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
    if (task.status !== "ready") {
      refuse(`task ${task.id} is ${task.status}, not ready`, HINT.blockers);
    }
    return task;
  }

  async #transitionTaskTo(taskId: string, to: TaskStatus): Promise<void> {
    const forward: TaskStatus[] = ["todo", "ready", "in_progress", "verifying", "done"];
    let doc = await this.store.readTask(taskId);
    if (doc.data.status === to) return;
    if (to === "blocked") {
      assertTaskStatusTransition(doc.data.status, "blocked");
      await this.store.writeTask({ ...doc.data, status: "blocked" }, doc.body);
      return;
    }
    let currentIdx = forward.indexOf(doc.data.status);
    const targetIdx = forward.indexOf(to);
    if (currentIdx === -1 || targetIdx === -1 || currentIdx > targetIdx) {
      assertTaskStatusTransition(doc.data.status, to);
      await this.store.writeTask({ ...doc.data, status: to }, doc.body);
      return;
    }
    while (currentIdx < targetIdx) {
      const next = forward[currentIdx + 1];
      if (!next) break;
      doc = await this.store.readTask(taskId);
      assertTaskStatusTransition(doc.data.status, next);
      await this.store.writeTask({ ...doc.data, status: next }, doc.body);
      currentIdx += 1;
    }
  }

  async #assertExecuteSpawnable(config: LegionConfig): Promise<void> {
    const adapter = resolveAdapter(config, {
      artifacts: this.#fakeArtifacts,
      throwAfterWrite: this.#fakeThrowAfterWrite,
    });
    if (!(await isSpawnable(adapter))) {
      refuse("execute requires a spawnable adapter", HINT.doctor);
    }
    const skillsDir = this.#skillsDir ?? findSkillsDir();
    if (!skillsDir || !existsSync(join(skillsDir, "execute", "SKILL.md"))) {
      refuse("execute requires skills/execute/SKILL.md", HINT.execute);
    }
  }

  async #assertPlanSpawnable(config: LegionConfig): Promise<void> {
    const adapter = resolveAdapter(config, {
      artifacts: this.#fakeArtifacts,
      throwAfterWrite: this.#fakeThrowAfterWrite,
    });
    if (!(await isSpawnable(adapter))) {
      refuse("plan requires a spawnable adapter", HINT.doctor);
    }
    const skillsDir = this.#skillsDir ?? findSkillsDir();
    if (!skillsDir || !existsSync(join(skillsDir, "plan", "SKILL.md"))) {
      refuse("plan requires skills/plan/SKILL.md", HINT.plan);
    }
  }

  async #assertReviewSpawnable(config: LegionConfig): Promise<void> {
    const adapter = resolveAdapter(config, {
      artifacts: this.#fakeArtifacts,
      throwAfterWrite: this.#fakeThrowAfterWrite,
    });
    if (!(await isSpawnable(adapter))) {
      refuse("review requires a spawnable adapter", HINT.doctor);
    }
    const skillsDir = this.#skillsDir ?? findSkillsDir();
    if (!skillsDir || !existsSync(join(skillsDir, "review", "SKILL.md"))) {
      refuse("review requires skills/review/SKILL.md", HINT.review);
    }
  }

  async #failLastReviewLocked(): Promise<void> {
    const current = await this.#readState();
    if (current.phase !== "executing" && current.phase !== "ready_to_ship") return;
    const next: StateFile = { ...current, lastReview: "FAIL" };
    if (current.phase === "ready_to_ship") next.phase = "executing";
    if (next.lastReview !== current.lastReview || next.phase !== current.phase) {
      await this.#writeState(next);
    }
  }

  async #findVerifyNotes(taskId?: string): Promise<string | undefined> {
    const candidates = [
      taskId ? `.legion-cli/qa/verify/${taskId}.md` : undefined,
      ".legion-cli/qa/verify.md",
      ".legion-cli/qa/notes.md",
      ".legion-cli/qa/walkthrough.md",
    ];
    for (const path of candidates) {
      if (path && (await this.store.pathExists(path))) return path;
    }
    return undefined;
  }

  async #refuseSpawnContract(
    skillId: "verify" | "review",
    revert: { extrasReverted: string[]; incident: boolean } | null,
    error: unknown,
    createdTaskIds: readonly string[],
    before: readonly string[],
    after: readonly string[],
  ): Promise<void> {
    const failed = Boolean(revert?.incident) || Boolean(revert && revert.extrasReverted.length > 0) || Boolean(error);
    if (!failed) return;
    if (createdTaskIds.length > 0) {
      await this.#applyReviewSnapshotsLocked(await this.#readState(), before, after);
    }
    const hint = skillId === "review" ? HINT.review : HINT.verify;
    if (revert?.incident) {
      refuse("inspect .git — spawn touched .git/", hint);
    }
    if (revert && revert.extrasReverted.length > 0) {
      refuse(
        `${skillId} spawn wrote files outside SkillContract; reverted: ${revert.extrasReverted.join(", ")}`,
        hint,
      );
    }
    if (error instanceof LegionRefuseError) throw error;
    if (error) throw error;
  }

  async #fileExtrasFromRun(
    runId: string,
    specId: string,
    defaults?: { type?: NewTicket["type"]; parentId?: string },
  ): Promise<void> {
    const abs = join(this.projectRoot, ".legion-cli", "cache", "runs", runId, "extra.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(abs, "utf8"));
    } catch {
      return;
    }
    for (const input of parseExtraJson(raw)) {
      await this.#fileTicketLocked(
        {
          ...input,
          fromAgent: true,
          type: input.type ?? defaults?.type,
          parentId: input.parentId ?? defaults?.parentId,
        },
        specId,
      );
    }
  }

  async #fileTicketLocked(input: NewTicket, specIdOverride?: string): Promise<Task> {
    const title = input.title.trim();
    if (!title) {
      refuse("ticket requires a title", HINT.ticket(input.parentId ?? "TSK-x"));
    }
    const state = await this.#readState();
    const specId = specIdOverride ?? state.activeSpecId;
    if (!specId) {
      refuse("ticket requires an active spec", HINT.spec);
    }
    const tasks = await this.#listTasks();
    let parentId = input.parentId;
    if (parentId) {
      const parent = tasks.find((task) => task.id === parentId);
      if (!parent) {
        if (input.fromAgent) {
          parentId = undefined;
        } else {
          refuse(`unknown parent ${parentId}`, HINT.ticket(parentId));
        }
      }
    }
    const id = nextTaskId(tasks.map((task) => task.id));
    const ticket = ticketFromInput(id, specId, { ...input, title, parentId });
    await this.store.writeTask(ticket, taskMarkdownBody(ticket));
    if (parentId) {
      const parentDoc = await this.store.readTask(parentId);
      if (!parentDoc.data.blocks.includes(id)) {
        await this.store.writeTask(
          { ...parentDoc.data, blocks: [...parentDoc.data.blocks, id] },
          parentDoc.body,
        );
      }
    }
    const promoted = await this.#promoteTicketIfReady(id, specId);
    await this.#failLastReviewLocked();
    return promoted;
  }

  async #newPacketLocked(input: NewPacket): Promise<PacketResult> {
    const title = input.title.trim();
    if (!title) {
      refuse("packet new requires a title", HINT.packet);
    }
    const state = await this.#readState();
    if (state.phase === "uninitialized") {
      refuse("packet new is refused until init", HINT.init);
    }
    const id = nextPacketId((await this.#listPackets()).map((packet) => packet.id));
    const packet = packetFromInput(id, { ...input, title }, {
      specId: state.activeSpecId,
      createdAt: nowIso(),
    });
    await this.store.writePacket(packet, packetMarkdownBody(packet));
    return { packet, path: packetPath(id), tickets: [] };
  }

  async #respondPacketLocked(input: PacketRespondInput): Promise<PacketResult> {
    const id = input.id.trim();
    if (!id) {
      refuse("packet respond requires an id", HINT.packetRespond());
    }
    const state = await this.#readState();
    if (state.phase === "uninitialized") {
      refuse("packet respond is refused until init", HINT.init);
    }
    let doc: { data: Packet; body: string };
    try {
      doc = await this.store.readPacket(id);
    } catch {
      refuse(`unknown packet ${id}`, HINT.packetRespond(id));
    }
    if (doc.data.status === "responded") {
      refuse(`packet ${id} already responded`, HINT.ticket(doc.data.ticketIds[0] ?? "TSK-x"));
    }
    const ticketTitle = input.title?.trim() || doc.data.title;
    const ticket = await this.#fileTicketLocked({
      title: ticketTitle,
      type: input.type,
      priority: input.priority,
      notes: `Filed from packet ${id}.`,
    });
    const packet: Packet = {
      ...doc.data,
      status: "responded",
      response: input.message?.trim() || "Spawned tickets for this request.",
      ticketIds: [...doc.data.ticketIds, ticket.id],
      specId: ticket.specId,
      respondedAt: nowIso(),
    };
    await this.store.writePacket(packet, packetMarkdownBody(packet));
    return { packet, path: packetPath(id), tickets: [ticket] };
  }

  async #listPackets(): Promise<Packet[]> {
    const files = await listMarkdownFiles(this.store.paths.packetsDir);
    const out: Packet[] = [];
    for (const file of files) {
      const packetId = file.replace(/\.md$/i, "");
      try {
        out.push((await this.store.readPacket(packetId)).data);
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Spawn may write tasks/**; only execute + verificationCommands may mark done/blocked. */
  async #clampSpawnedTaskStatuses(createdTaskIds: readonly string[]): Promise<void> {
    for (const id of createdTaskIds) {
      const doc = await this.store.readTask(id);
      if (doc.data.status === "todo" || doc.data.status === "ready") continue;
      await this.store.writeTask({ ...doc.data, status: "todo" }, doc.body);
    }
  }

  async #clampPlanTaskStatuses(specId: string): Promise<void> {
    const slice = sliceTasks(await this.#listTasks(), specId);
    for (const task of slice) {
      if (task.status === "todo" || task.status === "ready") continue;
      const doc = await this.store.readTask(task.id);
      await this.store.writeTask({ ...doc.data, status: "todo" }, doc.body);
    }
  }

  async #promoteTicketIfReady(taskId: string, specId: string): Promise<Task> {
    const doc = await this.store.readTask(taskId);
    const state = await this.#readState();
    let controlMode: ControlMode = "guarded";
    try {
      controlMode = (await this.#readConfig()).control_mode;
    } catch {
      // missing config
    }
    const slice = sliceTasks(await this.#listTasks(), specId);
    const current = slice.find((task) => task.id === taskId) ?? doc.data;
    if (
      isTaskReady(current, {
        phase: state.phase,
        controlMode,
        tasks: slice,
        assumptions: await this.#listAssumptions(),
      })
    ) {
      if (doc.data.status !== "ready") {
        assertTaskStatusTransition(doc.data.status, "ready");
        const ready = { ...doc.data, status: "ready" as const };
        await this.store.writeTask(ready, doc.body);
        return ready;
      }
    }
    return doc.data;
  }

  async #promoteReadyTasks(specId: string, phase: Phase, controlMode: ControlMode): Promise<void> {
    const slice = sliceTasks(await this.#listTasks(), specId);
    const assumptions = await this.#listAssumptions();
    const readyCtx = { phase, controlMode, tasks: slice, assumptions };
    for (const task of slice) {
      if (task.status !== "todo") continue;
      if (!isTaskReady(task, readyCtx)) continue;
      const doc = await this.store.readTask(task.id);
      assertTaskStatusTransition(doc.data.status, "ready");
      await this.store.writeTask({ ...doc.data, status: "ready" }, doc.body);
    }
  }

  #isPostFreeze(phase: Phase): boolean {
    return (
      phase === "planning" ||
      phase === "plan_failed" ||
      phase === "plan_ready" ||
      phase === "executing" ||
      phase === "ready_to_ship" ||
      phase === "shipped" ||
      phase === "abandoned"
    );
  }

  async #intentState(): Promise<IntentState> {
    return this.#intentStateFrom(await this.#readState(), await this.#loadIntentAnswers());
  }

  #intentStateFrom(state: StateFile, answers: IntentAnswersFile): IntentState {
    const progress = intentProgress(answers);
    return {
      phase: state.phase,
      answers: progress.answers,
      mapped: progress.answers.mapped,
      nextQuestions: progress.nextQuestions,
      readyToConfirm: progress.readyToConfirm,
      canFinishEarly: progress.canFinishEarly,
      brief: progress.brief,
    };
  }

  async #loadIntentAnswers(): Promise<IntentAnswersFile> {
    if (!(await this.store.pathExists(".legion-cli/wiki/product/intent-answers.yaml"))) {
      return emptyIntentAnswers();
    }
    return this.store.readIntentAnswers();
  }

  async #loadDiscuss() {
    try {
      return (await this.store.readDiscuss()).data;
    } catch {
      return { schemaVersion: SCHEMA_VERSION.discuss, decisions: [] as DiscussDecision[] };
    }
  }

  async #applyIntentSideEffects(side: {
    platforms?: Array<"phone" | "desktop">;
    failureLines: string[];
    brand?: string;
    blockingLines: string[];
  }): Promise<void> {
    if (side.platforms) {
      const context = await this.store.readContext();
      await this.store.writeContext({ ...context.data, platforms: side.platforms }, context.body);
    }
    if (side.brand && !/^(none|no|n\/a|-)$/i.test(side.brand)) {
      const context = await this.store.readContext();
      const note = /^https?:\/\//i.test(side.brand)
        ? `Brand URL recorded but not fetched in v0: ${side.brand}`
        : `Brand file: ${side.brand}`;
      const standing = context.data.standingInstructions
        ? `${context.data.standingInstructions.trim()}\n${note}\n`
        : `${note}\n`;
      await this.store.writeContext({ ...context.data, standingInstructions: standing }, context.body);
    }
    const lines: Array<{ statement: string; blocking: boolean }> = [
      ...side.failureLines.map((statement) => ({ statement, blocking: false })),
      ...side.blockingLines.map((statement) => ({ statement, blocking: true })),
    ];
    if (lines.length === 0) return;
    let n = (await this.#listAssumptions()).length;
    for (const line of lines) {
      n += 1;
      const id = `ASM-${String(n).padStart(4, "0")}`;
      const assumption: Assumption = {
        schemaVersion: SCHEMA_VERSION.assumption,
        id,
        statement: line.statement,
        status: "open",
        blocking: line.blocking,
        escalatesTo: "user",
        createdIn: "intent",
      };
      await this.store.writeAssumption(assumption, `${line.statement}\n`);
    }
  }

  async #writeIntentArtifacts(answers: IntentAnswersFile, specId: string): Promise<void> {
    await this.store.writeMarkdown(
      ".legion-cli/wiki/product/intent.md",
      {
        schemaVersion: WIKI_PAGE_SCHEMA_VERSION,
        title: "Intent",
        aliases: ["intent brief"],
        tags: ["product"],
        trust: "reviewed",
        updated: nowIso(),
      },
      intentWikiBody(answers.mapped),
    );
    await mkdir(join(this.store.paths.specsDir, specId), { recursive: true });
    await writeFile(join(this.store.paths.specsDir, specId, "prd.md"), prdBody(answers.mapped), "utf8");
  }

  async #allocateSpecId(name: string, opts?: { allowExistingDraft?: boolean }): Promise<string> {
    const base = specIdFromName(name);
    const ids = [base, ...Array.from({ length: 98 }, (_, i) => `${base}-${i + 2}`)];
    for (const id of ids) {
      const storePath = `.legion-cli/specs/${id}/SPEC.md`;
      if (!(await this.store.pathExists(storePath))) return id;
      if (!opts?.allowExistingDraft) continue;
      try {
        const spec = (await this.store.readSpec(id)).data;
        if (spec.status === "draft") return id;
      } catch {
        return id;
      }
    }
    return `${base}-${Date.now()}`;
  }

  async #forceSpecDraft(specId: string, fallback: Spec): Promise<Spec> {
    let data: Spec;
    let body: string;
    try {
      const doc = await this.store.readSpec(specId);
      data = doc.data;
      body = doc.body;
    } catch {
      const restored = { ...fallback, status: "draft" as const, frozenAt: null, frozenBy: null };
      await this.store.writeSpec(restored, specMarkdownBody(restored));
      return restored;
    }
    if (data.status !== "draft" || data.frozenAt || data.frozenBy) {
      const restored = { ...data, status: "draft" as const, frozenAt: null, frozenBy: null };
      await this.store.writeSpec(restored, body);
      return restored;
    }
    return data;
  }

  async #writeWireframes(spec: Spec, screens: string[]): Promise<void> {
    const names = screens.length > 0 ? screens : ["home"];
    const pages = uniqueScreenPages(names);
    const dir = join(this.store.paths.specsDir, spec.id, "wireframes");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "INDEX.html"),
      renderWireframeIndex({ specTitle: spec.title, specId: spec.id, pages }),
      "utf8",
    );
    for (const page of pages) {
      await writeFile(
        join(dir, `${page.slug}.html`),
        renderWireframeScreen({
          specTitle: spec.title,
          screen: page.name,
          slug: page.slug,
          pages,
        }),
        "utf8",
      );
    }
  }

  async #ensureWireframePalette(specId: string, screens: string[]): Promise<void> {
    const names = screens.length > 0 ? screens : ["home"];
    const pages = uniqueScreenPages(names);
    const dir = join(this.store.paths.specsDir, specId, "wireframes");
    const files = ["INDEX.html", ...pages.map((page) => `${page.slug}.html`)];
    for (const file of files) {
      const abs = join(dir, file);
      try {
        const html = await readFile(abs, "utf8");
        if (!palettePresent(html)) {
          const spec = (await this.store.readSpec(specId)).data;
          await this.#writeWireframes(spec, names);
          return;
        }
      } catch {
        const spec = (await this.store.readSpec(specId)).data;
        await this.#writeWireframes(spec, names);
        return;
      }
    }
  }

  async #optionalSpawn(skillId: "interview" | "discuss" | "spec", specId: string, promptBody: string): Promise<void> {
    let config: LegionConfig;
    try {
      config = await this.#readConfig();
    } catch {
      return;
    }
    const result = await optionalSkillSpawn({
      projectRoot: this.projectRoot,
      config,
      skillId,
      specId,
      promptBody,
      skillsDir: this.#skillsDir,
      fakeArtifacts: this.#fakeArtifacts,
      throwAfterWrite: this.#fakeThrowAfterWrite,
    });
    if (!result.spawned || !result.revert) return;
    if (result.revert.incident) {
      refuse("inspect .git — spawn touched .git/", HINT.intent);
    }
    if (result.revert.extrasReverted.length > 0) {
      refuse(
        `spawn wrote files outside SkillContract; reverted: ${result.revert.extrasReverted.join(", ")}`,
        HINT.intent,
      );
    }
    if (result.error) {
      throw result.error;
    }
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

export function createLegionEngine(projectRoot: string, options?: LegionEngineOptions): LegionEngine {
  return new LegionEngine(projectRoot, undefined, options);
}
