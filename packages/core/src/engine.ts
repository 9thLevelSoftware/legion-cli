import {
  isResolvedAdapterSpawnable,
  listResolvedSkillCatalog,
  parseSkillFrontmatter,
  resolveAdapterId,
  resolveSkillDir,
  skillCatalogPath,
  type FakeArtifact,
} from "@9thlevelsoftware/legion-cli-agents";
import {
  expectedArtifactsFailsPlan,
  filesAllowedFailsPlan,
  isTaskReady,
  mergeFilesForbidden,
  overlappingFilesAllowed,
  pickNextTask,
  readyTasks,
  validateTaskGraph,
} from "@9thlevelsoftware/legion-cli-graph";
import {
  ensureRealMapDir,
  generateMap,
  MapError,
  mergeArchitecture,
  readExistingMapFile,
  renderArchitecture,
  writeMapFile,
} from "@9thlevelsoftware/legion-cli-map";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  abandonReceiptBody,
  abandonReceiptPath,
  appendAuditEvent,
  createLegionStore,
  DECISION_FILE_SCHEMA_VERSION,
  packetPath,
  parseMarkdownDocument,
  PathEscapeError,
  AuditTamperError,
  EngineLockedError,
  RestoreRefusedError,
  invalidTaskMessage,
  listTaskFiles,
  nextFileId,
  PersistError,
  ensureGitignore,
  commitPaths,
  gitAdd,
  gitCommitIndex,
  gitDiffCached,
  gitHasStaged,
  gitPorcelainPaths,
  gitResetMixed,
  gitRestoreStaged,
  gitStagedPaths,
  isGitRepo,
  tryGitHead,
  shipReceiptBody,
  shipReceiptPath,
  toFsPath,
  wikiIdFromStorePath,
  WIKI_PAGE_SCHEMA_VERSION,
  writeTextFile,
  type LegionStore,
  type WikiPage,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  buildSessionBrief,
  ensureWikiIndex,
  gardenReport,
  isForbiddenSpawnPath,
  materializeIngestSources,
  searchWiki,
  SsrfError,
  trustWikiPage,
  wrapUntrustedContent,
  writeWikiCatalog,
  WIKI_INDEX_STORE_PATH,
  WIKI_TOPICS_STORE_PATH,
  type GardenReport,
  type MaterializedIngest,
  type SearchHit,
} from "@9thlevelsoftware/legion-cli-wiki";
import {
  checklistComplete,
  readChecklist,
  runProjectQa,
  writeChecklist,
} from "@9thlevelsoftware/legion-cli-qa";
import {
  ADAPTER_ID_HELP,
  ControlModeSchema,
  AcceptanceReceiptSchema,
  PlanApprovalReceiptSchema,
  QAScoreSchema,
  SURGICAL_MIGRATION_HINT,
  SCHEMA_VERSION,
  type AdapterId,
  type AcceptanceReceipt,
  type Assumption,
  type ControlMode,
  type DiscussDecision,
  type IngestReceipt,
  type IntentAnswersFile,
  type LegionConfig,
  type Packet,
  type PlanApprovalReceipt,
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
  type WorkflowEvidenceReceipt,
  type SpecChallengeReceipt,
  type SpecChallengeProposedChange,
} from "@9thlevelsoftware/legion-cli-schema";
import { copyShippedCraft, isBrandViolationBlockingFreeze } from "@9thlevelsoftware/legion-cli-design-system";
import { assertExecuteSandbox, SandboxError } from "@9thlevelsoftware/legion-cli-sandbox";
import { HINT, LegionRefuseError, refuse, refuseKind } from "./errors.js";
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
import { evaluateReadiness, type ReadinessReport } from "./readiness.js";
import { isSliceTerminal, p0TasksNotDone, sliceHasOpenWork, sliceTasks } from "./slice.js";
import {
  HEAD_MOVED_WARNING,
  restoreChangedTaskFiles,
  snapshotTaskFiles,
  type TaskFileSnapshot,
} from "./revert.js";
import {
  findLatestTaskResume,
  findSkillsDir,
  finishStartedSpawn,
  listCacheResumes,
  optionalSkillSpawn,
  refuseIfLiveSkillSpawn,
  resumeRunIsLive,
  spawnableAdapterRefuseMessage,
  startSkillSpawn,
  waitStartedSpawn,
  defaultAllowCopyJail,
  type OptionalSpawnResult,
  type StartedSkillSpawn,
} from "./spawn.js";
import { buildSpecFromIntent, specMarkdownBody } from "./spec-build.js";
import { compactTaskBody, outcomeFromTask } from "./compact.js";
import { assertTaskStatusTransition, canTransitionTaskStatus } from "./tasks.js";
import {
  ensureRegressionTest,
  fixFilesAllowed,
  regressionTestPath,
  regressionVerifyCommand,
} from "./fix.js";
import { packetFromInput, packetMarkdownBody } from "./packets.js";
import { defaultTicketContract, parseExtraJson, taskMarkdownBody, ticketFromInput } from "./tickets.js";
import {
  displayStagedRoots,
  ghAvailable,
  SHIP_STAGED_CHANGED,
  shipAddPaths,
  shipCommitMessage,
  shipProductIndexFingerprint,
  tryCreatePullRequest,
  unionDoneFilesAllowed,
  unrelatedDirty,
} from "./ship.js";
import { undoLastTask as runUndoLastTask, type UndoResult } from "./undo.js";
import type {
  Actor,
  AmendTaskOptions,
  BrownfieldDagResult,
  BrownfieldEvidenceOptions,
  BrownfieldEvidenceResult,
  BrownfieldMergeResult,
  BrownfieldOptions,
  BrownfieldPatternsOptions,
  BrownfieldPatternsResult,
  BrownfieldPrPlanResult,
  BrownfieldResult,
  BrownfieldReviewStatusOptions,
  BrownfieldReviewStatusResult,
  BrownfieldRosterResult,
  BrownfieldStateResult,
  BrownfieldWorktreeOptions,
  BrownfieldWorktreeResult,
  CompactOptions,
  CompactResult,
  DecisionInput,
  ExecuteOptions,
  ExecuteResult,
  ExecuteWorkflowOptions,
  IngestOpts,
  IngestResult,
  ExecuteTaskResult,
  InitOptions,
  IntentState,
  LegionEngineOptions,
  NewPacket,
  NewTicket,
  PromoteRunOptions,
  PromoteRunResult,
  PacketRespondInput,
  PacketResult,
  PlanApprovalOptions,
  QaOptions,
  ReviewResult,
  ShipOptions,
  ShipPreview,
  ShipReceipt,
  VerifyResult,
  WorkflowExecutionResult,
  WorkflowStatus,
  AcceptanceEvidenceInput,
  SpecChallengeManualQuestionKey,
  SpecChallengeManualReviewInput,
  SpecChallengeResolutionInput,
  SpecChallengeResult,
  WireframeOptions,
  WireframeResult,
} from "./types.js";
import {
  applyManualReview,
  applySpecChallengeChanges,
  challengeResult,
  completeManualReview,
  createSpecChallengeBinding,
  newSpecChallengeReceipt,
  parseSpecChallengeAnalysis,
  parseSpecChallengeSynthesis,
  readSpecChallengeReceipt,
  receiptMatchesBinding,
  specChallengeAnalysisPath,
  specChallengeDraftBody,
  specChallengeReadableFingerprints,
  specChallengeSynthesisPath,
  validateManualAnswer,
  writeSpecChallengeReceipt,
  writeSpecChallengeThinking,
  type AppliedSpecChallenge,
  type SpecChallengeBinding,
} from "./spec-challenge.js";
import {
  acquireWorkflowClaim,
  WORKFLOW_APPROVAL_PATH,
  WORKFLOW_REVIEW_PATH,
  createWorkflowPlanSnapshot,
  readAcceptanceReceipt,
  readExplicitReviewEvidence,
  readPlanApproval,
  readPlanBody,
  readSpecApproval,
  readWorkflowEvidence,
  readWorkflowDiscoveryContext,
  workflowEnvironmentFingerprint,
  workflowFingerprint,
  workflowProductFingerprint,
  workflowReviewEvidenceFresh,
  writeAcceptanceReceipt,
  writePlanApproval,
  writeSpecApproval,
  writeWorkflowEvidence,
  writeWorkflowReviewReport,
  releaseWorkflowClaim,
  type WorkflowPlanSnapshot,
} from "./workflow.js";
import { assertDiscoverySelection } from "./discovery.js";
import {
  brownfieldEntry,
  dagRun,
  evidenceRun,
  mergeRun,
  patternsRun,
  prPlanRun,
  promoteBrownfieldRun,
  reviewStatusRun,
  rosterRun,
  stateRun,
  worktreeRun,
} from "./brownfield/index.js";
import { parseRunId as parseBrownfieldRunId } from "./brownfield/state.js";
import {
  MAP_ARCHITECTURE_PATH,
  MAP_FINGERPRINTS_PATH,
  MAP_SHOW_NEXT,
  MAP_SPAWN_PROMPT,
  type MapOptions,
  type MapResult,
} from "./map.js";
import { DEFAULT_VERIFICATION_TIMEOUT_MS, runVerificationCommands, verificationFailureReason } from "./verify.js";
import { palettePresent } from "./wireframes.js";
import { finishWireframe, prepareWireframe, screenPagesFor, writeWireframeFiles } from "./wireframe-run.js";

/** Distill spawn is skipped when materialized source exceeds this many characters (64 KiB). */
export const DISTILL_SOURCE_MAX_CHARS = 64 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

function isEngineWikiCatalogPath(storePath: string): boolean {
  const posix = storePath.replaceAll("\\", "/");
  return posix === WIKI_INDEX_STORE_PATH || posix === WIKI_TOPICS_STORE_PATH;
}

async function listWikiStorePaths(wikiDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const abs = rel ? join(wikiDir, ...rel.split("/")) : wikiDir;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const posix = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(posix.replaceAll("\\", "/"));
      else if (entry.isFile()) out.push(`.legion-cli/wiki/${posix.replaceAll("\\", "/")}`);
    }
  };
  await walk("");
  return out;
}

async function snapshotWikiRaw(projectRoot: string, wikiDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of await listWikiStorePaths(wikiDir)) {
    try {
      out.set(path, await readFile(toFsPath(projectRoot, path), "utf8"));
    } catch {
      // missing between list and read
    }
  }
  return out;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
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
  | { ok: false; id: string; file: string; error: string; specId?: string; filesAllowed?: string[] };

/** Every configured `apiKeyEnv` (adapter.http and any named adapter): scrubbed from commands. */
function configuredApiKeyEnvNames(config: unknown): string[] {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === "apiKeyEnv" && typeof nested === "string") names.add(nested);
      else walk(nested);
    }
  };
  walk((config as { adapter?: unknown } | undefined)?.adapter);
  return [...names];
}

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

type EngineSpecDocument = { data: Spec; body: string };
type EngineSpecChallengeContext =
  | { applicable: false; specId: string; spec: EngineSpecDocument }
  | { applicable: true; specId: string; spec: EngineSpecDocument; binding: SpecChallengeBinding };

export class LegionEngine {
  readonly store: LegionStore;
  readonly #skillsDir?: string;
  readonly #fakeArtifacts: FakeArtifact[];
  readonly #fakeThrowAfterWrite: boolean;
  readonly #fakeTimedOut: boolean;
  readonly #fakeHoldWait?: LegionEngineOptions["fakeHoldWait"];
  readonly #fakeOnWait?: () => Promise<void>;
  readonly #fakeVerificationError?: string;
  readonly #fakeOnVerify?: () => Promise<void>;
  readonly #fakeOnQa?: () => Promise<void>;
  readonly #fakeAfterChallengeOutputCheckpoint?: () => Promise<void>;
  readonly #fakeAfterChallengeDraftWrite?: () => Promise<void>;
  readonly #fakeHandlePid?: number;
  readonly #verificationTimeoutMs: number;
  #lastPlanReport: ReadinessReport | null = null;
  #lastQaWarnings: string[] = [];
  #reconciled = false;

  constructor(projectRoot: string, store?: LegionStore, options?: LegionEngineOptions) {
    this.store = store ?? createLegionStore(projectRoot);
    this.#skillsDir = options?.skillsDir;
    this.#fakeArtifacts = options?.fakeArtifacts ?? [];
    this.#fakeThrowAfterWrite = Boolean(options?.fakeThrowAfterWrite);
    this.#fakeTimedOut = Boolean(options?.fakeTimedOut);
    this.#fakeHoldWait = options?.fakeHoldWait;
    this.#fakeOnWait = options?.fakeOnWait;
    this.#fakeVerificationError = options?.fakeVerificationError;
    this.#fakeOnVerify = options?.fakeOnVerify;
    this.#fakeOnQa = options?.fakeOnQa;
    this.#fakeAfterChallengeOutputCheckpoint = options?.fakeAfterChallengeOutputCheckpoint;
    this.#fakeAfterChallengeDraftWrite = options?.fakeAfterChallengeDraftWrite;
    this.#fakeHandlePid = options?.fakeHandlePid;
    this.#verificationTimeoutMs = options?.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  }

  get projectRoot(): string {
    return this.store.projectRoot;
  }

  async init(opts: InitOptions): Promise<void> {
    const mode = opts.mode ?? "greenfield";
    if (mode !== "greenfield" && mode !== "brownfield") {
      refuse("init mode must be greenfield or brownfield", HINT.initMode);
    }
    if (opts.brownfieldGoal && mode !== "brownfield") {
      refuse("brownfield goal requires brownfield mode", HINT.initMode);
    }
    const controlMode = this.#parseControlMode(opts.controlMode ?? "guarded");
    if (!opts.name?.trim()) {
      refuse("init requires a product name", HINT.init);
    }
    if (!opts.adapter) {
      refuse("adapter.default is required", "set adapter.default in .legion-cli/config.yaml");
    }
    if (opts.adapter === "http" && !opts.http) {
      refuse(
        "adapter.http is required when adapter.default is http",
        "legion-cli init --adapter http --http-base-url <url> --http-model <id> --http-api-key-env <ENV>",
      );
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
        ...(mode === "brownfield" ? { brownfieldGoal: opts.brownfieldGoal ?? "change" } : {}),
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
          ...(opts.http ? { http: { allowLoopback: false, ...opts.http } } : {}),
        },
        ingest: { autoCommit: true },
        control_mode: controlMode,
        qa: { mode: "full", passScore: 85 },
        dashboard: { port: 7420, bind: "127.0.0.1" },
        flags: { mcpApps: false, webmcp: false, parallelExecute: false },
        sandbox: {
          requireHardened: true,
          allowCopyJail: opts.allowCopyJail ?? defaultAllowCopyJail(opts.adapter),
          backend: "auto",
          skills: ["execute"],
        },
        skills: { trustKeys: [] },
        map: {},
        ...(opts.workflowProfile
          ? { workflow: { profile: opts.workflowProfile, verificationCommands: [] } }
          : {}),
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
        await this.#assertCurrentShipGate(state, {});
      }
      await this.#writeState({ ...state, phase: target });
    });
  }

  async approveSpec(specId: string, actor: Actor, opts?: { message?: string }): Promise<void> {
    return this.#mutate(async () => {
      await this.#assertNoLiveInProgress("spec approve");
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
      // STATE.md is written last. A crash after the spec froze but before STATE moved on leaves
      // `frozen` + `spec_draft`; approving again completes the missing writes (F-015).
      // Only the approve that crashed resumes: the spec this draft phase is about.
      const resuming =
        spec.status === "frozen" && (state.activeSpecId == null || state.activeSpecId === specId);
      if (spec.status !== "draft" && !resuming) {
        refuse(`spec ${specId} is ${spec.status}, not draft`, HINT.specApprove);
      }
      const approvalMessage = opts?.message?.trim();
      if (approvalMessage && !specBody.includes(`## Approval note\n\n${approvalMessage}`)) {
        specBody = `${specBody.trimEnd()}\n\n## Approval note\n\n${approvalMessage}\n`;
      }
      if (!resuming) {
        await this.#assertFocusedSpecChallengeCompleteLocked(specId);
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
        await writeSpecApproval(this.store, {
          schemaVersion: SCHEMA_VERSION.specApproval,
          specId,
          specFingerprint: workflowFingerprint({ data: frozen, body: specBody }),
          approvedAt: frozen.frozenAt ?? nowIso(),
          approvedBy: actor.id,
        });
      } else {
        const existingApproval = await readSpecApproval(this.store);
        const resumedFingerprint = workflowFingerprint({ data: spec, body: specBody });
        if (existingApproval && existingApproval.specFingerprint !== resumedFingerprint) {
          refuse("the frozen spec differs from its approval receipt", HINT.specApprove);
        }
        if (approvalMessage) await this.store.writeSpec(spec, specBody);
        if (!existingApproval) {
          await writeSpecApproval(this.store, {
            schemaVersion: SCHEMA_VERSION.specApproval,
            specId,
            specFingerprint: resumedFingerprint,
            approvedAt: spec.frozenAt ?? nowIso(),
            approvedBy: spec.frozenBy ?? actor.id,
          });
        }
      }
      const project = await this.store.readProject();
      if (project.data.activeSpecId !== specId) {
        await this.store.writeProject({ ...project.data, activeSpecId: specId }, project.body);
      }
      await this.#writeState({
        ...state,
        phase: "spec_frozen",
        activeSpecId: specId,
      });
    });
  }

  async newSpec(): Promise<void> {
    return this.#mutate(async () => {
      await this.#assertNoLiveInProgress("spec new");
      const state = await this.#readState();
      if (state.phase !== "shipped" && state.phase !== "abandoned") {
        refuse("Start a new spec after this one ships or is abandoned", HINT.specNew);
      }
      assertCanTransition(state.phase, "intent_draft");
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
      await this.#audit("spec_new", "intent_draft", "user", {
        previousSpecId: state.activeSpecId ?? null,
      });
    });
  }

  async ingest(sources: string[], opts?: IngestOpts): Promise<IngestResult> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("Ingest needs a Legion CLI project first", HINT.init);
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
      const autoCommit = opts?.noCommit !== true;
      if (autoCommit && !isGitRepo(this.projectRoot)) {
        refuse("ingest auto-commit requires a git repository", HINT.noCommit);
      }
      let receipt: IngestReceipt;
      let distillSkipped: string | undefined;
      let distillRan = false;
      let extraWikiPaths: string[] = [];
      try {
        const materialized = await materializeIngestSources({
          projectRoot: this.projectRoot,
          sources,
          transcript: opts?.transcript,
          diff: opts?.diff,
        });
        receipt = await this.store.ingest(materialized.files, {
          noCommit: true,
          documents: materialized.documents,
        });
        if (opts?.distill) {
          const distill = await this.#maybeDistillLocked(receipt, materialized);
          distillSkipped = distill.skipped;
          extraWikiPaths = distill.extraWikiPaths;
          distillRan = Boolean(distill.ran);
        }
        await this.#refreshWikiCatalogLocked();
        if (autoCommit) {
          commitPaths(
            this.projectRoot,
            [
              ...new Set([
                ...receipt.pagesCreated,
                ...receipt.pagesUpdated,
                ...extraWikiPaths,
                WIKI_INDEX_STORE_PATH,
                WIKI_TOPICS_STORE_PATH,
              ]),
            ],
            `legion-cli ingest: ${receipt.id}`,
          );
        }
      } catch (err) {
        if (err instanceof PathEscapeError) {
          refuse("That file: URL is outside this folder", HINT.inRepo);
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
      return {
        ...receipt,
        ...(distillSkipped ? { distillSkipped } : {}),
        ...(distillRan ? { distillRan: true } : {}),
      };
    });
  }

  async wikiTrust(pageId: string): Promise<void> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("Wiki trust needs a Legion CLI project first", HINT.init);
      }
      try {
        await trustWikiPage(this.store, pageId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        refuse(message, HINT.show);
      }
      await this.#refreshWikiCatalogLocked();
    });
  }

  async brief(): Promise<SessionBrief> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("Brief needs a Legion CLI project first", HINT.init);
      }
      const skillsDir = this.#skillsDir ?? findSkillsDir();
      const { catalog } = await listResolvedSkillCatalog({
        projectRoot: this.projectRoot,
        packagedSkillsDir: skillsDir,
      });
      return buildSessionBrief(this.store, {
        skills: catalog.skills.map((skill) => ({
          skillId: skill.skillId,
          name: skill.name,
          description: skill.description,
        })),
      });
    });
  }

  async search(q: string, opts?: { includeUntrusted?: boolean; mentions?: boolean }): Promise<SearchHit[]> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("Search needs a Legion CLI project first", HINT.init);
      }
      await ensureWikiIndex(this.store);
      return searchWiki(this.projectRoot, q, opts);
    });
  }

  async garden(): Promise<GardenReport> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("garden is refused until init", HINT.init);
      }
      await ensureWikiIndex(this.store);
      return gardenReport(this.projectRoot);
    });
  }

  async map(opts: MapOptions = {}): Promise<MapResult> {
    let started: StartedSkillSpawn | undefined;
    let generated!: Awaited<ReturnType<typeof generateMap>>;

    await this.#withLockOrRefuse(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("Map needs a Legion CLI project first", HINT.init);
      }
      await this.#assertNoLiveInProgress("map");
      try {
        generated = await generateMap(this.projectRoot, {
          refresh: opts.refresh,
          lsp: opts.lsp,
          resolveBinary: opts.resolveBinary,
          spawnLsp: opts.spawnLsp,
          lspDeadlineMs: opts.lspDeadlineMs,
        });
      } catch (err) {
        if (err instanceof MapError) refuse(err.message, err.nextHint);
        throw err;
      }
      let config: LegionConfig;
      try {
        config = await this.#readConfig();
      } catch {
        return;
      }
      started = await startSkillSpawn({
        ...this.#skillSpawnFields(),
        config,
        skillId: "map",
        promptBody: MAP_SPAWN_PROMPT,
        required: false,
      });
    });

    const waited = started?.spawned ? await waitStartedSpawn(started) : undefined;

    return this.#withLockOrRefuse(async () => {
      if (started?.spawned) {
        const revert = await finishStartedSpawn(started);
        await ensureRealMapDir(this.projectRoot, this.store.paths.mapDir);
        const fingerprintsPath = join(this.store.paths.mapDir, "fingerprints.json");
        const architecturePath = join(this.store.paths.mapDir, "ARCHITECTURE.md");
        const existingArch = await readExistingMapFile(architecturePath);
        await writeMapFile(fingerprintsPath, `${JSON.stringify(generated.fingerprints, null, 2)}\n`, {
          root: this.projectRoot,
        });
        await writeMapFile(
          architecturePath,
          mergeArchitecture(existingArch, renderArchitecture(generated.fingerprints)),
          { root: this.projectRoot },
        );
        if (revert.incident) {
          refuse("inspect .git — spawn touched .git/", HINT.map);
        }
        if (revert.extrasReverted.length > 0) {
          refuse(
            `spawn wrote files outside SkillContract; reverted: ${revert.extrasReverted.join(", ")}`,
            HINT.map,
          );
        }
        if (waited?.error) {
          const message = waited.error instanceof Error ? waited.error.message : String(waited.error);
          refuse(`map skill spawn failed: ${message}`, HINT.map);
        }
      }
      const state = await this.#readState();
      await this.#audit(opts.refresh ? "map_refresh" : "map", state.phase, "user", {
        backend: generated.backend,
        modules: generated.fingerprints.modules.length,
        changedCount: generated.changed.length,
        rootHash: generated.fingerprints.rootHash,
      });
      return {
        path: MAP_ARCHITECTURE_PATH,
        fingerprintsPath: MAP_FINGERPRINTS_PATH,
        backend: generated.backend,
        modules: generated.fingerprints.modules.length,
        changed: generated.changed,
        next: MAP_SHOW_NEXT,
      };
    });
  }

  async compactContext(opts?: CompactOptions): Promise<CompactResult> {
    return this.#withLockOrRefuse(
      async () => {
        await this.#assertNoLiveInProgress("context compact");
        const state = await this.#readState();
        if (state.phase === "uninitialized") {
          refuse("context compact is refused until init", HINT.init);
        }
        const tasks = await this.#listTasks();
        const compacted: CompactResult["compacted"] = [];
        const skipped: CompactResult["skipped"] = [];
        for (const task of tasks) {
          if (task.status !== "done") continue;
          const siblingInProgress = tasks.some(
            (other) => other.specId === task.specId && other.status === "in_progress",
          );
          if (siblingInProgress) {
            skipped.push({ id: task.id, title: task.title, reason: "in_progress sibling" });
            continue;
          }
          const doc = await this.store.readTask(task.id);
          if (doc.data.status !== "done") continue;
          assertTaskStatusTransition(doc.data.status, "compacted");
          const outcome = outcomeFromTask(doc.data.notes, doc.body);
          await this.#writeTask({ ...doc.data, status: "compacted" }, compactTaskBody(doc.data.title, outcome));
          compacted.push({ id: doc.data.id, title: doc.data.title });
        }
        if (compacted.length > 0) {
          await this.#audit("context_compact", state.phase, "user", {
            compacted: compacted.map((task) => task.id),
            skipped: skipped.map((task) => task.id),
          });
        }
        await this.#refreshWikiCatalogLocked();
        return { compacted, skipped };
      },
      { timeoutMs: opts?.timeoutMs, nextHint: HINT.compact },
    );
  }

  async assumeList(): Promise<Assumption[]> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("assume list needs a Legion CLI project first", HINT.init);
      }
      return (await this.#listAssumptions()).sort((a, b) => a.id.localeCompare(b.id));
    });
  }

  async assumeAnswer(id: string, status: "confirmed" | "rejected"): Promise<Assumption> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("assume answer needs a Legion CLI project first", HINT.init);
      }
      if (status !== "confirmed" && status !== "rejected") {
        refuse("assume answer status must be confirmed or rejected", HINT.assumeAnswer);
      }
      const trimmed = id.trim();
      if (!trimmed) {
        refuse("assume answer requires an id", HINT.assumeAnswer);
      }
      let doc: { data: Assumption; body: string };
      try {
        doc = await this.store.readAssumption(trimmed);
      } catch (err) {
        if (err instanceof PathEscapeError) {
          refuse("unknown assumption", HINT.assumeList);
        }
        refuse(`unknown assumption ${trimmed}`, HINT.assumeList);
      }
      const next: Assumption = { ...doc.data, status };
      await this.store.writeAssumption(next, doc.body);
      if (state.activeSpecId) {
        let controlMode: ControlMode = "guarded";
        try {
          controlMode = (await this.#readConfig()).control_mode;
        } catch {
          // missing config
        }
        await this.#promoteReadyTasks(state.activeSpecId, state.phase, controlMode);
      }
      await this.store.rebuild();
      await this.#refreshWikiCatalogLocked();
      return next;
    });
  }

  async indexRebuild(): Promise<void> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("index rebuild needs a Legion CLI project first", HINT.init);
      }
      await this.store.rebuild();
      await this.#refreshWikiCatalogLocked();
    });
  }

  async getControlMode(): Promise<ControlMode> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("control-mode needs a Legion CLI project first", HINT.init);
      }
      return (await this.#readConfig()).control_mode;
    });
  }

  async setControlMode(mode: string): Promise<ControlMode> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("control-mode needs a Legion CLI project first", HINT.init);
      }
      const parsed = this.#parseControlMode(mode);
      const config = await this.#readConfig();
      await this.store.writeConfig({ ...config, control_mode: parsed });
      if (await this.store.pathExists(".legion-cli/PROJECT.md")) {
        const project = await this.store.readProject();
        if (project.data.controlMode !== parsed) {
          await this.store.writeProject({ ...project.data, controlMode: parsed }, project.body);
        }
      }
      if (state.activeSpecId) {
        await this.#promoteReadyTasks(state.activeSpecId, state.phase, parsed);
      }
      await this.#audit("control_mode", state.phase, "user", { control_mode: parsed });
      return parsed;
    });
  }

  /** Execute-spawn helper: wrap untrusted bodies if they are injected at all. */
  wrapUntrustedForSpawn(source: string, body: string): string {
    return wrapUntrustedContent(source, body);
  }

  spawnPathForbidden(path: string): boolean {
    return isForbiddenSpawnPath(path);
  }

  async plan(specId?: string, opts?: { adapter?: AdapterId }): Promise<Readiness> {
    const spawnFails: string[] = [];
    let started: StartedSkillSpawn | undefined;
    let current: StateFile | undefined;
    let id: string | undefined;
    let config: LegionConfig | undefined;

    await this.#withLockOrRefuse(async () => {
      await this.#assertNoLiveInProgress("plan");
      const state = await this.#readState();
      if (state.phase !== "spec_frozen" && state.phase !== "planning" && state.phase !== "plan_failed") {
        refuse("Plan needs a frozen spec first", HINT.spec);
      }
      id = specId ?? state.activeSpecId ?? undefined;
      if (!id) {
        refuse("plan requires an active spec", HINT.spec);
      }

      config = await this.#readConfig();
      await this.#assertSkillSpawnable(config, "plan", { cliAdapter: opts?.adapter });

      current = { ...state, activeSpecId: id };
      if (current.phase === "spec_frozen" || current.phase === "plan_failed") {
        assertCanTransition(current.phase, "planning");
        current = { ...current, phase: "planning" };
        await this.#writeState(current);
      }

      try {
        started = await startSkillSpawn({
          ...this.#skillSpawnFields(),
          config,
          skillId: "plan",
          specId: id,
          promptBody: [
            `Active spec: ${id}`,
            `Read .legion-cli/specs/${id}/SPEC.md.`,
            "For brownfield projects also read .legion-cli/map/DISCOVERY.md and .legion-cli/map/ARCHITECTURE.md when present.",
            `Write .legion-cli/plans/${id}.md and .legion-cli/tasks/TSK-*.md with FileContracts.`,
            "Every task needs verificationCommands and exclusive concrete filesAllowed.",
            `Optional adapter: is an AdapterId (${ADAPTER_ID_HELP}). Set it only when SPEC or DISCUSS names that coding CLI; otherwise omit.`,
            "Never emit adapter: fake outside tests.",
            `If you discover extra work, write extra.json in the run cache (may include "adapter": "grok"); do not expand filesAllowed.`,
            "Do not write src/** or other product files.",
          ].join("\n"),
          required: true,
          cliAdapter: opts?.adapter,
        });
      } catch (err) {
        if (err instanceof LegionRefuseError) throw err;
        spawnFails.push(err instanceof Error ? err.message : String(err));
      }
    });

    if (started?.spawned) {
      const waited = await waitStartedSpawn(started);
      if (waited.error) {
        spawnFails.push(waited.error instanceof Error ? waited.error.message : String(waited.error));
      }
    }

    return this.#withLockOrRefuse(async () => {
      const specIdLocked = id;
      const currentLocked = current;
      const configLocked = config;
      if (!specIdLocked || !currentLocked || !configLocked) {
        refuse("plan requires an active spec", HINT.spec);
      }
      let runId = started?.runId;
      if (started?.spawned) {
        const revert = await finishStartedSpawn(started);
        if (revert.incident) {
          await this.#fileExtrasFromRun(started.runId, specIdLocked);
          refuse("inspect .git — spawn touched .git/", HINT.plan);
        }
        if (revert.extrasReverted.length > 0) {
          spawnFails.push(
            `plan spawn wrote files outside SkillContract; reverted: ${revert.extrasReverted.join(", ")}`,
          );
        }
      }
      if (runId) {
        await this.#fileExtrasFromRun(runId, specIdLocked);
      }

      await this.#clampPlanTaskStatuses(specIdLocked);

      const spec = (await this.store.readSpec(specIdLocked)).data;
      const entries = await this.#loadTaskEntries();
      const unreadable = entries.filter(
        (entry): entry is Extract<LoadedTask, { ok: false }> =>
          !entry.ok && (entry.specId === specIdLocked || entry.specId === undefined),
      );
      const tasks = sliceTasks(
        entries.filter((entry): entry is Extract<LoadedTask, { ok: true }> => entry.ok).map((entry) => entry.task),
        specIdLocked,
      );
      const hasStories = await this.store.pathExists(`.legion-cli/specs/${specIdLocked}/stories.yaml`);
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
        ...currentLocked,
        phase,
        activeSpecId: specIdLocked,
        lastReadiness: readiness,
      });
      if (readiness !== "FAIL") {
        await this.#promoteReadyTasks(specIdLocked, phase, configLocked.control_mode);
      }
      return readiness;
    });
  }

  getLastPlanReport(): ReadinessReport | null {
    return this.#lastPlanReport;
  }

  async approvePlan(actor: Actor = { id: "user" }, opts: PlanApprovalOptions = {}): Promise<PlanApprovalReceipt> {
    return this.#mutate(async () => {
      await assertDiscoverySelection(this);
      await this.#assertNoLiveInProgress("plan approve");
      const state = await this.#readState();
      if (state.phase !== "plan_ready" && state.phase !== "executing" && state.phase !== "ready_to_ship") {
        refuse("plan approve requires plan_ready, executing, or ready_to_ship", HINT.plan);
      }
      const currentConfig = await this.#readConfig();
      const approvalConfig: LegionConfig = currentConfig.workflow?.profile === "focused"
        ? currentConfig
        : {
            ...currentConfig,
            workflow: {
              profile: "focused",
              verificationCommands: currentConfig.workflow?.verificationCommands ?? [],
            },
          };
      // Validate against the effective focused configuration before persisting it. A normal
      // approval refusal must leave a legacy project on its compatible legacy path.
      const context = await this.#workflowPlanContext(approvalConfig);
      const readiness = evaluateReadiness({
        spec: context.spec,
        tasks: context.tasks,
        hasStories: await this.store.pathExists(`.legion-cli/specs/${context.snapshot.specId}/stories.yaml`),
        skipWireframes: !context.spec.wireframesIndex,
        openNonBlockingAssumptions: (await this.#listAssumptions()).some(
          (assumption) => assumption.status === "open" && !assumption.blocking,
        ),
      });
      if (readiness.readiness === "FAIL") {
        refuse(`plan is not ready: ${readiness.fails.join("; ")}`, HINT.plan);
      }
      const planBody = await readPlanBody(this.projectRoot, context.snapshot.specId);
      if (!planBody?.trim()) {
        refuse(
          `plan approval requires a non-empty .legion-cli/plans/${context.snapshot.specId}.md; write the plan document, then approve it`,
          "legion-cli plan approve",
        );
      }

      const approvedSpec = await readSpecApproval(this.store);
      if (approvedSpec &&
          (approvedSpec.specId !== context.snapshot.specId ||
            approvedSpec.specFingerprint !== context.snapshot.specFingerprint)) {
        refuse("the frozen spec changed after approval; restore the approved spec or approve a new spec", HINT.specApprove);
      }
      if (!approvedSpec) {
        // Legacy frozen specs had no content-bound receipt. This explicit plan approval imports
        // and binds the current frozen revision instead of silently trusting it during execute.
        await writeSpecApproval(this.store, {
          schemaVersion: SCHEMA_VERSION.specApproval,
          specId: context.snapshot.specId,
          specFingerprint: context.snapshot.specFingerprint,
          approvedAt: nowIso(),
          approvedBy: actor.id,
        });
      }

      const priorPlanApproval = await readPlanApproval(this.store);
      const verificationCommands = [
        ...new Set([
          ...(context.config.workflow?.verificationCommands ?? []),
          ...(priorPlanApproval?.specId === context.snapshot.specId
            ? priorPlanApproval.verificationCommands
            : []),
          ...(opts.verificationCommands ?? []),
        ].map((command) => command.trim()).filter(Boolean)),
      ];
      if (currentConfig.workflow?.profile !== "focused") {
        await this.store.writeConfig(approvalConfig);
      }
      const receipt = PlanApprovalReceiptSchema.parse({
        schemaVersion: SCHEMA_VERSION.planApproval,
        specId: context.snapshot.specId,
        approvedAt: nowIso(),
        approvedBy: actor.id,
        approvalId: randomUUID(),
        planFingerprint: context.snapshot.planFingerprint,
        specFingerprint: context.snapshot.specFingerprint,
        taskFingerprint: context.snapshot.taskFingerprint,
        configFingerprint: context.snapshot.configFingerprint,
        taskIds: context.snapshot.taskIds,
        acceptanceIds: context.snapshot.acceptanceIds,
        verificationCommands,
      });
      await writePlanApproval(this.store, receipt);
      await this.#audit("plan_approve", state.phase, actor.id, {
        specId: receipt.specId,
        planFingerprint: receipt.planFingerprint,
        verificationCommands: receipt.verificationCommands,
      });
      return receipt;
    });
  }

  async readSpecChallenge(specId?: string): Promise<SpecChallengeResult> {
    const context = await this.#specChallengeContextLocked(specId);
    if (!context.applicable) {
      return challengeResult(
        context.specId,
        await readSpecChallengeReceipt(this.store, context.specId),
        "complete",
      );
    }
    const receipt = await readSpecChallengeReceipt(this.store, context.specId);
    if (!receipt) return challengeResult(context.specId, null);
    return challengeResult(
      context.specId,
      receipt,
      receiptMatchesBinding(receipt, context.binding) ? undefined : "stale",
    );
  }

  async prepareSpecChallenge(
    specId?: string,
    opts?: { adapter?: AdapterId },
  ): Promise<SpecChallengeResult> {
    let started: StartedSkillSpawn | undefined;
    const prepared = await this.#withLockOrRefuse(async (): Promise<
      { result: SpecChallengeResult } | { recoverRunId: string } | { spawn: true }
    > => {
      const context = await this.#specChallengeContextLocked(specId);
      if (!context.applicable) return { result: challengeResult(context.specId, null, "complete") };
      let receipt = await readSpecChallengeReceipt(this.store, context.specId);
      const current = Boolean(receipt && receiptMatchesBinding(receipt, context.binding));
      if (receipt && current) {
        if (receipt.status === "analysis_running") {
          if (receipt.generation.status === "complete" && receipt.generation.runId) {
            return { recoverRunId: receipt.generation.runId };
          }
          if (receipt.generation.runId) {
            const resume = (await listCacheResumes(this.projectRoot))
              .find((candidate) => candidate.runId === receipt?.generation.runId);
            if (resume && resumeRunIsLive(resume)) return { result: challengeResult(context.specId, receipt) };
          }
          receipt = await this.#markChallengeManualRequiredLocked(
            receipt,
            "analysis was interrupted before a successful adapter exit could be proven",
          );
          return { result: challengeResult(context.specId, receipt) };
        }
        return { result: challengeResult(context.specId, receipt) };
      }
      await this.#assertNoLiveInProgress("spec challenge");
      const nextRound = (receipt?.round ?? 0) + 1;
      receipt = newSpecChallengeReceipt(context.binding, nextRound, nowIso());
      await writeSpecChallengeReceipt(this.store, receipt);
      const config = await this.#readConfig();
      try {
        started = await startSkillSpawn({
          ...this.#skillSpawnFields(),
          config,
          skillId: "spec-challenge",
          specId: context.specId,
          promptBody: this.#specChallengePrompt("analysis", context.specId, null),
          cliAdapter: opts?.adapter,
          required: false,
        });
      } catch (err) {
        receipt = await this.#markChallengeManualRequiredLocked(
          receipt,
          `analysis automation unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { result: challengeResult(context.specId, receipt) };
      }
      if (!started.spawned) {
        receipt = await this.#markChallengeManualRequiredLocked(receipt, "analysis automation is unavailable");
        return { result: challengeResult(context.specId, receipt) };
      }
      receipt = {
        ...receipt,
        generation: { ...receipt.generation, runId: started.runId },
        updatedAt: nowIso(),
      };
      await writeSpecChallengeReceipt(this.store, receipt);
      return { spawn: true };
    }, { nextHint: "legion-cli spec" });

    if ("result" in prepared) return prepared.result;
    if ("recoverRunId" in prepared) {
      return this.#withLockOrRefuse(() => this.#finishChallengeAnalysisLocked(specId, prepared.recoverRunId));
    }
    const liveAnalysis = started;
    if (!liveAnalysis?.spawned) throw new Error("spec challenge spawn was not retained");
    const waited = await waitStartedSpawn(liveAnalysis);
    return this.#withLockOrRefuse(async () => {
      const context = await this.#specChallengeContextLocked(specId);
      if (!context.applicable) {
        await finishStartedSpawn(liveAnalysis);
        return challengeResult(context.specId, null, "complete");
      }
      let receipt = await this.#requireSpecChallengeReceiptLocked(context.specId);
      if (waited.error) {
        await finishStartedSpawn(liveAnalysis);
        receipt = await this.#markChallengeManualRequiredLocked(
          receipt,
          `analysis automation failed: ${waited.error instanceof Error ? waited.error.message : String(waited.error)}`,
        );
        return challengeResult(context.specId, receipt);
      }
      if (!receiptMatchesBinding(receipt, context.binding)) {
        await finishStartedSpawn(liveAnalysis);
        return challengeResult(context.specId, receipt, "stale");
      }
      let concerns;
      try {
        concerns = await parseSpecChallengeAnalysis(
          this.projectRoot,
          await this.#readChallengeSpawnOutput(liveAnalysis, specChallengeAnalysisPath(liveAnalysis.runId)),
          context.specId,
        );
      } catch (err) {
        await finishStartedSpawn(liveAnalysis);
        receipt = await this.#markChallengeManualRequiredLocked(
          receipt,
          err instanceof Error ? err.message : String(err),
        );
        return challengeResult(context.specId, receipt);
      }
      receipt = {
        ...receipt,
        generation: { ...receipt.generation, status: "complete", completedAt: nowIso() },
        concerns,
        updatedAt: nowIso(),
      };
      // Validated output is durable before copy-out/cleanup, so recovery never depends on a surviving jail.
      await writeSpecChallengeReceipt(this.store, receipt);
      await this.#fakeAfterChallengeOutputCheckpoint?.();
      await finishStartedSpawn(liveAnalysis);
      return this.#finishChallengeAnalysisLocked(context.specId, liveAnalysis.runId);
    }, { nextHint: "legion-cli spec" });
  }

  async recordSpecChallengeResolution(
    specId: string,
    concernId: string,
    resolution: SpecChallengeResolutionInput,
    actor: Actor = { id: "user" },
  ): Promise<SpecChallengeResult> {
    return this.#mutate(async () => {
      const context = await this.#specChallengeContextLocked(specId);
      if (!context.applicable) return challengeResult(context.specId, null, "complete");
      let receipt = await this.#requireCurrentSpecChallengeLocked(context);
      await this.#assertNoLiveInProgress("spec challenge resolution");
      if (receipt.status !== "awaiting_resolutions") {
        refuse("spec challenge is not awaiting concern resolutions", "legion-cli spec");
      }
      const response = resolution.response.trim();
      if (!response) refuse("spec challenge resolution requires a response or reason", "legion-cli spec");
      const index = receipt.concerns.findIndex((concern) => concern.id === concernId);
      if (index < 0) refuse(`unknown spec challenge concern ${concernId}`, "legion-cli spec");
      const concerns = [...receipt.concerns];
      concerns[index] = {
        ...concerns[index],
        resolution: {
          disposition: resolution.disposition,
          response,
          recordedAt: nowIso(),
          recordedBy: actor.id,
        },
      };
      receipt = { ...receipt, concerns, updatedAt: nowIso() };
      await writeSpecChallengeReceipt(this.store, receipt);
      await writeSpecChallengeThinking(this.projectRoot, receipt);
      return challengeResult(context.specId, receipt);
    });
  }

  async recordSpecChallengeManualAnswer(
    specId: string,
    key: SpecChallengeManualQuestionKey,
    response: string,
    actor: Actor = { id: "user" },
  ): Promise<SpecChallengeResult> {
    return this.#mutate(async () => {
      const context = await this.#specChallengeContextLocked(specId);
      if (!context.applicable) return challengeResult(context.specId, null, "complete");
      let receipt = await this.#requireCurrentSpecChallengeLocked(context);
      await this.#assertNoLiveInProgress("spec challenge manual review");
      if (receipt.status !== "manual_required") {
        refuse("manual review is available only after challenge automation fails", "legion-cli spec");
      }
      let value: string;
      try {
        value = validateManualAnswer(key, response);
      } catch (err) {
        refuse(err instanceof Error ? err.message : String(err), "legion-cli spec --manual-review");
      }
      receipt = {
        ...receipt,
        manualReview: {
          ...(receipt.manualReview ?? {}),
          [key]: value,
          updatedAt: nowIso(),
          updatedBy: actor.id,
        },
        updatedAt: nowIso(),
      };
      await writeSpecChallengeReceipt(this.store, receipt);
      await writeSpecChallengeThinking(this.projectRoot, receipt);
      return challengeResult(context.specId, receipt);
    });
  }

  async finalizeSpecChallenge(
    specId?: string,
    opts?: { adapter?: AdapterId; manualReview?: SpecChallengeManualReviewInput; actor?: Actor },
  ): Promise<SpecChallengeResult> {
    let started: StartedSkillSpawn | undefined;
    const prepared = await this.#withLockOrRefuse(async (): Promise<
      { result: SpecChallengeResult } | { recoverRunId: string } | { spawn: true }
    > => {
      const context = await this.#specChallengeContextLocked(specId);
      if (!context.applicable) return { result: challengeResult(context.specId, null, "complete") };
      let receipt = await this.#requireCurrentSpecChallengeLocked(context);
      await this.#assertNoLiveInProgress("spec challenge finalize");
      if (receipt.application) {
        return { result: await this.#applySpecChallengeApplicationLocked(context, receipt) };
      }
      if (opts?.manualReview) {
        if (receipt.status !== "manual_required") {
          refuse("manual review cannot bypass a successful challenge analysis", "legion-cli spec");
        }
        for (const key of ["measurableSuccess", "failureHandling", "compatibilityAndScope", "acknowledgement"] as const) {
          let value: string;
          try {
            value = validateManualAnswer(key, opts.manualReview[key] ?? "");
          } catch (err) {
            refuse(err instanceof Error ? err.message : String(err), "legion-cli spec --manual-review");
          }
          receipt = {
            ...receipt,
            manualReview: {
              ...(receipt.manualReview ?? {}),
              [key]: value,
              updatedAt: nowIso(),
              updatedBy: opts.actor?.id ?? "user",
            },
          };
          await writeSpecChallengeReceipt(this.store, receipt);
        }
      }
      if (receipt.status === "complete") return { result: challengeResult(context.specId, receipt) };
      if (receipt.status === "manual_required") {
        let manual;
        try {
          manual = completeManualReview(receipt.manualReview);
        } catch (err) {
          refuse(err instanceof Error ? err.message : String(err), "legion-cli spec --manual-review");
        }
        if (!manual) return { result: challengeResult(context.specId, receipt) };
        const applied = applyManualReview(context.spec.data, manual);
        const body = specChallengeDraftBody(context.spec.body, applied);
        receipt = await this.#checkpointSpecChallengeApplicationLocked(
          receipt,
          context.spec,
          applied,
          body,
        );
        return { result: await this.#applySpecChallengeApplicationLocked(context, receipt) };
      }
      if (receipt.concerns.some((concern) => !concern.resolution)) {
        refuse("spec challenge has unresolved concerns", "legion-cli spec");
      }
      if (receipt.status === "synthesis_running") {
        if (receipt.synthesis.status === "complete" && receipt.synthesis.runId) {
          return { recoverRunId: receipt.synthesis.runId };
        }
        if (receipt.synthesis.runId) {
          const resume = (await listCacheResumes(this.projectRoot))
            .find((candidate) => candidate.runId === receipt?.synthesis.runId);
          if (resume && resumeRunIsLive(resume)) return { result: challengeResult(context.specId, receipt) };
        }
        receipt = await this.#markChallengeManualRequiredLocked(
          receipt,
          "synthesis was interrupted before a successful adapter exit could be proven",
        );
        return { result: challengeResult(context.specId, receipt) };
      }
      if (receipt.status !== "awaiting_resolutions") {
        refuse("spec challenge is not ready for synthesis", "legion-cli spec");
      }
      const config = await this.#readConfig();
      receipt = {
        ...receipt,
        status: "synthesis_running",
        synthesis: { status: "running", runId: null, startedAt: nowIso() },
        updatedAt: nowIso(),
      };
      await writeSpecChallengeReceipt(this.store, receipt);
      try {
        started = await startSkillSpawn({
          ...this.#skillSpawnFields(),
          config,
          skillId: "spec-challenge",
          specId: context.specId,
          promptBody: this.#specChallengePrompt("synthesis", context.specId, receipt),
          cliAdapter: opts?.adapter,
          required: false,
        });
      } catch (err) {
        receipt = await this.#markChallengeManualRequiredLocked(
          receipt,
          `synthesis automation unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { result: challengeResult(context.specId, receipt) };
      }
      if (!started.spawned) {
        receipt = await this.#markChallengeManualRequiredLocked(receipt, "synthesis automation is unavailable");
        return { result: challengeResult(context.specId, receipt) };
      }
      receipt = {
        ...receipt,
        synthesis: { ...receipt.synthesis, runId: started.runId },
        updatedAt: nowIso(),
      };
      await writeSpecChallengeReceipt(this.store, receipt);
      return { spawn: true };
    }, { nextHint: "legion-cli spec" });

    if ("result" in prepared) return prepared.result;
    if ("recoverRunId" in prepared) {
      return this.#withLockOrRefuse(() => this.#finishChallengeSynthesisLocked(specId, prepared.recoverRunId));
    }
    const liveSynthesis = started;
    if (!liveSynthesis?.spawned) throw new Error("spec challenge synthesis spawn was not retained");
    const waited = await waitStartedSpawn(liveSynthesis);
    return this.#withLockOrRefuse(async () => {
      const context = await this.#specChallengeContextLocked(specId);
      if (!context.applicable) {
        await finishStartedSpawn(liveSynthesis);
        return challengeResult(context.specId, null, "complete");
      }
      let receipt = await this.#requireSpecChallengeReceiptLocked(context.specId);
      if (waited.error) {
        await finishStartedSpawn(liveSynthesis);
        receipt = await this.#markChallengeManualRequiredLocked(
          receipt,
          `synthesis automation failed: ${waited.error instanceof Error ? waited.error.message : String(waited.error)}`,
        );
        return challengeResult(context.specId, receipt);
      }
      if (!receiptMatchesBinding(receipt, context.binding)) {
        await finishStartedSpawn(liveSynthesis);
        return challengeResult(context.specId, receipt, "stale");
      }
      try {
        const output = parseSpecChallengeSynthesis(
          await this.#readChallengeSpawnOutput(liveSynthesis, specChallengeSynthesisPath(liveSynthesis.runId)),
        );
        const applied = applySpecChallengeChanges(context.spec.data, receipt.concerns, output.changes);
        const body = specChallengeDraftBody(context.spec.body, applied);
        receipt = await this.#checkpointSpecChallengeApplicationLocked(
          receipt,
          context.spec,
          applied,
          body,
        );
      } catch (err) {
        await finishStartedSpawn(liveSynthesis);
        receipt = await this.#markChallengeManualRequiredLocked(
          receipt,
          `synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return challengeResult(context.specId, receipt);
      }
      await this.#fakeAfterChallengeOutputCheckpoint?.();
      await finishStartedSpawn(liveSynthesis);
      return this.#finishChallengeSynthesisLocked(context.specId, liveSynthesis.runId);
    }, { nextHint: "legion-cli spec" });
  }

  async getWorkflowStatus(): Promise<WorkflowStatus> {
    const state = await this.#readState();
    if (state.phase === "shipped" || state.phase === "abandoned") {
      return {
        stage: "spec",
        planApproval: "missing",
        execution: "not_started",
        acceptance: { required: [], passed: [], failed: [], pending: [], notApplicable: [] },
        blocker: null,
        next: "legion-cli spec new",
      };
    }
    if (!state.activeSpecId) {
      return {
        stage: "spec",
        planApproval: "missing",
        execution: "not_started",
        acceptance: { required: [], passed: [], failed: [], pending: [], notApplicable: [] },
        blocker: null,
        next: "legion-cli spec",
      };
    }
    if (["initialized", "intent_draft", "intent_ready", "discussing", "spec_draft"].includes(state.phase)) {
      let next = "legion-cli spec";
      let blocker: string | null = null;
      if (state.phase === "spec_draft") {
        const config = await this.#readConfig();
        if (config.workflow?.profile === "focused") {
          const challenge = await this.readSpecChallenge(state.activeSpecId);
          if (challenge.status === "complete") next = "legion-cli spec approve";
          else {
            next = "legion-cli spec";
            blocker = challenge.status === "stale"
              ? "spec challenge evidence is stale"
              : challenge.status === "manual_required"
                ? challenge.automationError ?? "spec challenge requires manual review"
                : "spec challenge is pending";
          }
        } else {
          next = "legion-cli spec approve";
        }
      }
      return {
        stage: "spec",
        planApproval: "missing",
        execution: "not_started",
        acceptance: { required: [], passed: [], failed: [], pending: [], notApplicable: [] },
        blocker,
        next,
      };
    }
    if (["spec_frozen", "planning", "plan_failed"].includes(state.phase)) {
      return {
        stage: "plan",
        planApproval: "missing",
        execution: "not_started",
        acceptance: { required: [], passed: [], failed: [], pending: [], notApplicable: [] },
        blocker: state.phase === "plan_failed" ? "plan checks failed" : null,
        next: "legion-cli plan",
      };
    }

    const context = await this.#workflowPlanContext();
    const approval = await readPlanApproval(this.store);
    const planApproval = !approval
      ? "missing" as const
      : approval.specId === context.snapshot.specId && approval.planFingerprint === context.snapshot.planFingerprint
        ? "valid" as const
        : "stale" as const;
    if (planApproval !== "valid" || !approval) {
      const planBody = await readPlanBody(this.projectRoot, context.snapshot.specId);
      const missingPlanBody = !planBody?.trim();
      return {
        stage: "plan",
        planApproval,
        execution: "not_started",
        acceptance: this.#workflowAcceptanceStatus(context.spec, null),
        blocker: missingPlanBody
          ? `create .legion-cli/plans/${context.snapshot.specId}.md before approving the plan`
          : planApproval === "stale"
            ? "plan approval is stale"
            : null,
        next: "legion-cli plan approve",
      };
    }

    const productFingerprint = await workflowProductFingerprint(this.projectRoot, context.tasks);
    const environmentFingerprint = workflowEnvironmentFingerprint();
    const evidence = await readWorkflowEvidence(this.store);
    const reviewFresh = !evidence?.review || await workflowReviewEvidenceFresh(this.projectRoot, evidence.review);
    const evidenceFresh = Boolean(
      evidence &&
      evidence.specId === approval.specId &&
      evidence.planFingerprint === approval.planFingerprint &&
      evidence.approvalId === approval.approvalId &&
      evidence.productFingerprint === productFingerprint &&
      evidence.environmentFingerprint === environmentFingerprint &&
      reviewFresh,
    );
    const execution: WorkflowStatus["execution"] = !evidence
      ? "not_started"
      : !evidenceFresh
        ? "stale"
        : evidence.status === "complete"
          ? "complete"
          : evidence.status === "running"
            ? "running"
            : "blocked";
    const acceptanceReceipt = await readAcceptanceReceipt(this.store);
    const acceptanceFresh = Boolean(
      acceptanceReceipt &&
      acceptanceReceipt.specId === approval.specId &&
      acceptanceReceipt.planFingerprint === approval.planFingerprint &&
      acceptanceReceipt.approvalId === approval.approvalId &&
      acceptanceReceipt.productFingerprint === productFingerprint,
    );
    const acceptance = this.#workflowAcceptanceStatus(context.spec, acceptanceFresh ? acceptanceReceipt : null);
    const ready = execution === "complete" && acceptance.failed.length === 0 && acceptance.pending.length === 0;
    const retryableExecutionFailure = execution === "blocked" && Boolean(
      evidenceFresh && evidence && (
        evidence.integration.some((run) => !run.ok) ||
        evidence.review?.verdict === "FAIL" ||
        evidence.blocker?.startsWith("independent review")
      ),
    );
    const blockedTask = context.tasks.find((task) => task.status === "blocked");
    const blocker = execution === "stale"
      ? "workflow evidence is stale"
      : evidenceFresh && evidence?.blocker
        ? evidence.blocker
        : acceptance.failed.length > 0
          ? `acceptance failed: ${acceptance.failed.join(", ")}`
          : execution === "complete" && acceptance.pending.length > 0
            ? `acceptance evidence pending: ${acceptance.pending.join(", ")}`
            : null;
    return {
      stage: ready ? "ship" : "execute",
      planApproval,
      execution,
      acceptance,
      blocker,
      next: ready
        ? "legion-cli ship"
        : execution === "complete" && acceptance.failed.length > 0
          ? `legion-cli plan acceptance --pass ${acceptance.failed[0]}`
        : execution === "complete" && acceptance.pending.length > 0
          ? `legion-cli plan acceptance --pass ${acceptance.pending[0]}`
          : retryableExecutionFailure
            ? "legion-cli execute --retry"
            : blockedTask
              ? `legion-cli task amend ${blockedTask.id}`
              : "legion-cli execute",
    };
  }

  async recordAcceptance(
    entries: AcceptanceEvidenceInput[],
    actor: Actor = { id: "user" },
  ): Promise<AcceptanceReceipt> {
    return this.#mutate(async () => {
      const context = await this.#requireCurrentPlanApproval();
      const productFingerprint = await workflowProductFingerprint(this.projectRoot, context.tasks);
      const evidence = await readWorkflowEvidence(this.store);
      if (!evidence || evidence.status !== "complete" ||
          evidence.planFingerprint !== context.approval.planFingerprint ||
          evidence.approvalId !== context.approval.approvalId ||
          evidence.productFingerprint !== productFingerprint ||
          evidence.environmentFingerprint !== workflowEnvironmentFingerprint() ||
          !await workflowReviewEvidenceFresh(this.projectRoot, evidence.review)) {
        refuse("complete, fresh workflow evidence is required before acceptance", "legion-cli execute");
      }
      const validIds = new Set(context.spec.acceptance.map((criterion) => criterion.id));
      for (const entry of entries) {
        if (!validIds.has(entry.id)) refuse(`unknown acceptance criterion ${entry.id}`, "legion-cli spec");
        if ((entry.status === "failed" || entry.status === "not_applicable") && !entry.note?.trim()) {
          refuse(`${entry.status} acceptance evidence requires --note`, "legion-cli plan acceptance --help");
        }
      }
      const previous = await readAcceptanceReceipt(this.store);
      const reusable = previous &&
        previous.specId === context.approval.specId &&
        previous.planFingerprint === context.approval.planFingerprint &&
        previous.approvalId === context.approval.approvalId &&
        previous.productFingerprint === productFingerprint;
      const merged = new Map((reusable ? previous.entries : []).map((entry) => [entry.id, entry]));
      for (const entry of entries) merged.set(entry.id, { ...entry, ...(entry.note?.trim() ? { note: entry.note.trim() } : {}) });
      const receipt = AcceptanceReceiptSchema.parse({
        schemaVersion: SCHEMA_VERSION.acceptanceReceipt,
        specId: context.approval.specId,
        planFingerprint: context.approval.planFingerprint,
        approvalId: context.approval.approvalId,
        productFingerprint,
        recordedAt: nowIso(),
        recordedBy: actor.id,
        entries: [...merged.values()].sort((left, right) => left.id.localeCompare(right.id)),
      });
      await writeAcceptanceReceipt(this.store, receipt);
      await this.#audit("acceptance", (await this.#readState()).phase, actor.id, {
        specId: receipt.specId,
        entries: entries.map((entry) => ({ id: entry.id, status: entry.status })),
      });
      return receipt;
    });
  }

  async executeWorkflow(opts: ExecuteWorkflowOptions = {}): Promise<WorkflowExecutionResult> {
    let claim: Awaited<ReturnType<typeof acquireWorkflowClaim>>;
    try {
      claim = await acquireWorkflowClaim(this.store);
    } catch (err) {
      refuse(err instanceof Error ? err.message : String(err), "legion-cli status");
    }
    try {
      return await this.#executeWorkflowClaimed(opts);
    } finally {
      await releaseWorkflowClaim(this.store, claim.token);
    }
  }

  async #executeWorkflowClaimed(opts: ExecuteWorkflowOptions): Promise<WorkflowExecutionResult> {
    let context = await this.#requireCurrentPlanApproval();
    const environmentFingerprint = workflowEnvironmentFingerprint();
    let productFingerprint = await workflowProductFingerprint(this.projectRoot, context.tasks);
    let evidence = await readWorkflowEvidence(this.store);
    let completedTaskIds = context.tasks
      .filter((task) => task.status === "done" || task.status === "compacted")
      .map((task) => task.id);
    const workflowTasks: ExecuteTaskResult[] = [];
    const workflowWarnings: string[] = [];

    const result = (
      status: WorkflowExecutionResult["status"],
      blocker: string | null,
      next: string,
      taskId?: string,
    ): WorkflowExecutionResult => ({
      status,
      ...(taskId ? { taskId } : {}),
      completedTaskIds,
      blocker,
      next,
      tasks: workflowTasks,
      warnings: workflowWarnings,
    });
    const save = async (
      status: WorkflowEvidenceReceipt["status"],
      blocker: string | null,
      integration: WorkflowEvidenceReceipt["integration"],
      review: WorkflowEvidenceReceipt["review"],
      boundProductFingerprint?: string,
    ): Promise<WorkflowEvidenceReceipt> => {
      return this.#withLockOrRefuse(async () => {
        context = await this.#requireCurrentPlanApproval();
        const currentProductFingerprint = await workflowProductFingerprint(this.projectRoot, context.tasks);
        productFingerprint = boundProductFingerprint ?? currentProductFingerprint;
        completedTaskIds = context.tasks
          .filter((task) => task.status === "done" || task.status === "compacted")
          .map((task) => task.id);
        const receipt: WorkflowEvidenceReceipt = {
          schemaVersion: SCHEMA_VERSION.workflowEvidence,
          specId: context.approval.specId,
          planFingerprint: context.approval.planFingerprint,
          approvalId: context.approval.approvalId,
          productFingerprint,
          environmentFingerprint,
          status,
          completedTaskIds,
          integration,
          review,
          blocker,
          updatedAt: nowIso(),
        };
        await writeWorkflowEvidence(this.store, receipt);
        evidence = receipt;
        return receipt;
      });
    };

    const evidenceFresh = evidence &&
      evidence.specId === context.approval.specId &&
      evidence.planFingerprint === context.approval.planFingerprint &&
      evidence.approvalId === context.approval.approvalId &&
      evidence.productFingerprint === productFingerprint &&
      evidence.environmentFingerprint === environmentFingerprint &&
      (!evidence.review || await workflowReviewEvidenceFresh(this.projectRoot, evidence.review));
    if (!opts.retry && evidenceFresh && evidence?.status === "blocked" && evidence.blocker &&
        (evidence.integration.some((run) => !run.ok) || evidence.review?.verdict === "FAIL" ||
          evidence.blocker.startsWith("independent review"))) {
      return result("blocked", evidence.blocker, "legion-cli execute --retry", completedTaskIds.at(-1));
    }

    let lastTaskId: string | undefined;
    let first = true;
    while (true) {
      context = await this.#requireCurrentPlanApproval();
      completedTaskIds = context.tasks
        .filter((task) => task.status === "done" || task.status === "compacted")
        .map((task) => task.id);
      const blocked = context.tasks.find((task) => task.status === "blocked");
      if (blocked) {
        const blocker = `task ${blocked.id} is blocked`;
        await save("blocked", blocker, evidenceFresh ? evidence?.integration ?? [] : [], null);
        return result("blocked", blocker, `legion-cli task amend ${blocked.id}`, blocked.id);
      }
      const open = context.tasks.filter((task) => task.status !== "done" && task.status !== "compacted");
      if (open.length === 0) break;

      const target = first && opts.taskId ? opts.taskId : "auto";
      let executed: ExecuteResult;
      try {
        executed = await this.execute(target, {
          adapter: opts.adapter,
          fix: opts.fix,
          allowNoSandbox: opts.allowNoSandbox,
        });
      } catch (err) {
        const blocker = err instanceof Error ? err.message : String(err);
        const next = err instanceof LegionRefuseError ? err.nextHint : "legion-cli plan approve";
        try {
          await save("blocked", blocker, [], null);
        } catch {
          // A spawned task can intentionally stale the approved plan; the caller still gets the blocker.
        }
        return result("blocked", blocker, next, lastTaskId);
      }
      first = false;
      lastTaskId = executed.taskId || lastTaskId;
      workflowTasks.push(...executed.tasks);
      for (const warning of executed.warnings) if (!workflowWarnings.includes(warning)) workflowWarnings.push(warning);
      if (executed.status === "blocked") {
        const lastTask = executed.tasks.at(-1);
        const blocker = lastTask?.incident
          ? "inspect .git — execute touched protected repository metadata"
          : lastTask?.reason ?? `task ${executed.taskId} is blocked`;
        await save("blocked", blocker, [], null);
        return result("blocked", blocker, lastTask?.incident ? "legion-cli status" : `legion-cli task amend ${executed.taskId}`, executed.taskId);
      }
      if (opts.step) {
        await save("running", null, [], null);
        return result("step_complete", null, "legion-cli execute", executed.taskId);
      }
    }

    context = await this.#requireCurrentPlanApproval();
    productFingerprint = await workflowProductFingerprint(this.projectRoot, context.tasks);
    const verificationBaseline = productFingerprint;
    evidence = await readWorkflowEvidence(this.store);
    const reusableReceipt = evidence &&
      evidence.planFingerprint === context.approval.planFingerprint &&
      evidence.approvalId === context.approval.approvalId &&
      evidence.productFingerprint === productFingerprint &&
      evidence.environmentFingerprint === environmentFingerprint
        ? evidence
        : null;
    const integration: WorkflowEvidenceReceipt["integration"] = [];
    for (const [index, command] of context.approval.verificationCommands.entries()) {
      const prior = reusableReceipt?.integration[index];
      if (prior?.command === command && prior.ok) {
        integration.push(prior);
        continue;
      }
      if (prior?.command === command && !prior.ok && !opts.retry) {
        const failure = verificationFailureReason([prior]) ?? `verification failed: ${command}`;
        return result("blocked", failure, "legion-cli execute --retry", lastTaskId);
      }
      await this.#withLockOrRefuse(() => this.#assertNoLiveInProgress("execute"));
      const beforeCheck = await workflowProductFingerprint(this.projectRoot, context.tasks);
      if (beforeCheck !== verificationBaseline) {
        const blocker = "product inputs changed during workflow verification";
        await save("blocked", blocker, integration, null, verificationBaseline);
        return result("blocked", blocker, "legion-cli execute", lastTaskId);
      }
      const [run] = await runVerificationCommands(this.projectRoot, [command], {
        runId: `workflow-${Date.now()}-${index + 1}`,
        secretEnvNames: configuredApiKeyEnvNames(context.config),
        sandbox: context.config.sandbox,
        allowNoSandbox: opts.allowNoSandbox,
      });
      if (run) integration.push(run);
      const afterCheck = await workflowProductFingerprint(this.projectRoot, context.tasks);
      if (afterCheck !== verificationBaseline) {
        const blocker = `verification changed product inputs while running: ${command}`;
        await save("blocked", blocker, integration, null, beforeCheck);
        return result("blocked", blocker, "legion-cli status", lastTaskId);
      }
      const failure = verificationFailureReason(run ? [run] : []);
      if (failure) {
        await save("blocked", failure, integration, null);
        return result("blocked", failure, "legion-cli execute --retry", lastTaskId);
      }
      await save("running", null, integration, null, beforeCheck);
    }

    let completionProductFingerprint = verificationBaseline;
    let reviewEvidence = reusableReceipt?.review?.verdict === "PASS" &&
      await workflowReviewEvidenceFresh(this.projectRoot, reusableReceipt.review)
        ? reusableReceipt.review
        : null;
    if (!reviewEvidence) {
      try {
        const beforeReview = await workflowProductFingerprint(this.projectRoot, context.tasks);
        if (beforeReview !== verificationBaseline) {
          const blocker = "product inputs changed before independent review";
          await save("blocked", blocker, integration, null, verificationBaseline);
          return result("blocked", blocker, "legion-cli execute", lastTaskId);
        }
        completionProductFingerprint = beforeReview;
        const reviewed = await this.review({ adapter: opts.adapter });
        const afterReview = await workflowProductFingerprint(this.projectRoot, context.tasks);
        if (afterReview !== verificationBaseline) {
          const blocker = "independent review changed product inputs";
          await save("blocked", blocker, integration, null, beforeReview);
          return result("blocked", blocker, "legion-cli status", lastTaskId);
        }
        if (reviewed.verdict !== "PASS") {
          const blocker = "independent review failed and filed follow-up work";
          const failedReviewEvidence = reviewed.evidenceBody
            ? await writeWorkflowReviewReport(this.store, reviewed.evidenceBody)
            : null;
          await save("blocked", blocker, integration, failedReviewEvidence, beforeReview);
          return result("blocked", blocker, "legion-cli execute --retry", lastTaskId);
        }
        if (reviewed.explicitVerdict !== "PASS" || !reviewed.evidenceBody) {
          const blocker = `independent review requires a fresh explicit Verdict: PASS in ${WORKFLOW_REVIEW_PATH}`;
          await save("blocked", blocker, integration, null);
          return result("blocked", blocker, "legion-cli review", lastTaskId);
        }
        reviewEvidence = await writeWorkflowReviewReport(this.store, reviewed.evidenceBody);
      } catch (err) {
        const blocker = `independent review failed: ${err instanceof Error ? err.message : String(err)}`;
        try {
          await save("blocked", blocker, integration, null);
        } catch {
          // Review-created tasks make the prior approval stale by design.
        }
        return result("blocked", blocker, "legion-cli plan approve", lastTaskId);
      }
    }

    await save("complete", null, integration, reviewEvidence, completionProductFingerprint);
    const status = await this.getWorkflowStatus();
    if (status.stage === "ship") return result("complete", null, "legion-cli ship", lastTaskId);
    return result("blocked", status.blocker, status.next, lastTaskId);
  }

  /** Warnings from the last `qa()` run in this engine, e.g. "unit command did not start: …". */
  getLastQaWarnings(): string[] {
    return [...this.#lastQaWarnings];
  }

  async nextTasks(): Promise<Task[]> {
    const state = await this.#readState();
    let controlMode: ControlMode = "guarded";
    try {
      controlMode = (await this.#readConfig()).control_mode;
    } catch {
      // uninitialized / missing config
    }
    const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
    return readyTasks({
      phase: state.phase,
      controlMode,
      tasks: slice,
      assumptions: await this.#listAssumptions(),
    });
  }

  async fileTicket(input: NewTicket): Promise<Task> {
    return this.#mutate(async () => {
      await this.#assertTicketAgainstLiveSpawn(input);
      return (await this.#fileTicketLocked(input)).task;
    });
  }

  async newPacket(input: NewPacket): Promise<PacketResult> {
    return this.#mutate(() => this.#newPacketLocked(input));
  }

  async respondPacket(input: PacketRespondInput): Promise<PacketResult> {
    return this.#mutate(() => this.#respondPacketLocked(input));
  }

  async amendTask(id: string, contract: FileContract, opts?: AmendTaskOptions): Promise<void> {
    return this.#mutate(async () => {
      await this.#assertNoLiveInProgress("task amend");
      await refuseIfLiveSkillSpawn(this.projectRoot, "task amend");
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
        refuse("File paths must be concrete (no * or **)", HINT.concretePaths);
      }
      if (expectedArtifactsFailsPlan(contract.filesAllowed, contract.expectedArtifacts)) {
        refuse("expectedArtifacts must be a subset of filesAllowed", HINT.concretePaths);
      }
      if (contract.verificationCommands.length === 0) {
        refuse("amend requires verificationCommands", HINT.plan);
      }
      const merged: FileContract = {
        ...contract,
        filesForbidden: mergeFilesForbidden(contract.filesForbidden),
      };
      const others = (await this.#listTasks()).filter(
        (task) => task.id !== id && task.status !== "done" && task.status !== "compacted",
      );
      const overlaps = overlappingFilesAllowed([{ ...doc.data, contract: merged }, ...others]);
      if (overlaps.length > 0) {
        refuse(`overlapping filesAllowed ${overlaps[0]}`, HINT.amend);
      }
      if (opts?.clearAdapter && opts.adapter) {
        refuse("clearAdapter and adapter are mutually exclusive", HINT.amend);
      }
      const adapter = opts?.clearAdapter ? undefined : (opts?.adapter ?? doc.data.adapter);
      const nextTask: Task = {
        ...doc.data,
        adapter,
        contract: merged,
        blockedBy: nextBlockedBy,
        blocks: nextBlocks,
      };
      if (depsChanged) {
        const allTasks = await this.#listTasks();
        const candidateTasks = allTasks.map((t) => (t.id === id ? nextTask : t));
        const graphCheck = validateTaskGraph(candidateTasks);
        if (!graphCheck.valid) {
          refuse(`cannot amend task: ${graphCheck.error}`, HINT.amend);
        }
      }
      await this.#writeTask(nextTask, doc.body);
      const state = await this.#readState();
      let controlMode: ControlMode = "guarded";
      try {
        controlMode = (await this.#readConfig()).control_mode;
      } catch {
        // missing config
      }
      await this.#promoteReadyTasks(doc.data.specId, state.phase, controlMode);
    });
  }

  async execute(taskId: string | "auto" = "auto", opts?: ExecuteOptions): Promise<ExecuteResult> {
    const workflowConfig = await this.#readConfig();
    if (workflowConfig.workflow?.profile === "focused") await this.#requireCurrentPlanApproval();
    const outcomes: ExecuteTaskResult[] = [];
    const warnings: string[] = [];
    let nextId: string | "auto" = taskId;
    let config: LegionConfig | undefined;
    while (true) {
      const outcome = await this.#executeOne(nextId, {
        fix: Boolean(opts?.fix),
        adapter: opts?.adapter,
        allowNoSandbox: Boolean(opts?.allowNoSandbox),
        config,
      });
      config = outcome.config;
      outcomes.push(outcome.result);
      if (outcome.result.headMoved && !warnings.includes(HEAD_MOVED_WARNING)) {
        warnings.push(HEAD_MOVED_WARNING);
      }
      if (outcome.result.status === "blocked" || outcome.result.incident) break;
      if (!opts?.untilBlocked) break;
      const ready = await this.#withLockOrRefuse(async () => {
        const state = await this.#readState();
        const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
        return pickNextTask({
          phase: state.phase,
          controlMode: config?.control_mode ?? "guarded",
          tasks: slice,
          assumptions: await this.#listAssumptions(),
        });
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
  }

  async verify(taskId?: string, opts?: { adapter?: AdapterId }): Promise<VerifyResult> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("Verify needs a Legion CLI project first", HINT.init);
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
        store: this.store,
        fakeArtifacts: this.#fakeArtifacts,
        throwAfterWrite: this.#fakeThrowAfterWrite,
        timedOut: this.#fakeTimedOut,
        cliAdapter: opts?.adapter,
        taskAdapter: task?.adapter,
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

  async review(opts?: { adapter?: AdapterId }): Promise<ReviewResult> {
    let specId: string | undefined;
    let config: LegionConfig | undefined;
    let before: string[] = [];
    let beforeFiles: TaskFileSnapshot | undefined;
    let beforeReviewEvidence: Awaited<ReturnType<typeof readExplicitReviewEvidence>> = null;
    let started: StartedSkillSpawn | undefined;

    await this.#withLockOrRefuse(async () => {
      await this.#assertNoLiveInProgress("review");
      const state = await this.#readState();
      const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
      this.#assertCanReview(state, slice);
      specId = state.activeSpecId ?? undefined;
      if (!specId) {
        refuse("review requires an active spec", HINT.spec);
      }
      config = await this.#readConfig();
      await this.#assertSkillSpawnable(config, "review", { cliAdapter: opts?.adapter });
      before = await this.snapshotTaskIds();
      beforeFiles = await snapshotTaskFiles(this.store.paths.tasksDir);
      beforeReviewEvidence = await readExplicitReviewEvidence(this.projectRoot);
      started = await startSkillSpawn({
        ...this.#skillSpawnFields(),
        config,
        skillId: "review",
        specId,
        promptBody: [
          "Spec-level review of a terminal slice.",
          `Active spec: ${specId}`,
          `Read .legion-cli/specs/${specId}/SPEC.md and .legion-cli/tasks/*.md.`,
          "Write notes to .legion-cli/qa/review.md.",
          "Include exactly one explicit `Verdict: PASS` or `Verdict: FAIL` line in that report.",
          "If the slice does not meet the spec, file tasks under .legion-cli/tasks/ (type: fix) or extra.json.",
          "Creating any new task id or rewriting existing TSK-*.md FAILs this review.",
          "PASS only if ids are unchanged and existing task files are byte-identical.",
          "Do not git add or git commit. Do not write packets.",
        ].join("\n"),
        required: true,
        cliAdapter: opts?.adapter,
      });
    });

    const waited = started?.spawned ? await waitStartedSpawn(started) : { error: undefined, timedOut: false, durationMs: 0 };

    return this.#withLockOrRefuse(async () => {
      if (!specId || !config) {
        refuse("review requires an active spec", HINT.spec);
      }
      const currentReviewEvidence = await readExplicitReviewEvidence(this.projectRoot);
      const explicitReviewEvidence = currentReviewEvidence &&
        (currentReviewEvidence.evidenceFingerprint !== beforeReviewEvidence?.evidenceFingerprint ||
          currentReviewEvidence.modifiedAtMs !== beforeReviewEvidence?.modifiedAtMs)
        ? currentReviewEvidence
        : null;
      const revert = started?.spawned ? await finishStartedSpawn(started) : null;
      const restoredTaskIds = (revert?.engineRestored ?? [])
        .filter((posix) => posix.startsWith(".legion-cli/tasks/") && posix.toLowerCase().endsWith(".md"))
        .map((posix) => posix.slice(".legion-cli/tasks/".length).replace(/\.md$/i, ""));
      const taskSnap = beforeFiles;
      const rewrittenExistingTaskIds = taskSnap
        ? [
            ...new Set([
              ...restoredTaskIds.filter((id) => taskSnap.has(`${id}.md`)),
              ...(await restoreChangedTaskFiles(this.store.paths.tasksDir, taskSnap)),
            ]),
          ].sort((a, b) => a.localeCompare(b))
        : [];
      if (started?.runId) {
        await this.#fileExtrasFromRun(started.runId, specId);
      }
      const after = await this.snapshotTaskIds();
      const createdTaskIds = after.filter((id) => !before.includes(id));
      if (createdTaskIds.length > 0) {
        await this.#clampSpawnedTaskStatuses(createdTaskIds);
        await this.#promoteReadyTasks(specId, "executing", config.control_mode);
      }
      await this.#refuseSpawnContract(
        "review",
        revert,
        waited.error,
        createdTaskIds,
        before,
        after,
        rewrittenExistingTaskIds,
      );
      const verdict = await this.#applyReviewSnapshotsLocked(
        await this.#readState(),
        before,
        after,
        rewrittenExistingTaskIds,
      );
      return {
        verdict,
        createdTaskIds,
        extrasReverted: revert?.extrasReverted ?? [],
        rewrittenExistingTaskIds,
        ...(explicitReviewEvidence ? {
          explicitVerdict: explicitReviewEvidence.verdict,
          evidencePath: explicitReviewEvidence.evidencePath,
          evidenceFingerprint: explicitReviewEvidence.evidenceFingerprint,
          evidenceBody: explicitReviewEvidence.body,
        } : {}),
      };
    });
  }

  async snapshotTaskIds(): Promise<string[]> {
    const tasks = await this.#listTasks();
    return tasks.map((task) => task.id).sort();
  }

  /**
   * Id-only review comparison for tests: PASS iff after has no ids that before
   * lacked. Spawn-path byte identity is `review()`, not this helper.
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
    const prepared = await this.#withLockOrRefuse(async () => {
      await this.#assertNoLiveInProgress("qa");
      const state = await this.#readState();
      const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
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
      return { spec, config, mode };
    });

    this.#lastQaWarnings = [];
    let score: QAScore;
    if (this.#fakeOnQa) await this.#fakeOnQa();
    if (opts.score) {
      score = QAScoreSchema.parse(opts.score);
    } else {
      const run = await runProjectQa({
        projectRoot: this.projectRoot,
        spec: prepared.spec,
        mode: prepared.mode,
        unitCommand: prepared.config.qa.unitCommand,
        secretEnvNames: configuredApiKeyEnvNames(prepared.config),
      });
      score = run.score;
      this.#lastQaWarnings = run.warnings;
    }

    return this.#withLockOrRefuse(async () => {
      const state = await this.#readState();
      const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
      this.#assertCanQa(state, slice);
      await this.#writeQaScore(score);
      const next: StateFile = {
        ...state,
        lastQaId: score.id,
      };
      if (score.pass === true && state.lastReview === "PASS") {
        next.phase = "ready_to_ship";
      }
      await this.#writeState(next);
      await this.#audit("qa", next.phase, "user", {
        pass: score.pass,
        total: score.total,
        mode: score.mode,
        id: score.id,
        ...(this.#lastQaWarnings.length > 0 ? { warnings: this.#lastQaWarnings } : {}),
      });
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

  /** Focused-profile amendment: records bounded bug work without writing or running a regression test. */
  async proposeFix(bug: string): Promise<Task> {
    return this.#mutate(async () => {
      await this.#assertNoLiveInProgress("fix");
      const title = bug.trim();
      if (!title) refuse("fix requires a bug description", HINT.fix);
      const state = await this.#readState();
      if (state.phase !== "executing" && state.phase !== "ready_to_ship" && state.phase !== "plan_ready") {
        refuse("fix requires plan_ready, executing, or ready_to_ship", HINT.execute);
      }
      const specId = state.activeSpecId;
      if (!specId) refuse("fix requires an active spec", HINT.spec);
      const testPath = regressionTestPath(title);
      const filesAllowed = fixFilesAllowed(this.projectRoot, testPath);
      const verifyCmd = regressionVerifyCommand(testPath);
      if (filesAllowedFailsPlan(filesAllowed) || expectedArtifactsFailsPlan(filesAllowed, [testPath])) {
        refuse("File paths must be concrete (no * or **)", HINT.concretePaths);
      }
      const live = (await this.#listTasks()).filter(
        (task) => task.status !== "done" && task.status !== "compacted",
      );
      const probe = ticketFromInput("TSK-probe", specId, {
        title,
        contract: { filesAllowed, expectedArtifacts: [testPath], verificationCommands: [verifyCmd] },
      });
      const overlaps = overlappingFilesAllowed([probe, ...live]);
      if (overlaps.length > 0) refuse(`overlapping filesAllowed ${overlaps[0]}`, HINT.fix);
      await this.#failLastReviewLocked();
      return (await this.#fileTicketLocked({
        title,
        type: "bug",
        priority: "P0",
        notes: "Proposed focused-workflow amendment. Add a reproducing regression test during approved execution.",
        contract: {
          filesAllowed,
          expectedArtifacts: [testPath],
          verificationCommands: [verifyCmd],
        },
      })).task;
    });
  }

  async fix(bug: string): Promise<Task> {
    return this.#mutate(async () => {
      await this.#assertNoLiveInProgress("fix");
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
      const filesAllowed = fixFilesAllowed(this.projectRoot, testPath);
      const verifyCmd = regressionVerifyCommand(testPath);
      if (filesAllowedFailsPlan(filesAllowed) || expectedArtifactsFailsPlan(filesAllowed, [testPath])) {
        refuse("File paths must be concrete (no * or **)", HINT.concretePaths);
      }
      const live = (await this.#listTasks()).filter(
        (task) => task.status !== "done" && task.status !== "compacted",
      );
      const probe = ticketFromInput("TSK-probe", specId, {
        title,
        contract: { filesAllowed, expectedArtifacts: [testPath], verificationCommands: [verifyCmd] },
      });
      const overlaps = overlappingFilesAllowed([probe, ...live]);
      if (overlaps.length > 0) {
        refuse(`overlapping filesAllowed ${overlaps[0]}`, HINT.fix);
      }
      await ensureRegressionTest(this.projectRoot, testPath, title);
      const fixConfig = await this.#readConfig();
      const red = await runVerificationCommands(this.projectRoot, [verifyCmd], {
        runId: `fix-${Date.now()}`,
        secretEnvNames: configuredApiKeyEnvNames(fixConfig),
        sandbox: fixConfig.sandbox,
      });
      if (red[0]?.ok) {
        refuse("this does not reproduce", HINT.fix);
      }
      await this.#failLastReviewLocked();
      return (await this.#fileTicketLocked({
        title,
        type: "bug",
        priority: "P0",
        notes: "Playwright-before-fix: reproducing test must stay RED until execute goes GREEN.",
        contract: {
          filesAllowed,
          expectedArtifacts: [testPath],
          verificationCommands: [verifyCmd],
        },
      })).task;
    });
  }

  async ship(opts: ShipOptions = {}): Promise<ShipReceipt> {
    if ((opts.commit || opts.pr) && !isGitRepo(this.projectRoot)) {
      refuse("ship --commit/--pr requires a git repository", HINT.shipCommit);
    }
    if (opts.pr && !opts.commit) {
      refuse("ship --pr requires --commit", HINT.shipPrRetry);
    }
    if (opts.pr && !opts.prCreate && !ghAvailable()) {
      refuse("gh is required for --pr", HINT.shipPr);
    }

    const preview = await this.#mutate(async () => {
      await this.#assertNoLiveInProgress("ship");
      const state = await this.#readState();
      await this.#assertCurrentShipGate(state, opts);
      return this.#stageShipLocked(state);
    });

    if (opts.confirm) {
      let accepted = false;
      try {
        accepted = await opts.confirm(preview);
      } catch (err) {
        await this.#unstageShip(preview.added);
        throw err;
      }
      if (!accepted) {
        await this.#unstageShip(preview.added);
        refuse("ship cancelled", HINT.ship);
      }
    }

    return this.#mutate(async () => {
      await this.#assertNoLiveInProgress("ship");
      const state = await this.#readState();
      await this.#assertCurrentShipGate(state, opts);
      return this.#completeShipLocked(state, opts, preview);
    });
  }

  async beginIntent(): Promise<IntentState> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("Intent needs a Legion CLI project first", HINT.init);
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
        refuse("Intent needs a Legion CLI project first", HINT.init);
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
        [
          "Propose decisions in .legion-cli/discuss/DISCUSS.md with status proposed. Do not accept them.",
          "For brownfield projects also read .legion-cli/map/DISCOVERY.md and .legion-cli/map/ARCHITECTURE.md when present.",
        ].join("\n"),
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
      await this.#assertNoLiveInProgress("spec");
      await assertDiscoverySelection(this);
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
      if (state.phase === "spec_draft" && state.activeSpecId) {
        try {
          const existing = await this.store.readSpec(state.activeSpecId);
          if (existing.data.status === "draft") return existing.data;
        } catch {
          // A missing draft is reconstructed below from durable interview context.
        }
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
      const discuss = await this.#loadDiscuss();
      const failureCases = answers.rounds.flatMap((round) =>
        round.questions.flatMap((question, index) => {
          if (!/(fail|edge|error|security|integration|unavailable|timeout)/i.test(question)) return [];
          const answer = round.answers[index]?.trim();
          if (!answer || /^(none|n\/a|no)$/i.test(answer)) return [];
          return answer.split(/\r?\n|;/).map((line) => line.trim()).filter(Boolean);
        }),
      );
      const spec = buildSpecFromIntent({
        specId,
        title: project.data.name,
        mapped: answers.mapped,
        extraAcceptance,
        skipWireframes,
        decisions: discuss.decisions,
        failureCases,
      });
      await this.store.writeSpec(spec, specMarkdownBody(spec));
      await mkdir(join(this.store.paths.specsDir, specId), { recursive: true });
      await writeTextFile(join(this.store.paths.specsDir, specId, "prd.md"), prdBody(answers.mapped), {
        root: this.projectRoot,
      });
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
          "For brownfield projects also read .legion-cli/map/DISCOVERY.md and .legion-cli/map/ARCHITECTURE.md when present.",
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

  async wireframe(opts: WireframeOptions = {}): Promise<WireframeResult> {
    let started: StartedSkillSpawn | undefined;
    let session: Awaited<ReturnType<typeof prepareWireframe>> | undefined;
    const prepared = await this.#mutate(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized" || !state.activeSpecId) {
        refuse("no active spec", HINT.spec);
      }
      const specId = state.activeSpecId;
      let specDoc: Awaited<ReturnType<LegionStore["readSpec"]>>;
      try {
        specDoc = await this.store.readSpec(specId);
      } catch {
        refuse("no active spec", HINT.spec);
      }
      const answers = await this.#loadIntentAnswers();
      session = await prepareWireframe({
        projectRoot: this.projectRoot,
        dir: join(this.store.paths.specsDir, specId, "wireframes"),
        specDir: join(this.store.paths.specsDir, specId),
        spec: specDoc.data,
        specBody: specDoc.body,
        screens: answers.mapped.screens,
        opts,
        writeSpec: (spec, body) => this.store.writeSpec(spec, body),
      });
      if (!opts.spawn) return finishWireframe(session, null);
      started = await this.#startOptionalSpawn("wireframe", specId, session.spawnPrompt, opts.adapter);
      return null;
    });
    if (prepared) return prepared;
    const waited = started?.spawned ? await waitStartedSpawn(started) : { error: undefined };
    return this.#mutate(async () => {
      if (!session) refuse("no active spec", HINT.spec);
      const latest = await this.store.readSpec(session.spec.id);
      if (latest.data.status !== session.spec.status) {
        session = {
          ...session,
          spec: latest.data,
          frozen: latest.data.status !== "draft",
          specSnap: latest.body,
        };
      }
      const revert = started?.spawned ? await finishStartedSpawn(started) : null;
      return finishWireframe(session, {
        spawned: Boolean(started?.spawned),
        revert,
        error: waited.error,
      });
    });
  }

  async abandon(message: string): Promise<void> {
    const reason = message.trim();
    if (!reason) {
      refuse("abandon requires a message", HINT.abandon);
    }
    return this.#mutate(async () => {
      await this.#assertNoLiveInProgress("abandon");
      const state = await this.#readState();
      assertCanTransition(state.phase, "abandoned");
      const specId = state.activeSpecId ?? "none";
      const abandonedAt = nowIso();
      const receiptPath = abandonReceiptPath(specId);
      await writeTextFile(
        toFsPath(this.projectRoot, receiptPath),
        abandonReceiptBody({ specId, abandonedAt, message: reason, phase: state.phase }),
        { root: this.projectRoot },
      );
      await this.#writeState({ ...state, phase: "abandoned", currentTaskId: null });
      await this.#audit("abandon", "abandoned", "user", {
        specId,
        message: reason,
        fromPhase: state.phase,
        receiptPath,
      });
    });
  }

  async undoLastTask(opts?: { taskId?: string }): Promise<UndoResult> {
    return this.#mutate(async () => {
      await this.#assertNoLiveInProgress("undo");
      const result = await runUndoLastTask({
        projectRoot: this.projectRoot,
        store: this.store,
        taskId: opts?.taskId,
      });
      const state = await this.#readState();
      await this.#audit("undo", state.phase, "user", {
        taskId: result.taskId,
        commitSha: result.commitSha,
      });
      return result;
    });
  }

  async unblockTask(taskId: string): Promise<Task> {
    return this.#mutate(async () => {
      await this.#assertNoLiveInProgress("task unblock");
      let doc: { data: Task; body: string };
      try {
        doc = await this.store.readTask(taskId);
      } catch {
        refuse(`unknown task ${taskId}`, HINT.taskUnblock);
      }
      if (doc.data.status !== "blocked") {
        refuse(`cannot unblock task ${taskId} from ${doc.data.status}`, HINT.taskUnblock);
      }
      const state = await this.#readState();
      const slice = sliceTasks(await this.#listTasks(), state.activeSpecId);
      const unresolved = doc.data.blockedBy.filter((id) => {
        const blocker = slice.find((task) => task.id === id);
        return blocker && blocker.status !== "done" && blocker.status !== "compacted";
      });
      if (unresolved.length > 0) {
        refuse(`cannot unblock ${taskId}: still blocked by ${unresolved.join(", ")}`, HINT.blockers);
      }
      const before = slice;
      const wasTerminal = isSliceTerminal(before);
      await this.#writeTask({ ...doc.data, status: "todo" }, doc.body);
      let controlMode: ControlMode = "guarded";
      try {
        controlMode = (await this.#readConfig()).control_mode;
      } catch {
        controlMode = "guarded";
      }
      await this.#promoteReadyTasks(doc.data.specId, state.phase, controlMode);
      const after = sliceTasks(await this.#listTasks(), state.activeSpecId);
      if (wasTerminal && !isSliceTerminal(after)) {
        const next: StateFile = { ...state };
        if (state.lastReview === "PASS") next.lastReview = "FAIL";
        if (state.phase === "ready_to_ship") {
          assertCanTransition(state.phase, "executing");
          next.phase = "executing";
        }
        if (next.lastReview !== state.lastReview || next.phase !== state.phase) {
          await this.#writeState(next);
        }
      }
      await this.#audit("unblock", (await this.#readState()).phase, "user", { from: "blocked" }, taskId);
      return (await this.store.readTask(taskId)).data;
    });
  }

  async recoverTask(taskId: string): Promise<Task> {
    return this.#mutate(async () => {
      let doc: { data: Task; body: string };
      try {
        doc = await this.store.readTask(taskId);
      } catch {
        refuse(`unknown task ${taskId}`, HINT.taskRecover);
      }
      if (doc.data.status !== "verifying") {
        refuse(`cannot recover task ${taskId} from ${doc.data.status}`, HINT.taskRecover);
      }
      const resume = await findLatestTaskResume(this.projectRoot, taskId);
      if (resume && resumeRunIsLive(resume)) {
        refuse(`cannot recover ${taskId} while verification is live`, HINT.status);
      }
      await this.#writeTask({ ...doc.data, status: "blocked" }, doc.body);
      const state = await this.#readState();
      if (state.currentTaskId === taskId) {
        await this.#writeState({ ...state, currentTaskId: null });
      }
      await this.#audit(
        "recover",
        (await this.#readState()).phase,
        "user",
        { from: "verifying", to: "blocked", reason: "human recover" },
        taskId,
      );
      return (await this.store.readTask(taskId)).data;
    });
  }

  async expandCurrentTask(_work: string): Promise<never> {
    void _work;
    const state = await this.#readState();
    refuse(
      "Park extra work as a linked ticket instead of expanding this task",
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

  async spawnChatSkill(
    promptBody: string,
    cliAdapter?: AdapterId,
  ): Promise<{ spawned: boolean; runId: string }> {
    let started: StartedSkillSpawn | undefined;
    await this.#withLockOrRefuse(async () => {
      await refuseIfLiveSkillSpawn(this.projectRoot, "chat");
      let config: LegionConfig;
      try {
        config = await this.#readConfig();
      } catch {
        return;
      }
      started = await startSkillSpawn({
        ...this.#skillSpawnFields(),
        config,
        skillId: "chat",
        promptBody,
        cliAdapter,
      });
    });
    if (!started?.spawned) {
      return { spawned: false, runId: started?.runId ?? "" };
    }
    const live = started;
    const waited = await waitStartedSpawn(live);
    return this.#withLockOrRefuse(async () => {
      const revert = await finishStartedSpawn(live);
      if (revert.incident) {
        refuse("inspect .git — spawn touched .git/", HINT.status);
      }
      if (revert.extrasReverted.length > 0) {
        refuse(
          `spawn wrote files outside SkillContract; reverted: ${revert.extrasReverted.join(", ")}`,
          HINT.status,
        );
      }
      if (waited.error) {
        return { spawned: false, runId: live.runId };
      }
      return { spawned: true, runId: live.runId };
    });
  }

  async recoverStaleInProgress(): Promise<void> {
    await this.#withLockOrRefuse(async () => undefined);
  }

  async peekLiveSpawn(): Promise<{ taskId: string } | null> {
    const state = await this.#readState();
    if (!state.currentTaskId) return null;
    try {
      const task = (await this.store.readTask(state.currentTaskId)).data;
      if (task.status !== "in_progress") return null;
      const resume = await findLatestTaskResume(this.projectRoot, task.id);
      if (resume && resumeRunIsLive(resume)) return { taskId: task.id };
      return null;
    } catch {
      return null;
    }
  }

  /** Start a brownfield run (or, with `resume`, report its state). The orchestrating agent does judgment. */
  async brownfield(opts: BrownfieldOptions = {}): Promise<BrownfieldResult> {
    return this.#mutate(() =>
      brownfieldEntry(this.store, opts, async () => {
        // Every brownfield run starts from a fresh map, same generator as `legion-cli map`
        // (no map-skill spawn). `--lsp` requires a language server; default "auto".
        let generated: Awaited<ReturnType<typeof generateMap>>;
        try {
          generated = await generateMap(this.projectRoot, {
            refresh: true,
            lsp: opts.lsp ? "require" : "auto",
            resolveBinary: opts.resolveBinary,
            spawnLsp: opts.spawnLsp,
            lspDeadlineMs: opts.lspDeadlineMs,
          });
        } catch (err) {
          if (err instanceof MapError) refuse(err.message, err.nextHint);
          throw err;
        }
        const state = await this.#readState();
        await this.#audit("map_refresh", state.phase, "user", {
          backend: generated.backend,
          modules: generated.fingerprints.modules.length,
          changedCount: generated.changed.length,
          rootHash: generated.fingerprints.rootHash,
        });
        return {
          path: MAP_ARCHITECTURE_PATH,
          fingerprintsPath: MAP_FINGERPRINTS_PATH,
          backend: generated.backend,
          modules: generated.fingerprints.modules.length,
          changed: generated.changed,
          next: MAP_SHOW_NEXT,
        };
      }),
    );
  }

  async brownfieldState(runId: string, pairs: readonly string[] = []): Promise<BrownfieldStateResult> {
    return this.#mutate(() => stateRun(this.store, parseBrownfieldRunId(runId), pairs));
  }

  async brownfieldRoster(runId: string): Promise<BrownfieldRosterResult> {
    return this.#mutate(() => rosterRun(this.store, parseBrownfieldRunId(runId)));
  }

  async brownfieldEvidence(runId: string, opts: BrownfieldEvidenceOptions = {}): Promise<BrownfieldEvidenceResult> {
    return this.#mutate(() => evidenceRun(this.store, parseBrownfieldRunId(runId), opts));
  }

  async brownfieldMerge(runId: string): Promise<BrownfieldMergeResult> {
    return this.#mutate(() => mergeRun(this.store, parseBrownfieldRunId(runId)));
  }

  async brownfieldReviewStatus(
    runId: string,
    opts: BrownfieldReviewStatusOptions = {},
  ): Promise<BrownfieldReviewStatusResult> {
    return this.#mutate(() => reviewStatusRun(this.store, parseBrownfieldRunId(runId), opts));
  }

  async brownfieldPrPlan(runId: string, opts: { force?: boolean } = {}): Promise<BrownfieldPrPlanResult> {
    return this.#mutate(() => prPlanRun(this.store, parseBrownfieldRunId(runId), opts));
  }

  async brownfieldDag(runId: string, nodeId?: string, pairs: readonly string[] = []): Promise<BrownfieldDagResult> {
    return this.#mutate(() => dagRun(this.store, parseBrownfieldRunId(runId), nodeId, pairs));
  }

  async brownfieldWorktree(
    runId: string,
    nodeId: string,
    opts: BrownfieldWorktreeOptions = {},
  ): Promise<BrownfieldWorktreeResult> {
    return this.#mutate(() => worktreeRun(this.store, parseBrownfieldRunId(runId), nodeId, opts));
  }

  async brownfieldPatterns(opts: BrownfieldPatternsOptions = {}): Promise<BrownfieldPatternsResult> {
    return this.#mutate(() => patternsRun(this.store, opts));
  }

  async promoteRun(runId: string, opts: PromoteRunOptions = {}): Promise<PromoteRunResult> {
    return this.#mutate(async () => {
      const result = await promoteBrownfieldRun(this.store, runId, opts);
      await this.#refreshWikiCatalogLocked();
      return result;
    });
  }

  async #executeOne(
    taskId: string | "auto",
    opts: { fix: boolean; adapter?: AdapterId; allowNoSandbox?: boolean; config?: LegionConfig },
  ): Promise<{ result: ExecuteTaskResult; config: LegionConfig }> {
    let task: Task | undefined;
    let config: LegionConfig | undefined = opts.config;
    let started: StartedSkillSpawn | undefined;

    await this.#withLockOrRefuse(async () => {
      await this.#assertNoLiveInProgress("execute");
      const state = await this.#readState();
      if (state.phase === "plan_failed") {
        refuse("Plan failed. Fix the FAIL list before executing", HINT.planRetry);
      }
      if (state.phase !== "plan_ready" && state.phase !== "executing") {
        refuse("Execute needs plan_ready or executing", HINT.plan);
      }
      config = opts.config ?? (await this.#readConfig());
      if (config.control_mode === "advisory") {
        refuse("Execute is off in advisory mode", HINT.advisory);
      }

      task = await this.#resolveExecuteTask(taskId, state, config);
      if (task.contract.filesAllowed.length === 0 || task.contract.verificationCommands.length === 0) {
        refuse("This task needs a file contract and verification commands", HINT.plan);
      }

      await this.#assertSkillSpawnable(config, "execute", {
        cliAdapter: opts.adapter,
        taskAdapter: task.adapter,
      });
      try {
        assertExecuteSandbox(config, { allowNoSandbox: opts.allowNoSandbox });
      } catch (err) {
        if (err instanceof SandboxError) {
          refuse(err.message, HINT.allowNoSandbox);
        }
        throw err;
      }
      if (state.phase !== "executing") {
        assertCanTransition(state.phase, "executing");
      }

      await this.#transitionTaskTo(task.id, "in_progress");
      await this.#writeState({
        ...(await this.#readState()),
        phase: "executing",
        currentTaskId: task.id,
      });

      const extraAllowed = [...task.contract.filesAllowed, ...task.contract.expectedArtifacts];
      const promptBody = [
        `Task: ${task.id} ${task.title}`,
        `Priority: ${task.priority}`,
        opts.fix ? "This is a fix run. Keep the reproducing test. Do not delete tests." : "",
        `Read .legion-cli/specs/${task.specId}/SPEC.md.`,
        "Write only the files listed in FileContract. Do not git add or git commit.",
        "Copy AC.priority into new test names as @p0/@p1/@p2.",
      ]
        .filter((line) => line !== "")
        .join("\n");

      try {
        started = await startSkillSpawn({
          ...this.#skillSpawnFields(),
          config,
          skillId: "execute",
          specId: task.specId,
          taskId: task.id,
          promptBody,
          fileContract: task.contract,
          extraAllowedRoots: extraAllowed,
          filesForbidden: task.contract.filesForbidden,
          required: true,
          cliAdapter: opts.adapter,
          taskAdapter: task.adapter,
          allowNoSandbox: opts.allowNoSandbox,
        });
      } catch (err) {
        await this.#transitionTaskTo(task.id, "blocked");
        if (err instanceof SandboxError) {
          refuse(err.message, HINT.allowNoSandbox);
        }
        throw err;
      }
      if (!started.spawned) {
        await this.#transitionTaskTo(task.id, "blocked");
      } else if (started.sandbox) {
        const degraded = Boolean(opts.allowNoSandbox) && !started.sandbox.hardened;
        await this.#audit(
          degraded ? "sandbox_degraded" : "sandbox_start",
          "executing",
          "agent",
          {
            backend: started.sandbox.backend,
            hardened: started.sandbox.hardened,
            degraded,
          },
          task.id,
        );
      }
    });

    if (!task || !config) {
      refuse("Execute needs plan_ready or executing", HINT.plan);
    }
    const lockedTask = task;
    const lockedConfig = config;
    const waited = started?.spawned ? await waitStartedSpawn(started) : { error: undefined, timedOut: false, durationMs: 0 };

    const post = await this.#withLockOrRefuse(async () => {
      const revert = started?.spawned ? await finishStartedSpawn(started) : null;
      const extras = revert?.extrasReverted ?? [];
      const incident = Boolean(revert?.incident);
      const headMoved = Boolean(revert?.headMoved);
      if (started?.spawned && started.sandbox && revert) {
        await this.#audit(
          "sandbox_copyout",
          "executing",
          "agent",
          {
            backend: started.sandbox.backend,
            hardened: started.sandbox.hardened,
            copied: revert.sandboxCopied ?? [],
            dropped: revert.sandboxDropped ?? [],
          },
          lockedTask.id,
        );
      }
      const runId = started?.runId ?? "";
      const durationMs = waited.durationMs;
      const timedOut = Boolean(waited.timedOut);
      const adapterId = started && started.spawned ? started.resolution.id : started?.resolution?.id;
      const resolutionSource = started && started.spawned ? started.resolution.source : undefined;
      const spawnAudit = {
        adapterId,
        binary: started && started.spawned ? started.binary : undefined,
        argvSummary: started && started.spawned ? started.argvSummary : undefined,
        resolutionSource,
      };

      const finish = async (outcome: ExecuteTaskResult): Promise<ExecuteTaskResult> => {
        const current = await this.#readState();
        await this.#audit(
          "execute",
          current.phase,
          "agent",
          {
            durationMs,
            timedOut,
            status: outcome.status,
            runId,
            ...spawnAudit,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          },
          outcome.taskId,
        );
        if (timedOut) {
          await this.#audit(
            "timeout",
            current.phase,
            "agent",
            { skillId: "execute", durationMs, ...spawnAudit },
            outcome.taskId,
          );
        }
        return { ...outcome, adapterId, resolutionSource };
      };

      let extraJsonInvalid = false;
      let extraJsonTicketIds: string[] = [];
      if (runId) {
        const filed = await this.#fileExtrasFromRun(runId, lockedTask.specId);
        extraJsonInvalid = filed.invalid;
        extraJsonTicketIds = filed.ticketIds;
      }

      if (incident || extras.length > 0 || extraJsonInvalid) {
        let ticketId: string | undefined;
        if (extras.length > 0) {
          const { task: ticket } = await this.#fileTicketLocked(
            {
              title:
                extras.length === 1
                  ? `FileContract extra: ${extras[0]}`
                  : `FileContract extras: ${extras.join(", ")}`,
              parentId: lockedTask.id,
              fromAgent: true,
              type: "bug",
              notes: "type: scope. Spawn wrote paths outside FileContract; extras were reverted.",
            },
            lockedTask.specId,
          );
          ticketId = ticket.id;
        }
        ticketId ??= extraJsonTicketIds[0];
        await this.#transitionTaskTo(lockedTask.id, "blocked");
        await this.#writeState({
          ...(await this.#readState()),
          phase: "executing",
          currentTaskId: lockedTask.id,
        });
        return {
          kind: "done" as const,
          result: await finish({
            taskId: lockedTask.id,
            status: "blocked",
            runId,
            extrasReverted: extras,
            incident,
            headMoved,
            ticketId,
          }),
        };
      }

      if (waited.error || !started?.spawned) {
        await this.#transitionTaskTo(lockedTask.id, "blocked");
        return {
          kind: "done" as const,
          result: await finish({
            taskId: lockedTask.id,
            status: "blocked",
            runId,
            extrasReverted: extras,
            incident,
            headMoved,
          }),
        };
      }

      await this.#transitionTaskTo(lockedTask.id, "verifying");
      return {
        kind: "verify" as const,
        runId,
        durationMs,
        timedOut,
        extras,
        incident,
        headMoved,
        spawnAudit,
        adapterId,
        resolutionSource,
      };
    });

    if (post.kind === "done") return { result: post.result, config: lockedConfig };

    let verificationPass = false;
    let reason: string | undefined;
    let trustTierNote: string | undefined;
    const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
    try {
      if (this.#fakeOnVerify) await this.#fakeOnVerify();
      if (this.#fakeVerificationError) throw new Error(this.#fakeVerificationError);
      const verification = await runVerificationCommands(
        this.projectRoot,
        lockedTask.contract.verificationCommands,
        {
          timeoutMs: this.#verificationTimeoutMs,
          runId: post.runId,
          secretEnvNames: configuredApiKeyEnvNames(lockedConfig),
          sandbox: lockedConfig.sandbox,
        },
      );
      verificationPass = verification.length > 0 && verification.every((run) => run.ok);
      reason = verificationFailureReason(verification);
      trustTierNote = verification.find((run) => run.trustTierNote)?.trustTierNote;
    } catch (err) {
      verificationPass = false;
      reason = `verification failed: ${describe(err)}`;
    }

    const result = await this.#withLockOrRefuse(async () => {
      try {
        if (verificationPass) {
          await this.#transitionTaskTo(lockedTask.id, "done");
          await this.#promoteReadyTasks(lockedTask.specId, "executing", lockedConfig.control_mode);
        } else {
          await this.#transitionTaskTo(lockedTask.id, "blocked");
        }
      } catch (err) {
        reason = `${reason ? `${reason}; ` : ""}after verification: ${describe(err)}`;
        try {
          const status = (await this.store.readTask(lockedTask.id)).data.status;
          verificationPass = status === "done";
          if (status === "verifying") await this.#transitionTaskTo(lockedTask.id, "blocked");
        } catch (inner) {
          // Left for #recoverDeadInProgressLocked on the next verb; say so.
          verificationPass = false;
          reason = `${reason}; could not move ${lockedTask.id} out of verifying: ${describe(inner)}`;
        }
      }

      try {
        const state = await this.#readState();
        const currentTaskId =
          state.currentTaskId && state.currentTaskId !== lockedTask.id ? state.currentTaskId : lockedTask.id;
        await this.#writeState({
          ...state,
          phase: "executing",
          currentTaskId,
        });
      } catch (err) {
        reason = `${reason ? `${reason}; ` : ""}STATE.md not updated: ${describe(err)}`;
      }

      const current = await this.#readState();
      await this.#audit(
        "execute",
        current.phase,
        "agent",
        {
          durationMs: post.durationMs,
          timedOut: post.timedOut,
          status: verificationPass ? "done" : "blocked",
          runId: post.runId,
          ...post.spawnAudit,
          ...(reason ? { reason } : {}),
          ...(trustTierNote ? { trustTierNote } : {}),
        },
        lockedTask.id,
      );
      if (post.timedOut) {
        await this.#audit(
          "timeout",
          current.phase,
          "agent",
          { skillId: "execute", durationMs: post.durationMs, ...post.spawnAudit },
          lockedTask.id,
        );
      }
      return {
        taskId: lockedTask.id,
        status: (verificationPass ? "done" : "blocked") as ExecuteTaskResult["status"],
        runId: post.runId,
        extrasReverted: post.extras,
        incident: post.incident,
        headMoved: post.headMoved,
        verificationPass,
        adapterId: post.adapterId,
        resolutionSource: post.resolutionSource,
        ...(reason ? { reason } : {}),
        ...(trustTierNote ? { trustTierNote } : {}),
      };
    });

    return { result, config: lockedConfig };
  }

  async #resolveExecuteTask(taskId: string | "auto", state: StateFile, config: LegionConfig): Promise<Task> {
    const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
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
      } catch (err) {
        if (err instanceof LegionRefuseError) throw err;
        refuse(`unknown task ${taskId}`, HINT.blockers);
      }
    }
    if (task.contract.filesAllowed.length === 0 || task.contract.verificationCommands.length === 0) {
      refuse("This task needs a file contract and verification commands", HINT.plan);
    }
    if (
      !isTaskReady(task, {
        phase: state.phase,
        controlMode: config.control_mode,
        tasks: slice,
        assumptions: await this.#listAssumptions(),
      })
    ) {
      refuse(`task ${task.id} is not ready`, HINT.blockers);
    }
    return task;
  }

  async #transitionTaskTo(taskId: string, to: TaskStatus): Promise<void> {
    const forward: TaskStatus[] = ["todo", "ready", "in_progress", "verifying", "done"];
    let doc = await this.store.readTask(taskId);
    if (doc.data.status === to) return;
    if (to === "blocked") {
      assertTaskStatusTransition(doc.data.status, "blocked");
      await this.#writeTask({ ...doc.data, status: "blocked" }, doc.body);
      return;
    }
    let currentIdx = forward.indexOf(doc.data.status);
    const targetIdx = forward.indexOf(to);
    if (currentIdx === -1 || targetIdx === -1 || currentIdx > targetIdx) {
      assertTaskStatusTransition(doc.data.status, to);
      await this.#writeTask({ ...doc.data, status: to }, doc.body);
      return;
    }
    while (currentIdx < targetIdx) {
      const next = forward[currentIdx + 1];
      if (!next) break;
      doc = await this.store.readTask(taskId);
      assertTaskStatusTransition(doc.data.status, next);
      await this.#writeTask({ ...doc.data, status: next }, doc.body);
      currentIdx += 1;
    }
  }

  async #assertSkillSpawnable(
    config: LegionConfig,
    skillId: "plan" | "execute" | "review",
    opts?: { cliAdapter?: AdapterId; taskAdapter?: AdapterId },
  ): Promise<void> {
    const resolution = resolveAdapterId({
      config,
      skillId,
      taskAdapter: opts?.taskAdapter,
      cliAdapter: opts?.cliAdapter,
    });
    if (!(await isResolvedAdapterSpawnable(config, resolution.id))) {
      refuse(spawnableAdapterRefuseMessage(skillId, resolution), HINT.doctor);
    }
    const skillsDir = this.#skillsDir ?? findSkillsDir();
    const hint = skillId === "execute" ? HINT.execute : skillId === "review" ? HINT.review : HINT.plan;
    const resolved = await resolveSkillDir({
      projectRoot: this.projectRoot,
      skillId,
      packagedSkillsDir: skillsDir,
    });
    if (!resolved.ok) {
      refuse(resolved.reason, hint);
    }
    const skillMd = join(resolved.skillDir, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(skillMd, "utf8");
    } catch {
      refuse(
        resolved.source === "overlay"
          ? `${skillId} overlay is missing SKILL.md`
          : `${skillId} requires skills/${skillId}/SKILL.md`,
        hint,
      );
    }
    const catalogPath = skillCatalogPath(skillId, resolved.source);
    const parsed = parseSkillFrontmatter(raw, catalogPath);
    if (!parsed.ok) {
      refuse(`${skillId} requires valid ${catalogPath} frontmatter (${parsed.reason})`, hint);
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
    rewrittenExistingTaskIds: readonly string[] = [],
  ): Promise<void> {
    const failed = Boolean(revert?.incident) || Boolean(revert && revert.extrasReverted.length > 0) || Boolean(error);
    if (!failed) return;
    if (createdTaskIds.length > 0 || rewrittenExistingTaskIds.length > 0) {
      await this.#applyReviewSnapshotsLocked(
        await this.#readState(),
        before,
        after,
        rewrittenExistingTaskIds,
      );
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
  ): Promise<{ invalid: boolean; ticketIds: string[] }> {
    const abs = join(this.projectRoot, ".legion-cli", "cache", "runs", runId, "extra.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(abs, "utf8"));
    } catch {
      return { invalid: false, ticketIds: [] };
    }
    let invalid = false;
    const ticketIds: string[] = [];
    for (const input of parseExtraJson(raw)) {
      const { task, coerced } = await this.#fileTicketLocked(
        {
          ...input,
          fromAgent: true,
          type: input.type ?? defaults?.type,
          parentId: input.parentId ?? defaults?.parentId,
        },
        specId,
      );
      if (coerced) invalid = true;
      ticketIds.push(task.id);
    }
    return { invalid, ticketIds };
  }

  async #fileTicketLocked(
    input: NewTicket,
    specIdOverride?: string,
  ): Promise<{ task: Task; coerced: boolean }> {
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
    let parentAdapter: AdapterId | undefined;
    if (parentId) {
      const parent = tasks.find((task) => task.id === parentId);
      if (!parent) {
        if (input.fromAgent) {
          parentId = undefined;
        } else {
          refuse(`unknown parent ${parentId}`, HINT.ticket(parentId));
        }
      } else {
        parentAdapter = parent.adapter;
      }
    }
    // From file names (valid or not), under engine.lock, so a corrupt file's id is never
    // reused (F-004).
    const id = await nextFileId(this.store.paths.tasksDir, "TSK", 4);
    let ticket = ticketFromInput(id, specId, {
      ...input,
      title,
      parentId,
      adapter: input.adapter ?? parentAdapter,
    });
    const contractInvalid =
      filesAllowedFailsPlan(ticket.contract.filesAllowed) ||
      expectedArtifactsFailsPlan(ticket.contract.filesAllowed, ticket.contract.expectedArtifacts);
    const live = tasks.filter((task) => task.status !== "done" && task.status !== "compacted");
    const overlaps = overlappingFilesAllowed([ticket, ...live]);
    let coerced = false;
    if (contractInvalid || overlaps.length > 0) {
      if (!input.fromAgent) {
        if (contractInvalid) {
          refuse("File paths must be concrete (no * or **)", HINT.concretePaths);
        }
        refuse(`overlapping filesAllowed ${overlaps[0]}`, HINT.ticket(parentId ?? "TSK-x"));
      }
      ticket = {
        ...ticket,
        contract: defaultTicketContract(id),
      };
      coerced = true;
    }
    await this.#writeTask(ticket, taskMarkdownBody(ticket));
    if (parentId) {
      const parentDoc = await this.store.readTask(parentId);
      if (!parentDoc.data.blocks.includes(id)) {
        await this.#writeTask(
          { ...parentDoc.data, blocks: [...parentDoc.data.blocks, id] },
          parentDoc.body,
        );
      }
    }
    const promoted = await this.#promoteTicketIfReady(id, specId);
    await this.#failLastReviewLocked();
    return { task: promoted, coerced };
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
    const id = await nextFileId(this.store.paths.packetsDir, "PKT", 4);
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
    const { task: ticket } = await this.#fileTicketLocked({
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
      if (doc.data.status === "todo" || doc.data.status === "ready" || doc.data.status === "compacted") continue;
      const to = canTransitionTaskStatus(doc.data.status, "todo") ? "todo" : "blocked";
      await this.#writeTask({ ...doc.data, status: to }, doc.body);
    }
  }

  async #clampPlanTaskStatuses(specId: string): Promise<void> {
    const slice = sliceTasks(await this.#listTasks(), specId);
    for (const task of slice) {
      if (task.status === "todo" || task.status === "ready" || task.status === "compacted") continue;
      const doc = await this.store.readTask(task.id);
      const to = canTransitionTaskStatus(doc.data.status, "todo") ? "todo" : "blocked";
      await this.#writeTask({ ...doc.data, status: to }, doc.body);
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
        await this.#writeTask(ready, doc.body);
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
      if (task.status === "todo" && isTaskReady(task, readyCtx)) {
        const doc = await this.store.readTask(task.id);
        assertTaskStatusTransition(doc.data.status, "ready");
        await this.#writeTask({ ...doc.data, status: "ready" }, doc.body);
        continue;
      }
      if (task.status === "ready" && !isTaskReady(task, readyCtx)) {
        const doc = await this.store.readTask(task.id);
        assertTaskStatusTransition(doc.data.status, "todo");
        await this.#writeTask({ ...doc.data, status: "todo" }, doc.body);
      }
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
        : `Constraint or design input: ${side.brand}`;
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
    for (const line of lines) {
      const id = await nextFileId(this.store.paths.assumptionsDir, "ASM", 4);
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
    await writeTextFile(join(this.store.paths.specsDir, specId, "prd.md"), prdBody(answers.mapped), {
      root: this.projectRoot,
    });
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
        // An unreadable SPEC.md keeps its id: never allocate over it (F-061).
        continue;
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
    const dir = join(this.store.paths.specsDir, spec.id, "wireframes");
    await writeWireframeFiles(dir, spec, screenPagesFor(screens), this.projectRoot);
  }

  async #ensureWireframePalette(specId: string, screens: string[]): Promise<void> {
    const pages = screenPagesFor(screens);
    const dir = join(this.store.paths.specsDir, specId, "wireframes");
    const files = ["INDEX.html", ...pages.map((page) => `${page.slug}.html`)];
    for (const file of files) {
      const abs = join(dir, file);
      try {
        const html = await readFile(abs, "utf8");
        if (!palettePresent(html)) {
          const spec = (await this.store.readSpec(specId)).data;
          await this.#writeWireframes(spec, screens);
          return;
        }
      } catch {
        const spec = (await this.store.readSpec(specId)).data;
        await this.#writeWireframes(spec, screens);
        return;
      }
    }
  }

  async #startOptionalSpawn(
    skillId: "interview" | "discuss" | "spec" | "wireframe",
    specId: string,
    promptBody: string,
    cliAdapter?: AdapterId,
  ): Promise<StartedSkillSpawn> {
    let config: LegionConfig;
    try {
      config = await this.#readConfig();
    } catch {
      return { spawned: false, runId: `${skillId}-${Date.now().toString(36)}` };
    }
    return startSkillSpawn({
      config,
      skillId,
      specId,
      promptBody,
      cliAdapter,
      ...this.#skillSpawnFields(),
    });
  }

  async #runOptionalSpawn(
    skillId: "interview" | "discuss" | "spec",
    specId: string,
    promptBody: string,
    cliAdapter?: AdapterId,
  ): Promise<OptionalSpawnResult> {
    let config: LegionConfig;
    try {
      config = await this.#readConfig();
    } catch {
      return { spawned: false, runId: `${skillId}-${Date.now().toString(36)}`, revert: null };
    }
    return optionalSkillSpawn({
      config,
      skillId,
      specId,
      promptBody,
      cliAdapter,
      ...this.#skillSpawnFields(),
    });
  }

  async #optionalSpawn(
    skillId: "interview" | "discuss" | "spec",
    specId: string,
    promptBody: string,
    cliAdapter?: AdapterId,
  ): Promise<void> {
    const result = await this.#runOptionalSpawn(skillId, specId, promptBody, cliAdapter);
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
    const trimmed = mode.trim();
    if (trimmed === "autonomous") {
      refuse("Autonomous mode is not allowed", HINT.controlMode);
    }
    if (trimmed === "surgical") {
      refuse(SURGICAL_MIGRATION_HINT, HINT.controlMode);
    }
    const parsed = ControlModeSchema.safeParse(trimmed);
    if (!parsed.success) {
      const hint = parsed.error.issues[0]?.message;
      refuse(hint && hint.length > 0 ? hint : `control_mode ${trimmed || mode} is rejected`, HINT.controlMode);
    }
    return parsed.data;
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

  async #writeTask(data: Task, body: string): Promise<void> {
    let from: TaskStatus | undefined;
    try {
      from = (await this.store.readTask(data.id)).data.status;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        from = undefined;
      } else {
        throw err;
      }
    }
    if (from !== undefined && from !== data.status) {
      assertTaskStatusTransition(from, data.status);
    }
    await this.store.writeTask(data, body);
  }

  async #readConfig(): Promise<LegionConfig> {
    return this.store.readConfig();
  }

  async #specChallengeContextLocked(specId?: string): Promise<EngineSpecChallengeContext> {
    const state = await this.#readState();
    const selected = specId ?? state.activeSpecId;
    if (!selected) refuse("no active spec", HINT.spec);
    if (state.activeSpecId && selected !== state.activeSpecId) {
      refuse(`spec challenge requires the active spec ${state.activeSpecId}`, HINT.spec);
    }
    let spec;
    try {
      spec = await this.store.readSpec(selected);
    } catch {
      refuse(`unknown spec ${selected}`, HINT.spec);
    }
    const config = await this.#readConfig();
    if (config.workflow?.profile !== "focused" || spec.data.status !== "draft") {
      return { applicable: false, specId: selected, spec };
    }
    const intent = await this.#loadIntentAnswers();
    const discuss = await this.#loadDiscuss();
    const discovery = await readWorkflowDiscoveryContext(this.projectRoot);
    const readable = await specChallengeReadableFingerprints(this.projectRoot, selected);
    return {
      applicable: true,
      specId: selected,
      spec,
      binding: createSpecChallengeBinding({
        specId: selected,
        spec,
        intent,
        discuss,
        discovery,
        repositoryFingerprint: readable.repositoryFingerprint,
        readableContextFingerprint: readable.contextFingerprint,
      }),
    };
  }

  async #requireSpecChallengeReceiptLocked(specId: string): Promise<SpecChallengeReceipt> {
    const receipt = await readSpecChallengeReceipt(this.store, specId);
    if (!receipt) refuse("spec challenge has not started", "legion-cli spec");
    return receipt;
  }

  async #requireCurrentSpecChallengeLocked(
    context: Extract<EngineSpecChallengeContext, { applicable: true }>,
  ): Promise<SpecChallengeReceipt> {
    const receipt = await this.#requireSpecChallengeReceiptLocked(context.specId);
    if (!receiptMatchesBinding(receipt, context.binding)) {
      refuse("spec challenge evidence is stale after draft or context changes", "legion-cli spec");
    }
    return receipt;
  }

  async #markChallengeManualRequiredLocked(
    receipt: SpecChallengeReceipt,
    error: string,
  ): Promise<SpecChallengeReceipt> {
    const now = nowIso();
    const next: SpecChallengeReceipt = {
      ...receipt,
      status: "manual_required",
      generation: receipt.status === "analysis_running"
        ? { ...receipt.generation, status: "failed", completedAt: now, error }
        : receipt.generation,
      synthesis: receipt.status === "synthesis_running"
        ? { ...receipt.synthesis, status: "failed", completedAt: now, error }
        : receipt.synthesis,
      automationError: error,
      updatedAt: now,
    };
    await writeSpecChallengeReceipt(this.store, next);
    await writeSpecChallengeThinking(this.projectRoot, next);
    return next;
  }

  async #readChallengeSpawnOutput(
    started: Extract<StartedSkillSpawn, { spawned: true }>,
    storePath: string,
  ): Promise<string> {
    const root = started.sandbox?.jailRoot ?? this.projectRoot;
    return readFile(toFsPath(root, storePath), "utf8");
  }

  async #finishChallengeAnalysisLocked(specId: string | undefined, runId: string): Promise<SpecChallengeResult> {
    const context = await this.#specChallengeContextLocked(specId);
    if (!context.applicable) return challengeResult(context.specId, null, "complete");
    let receipt = await this.#requireSpecChallengeReceiptLocked(context.specId);
    if (!receiptMatchesBinding(receipt, context.binding)) return challengeResult(context.specId, receipt, "stale");
    if (receipt.generation.status !== "complete") {
      receipt = await this.#markChallengeManualRequiredLocked(
        receipt,
        "analysis completion checkpoint is missing",
      );
      return challengeResult(context.specId, receipt);
    }
    const now = nowIso();
    receipt = {
      ...receipt,
      status: receipt.concerns.length === 0 ? "complete" : "awaiting_resolutions",
      finalDraftFingerprint: receipt.concerns.length === 0 ? context.binding.initialDraftFingerprint : null,
      generation: { ...receipt.generation, runId, completedAt: receipt.generation.completedAt ?? now },
      synthesis: receipt.concerns.length === 0
        ? { status: "complete", runId: null, completedAt: now }
        : receipt.synthesis,
      automationError: null,
      updatedAt: now,
    };
    await writeSpecChallengeReceipt(this.store, receipt);
    await writeSpecChallengeThinking(this.projectRoot, receipt);
    return challengeResult(context.specId, receipt);
  }

  async #finishChallengeSynthesisLocked(specId: string | undefined, _runId: string): Promise<SpecChallengeResult> {
    const context = await this.#specChallengeContextLocked(specId);
    if (!context.applicable) return challengeResult(context.specId, null, "complete");
    const receipt = await this.#requireSpecChallengeReceiptLocked(context.specId);
    if (!receiptMatchesBinding(receipt, context.binding)) return challengeResult(context.specId, receipt, "stale");
    return this.#applySpecChallengeApplicationLocked(context, receipt);
  }

  async #checkpointSpecChallengeApplicationLocked(
    receipt: SpecChallengeReceipt,
    base: EngineSpecDocument,
    applied: AppliedSpecChallenge,
    body: string,
  ): Promise<SpecChallengeReceipt> {
    const now = nowIso();
    const next: SpecChallengeReceipt = {
      ...receipt,
      synthesis: { ...receipt.synthesis, status: "complete", completedAt: now },
      application: {
        expectedDraftFingerprint: workflowFingerprint({ data: applied.spec, body }),
        baseSpec: base.data,
        baseBody: base.body,
        spec: applied.spec,
        body,
        changes: applied.changes,
        draftDiff: applied.draftDiff,
      },
      changes: applied.changes,
      draftDiff: applied.draftDiff,
      updatedAt: now,
    };
    await writeSpecChallengeReceipt(this.store, next);
    return next;
  }

  async #applySpecChallengeApplicationLocked(
    context: Extract<EngineSpecChallengeContext, { applicable: true }>,
    receipt: SpecChallengeReceipt,
  ): Promise<SpecChallengeResult> {
    const application = receipt.application;
    if (!application) {
      const failed = await this.#markChallengeManualRequiredLocked(
        receipt,
        "validated synthesis application checkpoint is missing",
      );
      return challengeResult(context.specId, failed);
    }
    const base = { data: application.baseSpec, body: application.baseBody };
    const baseFingerprint = workflowFingerprint(base);
    const identityKeys = ["schemaVersion", "id", "title", "status", "frozenAt", "frozenBy"] as const;
    if (baseFingerprint !== receipt.initialDraftFingerprint ||
        application.baseSpec.id !== context.specId || application.baseSpec.status !== "draft" ||
        application.spec.id !== context.specId || application.spec.status !== "draft" ||
        identityKeys.some((key) => application.baseSpec[key] !== application.spec[key]) ||
        workflowFingerprint({ data: application.spec, body: application.body }) !== application.expectedDraftFingerprint) {
      refuse("invalid spec challenge application checkpoint", "legion-cli spec");
    }
    let replayed: AppliedSpecChallenge;
    const manual = completeManualReview(receipt.manualReview);
    if (manual && receipt.automationError) {
      replayed = applyManualReview(application.baseSpec, manual);
    } else {
      const proposed: SpecChallengeProposedChange[] = application.changes.map(({ appliedId: _appliedId, ...change }) => change);
      replayed = applySpecChallengeChanges(application.baseSpec, receipt.concerns, proposed);
    }
    const replayedBody = specChallengeDraftBody(application.baseBody, replayed);
    if (workflowFingerprint({ data: replayed.spec, body: replayedBody }) !== application.expectedDraftFingerprint ||
        workflowFingerprint({ changes: replayed.changes, draftDiff: replayed.draftDiff }) !==
          workflowFingerprint({ changes: application.changes, draftDiff: application.draftDiff })) {
      refuse("invalid spec challenge application checkpoint", "legion-cli spec");
    }
    const currentFingerprint = workflowFingerprint(context.spec);
    if (currentFingerprint === receipt.initialDraftFingerprint) {
      await this.store.writeSpec(replayed.spec, replayedBody);
      await this.#fakeAfterChallengeDraftWrite?.();
    } else if (currentFingerprint !== application.expectedDraftFingerprint) {
      return challengeResult(context.specId, receipt, "stale");
    }
    const applied: AppliedSpecChallenge = {
      spec: replayed.spec,
      changes: replayed.changes,
      draftDiff: replayed.draftDiff,
    };
    const completed = await this.#completeSpecChallengeLocked(receipt, applied, replayedBody);
    return challengeResult(context.specId, completed);
  }

  async #completeSpecChallengeLocked(
    receipt: SpecChallengeReceipt,
    applied: AppliedSpecChallenge,
    body: string,
  ): Promise<SpecChallengeReceipt> {
    const now = nowIso();
    const next: SpecChallengeReceipt = {
      ...receipt,
      status: "complete",
      finalDraftFingerprint: workflowFingerprint({ data: applied.spec, body }),
      synthesis: {
        ...receipt.synthesis,
        status: "complete",
        completedAt: receipt.synthesis.completedAt ?? now,
      },
      changes: applied.changes,
      draftDiff: applied.draftDiff,
      automationError: receipt.automationError,
      updatedAt: now,
    };
    await writeSpecChallengeReceipt(this.store, next);
    await writeSpecChallengeThinking(this.projectRoot, next);
    return next;
  }

  #specChallengePrompt(
    mode: "analysis" | "synthesis",
    specId: string,
    receipt: SpecChallengeReceipt | null,
  ): string {
    if (mode === "analysis") {
      return [
        "Mode: analysis",
        `Review .legion-cli/specs/${specId}/SPEC.md and the staged interview, decisions, map, and readable repository context.`,
        "Write analysis.json in this run's cache using schemaVersion legion-cli-spec-challenge-analysis/v1.",
        "Return zero to three concerns. Each concern has question, why, and non-empty evidence.",
        "Repository evidence requires kind, path, line, exact quote, and claim; otherwise use kind assumption with claim.",
      ].join("\n");
    }
    return [
      "Mode: synthesis",
      `Review .legion-cli/specs/${specId}/SPEC.md and only these engine-recorded concern resolutions:`,
      JSON.stringify(receipt?.concerns ?? [], null, 2),
      "Write synthesis.json in this run's cache using schemaVersion legion-cli-spec-challenge-synthesis/v1.",
      "Changes are additive and use section mustBeTrue, mustNotChange, outOfScope, failureCases, acceptance, or decision.",
      "Each change requires statement, rationale, and concernIds. Acceptance also requires kind behavior|test|rubric and priority P0|P1|P2.",
      "For safety, each proposed statement must preserve one linked human response verbatim as the complete statement.",
      "Do not propose changes for dismissed concerns or unrelated scope.",
    ].join("\n");
  }

  async #assertFocusedSpecChallengeCompleteLocked(specId: string): Promise<void> {
    const context = await this.#specChallengeContextLocked(specId);
    if (!context.applicable) return;
    const receipt = await readSpecChallengeReceipt(this.store, specId);
    if (!receipt) refuse("focused spec approval requires a completed challenge", "legion-cli spec");
    if (!receiptMatchesBinding(receipt, context.binding)) {
      refuse("focused spec challenge evidence is stale", "legion-cli spec");
    }
    if (receipt.status !== "complete" || !receipt.finalDraftFingerprint ||
        receipt.concerns.some((concern) => !concern.resolution)) {
      const hint = receipt.status === "manual_required" ? "legion-cli spec --manual-review" : "legion-cli spec";
      refuse("focused spec challenge is unresolved", hint);
    }
  }

  async #workflowPlanContext(configOverride?: LegionConfig): Promise<{
    snapshot: WorkflowPlanSnapshot;
    spec: Spec;
    tasks: Task[];
    config: LegionConfig;
  }> {
    const state = await this.#readState();
    const specId = state.activeSpecId;
    if (!specId) refuse("workflow requires an active spec", HINT.spec);
    const specDoc = await this.store.readSpec(specId);
    if (specDoc.data.status !== "frozen") refuse("workflow requires a frozen spec", HINT.specApprove);
    const tasks = sliceTasks(await this.#listGateTasks(), specId);
    const taskDocs = [];
    for (const task of tasks) taskDocs.push(await this.store.readTask(task.id));
    const config = configOverride ?? await this.#readConfig();
    const project = (await this.store.readProject()).data;
    const planBody = await readPlanBody(this.projectRoot, specId);
    const snapshot = createWorkflowPlanSnapshot({
      spec: specDoc,
      tasks: taskDocs,
      planBody,
      config,
      project,
      discoveryContext: await readWorkflowDiscoveryContext(this.projectRoot),
    });
    return { snapshot, spec: specDoc.data, tasks, config };
  }

  async #requireCurrentPlanApproval(): Promise<{
    approval: PlanApprovalReceipt;
    snapshot: WorkflowPlanSnapshot;
    spec: Spec;
    tasks: Task[];
    config: LegionConfig;
  }> {
    const approval = await readPlanApproval(this.store);
    if (!approval) refuse("plan approval is required before execute", "legion-cli plan approve");
    const context = await this.#workflowPlanContext();
    if (approval.specId !== context.snapshot.specId || approval.planFingerprint !== context.snapshot.planFingerprint) {
      refuse("plan approval is stale; review and approve the current plan", "legion-cli plan approve");
    }
    return { approval, ...context };
  }

  #workflowAcceptanceStatus(spec: Spec, receipt: AcceptanceReceipt | null): WorkflowStatus["acceptance"] {
    const required = spec.acceptance.map((criterion) => criterion.id);
    const byId = new Map((receipt?.entries ?? []).map((entry) => [entry.id, entry.status]));
    return {
      required,
      passed: required.filter((id) => byId.get(id) === "passed"),
      failed: required.filter((id) => byId.get(id) === "failed"),
      pending: required.filter((id) => !byId.has(id)),
      notApplicable: required.filter((id) => byId.get(id) === "not_applicable"),
    };
  }

  async #loadTaskEntries(): Promise<LoadedTask[]> {
    return (await listTaskFiles(this.projectRoot)).map((entry): LoadedTask =>
      entry.ok
        ? { ok: true, task: entry.task }
        : { ok: false, id: entry.id, file: entry.file, error: entry.error, ...peekTaskFrontmatter(entry.frontmatter) },
    );
  }

  /** Valid tasks only. Gates use {@link #listGateTasks}, which refuses on an invalid file. */
  async #listTasks(): Promise<Task[]> {
    return (await this.#loadTaskEntries())
      .filter((entry): entry is { ok: true; task: Task } => entry.ok)
      .map((entry) => entry.task)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Fail closed (FP-1): review, qa, ship, execute and next refuse while any file under tasks/ is
   * not a valid task, instead of computing the gate over the tasks that happened to parse.
   */
  async #listGateTasks(): Promise<Task[]> {
    const entries = await this.#loadTaskEntries();
    const bad = entries.find((entry): entry is Extract<LoadedTask, { ok: false }> => !entry.ok);
    if (bad) {
      refuse(invalidTaskMessage({ ok: false, file: bad.file, id: bad.id, error: bad.error }), HINT.status);
    }
    return entries
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
    await writeTextFile(abs, `${JSON.stringify(score, null, 2)}\n`, { root: this.projectRoot });
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
    if (state.phase !== "executing" && state.phase !== "ready_to_ship") {
      refuse("Review is for a terminal slice after execute", HINT.execute);
    }
    if (!isSliceTerminal(slice) || sliceHasOpenWork(slice)) {
      refuse("Finish the slice before review (every task done or blocked — terminal slice)", HINT.execute);
    }
  }

  #assertCanQa(state: StateFile, slice: Task[]): void {
    if (state.phase !== "executing") {
      refuse("Score the product after execute, once review PASSes", HINT.execute);
    }
    if (!isSliceTerminal(slice) || sliceHasOpenWork(slice)) {
      refuse("Finish the slice before scoring (tasks still todo/ready/in_progress/verifying)", HINT.execute);
    }
    if (state.lastReview !== "PASS") {
      refuse("Review must PASS before scoring", HINT.review);
    }
    if (p0TasksNotDone(slice).length > 0) {
      refuse("A P0 task is not done yet", HINT.blockers);
    }
  }

  async #assertReadyToShip(state: StateFile): Promise<void> {
    const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
    if (state.lastReview !== "PASS") {
      refuse("Review must PASS before shipping", HINT.review);
    }
    const lastQa = await this.#readLastQa(state);
    if (lastQa?.pass !== true) {
      refuse("QA must PASS before shipping", HINT.qa);
    }
    if (p0TasksNotDone(slice).length > 0) {
      refuse("A P0 task is not done yet", HINT.blockers);
    }
  }

  async #assertCurrentShipGate(state: StateFile, opts: ShipOptions): Promise<void> {
    const config = await this.#readConfig();
    if (config.workflow?.profile === "focused" || await this.store.pathExists(WORKFLOW_APPROVAL_PATH)) {
      if (state.phase !== "executing" && state.phase !== "ready_to_ship") {
        refuse("focused ship requires completed execution", "legion-cli execute");
      }
      const workflow = await this.getWorkflowStatus();
      if (workflow.stage !== "ship" || workflow.planApproval !== "valid" || workflow.execution !== "complete") {
        refuse(workflow.blocker ?? "focused workflow is not ready to ship", workflow.next);
      }
      return;
    }
    await this.#assertCanShip(state, opts);
  }

  async #assertCanShip(state: StateFile, opts: ShipOptions): Promise<void> {
    if (state.lastReview !== "PASS") {
      refuse("Review must PASS before shipping", HINT.review);
    }
    const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
    if (p0TasksNotDone(slice).length > 0) {
      refuse("A P0 task is not done yet", HINT.blockers);
    }
    const lastQa = await this.#readLastQa(state);
    if (lastQa?.pass === true) {
      if (state.phase !== "ready_to_ship") {
        refuse("ship requires ready_to_ship", HINT.qa);
      }
      return;
    }
    // Failed or missing QA: only no-browser may proceed, and only with the flag.
    if (!opts.allowDegradedQa) {
      refuse("QA must PASS before shipping", HINT.qa);
    }
    if (!lastQa) {
      refuse("ship --allow-degraded-qa requires a no-browser QA score", HINT.qa);
    }
    if (lastQa.mode !== "no-browser") {
      refuse("ship --allow-degraded-qa only applies to no-browser QA", HINT.qa);
    }
    if (state.phase !== "executing" && state.phase !== "ready_to_ship") {
      refuse("ship requires ready_to_ship (or --allow-degraded-qa)", HINT.qa);
    }
  }

  async #stageShipLocked(state: StateFile): Promise<ShipPreview> {
    const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
    const allowedFiles = unionDoneFilesAllowed(slice);
    const allowedSet = new Set(allowedFiles);
    const empty: ShipPreview = {
      staged: [],
      added: [],
      stagedDisplay: "(none)",
      diff: "",
      unrelatedUnchanged: true,
      unrelated: [],
      productFingerprint: "",
    };
    if (!isGitRepo(this.projectRoot)) return empty;

    const addPaths = shipAddPaths(this.projectRoot, allowedFiles);
    gitAdd(this.projectRoot, addPaths);
    const staged = gitStagedPaths(this.projectRoot);
    const dirty = gitPorcelainPaths(this.projectRoot);
    const unrelated = unrelatedDirty(dirty, allowedSet);
    const display = displayStagedRoots([".legion-cli", ...addPaths, ...staged]);
    return {
      staged,
      added: addPaths,
      stagedDisplay: display || "(none)",
      diff: gitDiffCached(this.projectRoot),
      unrelatedUnchanged: unrelated.length === 0,
      unrelated,
      productFingerprint: shipProductIndexFingerprint(this.projectRoot),
    };
  }

  async #unstageShip(added: readonly string[]): Promise<void> {
    if (added.length === 0 || !isGitRepo(this.projectRoot)) return;
    await this.#mutate(async () => {
      gitRestoreStaged(this.projectRoot, [...added]);
    });
  }

  async #completeShipLocked(
    state: StateFile,
    opts: ShipOptions,
    preview: ShipPreview,
  ): Promise<ShipReceipt> {
    if (isGitRepo(this.projectRoot)) {
      const actual = shipProductIndexFingerprint(this.projectRoot);
      if (actual !== preview.productFingerprint) {
        refuse(SHIP_STAGED_CHANGED, HINT.ship);
      }
    }

    const lastQa = await this.#readLastQa(state);
    const specId = state.activeSpecId ?? "";
    const shippedAt = nowIso();
    const receiptPath = specId ? shipReceiptPath(specId) : ".legion-cli/audit/ship.md";
    const qaMode = lastQa?.mode ?? null;
    const qaScore = lastQa?.total ?? null;
    const qaPass = lastQa?.pass === true;
    const allowDegradedQa = Boolean(opts.allowDegradedQa);
    const actor = opts.actor ?? "user";

    const receipt: ShipReceipt = {
      specId,
      shippedAt,
      phase: "shipped",
      qaMode,
      qaScore,
      qaPass,
      allowDegradedQa,
      staged: preview.staged,
      committed: Boolean(opts.commit),
      receiptPath,
    };

    assertCanTransition(state.phase, "shipped");
    await this.#writeState({
      ...state,
      phase: "shipped",
      currentTaskId: null,
    });
    await writeTextFile(toFsPath(this.projectRoot, receiptPath), shipReceiptBody(receipt), {
      root: this.projectRoot,
    });
    await this.#audit("ship", "shipped", actor, {
      specId,
      qaMode,
      qaScore,
      qaPass,
      allowDegradedQa,
      receiptPath,
    });

    const priorHead = isGitRepo(this.projectRoot) ? tryGitHead(this.projectRoot) : null;
    if (isGitRepo(this.projectRoot)) {
      // Product paths were staged before confirm. Re-adding a staged deletion fails
      // (`pathspec did not match`); only pick up receipt / STATE / .legion-cli here.
      gitAdd(this.projectRoot, [".legion-cli"]);
      receipt.staged = gitStagedPaths(this.projectRoot);
      if (opts.commit && gitHasStaged(this.projectRoot)) {
        receipt.commitSha = gitCommitIndex(this.projectRoot, shipCommitMessage(specId));
        receipt.committed = true;
      }
    }

    if (opts.pr) {
      const title = shipCommitMessage(specId);
      const body = [
        `Ship receipt for ${specId || "spec"}.`,
        `QA mode: ${qaMode ?? "none"}`,
        `QA score: ${qaScore ?? "none"}`,
        `QA pass: ${qaPass}`,
      ].join("\n");
      const created = opts.prCreate
        ? opts.prCreate({ cwd: this.projectRoot, title, body })
        : tryCreatePullRequest(this.projectRoot, title, body);
      if (created.error || !created.url) {
        if (priorHead && receipt.commitSha) {
          gitResetMixed(this.projectRoot, priorHead);
        }
        await this.#writeState(state);
        refuse(`gh pr create failed: ${created.error ?? "no pull request url"}`, HINT.shipPrRetry);
      }
      receipt.prUrl = created.url;
    }

    return receipt;
  }

  async #audit(
    type: string,
    phase: StateFile["phase"],
    actor: string,
    data: Record<string, unknown>,
    taskId?: string,
  ): Promise<void> {
    try {
      await appendAuditEvent(this.projectRoot, {
        schemaVersion: SCHEMA_VERSION.audit,
        ts: nowIso(),
        type,
        phase,
        taskId: taskId ?? null,
        actor,
        data,
      });
    } catch {
      // local metrics are best-effort
    }
  }

  async #auditRefuse(err: LegionRefuseError): Promise<void> {
    try {
      const state = await this.#readState();
      await this.#audit("refuse", state.phase, "user", {
        kind: refuseKind(err.nextHint),
        message: err.message,
        next: err.nextHint,
      });
    } catch {
      // local metrics are best-effort
    }
  }

  #skillSpawnFields() {
    return {
      projectRoot: this.projectRoot,
      skillsDir: this.#skillsDir,
      store: this.store,
      fakeArtifacts: this.#fakeArtifacts,
      throwAfterWrite: this.#fakeThrowAfterWrite,
      timedOut: this.#fakeTimedOut,
      holdWait: this.#fakeHoldWait,
      onWait: this.#fakeOnWait,
      handlePid: this.#fakeHandlePid,
    };
  }

  async #liveInProgressTask(): Promise<Task | null> {
    const state = await this.#readState();
    if (!state.currentTaskId) return null;
    try {
      const task = (await this.store.readTask(state.currentTaskId)).data;
      if (task.status !== "in_progress" && task.status !== "verifying") return null;
      return task;
    } catch {
      return null;
    }
  }

  /** KD-21 is the execute `currentTaskId` + `in_progress` window. Plan/review wait is execute-only. */
  async #assertNoLiveInProgress(action: string): Promise<void> {
    const task = await this.#liveInProgressTask();
    if (task) {
      const resume = await findLatestTaskResume(this.projectRoot, task.id);
      if (resume && resumeRunIsLive(resume)) {
        refuse(`${action} is refused while ${task.id} is ${task.status}`, HINT.status);
      }
      if (!resume) {
        refuse(`${action} is refused while ${task.id} is ${task.status}`, HINT.status);
      }
    }
    await refuseIfLiveSkillSpawn(this.projectRoot, action);
  }

  async #assertTicketAgainstLiveSpawn(_input: NewTicket): Promise<void> {
    await this.#assertNoLiveInProgress("ticket create");
    await refuseIfLiveSkillSpawn(this.projectRoot, "ticket create");
  }

  async #recoverDeadInProgressLocked(): Promise<void> {
    const state = await this.#readState();
    if (state.phase === "uninitialized") return;
    const resumes = await listCacheResumes(this.projectRoot);
    const latestByTask = new Map<string, (typeof resumes)[number]>();
    for (const resume of resumes) {
      if (!resume.taskId) continue;
      const prev = latestByTask.get(resume.taskId);
      if (!prev || resume.startedAt > prev.startedAt) latestByTask.set(resume.taskId, resume);
    }
    const candidateIds = new Set(latestByTask.keys());
    if (state.currentTaskId) candidateIds.add(state.currentTaskId);
    let current = state.currentTaskId ?? null;
    let changedCurrent = false;
    for (const taskId of candidateIds) {
      let task;
      try {
        task = (await this.store.readTask(taskId)).data;
      } catch {
        continue;
      }
      if (task.status !== "in_progress" && task.status !== "verifying") continue;
      const resume = latestByTask.get(task.id);
      // Child pid is dead after wait(); enginePid live means this process is still finishing.
      // Verification runs outside engine.lock; a `verifying` task whose run is dead was
      // interrupted (Ctrl-C, crash) and would otherwise be stuck forever.
      if (resume && resumeRunIsLive(resume)) continue;
      const isCurrent = current === task.id;
      if (!resume && !isCurrent) continue;
      if (task.status === "verifying") {
        await this.#audit(
          "recover",
          state.phase,
          "cli",
          { from: "verifying", to: "blocked", reason: "verification was interrupted" },
          task.id,
        );
      }
      await this.#transitionTaskTo(task.id, "blocked");
      if (isCurrent) {
        current = null;
        changedCurrent = true;
      }
    }
    if (changedCurrent) {
      await this.#writeState({ ...(await this.#readState()), currentTaskId: null });
    }
  }

  async #withLockOrRefuse<T>(
    fn: () => Promise<T>,
    opts?: { timeoutMs?: number; nextHint?: string },
  ): Promise<T> {
    try {
      const already = this.store.holdsLock();
      return await this.store.withLock(
        async () => {
          if (!already) {
            if (!this.#reconciled) {
              await this.store.reconcileUnfinished();
              this.#reconciled = true;
            }
            await this.#recoverDeadInProgressLocked();
          }
          try {
            return await fn();
          } catch (err) {
            if (err instanceof LegionRefuseError) await this.#auditRefuse(err);
            throw err;
          }
        },
        opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined,
      );
    } catch (err) {
      if (err instanceof EngineLockedError || err instanceof RestoreRefusedError || err instanceof AuditTamperError) {
        const refuseErr = new LegionRefuseError(err.message, opts?.nextHint ?? HINT.status);
        await this.#auditRefuse(refuseErr);
        throw refuseErr;
      }
      throw err;
    }
  }

  async #mutate<T>(fn: () => Promise<T>): Promise<T> {
    return this.#withLockOrRefuse(fn);
  }

  /** Persist must not import wiki; catalog is engine-authored while holding the lock. */
  async #refreshWikiCatalogLocked(): Promise<void> {
    await writeWikiCatalog(this.store);
  }

  async #maybeDistillLocked(
    receipt: IngestReceipt,
    materialized: MaterializedIngest,
  ): Promise<{ skipped?: string; extraWikiPaths: string[]; ran?: boolean }> {
    let config: LegionConfig;
    try {
      config = await this.#readConfig();
    } catch {
      return { skipped: "no spawnable adapter", extraWikiPaths: [] };
    }
    const resolution = resolveAdapterId({ config, skillId: "ingest" });
    if (!(await isResolvedAdapterSpawnable(config, resolution.id))) {
      return { skipped: "no spawnable adapter", extraWikiPaths: [] };
    }

    const source = await this.#collectDistillSource(receipt, materialized);
    if (source.chars > DISTILL_SOURCE_MAX_CHARS) {
      return { skipped: "source too large", extraWikiPaths: [] };
    }
    if (source.chars === 0) {
      return { skipped: "no source", extraWikiPaths: [] };
    }

    const wikiBefore = await snapshotWikiRaw(this.projectRoot, this.store.paths.wikiDir);
    const result = await optionalSkillSpawn({
      projectRoot: this.projectRoot,
      config,
      skillId: "ingest",
      promptBody: [
        "Distill the untrusted source below into compiled wiki notes under .legion-cli/wiki/.",
        "Do not set trust: reviewed. Do not overwrite .legion-cli/wiki/index.md or .legion-cli/wiki/topics.yaml.",
        "The engine clamps trust and overwrites the catalog after wait().",
        "Link existing catalog titles. Do not write product code (src/**).",
        "",
        source.wrapped.trimEnd(),
      ].join("\n"),
      skillsDir: this.#skillsDir,
      store: this.store,
      fakeArtifacts: this.#fakeArtifacts,
      throwAfterWrite: this.#fakeThrowAfterWrite,
      timedOut: this.#fakeTimedOut,
      required: false,
    });
    if (!result.spawned) {
      return { skipped: "skill unavailable", extraWikiPaths: [] };
    }
    if (result.revert?.incident) {
      refuse("inspect .git — spawn touched .git/", HINT.inRepo);
    }
    const extraWikiPaths = await this.#clampSpawnWrittenWikiPages(wikiBefore);
    // Spawn writes are on disk but not yet in sqlite; catalog reads the index.
    await this.store.rebuild();
    if (result.timedOut) {
      return { skipped: "timed out", extraWikiPaths };
    }
    if (result.error) {
      return { skipped: "spawn failed", extraWikiPaths };
    }
    return { extraWikiPaths, ran: true };
  }

  async #collectDistillSource(
    receipt: IngestReceipt,
    materialized: MaterializedIngest,
  ): Promise<{ chars: number; wrapped: string }> {
    const parts: Array<{ source: string; body: string }> = [];
    const seen = new Set<string>();
    for (const pagePath of [...receipt.pagesCreated, ...receipt.pagesUpdated]) {
      try {
        const page = await this.store.readWikiPage(pagePath);
        if (seen.has(pagePath)) continue;
        seen.add(pagePath);
        parts.push({ source: page.data.source ?? pagePath, body: page.body });
      } catch {
        // excerpt may be unreadable; skip that page
      }
    }
    if (parts.length === 0) {
      for (const doc of materialized.documents) {
        parts.push({ source: doc.source, body: doc.body });
      }
    }
    const chars = parts.reduce((n, part) => n + part.body.length, 0);
    const wrapped = parts.map((part) => wrapUntrustedContent(part.source, part.body)).join("\n");
    return { chars, wrapped };
  }

  async #clampSpawnWrittenWikiPages(before: Map<string, string>): Promise<string[]> {
    const extraWikiPaths: string[] = [];
    for (const path of await listWikiStorePaths(this.store.paths.wikiDir)) {
      if (!path.endsWith(".md") || isEngineWikiCatalogPath(path)) continue;
      let raw: string;
      try {
        raw = await readFile(toFsPath(this.projectRoot, path), "utf8");
      } catch {
        continue;
      }
      if (before.get(path) === raw) continue;
      extraWikiPaths.push(path);
      await this.#forceWikiTrustUntrusted(path);
    }
    return extraWikiPaths;
  }

  async #forceWikiTrustUntrusted(storePath: string): Promise<void> {
    try {
      const doc = await this.store.readWikiPage(storePath);
      if (doc.data.trust === "untrusted") return;
      await this.store.writeWikiPage(
        storePath,
        { ...doc.data, trust: "untrusted", updated: nowIso() },
        doc.body,
      );
      return;
    } catch {
      // spawn may have written invalid or reviewed-looking frontmatter
    }
    let raw: string;
    try {
      raw = await readFile(toFsPath(this.projectRoot, storePath), "utf8");
    } catch {
      return;
    }
    try {
      const parsed = parseMarkdownDocument(raw);
      const fm =
        parsed.frontmatter && typeof parsed.frontmatter === "object"
          ? (parsed.frontmatter as Record<string, unknown>)
          : {};
      if (fm.trust === "untrusted") return;
      const title =
        typeof fm.title === "string" && fm.title.trim().length > 0
          ? fm.title.trim()
          : wikiIdFromStorePath(storePath);
      const page: WikiPage = {
        schemaVersion: WIKI_PAGE_SCHEMA_VERSION,
        title,
        aliases: stringList(fm.aliases),
        tags: stringList(fm.tags),
        trust: "untrusted",
        updated: nowIso(),
        ...(typeof fm.source === "string" ? { source: fm.source } : {}),
      };
      await this.store.writeWikiPage(storePath, page, parsed.body);
    } catch {
      // not a wiki markdown page
    }
  }

  async #applyReviewSnapshotsLocked(
    state: StateFile,
    beforeTaskIds: readonly string[],
    afterTaskIds: readonly string[],
    rewrittenExistingTaskIds: readonly string[] = [],
  ): Promise<ReviewVerdict> {
    const before = new Set(beforeTaskIds);
    const created = afterTaskIds.filter((id) => !before.has(id));
    const verdict: ReviewVerdict =
      created.length === 0 && rewrittenExistingTaskIds.length === 0 ? "PASS" : "FAIL";
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
