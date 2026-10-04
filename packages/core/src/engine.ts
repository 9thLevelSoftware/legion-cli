import {
  isResolvedAdapterSpawnable,
  listResolvedSkillCatalog,
  parseSkillFrontmatter,
  resolveAdapterId,
  resolveSkillDir,
  skillCatalogPath,
  type FakeArtifact,
} from "@9thlevelsoftware/legion-cli-agents";
import { applyProfileArgs } from "@9thlevelsoftware/legion-cli-agents";
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
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, sep } from "node:path";
import { constants, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readlink, readdir, readFile, realpath, rm } from "node:fs/promises";
import {
  abandonReceiptBody,
  abandonReceiptPath,
  appendAuditEvent,
  appendGovernanceBegin,
  appendGovernanceEnd,
  appendGovernanceEpoch,
  inspectGovernanceTrace,
  readGovernanceEpochs,
  readGovernanceTrace,
  reconcileGovernanceTrace,
  createLegionStore,
  DECISION_FILE_SCHEMA_VERSION,
  packetPath,
  parseMarkdownDocument,
  PathEscapeError,
  AuditTamperError,
  assertAuditAppendable,
  assertAuditChainUsable,
  healAuditChain,
  EngineLockedError,
  RestoreRefusedError,
  clearLiveRun,
  invalidTaskMessage,
  isPidAlive,
  listTaskFiles,
  listTaskSummaries,
  liveRuns,
  readLiveRun,
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
  type LiveRunMarker,
  type WikiPage,
  assertNoLinkInPath,
  abortDeliverySnapshot,
  completeDeliverySnapshot,
  canonicalJson,
  exportDeliveryBundle,
  gitIndexEntries,
  prepareDeliverySnapshot,
  readDeliverySnapshot,
  recordDeliveryExportAttempt,
  recordDeliveryOutcome,
  readDeliveryOutcome,
  type DeliveryBundleExport,
  type DeliveryOutcome,
  type PreparedDeliverySnapshot,
  type GovernanceTrace,
  GovernanceEpochError,
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
  AnyQAScoreSchema,
  QAScoreSchema,
  computeQaPass,
  SURGICAL_MIGRATION_HINT,
  SCHEMA_VERSION,
  GovernanceProjectionSchema,
  governanceOutcomeBlocks,
  type GovernanceAction,
  type GovernanceProjection,
  type GovernanceEpochs,
  type AdapterId,
  type AcceptanceReceipt,
  type AssurancePlan,
  type AnyQAScore,
  type Assumption,
  normalizePathKey,
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
  type ResumeFile,
  type FileContract,
  type SessionBrief,
  type Spec,
  type StateFile,
  type Task,
  type TaskStatus,
  type WorkflowEvidenceReceipt,
  type SpecChallengeReceipt,
  type SpecChallengeProposedChange,
  ResumeFileSchema,
  WorkflowClaimSchema,
  CheckEvidenceSchema,
  type ComponentRuntimeIdentity,
} from "@9thlevelsoftware/legion-cli-schema";
import type { WorkflowClaim } from "@9thlevelsoftware/legion-cli-schema";
import { copyShippedCraft, isBrandViolationBlockingFreeze } from "@9thlevelsoftware/legion-cli-design-system";
import { readHttpCheckpoint, stableHash } from "@9thlevelsoftware/legion-cli-http";
import { recordAppliedFileProvenance } from "./assurance-flow.js";
import { buildApprovedHttpAssuranceContext } from "./assurance-flow.js";
import {
  assertExecuteSandbox,
  hardenedSandboxAvailable,
  retainedJailIdentity,
  SandboxError,
} from "@9thlevelsoftware/legion-cli-sandbox";
import { HINT, LegionRefuseError, refuse, refuseKind } from "./errors.js";
import {
  assuranceManifestDigest,
  assuranceImpact,
  ASSURANCE_EXECUTION_PATH,
  ASSURANCE_TRACE_PREREQUISITE,
  bindAssuranceApproval,
  inspectAssuranceEvidence,
  loadAssurance,
  prepareAssuranceApproval,
  readAssuranceDraft,
  readAssuranceExecution,
  resolveAssuranceHost,
  runAssuranceChecks,
  validateAssuranceContext,
  writeAssuranceApproval,
  writeAssuranceCheck,
  writeAssuranceManifest,
  type AssuranceState,
  type AssuranceEvidenceReport,
  type AssuranceImpactReport,
} from "./assurance.js";
import { evaluateQaEvidenceFreshness, qaSourceHash, qaSpecHash } from "./qa-evidence.js";
import { selectParallelTasks } from "./parallel.js";
import {
  applyPreparedSandboxSpawn,
  discardPreparedSandboxSpawn,
  prepareSandboxedSpawn,
  type PreparedSandboxSpawn,
} from "./parallel-spawn.js";
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
import { isAllowedPath } from "./contracts.js";
import { assertCanTransition } from "./phases.js";
import { evaluateReadiness, type ReadinessReport } from "./readiness.js";
import { isSliceTerminal, p0TasksNotDone, sliceHasOpenWork, sliceTasks } from "./slice.js";
import {
  HEAD_MOVED_WARNING,
  restoreChangedTaskFiles,
  snapshotTaskFiles,
  type TaskFileSnapshot,
} from "./revert.js";
import {
  approveGovernedAction,
  buildVerificationInformationFlow,
  currentGovernedTaskPolicyFingerprint,
  type GovernedMcpDescriptor,
  inspectGovernedRun,
  readGovernedRunSchemaIdentities,
  recordOpaqueVerificationOutputProvenance,
} from "./assurance-flow.js";
import {
  currentGovernedMcpDescriptors,
  findLatestTaskResume,
  findSkillsDir,
  finishStartedSpawn,
  clearLiveSpawnMarker,
  inspectResumeOwner,
  listCacheResumes,
  optionalSkillSpawn,
  preserveStartedHttpSpawnForRecovery,
  refuseIfLiveSkillSpawn,
  refuseIfLiveRun,
  resumeAsLiveRun,
  spawnableAdapterRefuseMessage,
  startSkillSpawn,
  resumeHttpSkillSpawn,
  updateResumeStage,
  waitStartedSpawn,
  agentExitProblem,
  cleanupStartedSpawnResources,
  defaultAllowCopyJail,
  type OptionalSpawnResult,
  type StartedSkillSpawn,
} from "./spawn.js";
import { buildSpecFromIntent, specMarkdownBody } from "./spec-build.js";
import { compactTaskBody, outcomeFromTask } from "./compact.js";
import { hybridSearch } from "./retrieval.js";
import { assertTaskStatusTransition } from "./tasks.js";
import { canTransitionTaskStatus } from "@9thlevelsoftware/legion-cli-schema";
import {
  ensureRegressionTest,
  fixFilesAllowed,
  regressionTestPath,
  regressionVerifyCommand,
} from "./fix.js";
import { packetFromInput, packetMarkdownBody } from "./packets.js";
import {
  defaultTicketContract,
  parseExtraJson,
  taskMarkdownBody,
  ticketFromInput,
  touchesVerificationEntryPoint,
} from "./tickets.js";
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
  ExecuteProgress,
  ExecuteResult,
  GovernanceInspection,
  GovernedActionApprovalOptions,
  PendingGovernedAction,
  IngestOpts,
  IngestResult,
  ExecuteTaskResult,
  TicketSource,
  FiledTicketSummary,
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
  ShipExportResult,
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
  ExecuteWorkflowOptions,
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
  WORKFLOW_CLAIM_PATH,
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
  workflowProductPaths,
  workflowReviewEvidenceFresh,
  writeAcceptanceReceipt,
  writePlanApproval,
  writeSpecApproval,
  writeWorkflowEvidence,
  writeWorkflowReviewReport,
  releaseWorkflowClaim,
  workflowClaimHolderLive,
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
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  runVerificationCommands,
  verificationFailureReason,
  type VerificationInformationFlow,
} from "./verify.js";
import { palettePresent } from "./wireframes.js";
import { finishWireframe, prepareWireframe, screenPagesFor, writeWireframeFiles } from "./wireframe-run.js";
const MAX_VERIFICATION_INVENTORY_FILES = 8192;
const MAX_VERIFICATION_INVENTORY_FILE_BYTES = 16 * 1024 * 1024;
const MAX_VERIFICATION_INVENTORY_BYTES = 256 * 1024 * 1024;
const GOVERNED_HTTP_TIMEOUT_MS = 120_000;


type DeliveryProduct = PreparedDeliverySnapshot["product"];

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deliverySubjectDigest(scope: DeliveryProduct["scope"], entries: DeliveryProduct["entries"]): string {
  return sha256Hex(Buffer.from(canonicalJson({ scope, entries }), "utf8"));
}

function gitBatchObjects(projectRoot: string, oids: readonly string[]): Map<string, Buffer> {
  if (oids.length === 0) return new Map();
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: projectRoot,
    input: `${oids.join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`git cat-file --batch failed: ${result.error?.message ?? result.stderr?.toString("utf8").slice(0, 512)}`);
  const bytes = result.stdout as Buffer;
  const objects = new Map<string, Buffer>();
  let offset = 0;
  for (const expected of oids) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) throw new Error("Malformed git cat-file --batch header");
    const header = bytes.toString("ascii", offset, newline).split(" ");
    const size = Number(header[2]);
    if (header[0] !== expected || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0) throw new Error("Unexpected Git product object");
    const start = newline + 1;
    const end = start + size;
    if (end >= bytes.length || bytes[end] !== 10) throw new Error("Truncated git cat-file --batch object");
    objects.set(expected, bytes.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== bytes.length) throw new Error("Unexpected trailing git cat-file --batch output");
  return objects;
}

function gitProductInventory(projectRoot: string): DeliveryProduct {
  const parsed = gitIndexEntries(projectRoot).map((entry) => {
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("Malformed Git index entry");
    const [mode, oid, stage] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1).replaceAll("\\", "/");
    if (stage !== "0") throw new Error(`Unmerged Git index entry: ${path}`);
    return { mode: mode!, oid: oid!, path };
  }).filter((entry) => entry.path !== ".legion-cli" && !entry.path.startsWith(".legion-cli/")).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const blobs = gitBatchObjects(projectRoot, parsed.filter((entry) => entry.mode !== "160000").map((entry) => entry.oid));
  const entries: DeliveryProduct["entries"] = parsed.map((entry) => {
    if (entry.mode === "160000") return { kind: "gitlink", path: entry.path, mode: "160000", oid: entry.oid, scope: "referenced-commit-only" };
    const body = blobs.get(entry.oid);
    if (!body) throw new Error(`Missing Git object for ${entry.path}`);
    if (entry.mode !== "100644" && entry.mode !== "100755" && entry.mode !== "120000") throw new Error(`Unsupported Git product mode ${entry.mode}`);
    return { kind: "blob", path: entry.path, mode: entry.mode, sha256: sha256Hex(body), size: body.length };
  });
  const scope = "git-index" as const;
  return { scope, entries, subjectDigest: deliverySubjectDigest(scope, entries) };
}

async function nativeProductInventory(projectRoot: string): Promise<DeliveryProduct> {
  const entries: DeliveryProduct["entries"] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (!prefix && child.name === ".legion-cli") continue;
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = join(directory, child.name);
      const stats = await lstat(absolute);
      if (stats.isDirectory()) {
        await visit(absolute, path);
        continue;
      }
      if (!stats.isSymbolicLink() && !stats.isFile()) {
        throw new Error(`Unsupported filesystem object in native product inventory: ${path}`);
      }
      const content = stats.isSymbolicLink()
        ? await readlink(absolute, { encoding: "buffer" })
        : await readFile(absolute);
      entries.push({
        kind: "native-file",
        path,
        mode: `native:${(stats.mode & 0o7777).toString(8).padStart(4, "0")}`,
        sha256: sha256Hex(content),
        size: content.length,
      });
    }
  };
  await visit(projectRoot, "");
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const scope = "host-native-product" as const;
  return { scope, entries, subjectDigest: deliverySubjectDigest(scope, entries) };
}

function gitCommitProductInventory(projectRoot: string, commit: string): DeliveryProduct {
  const tree = spawnSync("git", ["ls-tree", "-r", "-z", "--full-tree", commit], {
    cwd: projectRoot,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (tree.error || tree.status !== 0) throw new Error(`git ls-tree failed: ${tree.error?.message ?? tree.stderr?.toString("utf8").slice(0, 512)}`);
  const records = (tree.stdout as Buffer).toString("utf8").split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, , oid] = record.slice(0, tab).split(" ");
    return { mode: mode!, oid: oid!, path: record.slice(tab + 1).replaceAll("\\", "/") };
  }).filter((entry) => entry.path !== ".legion-cli" && !entry.path.startsWith(".legion-cli/")).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const blobs = gitBatchObjects(projectRoot, records.filter((item) => item.mode !== "160000").map((item) => item.oid));
  const entries: DeliveryProduct["entries"] = records.map((item) => {
    if (item.mode === "160000") return { kind: "gitlink", path: item.path, mode: "160000", oid: item.oid, scope: "referenced-commit-only" };
    const body = blobs.get(item.oid);
    if (!body) throw new Error(`Missing committed Git object for ${item.path}`);
    if (item.mode !== "100644" && item.mode !== "100755" && item.mode !== "120000") throw new Error(`Unsupported committed Git mode ${item.mode}`);
    return { kind: "blob", path: item.path, mode: item.mode, sha256: sha256Hex(body), size: body.length };
  });
  const scope = "git-index" as const;
  return { scope, entries, subjectDigest: deliverySubjectDigest(scope, entries) };
}

async function deliveryProductInventory(projectRoot: string): Promise<DeliveryProduct> {
  return isGitRepo(projectRoot) ? gitProductInventory(projectRoot) : nativeProductInventory(projectRoot);
}
/** Distill spawn is skipped when materialized source exceeds this many characters (64 KiB). */
export const DISTILL_SOURCE_MAX_CHARS = 64 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

async function readDeliveryCheckEvidence(
  store: LegionStore,
  approvalId: string,
  checkId: string,
  executionId: string | null,
  nativeHost: ComponentRuntimeIdentity | null,
): Promise<{ observationDigest: string | null; recordedAt: string | null; runtime: ComponentRuntimeIdentity | null }> {
  if (!executionId) return { observationDigest: null, recordedAt: null, runtime: null };
  const filename = createHash("sha256").update(executionId, "utf8").digest("hex");
  const path = `.legion-cli/workflow/checks/${checkId}/${filename}.yaml`;
  if (!await store.pathExists(path)) return { observationDigest: null, recordedAt: null, runtime: null };
  await assertNoLinkInPath(toFsPath(store.projectRoot, path), { root: store.projectRoot });
  const receipt = await store.readYaml(path, CheckEvidenceSchema);
  if (receipt.approvalId !== approvalId || receipt.checkId !== checkId || receipt.executionId !== executionId) {
    throw new Error(`Validator ${checkId} observation receipt identity mismatch`);
  }
  if (canonicalJson(receipt.runtime) !== canonicalJson(nativeHost)) {
    throw new Error(`Validator ${checkId} runtime identity differs from the approved host`);
  }
  const expectedDigest = receipt.output
    ? sha256Hex(Buffer.from(canonicalJson(receipt.output.observations), "utf8"))
    : null;
  if (receipt.observationDigest !== expectedDigest) throw new Error(`Validator ${checkId} observation digest mismatch`);
  return { observationDigest: receipt.observationDigest, recordedAt: receipt.recordedAt, runtime: receipt.runtime };
}

type VerificationProductEntry = { kind: "file" | "symlink" | "directory" | "other" | "missing"; digest: string | null };

type VerificationFileStat = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; nlink: bigint; mode: bigint };
function sameVerificationFileIdentity(left: VerificationFileStat, right: VerificationFileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.nlink === right.nlink && left.mode === right.mode;
}

function assertVerificationFileInsideRoot(root: string, absolute: string): Promise<string> {
  return realpath(absolute).then((canonical) => {
    const rel = relative(root, canonical);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("verification product path resolves outside the project");
    }
    return canonical;
  });
}

async function snapshotVerificationProduct(projectRoot: string): Promise<Map<string, VerificationProductEntry>> {
  const paths = await workflowProductPaths(projectRoot);
  if (paths.length > MAX_VERIFICATION_INVENTORY_FILES) throw new Error("verification product inventory exceeds its bounded file count");
  const realRoot = await realpath(projectRoot);
  const entries = new Map<string, VerificationProductEntry>();
  let totalBytes = 0;
  for (const path of paths) {
    const absolute = toFsPath(projectRoot, path);
    let namedBefore;
    try {
      namedBefore = await lstat(absolute, { bigint: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      entries.set(path, { kind: "missing", digest: null });
      continue;
    }
    if (namedBefore.isSymbolicLink()) {
      const target = await readlink(absolute);
      const namedAfter = await lstat(absolute, { bigint: true });
      if (!sameVerificationFileIdentity(namedBefore, namedAfter) || target !== await readlink(absolute)) {
        throw new Error(`verification product changed while capturing symlink ${path}`);
      }
      entries.set(path, { kind: "symlink", digest: createHash("sha256").update(target).digest("hex") });
      continue;
    }
    if (!namedBefore.isFile()) {
      const namedAfter = await lstat(absolute, { bigint: true });
      if (!sameVerificationFileIdentity(namedBefore, namedAfter)) throw new Error(`verification product changed while capturing ${path}`);
      entries.set(path, { kind: namedBefore.isDirectory() ? "directory" : "other", digest: null });
      continue;
    }
    if (namedBefore.size > BigInt(MAX_VERIFICATION_INVENTORY_FILE_BYTES)) {
      throw new Error(`verification product inventory cannot safely capture ${path}`);
    }
    totalBytes += Number(namedBefore.size);
    if (totalBytes > MAX_VERIFICATION_INVENTORY_BYTES) throw new Error("verification product inventory exceeds its bounded byte count");
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(absolute, flags);
    try {
      const descriptorBefore = await handle.stat({ bigint: true });
      if (!descriptorBefore.isFile() || !sameVerificationFileIdentity(namedBefore, descriptorBefore)) {
        throw new Error(`verification product path changed while opening ${path}`);
      }
      const canonicalBefore = await assertVerificationFileInsideRoot(realRoot, absolute);
      const hash = createHash("sha256");
      let streamedBytes = 0;
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) {
        streamedBytes += chunk.length;
        if (streamedBytes > Number(descriptorBefore.size) ||
            streamedBytes > MAX_VERIFICATION_INVENTORY_FILE_BYTES ||
            totalBytes - Number(descriptorBefore.size) + streamedBytes > MAX_VERIFICATION_INVENTORY_BYTES) {
          stream.destroy();
          throw new Error(`verification product exceeded its bounded capture while reading ${path}`);
        }
        hash.update(chunk);
      }
      const descriptorAfter = await handle.stat({ bigint: true });
      const namedAfter = await lstat(absolute, { bigint: true });
      const canonicalAfter = await assertVerificationFileInsideRoot(realRoot, absolute);
      if (streamedBytes !== Number(descriptorBefore.size) ||
          !sameVerificationFileIdentity(descriptorBefore, descriptorAfter) ||
          !sameVerificationFileIdentity(namedBefore, namedAfter) ||
          canonicalBefore !== canonicalAfter) {
        throw new Error(`verification product changed while capturing ${path}`);
      }
      entries.set(path, { kind: "file", digest: hash.digest("hex") });
    } finally {
      await handle.close();
    }
  }
  return entries;
}

function changedVerificationOutputs(
  before: ReadonlyMap<string, VerificationProductEntry>,
  after: ReadonlyMap<string, VerificationProductEntry>,
  expectedArtifacts: readonly string[],
): Array<{ path: string; beforeDigest: string | null; afterDigest: string }> {
  const changes: Array<{ path: string; beforeDigest: string | null; afterDigest: string }> = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(path) ?? { kind: "missing", digest: null };
    const current = after.get(path) ?? { kind: "missing", digest: null };
    if (previous.kind === current.kind && previous.digest === current.digest) continue;
    if (!expectedArtifacts.some((expected) => normalizePathKey(expected) === normalizePathKey(path))) {
      throw new Error(`verification changed product outside expectedArtifacts: ${path}`);
    }
    if (current.kind === "missing") continue;
    if (current.kind !== "file" || current.digest === null) {
      throw new Error(`verification changed non-regular product path ${path}; output provenance cannot be recorded`);
    }
    changes.push({
      path,
      beforeDigest: previous.kind === "file" ? previous.digest : null,
      afterDigest: current.digest,
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}
function governedConfigurationFingerprint(
  config: LegionConfig,
  profile: string,
  profileConfig: unknown,
): string {
  const profileSettings = profileConfig && typeof profileConfig === "object"
    ? profileConfig as { limits?: unknown; outputLimit?: unknown; pricing?: unknown }
    : {};
  const http = config.adapter.http;
  return stableHash({
    endpoint: http?.baseUrl ?? null,
    model: http?.model ?? null,
    apiKeyEnv: http?.apiKeyEnv ?? null,
    allowLoopback: http?.allowLoopback ?? null,
    headers: http?.headers ?? null,
    profile,
    timeoutMs: GOVERNED_HTTP_TIMEOUT_MS,
    limits: profileSettings.limits ?? null,
    outputLimit: profileSettings.outputLimit ?? null,
    pricing: profileSettings.pricing ?? null,
  });
}


type HttpCrashRecovery =
  | { kind: "safe" }
  | { kind: "manual"; reason: string }
  | { kind: "none" };

async function classifyHttpCrashRecovery(
  projectRoot: string,
  task: Task,
  resume: ResumeFile | undefined,
): Promise<HttpCrashRecovery> {
  if (task.status === "in_progress" && resume?.schemaVersion === SCHEMA_VERSION.resume &&
      resume.skillId === "execute" && resume.adapterId === "http" && !resume.checkpointPath) {
    if (!["running", "agent-complete", "interrupted"].includes(resume.stage) ||
        !resume.sourceIdentity || !resume.contractIdentity || !resume.jailIdentity) return { kind: "none" };
    const jailPath = toFsPath(projectRoot, `.legion-cli/sandbox/${resume.runId}`);
    const sandboxRecord = toFsPath(projectRoot, `.legion-cli/cache/runs/${resume.runId}/sandbox.json`);
    if (!existsSync(jailPath) || !existsSync(sandboxRecord)) return { kind: "none" };
    try {
      if ((await retainedJailIdentity(projectRoot, resume.runId)) !== resume.jailIdentity) return { kind: "none" };
      const governed = await inspectGovernedRun({ store: createLegionStore(projectRoot), runId: resume.runId });
      if (!governed || governed.checkpoint.runId !== resume.runId ||
          governed.checkpoint.identities.sourceFingerprint !== resume.sourceIdentity ||
          governed.checkpoint.identities.jailFingerprint !== resume.jailIdentity) return { kind: "none" };
      if (governed.checkpoint.effects.some((effect) => effect.state === "pending" || effect.state === "uncertain")) {
        return { kind: "manual", reason: "governed external effect outcome is uncertain" };
      }
      if (governed.checkpoint.status === "complete") return { kind: "safe" };
      if (governed.checkpoint.status === "blocked") {
        return governed.checkpoint.blocker === "approval-required"
          ? { kind: "safe" }
          : { kind: "manual", reason: "governed run is blocked pending explicit authority" };
      }
      return { kind: "safe" };
    } catch {
      return { kind: "manual", reason: "governed recovery record could not be validated" };
    }
  }
  if (
    task.status !== "in_progress" ||
    !resume ||
    resume.schemaVersion !== SCHEMA_VERSION.resume ||
    resume.skillId !== "execute" ||
    resume.adapterId !== "http" ||
    !["running", "agent-complete", "interrupted"].includes(resume.stage) ||
    !resume.checkpointPath ||
    !resume.sourceIdentity ||
    !resume.contractIdentity ||
    !resume.jailIdentity
  ) {
    return { kind: "none" };
  }
  const jailPath = toFsPath(projectRoot, `.legion-cli/sandbox/${resume.runId}`);
  const sandboxRecord = toFsPath(projectRoot, `.legion-cli/cache/runs/${resume.runId}/sandbox.json`);
  if (!existsSync(jailPath) || !existsSync(sandboxRecord)) return { kind: "none" };
  try {
    if ((await retainedJailIdentity(projectRoot, resume.runId)) !== resume.jailIdentity) {
      return { kind: "none" };
    }
    const checkpoint = await readHttpCheckpoint(toFsPath(projectRoot, resume.checkpointPath));
    if (
      !checkpoint ||
      checkpoint.runId !== resume.runId ||
      checkpoint.identities.sourceIdentity !== resume.sourceIdentity ||
      checkpoint.identities.contractHash !== resume.contractIdentity ||
      checkpoint.identities.jailIdentity !== resume.jailIdentity
    ) {
      return { kind: "none" };
    }
    if (checkpoint.request?.status === "dispatching") {
      return { kind: "manual", reason: "provider request outcome is uncertain" };
    }
    if (checkpoint.completion.status === "complete") return { kind: "safe" };
    const pending = checkpoint.toolOutcomes.filter((outcome) => outcome.status === "pending");
    let allReconciled = true;
    for (const outcome of pending) {
      if (outcome.name === "read_file" || outcome.name === "list_dir") continue;
      if (outcome.name !== "write_file") {
        allReconciled = false;
        break;
      }
      let args: unknown;
      try {
        args = JSON.parse(outcome.arguments);
      } catch {
        allReconciled = false;
        break;
      }
      if (!args || typeof args !== "object") {
        allReconciled = false;
        break;
      }
      const { path, contents } = args as { path?: unknown; contents?: unknown };
      if (typeof path !== "string" || typeof contents !== "string") {
        allReconciled = false;
        break;
      }
      try {
        if ((await readFile(toFsPath(jailPath, path), "utf8")) !== contents) {
          allReconciled = false;
          break;
        }
      } catch {
        allReconciled = false;
        break;
      }
    }
    if (allReconciled) {
      return { kind: "safe" };
    }
    return { kind: "manual", reason: "tool outcome is uncertain" };
  } catch {
    return { kind: "none" };
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<PromiseSettledResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PromiseSettledResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "rejected", reason: new Error("operation did not settle after abort grace") }), timeoutMs);
  });
  try {
    const settled = promise
      .then<PromiseSettledResult<T>>((value) => ({ status: "fulfilled", value }))
      .catch<PromiseSettledResult<T>>((reason: unknown) => ({ status: "rejected", reason }));
    return await Promise.race([
      settled,
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

/**
 * `allowLive`: read-only entry. `ownRunId`: the run this entry finishes (exempt from the live-run guard).
 * `allowInterruptedEpoch`: only plan approval, which opens the next governance epoch, may enter while the
 * current approval identity disagrees with the latest epoch anchor.
 */
type LockEntryOptions = {
  timeoutMs?: number;
  nextHint?: string;
  allowLive?: boolean;
  allowInterruptedEpoch?: boolean;
  ownRunId?: string;
  ownRunIds?: readonly string[];
};

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
function normalizeInjectedQaScore(input: QAScore, spec: Spec, specHash: string, sourceHash: string): QAScore {
  const expected = [...spec.acceptance]
    .map((criterion) => ({ id: criterion.id, priority: criterion.priority }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const actual = input.criteria
    .map((criterion) => ({ id: criterion.id, priority: criterion.priority }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    refuse("Injected QA score criteria do not match the active SPEC", HINT.qa);
  }
  const count = (priority: "P0" | "P1" | "P2", passed: boolean): number =>
    input.criteria.filter(
      (criterion) => criterion.priority === priority && (passed ? criterion.outcome === "passed" : criterion.outcome !== "passed"),
    ).length;
  const rate = (priority: "P1" | "P2"): number => {
    const passed = count(priority, true);
    const failed = count(priority, false);
    return passed + failed === 0 ? 1 : passed / (passed + failed);
  };
  const p0Failed = count("P0", false);
  const p1Rate = rate("P1");
  const p2Rate = rate("P2");
  const buckets = {
    p0: { points: p0Failed === 0 ? 40 : 0, max: 40 as const, failed: p0Failed },
    p1: { points: Math.round(30 * p1Rate), max: 30 as const, passRate: p1Rate },
    p2: { points: Math.round(15 * p2Rate), max: 15 as const, passRate: p2Rate },
    visual: input.buckets.visual,
  };
  const sum = buckets.p0.points + buckets.p1.points + buckets.p2.points + buckets.visual.points;
  const total = input.mode === "no-browser" ? Math.min(sum, 70) : sum;
  const failedCriterionIds = input.criteria.filter((item) => item.outcome === "failed").map((item) => item.id);
  const missingCriterionIds = input.criteria.filter((item) => item.outcome === "missing").map((item) => item.id);
  const skippedCriterionIds = input.criteria.filter((item) => item.outcome === "skipped").map((item) => item.id);
  const reportFailures = Math.max(input.reportFailures, failedCriterionIds.length);
  return QAScoreSchema.parse({
    ...input,
    specId: spec.id,
    criteria: [...input.criteria].sort((a, b) => a.id.localeCompare(b.id)),
    buckets,
    total,
    pass: computeQaPass({ mode: input.mode, total, buckets, reportFailures }),
    failedCriterionIds,
    missingCriterionIds,
    skippedCriterionIds,
    reportFailures,
    specHash,
    sourceHash,
  });
}

export class LegionEngine {
  readonly store: LegionStore;
  readonly #skillsDir?: string;
  readonly #fakeArtifacts: FakeArtifact[];
  readonly #fakeDistillSandboxHardened: boolean | undefined;
  readonly #fakeThrowAfterWrite: boolean;
  readonly #fakeTimedOut: boolean;
  readonly #fakeExitCode?: number;
  readonly #fakeExitCodeForTask?: LegionEngineOptions["fakeExitCodeForTask"];
  readonly #fakeResourceCleanupForTask?: LegionEngineOptions["fakeResourceCleanupForTask"];
  readonly #fakeOmitSummary: boolean;
  readonly #fakeHoldWait?: LegionEngineOptions["fakeHoldWait"];
  readonly #fakeOnWait?: () => Promise<void>;
  readonly #fakeBeforeParallelApply?: LegionEngineOptions["fakeBeforeParallelApply"];
  readonly #fakeBeforeParallelStart?: LegionEngineOptions["fakeBeforeParallelStart"];
  readonly #fakeVerificationError?: string;
  readonly #fakeOnVerify?: () => Promise<void>;
  readonly #fakeOnQa?: () => Promise<void>;
  readonly #fakeAfterChallengeOutputCheckpoint?: () => Promise<void>;
  readonly #fakeAfterChallengeDraftWrite?: () => Promise<void>;
  readonly #fakeQaScoreInjection: boolean;
  readonly #fakeHandlePid?: number;
  readonly #fakeGovernanceFault?: LegionEngineOptions["fakeGovernanceFault"];
  readonly #verificationTimeoutMs: number;
  #lastPlanReport: ReadinessReport | null = null;
  #lastQaWarnings: string[] = [];
  #reconciled = false;
  #governanceBoundaryActive = false;
  #shipProjection: GovernanceProjection["ship"] | null = null;
  #reviewProjection: GovernanceProjection["review"] | null = null;

  constructor(projectRoot: string, store?: LegionStore, options?: LegionEngineOptions) {
    this.store = store ?? createLegionStore(projectRoot);
    this.#skillsDir = options?.skillsDir;
    this.#fakeArtifacts = options?.fakeArtifacts ?? [];
    this.#fakeDistillSandboxHardened = options?.fakeDistillSandboxHardened;
    this.#fakeThrowAfterWrite = Boolean(options?.fakeThrowAfterWrite);
    this.#fakeTimedOut = Boolean(options?.fakeTimedOut);
    this.#fakeExitCode = options?.fakeExitCode;
    this.#fakeExitCodeForTask = options?.fakeExitCodeForTask;
    this.#fakeResourceCleanupForTask = options?.fakeResourceCleanupForTask;
    this.#fakeOmitSummary = Boolean(options?.fakeOmitSummary);
    this.#fakeHoldWait = options?.fakeHoldWait;
    this.#fakeOnWait = options?.fakeOnWait;
    this.#fakeBeforeParallelApply = options?.fakeBeforeParallelApply;
    this.#fakeBeforeParallelStart = options?.fakeBeforeParallelStart;
    this.#fakeVerificationError = options?.fakeVerificationError;
    this.#fakeOnVerify = options?.fakeOnVerify;
    this.#fakeOnQa = options?.fakeOnQa;
    this.#fakeAfterChallengeOutputCheckpoint = options?.fakeAfterChallengeOutputCheckpoint;
    this.#fakeAfterChallengeDraftWrite = options?.fakeAfterChallengeDraftWrite;
    this.#fakeQaScoreInjection = Boolean(options?.fakeQaScoreInjection);
    this.#fakeHandlePid = options?.fakeHandlePid;
    this.#fakeGovernanceFault = options?.fakeGovernanceFault;
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
    if (opts.adapter === "acp" && !opts.acp) {
      refuse(
        "adapter.acp is required when adapter.default is acp",
        "legion-cli init --adapter acp --acp-command <bin>",
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
          ...(opts.acp ? { acp: opts.acp } : {}),
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
        search: { mode: "lexical" },
        execution: { maxWorkers: 1 },
        telemetry: {},
        mcpHttpToolAllowlist: [],
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

  async approveSpec(specId: string, actor: Actor, opts: { message?: string } = {}): Promise<void> {
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
      const approvalMessage = opts.message?.trim();
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
      if (opts?.distill) await this.#assertDistillSandbox();
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
      // Ingest never changes the phase. If another writer moved it meanwhile, leave that move alone.
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
    return this.#read(async () => {
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
    return this.#read(async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("Search needs a Legion CLI project first", HINT.init);
      }
      await ensureWikiIndex(this.store);
      const lexical = searchWiki(this.projectRoot, q, opts);
      if (opts?.mentions) return lexical;
      return hybridSearch(this.projectRoot, q, lexical, (await this.#readConfig()).search);
    });
  }

  async garden(): Promise<GardenReport> {
    return this.#read(async () => {
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

    await this.#startLock(() => started, async () => {
      const state = await this.#readState();
      if (state.phase === "uninitialized") {
        refuse("Map needs a Legion CLI project first", HINT.init);
      }
      try {
        generated = await generateMap(this.projectRoot, {
          refresh: opts.refresh,
          lsp: opts.lsp,
          resolveBinary: opts.resolveBinary,
          spawnLsp: opts.spawnLsp,
          lspDeadlineMs: opts.lspDeadlineMs,
          maxModules: opts.maxModules,
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

    return this.#relock(started?.runId, async () => {
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
          mergeArchitecture(existingArch, renderArchitecture(generated.fingerprints, { omitted: generated.omitted })),
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
      async () => this.#governanceMutation("compact", async () => {
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
      }),
      { timeoutMs: opts?.timeoutMs, nextHint: HINT.compact },
    );
  }

  async assumeList(): Promise<Assumption[]> {
    return this.#read(async () => {
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
    return this.#read(async () => {
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

  async plan(specId?: string, opts?: { adapter?: AdapterId; profile?: string }): Promise<Readiness> {
    const spawnFails: string[] = [];
    let planExitWarning: string | undefined;
    let planAgentExit: { runId: string; code: number | null } | undefined;
    let started: StartedSkillSpawn | undefined;
    let current: StateFile | undefined;
    let id: string | undefined;
    let config: LegionConfig | undefined;

    await this.#startLock(() => started, async () => {
      const state = await this.#readState();
      if (state.phase !== "spec_frozen" && state.phase !== "planning" && state.phase !== "plan_failed") {
        refuse("Plan needs a frozen spec first", HINT.spec);
      }
      id = specId ?? state.activeSpecId ?? undefined;
      if (!id) {
        refuse("plan requires an active spec", HINT.spec);
      }

      config = await this.#readConfig();
      await this.#assertSkillSpawnable(config, "plan", { cliAdapter: opts?.adapter, cliProfile: opts?.profile });

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
          cliProfile: opts?.profile,
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
      const problem = agentExitProblem(waited);
      if (problem) {
        planAgentExit = { runId: started.runId, code: waited.exitCode ?? null };
        planExitWarning = `plan ${problem} (log: .legion-cli/cache/runs/${started.runId}/stderr.log); readiness decides the result`;
      }
    }

    return this.#relock(started?.runId, async () => {
      const specIdLocked = id;
      const currentLocked = current;
      const configLocked = config;
      if (!specIdLocked || !currentLocked || !configLocked) {
        refuse("plan requires an active spec", HINT.spec);
      }
      let runId = started?.runId;
      if (planAgentExit) {
        await this.#audit("plan", currentLocked.phase, "agent", {
          skillId: "plan",
          runId: planAgentExit.runId,
          agentExitCode: planAgentExit.code,
        });
      }
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
      const concerns = [
        ...(fails.length > 0 ? [] : report.concerns),
        ...(planExitWarning ? [planExitWarning] : []),
      ];
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
      if (opts.assuranceManifestPath !== undefined && opts.assuranceOff) {
        refuse("plan approve cannot adopt and remove assurance together", "legion-cli plan approve --assurance <yaml-file>");
      }
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
      const priorAssurance = await loadAssurance(this.store);
      const assuranceManifest = opts.assuranceOff
        ? null
        : opts.assuranceManifestPath !== undefined
          ? await readAssuranceDraft(opts.assuranceManifestPath)
          : priorAssurance.manifest;
      if (!opts.assuranceOff && opts.assuranceManifestPath === undefined && priorAssurance.status && !assuranceManifest) {
        refuse(priorAssurance.status.blocker ?? "assurance manifest is invalid", "legion-cli plan approve --assurance <yaml-file>");
      }
      if (!opts.assuranceOff && opts.assuranceManifestPath === undefined && priorAssurance.approval &&
          priorAssurance.fingerprint !== priorAssurance.approval.manifestDigest) {
        refuse("adopted assurance manifest changed; replacement requires --assurance", "legion-cli plan approve --assurance <yaml-file>");
      }
      const context = await this.#workflowPlanContext(approvalConfig, assuranceManifest);
      if (assuranceManifest) {
        await validateAssuranceContext(assuranceManifest, { ...context, projectRoot: this.projectRoot });
      }
      const nativeHost = assuranceManifest ? await resolveAssuranceHost(assuranceManifest) : null;
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
      const configurationChanged = currentConfig.workflow?.profile !== "focused";
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
      const assuranceApproval = assuranceManifest
        ? await prepareAssuranceApproval(assuranceManifest, receipt, this.projectRoot, nativeHost)
        : null;
      const persistApproval = async (): Promise<void> => {
        if (configurationChanged) await this.store.writeConfig(approvalConfig);
        if (assuranceManifest || priorAssurance.status || opts.assuranceOff) {
          await writeAssuranceManifest(this.store, assuranceManifest);
        }
        await writePlanApproval(this.store, receipt);
        if (assuranceApproval) await writeAssuranceApproval(this.store, assuranceApproval);
        await this.#audit("plan_approve", state.phase, actor.id, {
          specId: receipt.specId,
          planFingerprint: receipt.planFingerprint,
          verificationCommands: receipt.verificationCommands,
        });
      };
      // The epoch anchor is written before the approval boundary: a crash or journal restore after this
      // point leaves the anchor naming an approval the project no longer holds, which every writer refuses.
      if (assuranceApproval || await readGovernanceEpochs(this.store)) {
        await appendGovernanceEpoch(this.store, {
          approvalId: receipt.approvalId,
          adopted: Boolean(assuranceApproval),
          recordedAt: receipt.approvedAt,
        }, { assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); } });
      }
      if (assuranceApproval) {
        await this.#governanceMutationForApproval(receipt.approvalId, approvalConfig, persistApproval);
      } else {
        await persistApproval();
      }
      return receipt;
    }, { allowInterruptedEpoch: true });
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
            if (resume && ["live", "unknown"].includes(await inspectResumeOwner(resume))) {
              return { result: challengeResult(context.specId, receipt) };
            }
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
    return this.#relock(liveAnalysis.runId, async () => {
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
    });
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
          if (resume && ["live", "unknown"].includes(await inspectResumeOwner(resume))) {
            return { result: challengeResult(context.specId, receipt) };
          }
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
    return this.#relock(liveSynthesis.runId, async () => {
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
    });
  }

  async getPlanEvidence(): Promise<AssuranceEvidenceReport> {
    const context = await this.#workflowPlanContext();
    const approval = await readPlanApproval(this.store);
    const status = bindAssuranceApproval(context.assurance, approval, context.snapshot.planFingerprint);
    return inspectAssuranceEvidence(this.store, { ...context.assurance, ...(status ? { status } : {}) }, context.spec.acceptance.map((criterion) => criterion.id), await this.#componentPolicyPosture(context.assurance, context.tasks));
  }

  async getPlanImpact(): Promise<AssuranceImpactReport> {
    const context = await this.#workflowPlanContext();
    const approval = await readPlanApproval(this.store);
    const status = bindAssuranceApproval(context.assurance, approval, context.snapshot.planFingerprint);
    const report = await inspectAssuranceEvidence(this.store, { ...context.assurance, ...(status ? { status } : {}) }, context.spec.acceptance.map((criterion) => criterion.id), await this.#componentPolicyPosture(context.assurance, context.tasks));
    return assuranceImpact(report, context.assurance.manifest);
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
    let assurance = bindAssuranceApproval(context.assurance, approval, context.snapshot.planFingerprint);
    const planApproval = !approval
      ? "missing" as const
      : assurance?.status !== "invalid" && approval.specId === context.snapshot.specId && approval.planFingerprint === context.snapshot.planFingerprint
        ? "valid" as const
        : "stale" as const;
    if (planApproval !== "valid" || !approval) {
      const planBody = await readPlanBody(this.projectRoot, context.snapshot.specId);
      const missingPlanBody = !planBody?.trim();
      return {
        stage: "plan",
        planApproval,
        ...(assurance ? { assurance } : {}),
        execution: "not_started",
        acceptance: this.#workflowAcceptanceStatus(context.spec, null),
        blocker: assurance?.blocker ?? (missingPlanBody
          ? `create .legion-cli/plans/${context.snapshot.specId}.md before approving the plan`
          : planApproval === "stale"
            ? "plan approval is stale"
            : null),
        next: "legion-cli plan approve",
      };
    }
    const governedExecution = await this.#governedExecutionEvidence(context.assurance, context.tasks);
    const informationFlowPosture = governedExecution.posture;
    if (assurance?.mode === "information-flow") assurance = { ...assurance, informationFlow: informationFlowPosture };
    // Done work whose governed run was granted different authority must re-run; undo returns it to todo.
    const staleGovernedTask = context.tasks.find((task) => task.status === "done" && governedExecution.staleTaskIds.includes(task.id));
    const staleGovernedBlocker = staleGovernedTask
      ? `governed execution evidence for ${governedExecution.staleTaskIds.join(", ")} was not produced under the current approved authority; re-run with legion-cli undo --task ${staleGovernedTask.id}, then legion-cli plan approve and legion-cli execute`
      : null;
    const assuranceEvidence = context.assurance.manifest
      ? await inspectAssuranceEvidence(
        this.store,
        { ...context.assurance, ...(assurance ? { status: assurance } : {}) },
        context.spec.acceptance.map((criterion) => criterion.id),
        informationFlowPosture,
      )
      : undefined;

    const governanceTraceStatus = context.assurance.manifest && context.assurance.approval
      ? await this.#governanceDeliveryTraceStatus(context.config, context.assurance.approval.approvalId)
      : null;
    const assuranceTraceStatus: "valid" | "incomplete" | "invalid" | undefined = governanceTraceStatus === null
      ? assuranceEvidence?.traceStatus === "not-adopted" ? "incomplete" : assuranceEvidence?.traceStatus
      : governanceTraceStatus === "not-adopted" ? "incomplete" : governanceTraceStatus;
    if (assurance && assuranceEvidence) assurance = {
      ...assurance,
      coverage: assuranceEvidence.criteria,
      checks: assuranceEvidence.checks,
      traceStatus: assuranceTraceStatus,
      policyStatus: assuranceEvidence.policyStatus === "not-adopted" ? "blocked" : assuranceEvidence.policyStatus,
      blocker: governanceTraceStatus === "valid" && assuranceEvidence.blocker === ASSURANCE_TRACE_PREREQUISITE
        ? null
        : assuranceEvidence.blocker,
    };

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
    let execution: WorkflowStatus["execution"] = !evidence
      ? "not_started"
      : !evidenceFresh
        ? "stale"
        : evidence.status === "complete"
          ? "complete"
          : evidence.status === "running"
            ? "running"
            : "blocked";
    if (assurance?.mode === "information-flow" && assurance.informationFlow !== "enforced") execution = "blocked";
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
    const retryableExecutionFailure = Boolean(assuranceEvidence?.checks.some((check) => check.decision === "blocked")) ||
      execution === "blocked" && Boolean(
        evidenceFresh && evidence && (
          evidence.integration.some((run) => !run.ok) ||
          evidence.review?.verdict === "FAIL" ||
          evidence.blocker?.startsWith("independent review")
        ),
      );
    const blockedTask = context.tasks.find((task) => task.status === "blocked");
    const blocker = assuranceEvidence?.units.find((unit) => unit.status === "unknown")?.reason ??
      staleGovernedBlocker ??
      assuranceEvidence?.checks.find((check) => check.decision === "blocked")?.reason ??
      (execution === "stale"
        ? "workflow evidence is stale"
        : null) ??
        (evidenceFresh && evidence?.blocker
          ? evidence.blocker
          : evidenceFresh && evidence?.status === "complete" && assurance?.blocker
            ? assurance.blocker
            : null) ??
        (acceptance.failed.length > 0
          ? `acceptance failed: ${acceptance.failed.join(", ")}`
          : execution === "complete" && acceptance.pending.length > 0
            ? `acceptance evidence pending: ${acceptance.pending.join(", ")}`
            : assurance?.mode === "information-flow" && assurance.informationFlow !== "enforced"
              ? "information-flow execution has not produced governed HTTP evidence"
              : null);
    return {
      stage: ready ? "ship" : "execute",
      planApproval,
      ...(assurance ? { assurance } : {}),
      execution,
      acceptance,
      blocker,
      next: ready
        ? "legion-cli ship"
        : assuranceEvidence?.units.some((unit) => unit.status === "unknown")
          ? "legion-cli plan impact"
        : staleGovernedTask
          ? `legion-cli undo --task ${staleGovernedTask.id}`
        : execution === "complete" && acceptance.failed.length > 0
          ? `legion-cli plan acceptance --pass ${acceptance.failed[0]}`
        : execution === "complete" && acceptance.pending.length > 0
          ? `legion-cli plan acceptance --pass ${acceptance.pending[0]}`
        : retryableExecutionFailure
          ? "legion-cli execute --retry"
          : blockedTask
            ? `legion-cli task amend ${blockedTask.id}`
            : evidenceFresh && evidence?.status === "complete" && assurance?.traceStatus !== "valid"
              ? "legion-cli plan evidence"
              : "legion-cli execute",
    };
  }

  async getPendingGovernedActions(): Promise<PendingGovernedAction[]> {
    return this.#read(async () => {
      const current = await this.#requireCurrentPlanApproval().catch(() => null);
      if (current?.assurance.manifest?.security.mode !== "information-flow" || !current.assurance.approval) return [];
      const actions: PendingGovernedAction[] = [];
      const resumes = await listCacheResumes(this.projectRoot);
      const summarize = (labels: readonly { confidentiality: "public" | "workspace" | "sealed"; integrity: "approved" | "untrusted" }[], unavailable = false) => {
        if (unavailable || labels.length === 0) return { confidentiality: "sealed" as const, integrity: "untrusted" as const };
        const rank = { public: 0, workspace: 1, sealed: 2 } as const;
        const confidentiality = labels.reduce(
          (highest, label) => rank[label.confidentiality] > rank[highest] ? label.confidentiality : highest,
          "public" as "public" | "workspace" | "sealed",
        );
        return {
          confidentiality,
          integrity: labels.every((label) => label.integrity === "approved") ? "approved" as const : "untrusted" as const,
        };
      };
      for (const resume of resumes) {
        if (resume.schemaVersion !== SCHEMA_VERSION.resume || resume.adapterId !== "http" || !resume.taskId) continue;
        const state = await inspectGovernedRun({ store: this.store, runId: resume.runId }).catch(() => null);
        if (!state || state.checkpoint.phase !== "program") continue;
        const checkpoint = state.checkpoint;
        let task: Task;
        try {
          task = (await this.store.readTask(resume.taskId)).data;
        } catch {
          continue;
        }
        let governed;
        try {
          // "default" in the run identity is the no-profile sentinel unless a profile is literally named "default".
          const recordedProfile = checkpoint.identities.provider.profile;
          governed = await this.#governedExecuteSpawnOptions(task, current.config, {
            profile: recordedProfile === "default" && !current.config.adapter.profiles?.[recordedProfile] ? undefined : recordedProfile,
          });
          if (!governed) continue;
          const context = await governed.resolveCurrentContext({
            runId: checkpoint.runId,
            sourceFingerprint: checkpoint.identities.sourceFingerprint,
            jailFingerprint: checkpoint.identities.jailFingerprint,
            jailRoot: "",
            allowedWrites: [...task.contract.filesAllowed],
            filesForbidden: [...task.contract.filesForbidden],
            artifactPaths: [...task.contract.expectedArtifacts],
          });
          if (stableHash(context.identities) !== stableHash(checkpoint.identities)) continue;
          const controlLabel = context.plannerInput.label;
          for (const call of checkpoint.providerCalls) {
            if (call.state !== "awaiting-approval") continue;
            const classification = summarize([controlLabel, call.label]);
            actions.push({
              runId: checkpoint.runId,
              actionId: call.actionId,
              actionKind: "provider",
              valueDigest: call.valueDigest,
              sinkId: call.sinkId,
              requestDigest: call.requestDigest,
              ...classification,
              target: "configured provider",
            });
          }
          for (const effect of checkpoint.effects) {
            if (effect.state !== "awaiting-approval") continue;
            const operation = checkpoint.program.operations.find((candidate) => candidate.id === effect.operationId);
            let inputLabels: Array<{ confidentiality: "public" | "workspace" | "sealed"; integrity: "approved" | "untrusted" }> = [];
            let unavailable = false;
            if (effect.kind === "write" && operation?.kind === "write") {
              const value = checkpoint.values.find((candidate) => candidate.id === operation.value);
              if (value) inputLabels = [value.label];
              else unavailable = true;
            } else if (effect.kind === "external-call" && operation?.kind === "external-call") {
              for (const input of operation.data) {
                const value = checkpoint.values.find((candidate) => candidate.id === input.value);
                if (!value) unavailable = true;
                else inputLabels.push(value.label);
              }
            } else {
              unavailable = true;
            }
            const classification = summarize([controlLabel, ...inputLabels], unavailable);
            const grant = effect.kind === "external-call" && operation?.kind === "external-call"
              ? current.assurance.manifest.security.externalCalls.find((candidate) => candidate.id === operation.grantId)
              : undefined;
            actions.push({
              runId: checkpoint.runId,
              actionId: effect.actionId,
              actionKind: effect.kind === "write" ? "write" : "http-mcp",
              valueDigest: effect.valueDigest,
              sinkId: effect.sinkId,
              requestDigest: effect.requestDigest,
              ...classification,
              target: effect.kind === "write" && operation?.kind === "write"
                ? operation.path
                : grant
                  ? `${grant.id}/${grant.tool}`
                  : "approved external call",
            });
          }
        } catch {
          continue;
        }
      }
      return actions.sort((left, right) =>
        left.runId.localeCompare(right.runId) || left.actionId.localeCompare(right.actionId),
      );
    });
  }

  /** Read-only governance epoch and trace inspection: never reconciles a head or writes any file. */
  async inspectGovernance(): Promise<GovernanceInspection> {
    const identity = await this.#governanceEpochIdentity(await loadAssurance(this.store));
    let anchor: GovernanceEpochs | null;
    try {
      anchor = await readGovernanceEpochs(this.store);
    } catch (error) {
      if (!(error instanceof GovernanceEpochError)) throw error;
      return { current: { ...identity, status: "invalid" }, epochs: [] };
    }
    if (!anchor) return { current: { ...identity, status: identity.adopted ? "invalid" : "not-adopted" }, epochs: [] };
    const modelDigest = anchor.epochs.some((epoch) => epoch.adopted)
      ? await this.#governanceModelDigest(await this.#readConfig())
      : null;
    const epochs: GovernanceInspection["epochs"] = [];
    for (const epoch of anchor.epochs) {
      const base = { sequence: epoch.sequence, approvalId: epoch.approvalId, adopted: epoch.adopted, recordedAt: epoch.recordedAt };
      if (!epoch.adopted || !epoch.approvalId || !modelDigest) {
        epochs.push({
          ...base, status: epoch.adopted ? "invalid" : "not-adopted",
          frames: 0, headDigest: null, lastAction: null, lastOutcome: null, violations: [],
        });
        continue;
      }
      const { trace, violations } = await inspectGovernanceTrace(this.store, epoch.approvalId, modelDigest);
      const last = trace.frames.at(-1);
      const blocked = trace.frames.some((frame) => frame.boundary === "end" && governanceOutcomeBlocks(frame.outcome));
      epochs.push({
        ...base,
        status: trace.status === "valid" && blocked ? "invalid" : trace.status,
        frames: trace.frames.length,
        headDigest: trace.status === "not-adopted" ? null : trace.headDigest,
        lastAction: last?.action ?? null,
        lastOutcome: last?.outcome ?? null,
        violations,
      });
    }
    const latest = epochs.at(-1)!;
    const interrupted = latest.approvalId !== identity.approvalId || latest.adopted !== identity.adopted;
    return { current: { ...identity, status: interrupted ? "interrupted-epoch" : latest.status }, epochs };
  }

  async recordAcceptance(
    entries: AcceptanceEvidenceInput[],
    actor: Actor = { id: "user" },
  ): Promise<AcceptanceReceipt> {
    return this.#mutate(async () => this.#governanceMutation("acceptance-record", async () => {
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
      if (context.assurance.manifest) {
        const assuranceEvidence = await inspectAssuranceEvidence(this.store, context.assurance, context.spec.acceptance.map((criterion) => criterion.id), await this.#componentPolicyPosture(context.assurance, context.tasks));
        const failed = assuranceEvidence.criteria.find((criterion) => criterion.status === "failed");
        const unknown = assuranceEvidence.units.find((unit) => unit.status === "unknown");
        if (failed || unknown || assuranceEvidence.checks.some((check) => check.result !== "passed") || assuranceEvidence.blocker !== ASSURANCE_TRACE_PREREQUISITE) {
          refuse(unknown?.reason ?? (failed ? `component evidence failed: ${failed.acceptanceId}` : "current passed component evidence is required before acceptance"), "legion-cli execute");
        }
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
    }));
  }

  async approveAction(options: GovernedActionApprovalOptions) {
    const state = await inspectGovernedRun({ store: this.store, runId: options.runId });
    if (!state) refuse(`governed run ${options.runId} was not found`, HINT.status);
    const resumePath = join(this.projectRoot, ".legion-cli", "cache", "runs", options.runId, "resume.json");
    let resume: ResumeFile;
    try {
      const parsed = ResumeFileSchema.safeParse(JSON.parse(await readFile(resumePath, "utf8")));
      if (!parsed.success || parsed.data.schemaVersion !== SCHEMA_VERSION.resume ||
          parsed.data.skillId !== "execute" || !parsed.data.taskId) {
        refuse(`governed run ${options.runId} has no compatible execute identity`, HINT.status);
      }
      resume = parsed.data;
    } catch (err) {
      if (err instanceof LegionRefuseError) throw err;
      refuse(`governed run ${options.runId} has no compatible execute identity`, HINT.status);
    }
    const task = (await this.store.readTask(resume.taskId!)).data;
    const current = await this.#requireCurrentPlanApproval();
    // "default" in the run identity is the no-profile sentinel unless a profile is literally named "default".
    const recordedProfile = state.checkpoint.identities.provider.profile;
    const governed = await this.#governedExecuteSpawnOptions(task, current.config, {
      profile: recordedProfile === "default" && !current.config.adapter.profiles?.[recordedProfile] ? undefined : recordedProfile,
    });
    if (!governed) refuse("information-flow authority is no longer approved", "legion-cli plan approve");
    const identity = state.checkpoint.identities;
    return approveGovernedAction({
      store: this.store,
      withLock: (callback) => this.#withLockOrRefuse(callback, { ownRunId: options.runId }),
      resolveCurrentContext: () => governed.resolveCurrentContext({
        runId: options.runId,
        sourceFingerprint: identity.sourceFingerprint,
        jailFingerprint: identity.jailFingerprint,
        jailRoot: "",
        allowedWrites: [...task.contract.filesAllowed],
        filesForbidden: [...task.contract.filesForbidden],
        artifactPaths: [...task.contract.expectedArtifacts],
      }),
      ...options,
    });
  }

  async executeWorkflow(opts: ExecuteWorkflowOptions = {}): Promise<WorkflowExecutionResult> {
    if (opts.resume && (opts.taskId || opts.step || opts.retry || opts.untilBlocked ||
        opts.jobs !== undefined || opts.fix || opts.adapter || opts.profile)) {
      refuse("execute --resume cannot be combined with a task, --step, --retry, --until-blocked, --jobs, --fix, --adapter, or --profile", HINT.execute);
    }
    if (opts.jobs !== undefined) {
      if (!Number.isInteger(opts.jobs) || opts.jobs < 1 || opts.jobs > 4) {
        refuse("execute jobs must be an integer from 1 to 4", HINT.execute);
      }
      if (!opts.untilBlocked || opts.taskId || opts.step) {
        refuse("execute --jobs requires --until-blocked without a task or --step", HINT.execute);
      }
    }
    let claim: WorkflowClaim;
    try {
      claim = await this.#withLockOrRefuse(async () => {
        const config = await this.#readConfig();
        if (config.control_mode === "advisory") {
          refuse("Execute is off in advisory mode", HINT.advisory);
        }
        return this.#governanceMutation("claim-acquire", () => acquireWorkflowClaim(this.store));
      });
    } catch (err) {
      if (err instanceof LegionRefuseError) throw err;
      refuse(err instanceof Error ? err.message : String(err), "legion-cli status");
    }
    try {
      return await this.#executeWorkflowClaimed(opts);
    } finally {
      await this.#mutate(() => this.#governanceMutation("claim-release", () => releaseWorkflowClaim(this.store, claim.token)));
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
    let assuranceStage: WorkflowExecutionResult["assurance"];

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
      ...(assuranceStage ? { assurance: assuranceStage } : {}),
    });
    const save = async (
      status: WorkflowEvidenceReceipt["status"],
      blocker: string | null,
      integration: WorkflowEvidenceReceipt["integration"],
      review: WorkflowEvidenceReceipt["review"],
      boundProductFingerprint?: string,
      action: GovernanceAction = "integration-complete",
    ): Promise<WorkflowEvidenceReceipt> => {
      return this.#withLockOrRefuse(() => this.#governanceMutation(action, async () => {
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
      }, { explicitRetry: action === "integration-start" && opts.retry === true }));
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
      if (blocked && !(first && opts.resume)) {
        const blocker = `task ${blocked.id} is blocked`;
        await save("blocked", blocker, evidenceFresh ? evidence?.integration ?? [] : [], null, undefined, "task-block");
        return result("blocked", blocker, `legion-cli task amend ${blocked.id}`, blocked.id);
      }
      const open = context.tasks.filter((task) => task.status !== "done" && task.status !== "compacted");
      if (open.length === 0 && !(first && opts.resume)) break;

      const target = first && opts.taskId ? opts.taskId : "auto";
      let executed: ExecuteResult;
      try {
        const resume = first ? opts.resume : undefined;
        executed = await this.execute(target, {
          adapter: opts.adapter,
          profile: opts.profile,
          fix: opts.fix,
          allowNoSandbox: opts.allowNoSandbox,
          resume,
          ...(target === "auto" && !opts.step && !resume
            ? { untilBlocked: true, jobs: opts.jobs }
            : {}),
          onProgress: opts.onProgress,
        });
      } catch (err) {
        const blocker = err instanceof Error ? err.message : String(err);
        const next = err instanceof LegionRefuseError ? err.nextHint : "legion-cli plan approve";
        try {
          await save("blocked", blocker, [], null, undefined, "task-block");
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
        const blockedTask = executed.tasks.find((task) => task.status === "blocked") ?? executed.tasks.at(-1);
        const blockedTaskId = blockedTask?.taskId ?? executed.taskId;
        const blocker = blockedTask?.incident
          ? "inspect .git — execute touched protected repository metadata"
          : blockedTask?.reason ?? `task ${blockedTaskId} is blocked`;
        try {
          await save("blocked", blocker, [], null, undefined, "task-block");
        } catch (err) {
          if (!(err instanceof LegionRefuseError)) throw err;
          return result("blocked", blocker, err.nextHint, blockedTaskId);
        }
        return result("blocked", blocker, blockedTask?.incident ? "legion-cli status" : `legion-cli task amend ${blockedTaskId}`, blockedTaskId);
      }
      if (opts.step) {
        await save("running", null, [], null, undefined, "task-complete");
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
      await save("running", null, integration, null, beforeCheck, "integration-start");
      const runResults = await runVerificationCommands(this.projectRoot, [command], {
        runId: `workflow-${Date.now()}-${index + 1}-${randomUUID().slice(0, 8)}`,
        secretEnvNames: configuredApiKeyEnvNames(context.config),
        sandbox: context.config.sandbox,
        allowNoSandbox: opts.allowNoSandbox,
        ...(context.assurance.manifest?.security.mode === "information-flow" && context.assurance.approval
          ? { informationFlow: buildVerificationInformationFlow(context.assurance.manifest, context.assurance.approval) }
          : {}),
      }).catch(async (error: unknown) => {
        await save("blocked", "workflow verification command could not complete", integration, null, beforeCheck, "integration-complete");
        throw error;
      });
      const run = runResults[0];
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
      await save("running", null, integration, null, beforeCheck, "integration-complete");
    }

    if (context.assurance.manifest && context.assurance.approval) {
      try {
        const componentStage = await runAssuranceChecks({
          store: this.store, plan: context.assurance.manifest, approval: context.assurance.approval,
          productFingerprint: verificationBaseline, environmentFingerprint, retry: Boolean(opts.retry),
          informationFlowPosture: await this.#componentPolicyPosture(context.assurance, context.tasks),
          observeProduct: () => workflowProductFingerprint(this.projectRoot, context.tasks),
          persist: (receipt, execution) => this.#withLockOrRefuse(() => this.#governanceMutation("task-verify", async () => {
            const current = await this.#requireCurrentPlanApproval();
            if (current.approval.approvalId !== receipt.approvalId) refuse("approval epoch changed during component evidence", "legion-cli plan approve");
            if (receipt.result === "passed" && await workflowProductFingerprint(this.projectRoot, current.tasks) !== verificationBaseline) {
              refuse("product inputs changed before component evidence persistence", "legion-cli execute");
            }
            await writeAssuranceCheck(this.store, receipt, execution);
          }, { explicitRetry: opts.retry === true })),
        });
        assuranceStage = { checks: componentStage.decisions, traceStatus: componentStage.execution.traceStatus, policyStatus: componentStage.execution.policyStatus };
        await this.#withLockOrRefuse(() => this.#governanceMutation("task-verify", async () => {
          const current = await this.#requireCurrentPlanApproval();
          if (current.approval.approvalId !== componentStage.execution.approvalId) refuse("approval epoch changed during component evidence", "legion-cli plan approve");
          await this.store.writeYaml(ASSURANCE_EXECUTION_PATH, componentStage.execution);
        }, { explicitRetry: opts.retry === true }));
        if (componentStage.blocker) {
          await save("blocked", componentStage.blocker, integration, null, verificationBaseline, "task-verify");
          return result("blocked", componentStage.blocker, componentStage.raced ? "legion-cli execute" : "legion-cli execute --retry", lastTaskId);
        }
      } catch (error) {
        if (context.assurance.approval) throw error;
        const blocker = `component evidence blocked: ${error instanceof Error ? error.message : String(error)}`;
        await save("blocked", blocker, integration, null, verificationBaseline, "task-verify");
        return result("blocked", blocker, "legion-cli execute", lastTaskId);
      }
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
        const reviewed = await this.#runReview({ adapter: opts.adapter, profile: opts.profile }, opts.retry === true);
        const afterReview = await workflowProductFingerprint(this.projectRoot, context.tasks);
        if (afterReview !== verificationBaseline) {
          const blocker = "independent review changed product inputs";
          await save("blocked", blocker, integration, null, beforeReview, "review-complete");
          return result("blocked", blocker, "legion-cli status", lastTaskId);
        }
        if (reviewed.verdict !== "PASS") {
          const blocker = "independent review failed and filed follow-up work";
          const failedReviewEvidence = reviewed.evidenceBody
            ? await this.#withLockOrRefuse(() => this.#governanceMutation("review-complete", () =>
              writeWorkflowReviewReport(this.store, reviewed.evidenceBody!)))
            : null;
          await save("blocked", blocker, integration, failedReviewEvidence, beforeReview, "review-complete");
          return result("blocked", blocker, "legion-cli execute --retry", lastTaskId);
        }
        if (reviewed.explicitVerdict !== "PASS" || !reviewed.evidenceBody) {
          const blocker = `independent review requires a fresh explicit Verdict: PASS in ${WORKFLOW_REVIEW_PATH}`;
          await save("blocked", blocker, integration, null, undefined, "review-complete");
          return result("blocked", blocker, "legion-cli review", lastTaskId);
        }
        reviewEvidence = await this.#withLockOrRefuse(() => this.#governanceMutation("review-complete", () =>
          writeWorkflowReviewReport(this.store, reviewed.evidenceBody!)));
      } catch (err) {
        if (context.assurance.approval) throw err;
        const blocker = `independent review failed: ${err instanceof Error ? err.message : String(err)}`;
        try {
          await save("blocked", blocker, integration, null);
        } catch {
          // Review-created tasks make the prior approval stale by design.
        }
        return result("blocked", blocker, "legion-cli plan approve", lastTaskId);
      }
    }

    await save("complete", null, integration, reviewEvidence, completionProductFingerprint, "review-complete");
    if (context.assurance.manifest) {
      const currentProduct = await workflowProductFingerprint(this.projectRoot, context.tasks);
      if (currentProduct !== completionProductFingerprint) return result("blocked", "product inputs changed at assurance completion", "legion-cli execute", lastTaskId);
    }
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
    return this.#mutate(async () => this.#governanceMutation("amend-inputs", async () => {
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
      if (opts?.clearProfile && opts.profile) {
        refuse("clearProfile and profile are mutually exclusive", HINT.amend);
      }
      if (opts?.adapter && opts?.profile) {
        refuse("adapter and profile are mutually exclusive", HINT.amend);
      }
      const adapter = opts?.profile
        ? undefined
        : opts?.clearAdapter
          ? undefined
          : (opts?.adapter ?? doc.data.adapter);
      const profile = opts?.adapter
        ? undefined
        : opts?.clearProfile
          ? undefined
          : (opts?.profile ?? doc.data.profile);
      const nextTask: Task = {
        ...doc.data,
        adapter,
        profile,
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
    }));
  }

  async execute(taskId: string | "auto" = "auto", opts?: ExecuteOptions): Promise<ExecuteResult> {
    if (opts?.resume) {
      if (taskId !== "auto" || opts.untilBlocked || opts.jobs !== undefined || opts.fix || opts.adapter || opts.profile) {
        refuse("execute --resume cannot be combined with a task, --until-blocked, --jobs, --fix, --adapter, or --profile", HINT.execute);
      }
      const resume = (await listCacheResumes(this.projectRoot)).find((item) => item.runId === opts.resume);
      if (!resume?.taskId) refuse(`unknown execute resume run ${opts.resume}`, HINT.status);
      const outcome = await this.#executeOne(resume.taskId, {
        fix: false,
        allowNoSandbox: Boolean(opts.allowNoSandbox),
        resumeRunId: opts.resume,
        onProgress: opts.onProgress,
      });
      const state = await this.#readState();
      return {
        taskId: outcome.result.taskId,
        phase: state.phase,
        status: outcome.result.status,
        tasks: [outcome.result],
        warnings: outcome.result.headMoved ? [HEAD_MOVED_WARNING] : [],
      };
    }
    if (opts?.jobs !== undefined && (!Number.isInteger(opts.jobs) || opts.jobs < 1 || opts.jobs > 4)) {
      refuse("execute jobs must be an integer from 1 to 4", HINT.execute);
    }
    if (taskId === "auto" && opts?.untilBlocked) {
      const configured = await this.#withLockOrRefuse(() => this.#readConfig());
      const workers = opts.jobs ?? configured.execution.maxWorkers;
      if (workers > 1) {
        const outcomes: ExecuteTaskResult[] = [];
        const warnings: string[] = [];
        while (true) {
          const batch = await this.#executeParallelBatch(workers, configured, opts);
          if (batch.length === 0) {
            if (outcomes.length === 0) refuse("no ready task in the active spec slice", HINT.blockers);
            break;
          }
          outcomes.push(...batch);
          for (const outcome of batch) {
            if (outcome.headMoved && !warnings.includes(HEAD_MOVED_WARNING)) warnings.push(HEAD_MOVED_WARNING);
          }
          if (batch.some((outcome) => outcome.status === "blocked" || outcome.incident)) break;
        }
        const state = await this.#readState();
        const last = outcomes.at(-1);
        return {
          taskId: last?.taskId ?? "",
          phase: state.phase,
          status: outcomes.some((outcome) => outcome.status === "blocked") ? "blocked" : (last?.status ?? "blocked"),
          tasks: outcomes,
          warnings,
        };
      }
    }
    const outcomes: ExecuteTaskResult[] = [];
    const warnings: string[] = [];
    let nextId: string | "auto" = taskId;
    let config: LegionConfig | undefined;
    while (true) {
      const outcome = await this.#executeOne(nextId, {
        fix: Boolean(opts?.fix),
        adapter: opts?.adapter,
        profile: opts?.profile,
        allowNoSandbox: Boolean(opts?.allowNoSandbox),
        config,
        onProgress: opts?.onProgress,
      });
      config = outcome.config;
      outcomes.push(outcome.result);
      if (outcome.result.headMoved && !warnings.includes(HEAD_MOVED_WARNING)) {
        warnings.push(HEAD_MOVED_WARNING);
      }
      if (outcome.result.dirtyWarning) warnings.push(outcome.result.dirtyWarning);
      if (outcome.result.agentExitWarning) warnings.push(outcome.result.agentExitWarning);
      if (outcome.result.status === "blocked" || outcome.result.incident) break;
      if (taskId !== "auto") break;
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

  async #executeParallelBatch(
    maxWorkers: number,
    configured: LegionConfig,
    opts: ExecuteOptions,
  ): Promise<ExecuteTaskResult[]> {
    const batchStartedAt = Date.now();
    const progress = (taskId: string, stage: ExecuteProgress["stage"], runId?: string): void => {
      opts.onProgress?.({
        taskId,
        stage,
        elapsedMs: Date.now() - batchStartedAt,
        ...(runId ? { logPath: `.legion-cli/cache/runs/${runId}/stdout.log` } : {}),
      });
    };

    type ParallelMember = {
      task: Task;
      started: Extract<StartedSkillSpawn, { spawned: true }>;
    };
    const startedMembers: ParallelMember[] = [];
    const abortsByRun = new Map<string, Promise<PromiseSettledResult<void>>>();
    let interrupted = false;
    let resolveInterrupted!: () => void;
    const interruptedSignal = new Promise<void>((resolve) => {
      resolveInterrupted = resolve;
    });
    const abortMember = (member: ParallelMember): Promise<PromiseSettledResult<void>> => {
      const existing = abortsByRun.get(member.started.runId);
      if (existing) return existing;
      const pending = settleWithin(member.started.handle.abort(), 5_000);
      abortsByRun.set(member.started.runId, pending);
      return pending;
    };
    const interrupt = (): void => {
      if (interrupted) return;
      interrupted = true;
      for (const member of startedMembers) void abortMember(member);
      resolveInterrupted();
    };
    const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    const removeInterruptHandlers = (): void => {
      for (const signal of signals) process.off(signal, interrupt);
    };
    for (const signal of signals) process.on(signal, interrupt);
    const persistInterruptedMembers = async (members: readonly ParallelMember[], reason: string): Promise<void> => {
      const abortResults = await Promise.all(members.map((member) => abortMember(member)));
      await Promise.allSettled(
        members.map((member, index) => {
          const childStillLive = Boolean(
            member.started.handle.pid &&
            member.started.handle.pid !== process.pid &&
            isPidAlive(member.started.handle.pid),
          );
          const uncertain = abortResults[index]?.status === "rejected" || childStillLive;
          return updateResumeStage(this.projectRoot, member.started.runId, "interrupted", {
            ...(!uncertain ? { pid: null, pidStartedAt: null } : {}),
            engineOwnershipReleasedAt: new Date().toISOString(),
            childTerminationUncertain: uncertain,
            interruptionReason: uncertain ? `${reason}; child termination is unconfirmed` : reason,
            recoveryCommand: `legion-cli task amend ${member.task.id} --unblock`,
          });
        }),
      );
      await Promise.allSettled(members.map(async (member, index) => {
        await clearLiveSpawnMarker(this.projectRoot, member.started.runId);
        const childStillLive = Boolean(
          member.started.handle.pid &&
          member.started.handle.pid !== process.pid &&
          isPidAlive(member.started.handle.pid),
        );
        if (abortResults[index]?.status !== "rejected" && !childStillLive) {
          await clearLiveRun(this.projectRoot, member.started.runId);
        }
      }));
      await Promise.all(members.map((member) => cleanupStartedSpawnResources(member.started)));
    };

    let setup: ParallelMember[] | null;
    try {
      setup = await this.#withLockOrRefuse(async () => {
      await this.#assertNoLiveInProgress("execute");
      if (configured.workflow?.profile === "focused") {
        configured = (await this.#requireCurrentPlanApproval()).config;
      }
      const state = await this.#readState();
      if (state.phase === "plan_failed") refuse("Plan failed. Fix the FAIL list before executing", HINT.planRetry);
      if (state.phase !== "plan_ready" && state.phase !== "executing") {
        refuse("Execute needs plan_ready or executing", HINT.plan);
      }
      if (configured.control_mode === "advisory") refuse("Execute is off in advisory mode", HINT.advisory);
      const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
      const ready = readyTasks({
        phase: state.phase,
        controlMode: configured.control_mode,
        tasks: slice,
        assumptions: await this.#listAssumptions(),
      });
      const tasks = selectParallelTasks(ready, maxWorkers);
      if (tasks.length === 0) return null;

      try {
        assertExecuteSandbox(configured, { allowNoSandbox: opts.allowNoSandbox });
      } catch (err) {
        if (err instanceof SandboxError) refuse(err.message, HINT.allowNoSandbox);
        throw err;
      }
      for (const task of tasks) {
        if (task.contract.filesAllowed.length === 0 || task.contract.verificationCommands.length === 0) {
          refuse(`task ${task.id} needs a file contract and verification commands`, HINT.plan);
        }
        await this.#assertSkillSpawnable(configured, "execute", {
          cliAdapter: opts.adapter,
          taskAdapter: task.adapter,
          cliProfile: opts.profile,
          taskProfile: task.profile,
        });
        progress(task.id, "starting");
      }
      await this.#governanceMutation("task-start", async () => {
        for (const task of tasks) await this.#transitionTaskTo(task.id, "in_progress");
        await this.#writeState({
          ...state,
          phase: "executing",
          currentTaskId: tasks[0]?.id ?? null,
          activeTaskIds: tasks.map((task) => task.id),
        });
      });

      const attempts = await Promise.allSettled(
        tasks.map(async (task, index) => {
          if (this.#fakeBeforeParallelStart) {
            await this.#fakeBeforeParallelStart(task.id, index);
          }
          if (interrupted) throw new Error("parallel execution interrupted before child start");
          const promptBody = [
            `Task: ${task.id} ${task.title}`,
            `Priority: ${task.priority}`,
            opts.fix ? "This is a fix run. Keep the reproducing test. Do not delete tests." : "",
            `Read .legion-cli/specs/${task.specId}/SPEC.md.`,
            "Write only the files listed in FileContract. Do not git add or git commit.",
            "Link tests to SPEC criteria with @ac(AC-ID), and copy AC.priority as @p0/@p1/@p2.",
          ].filter(Boolean).join("\n");
          const governed = await this.#governedExecuteSpawnOptions(task, configured, {
            adapter: opts.adapter,
            profile: opts.profile,
          });
          const started = await startSkillSpawn({
            ...this.#skillSpawnFields(),
            exitCode: this.#fakeExitCodeForTask?.(task.id) ?? this.#fakeExitCode,
            ...(this.#fakeResourceCleanupForTask
              ? { resourceCleanup: () => this.#fakeResourceCleanupForTask!(task.id) }
              : {}),
            config: configured,
            skillId: "execute",
            specId: task.specId,
            taskId: task.id,
            promptBody,
            fileContract: task.contract,
            extraAllowedRoots: [...task.contract.filesAllowed, ...task.contract.expectedArtifacts],
            filesForbidden: task.contract.filesForbidden,
            required: true,
            cliAdapter: opts.adapter,
            taskAdapter: task.adapter,
            cliProfile: opts.profile,
            taskProfile: task.profile,
            allowNoSandbox: opts.allowNoSandbox,
            ...(governed ? {
              governed: {
                ...governed,
                // Batch siblings run concurrently by design; a child's governed lock entry must not refuse on their
                // live markers. Children enter only after the setup lock releases, when every started member is known.
                withLock: <T>(runId: string, callback: () => Promise<T>) => this.#withLockOrRefuse(callback, {
                  ownRunId: runId,
                  ownRunIds: startedMembers.map((member) => member.started.runId),
                }),
              },
            } : {}),
          });
          if (!started.spawned || !started.sandbox) {
            if (started.spawned) await cleanupStartedSpawnResources(started);
            throw new Error(`parallel execute could not start an individual jail for ${task.id}`);
          }
          const member = { task, started };
          startedMembers.push(member);
          if (interrupted) void abortMember(member);
          return member;
        }),
      );
      const live = attempts
        .filter((attempt): attempt is PromiseFulfilledResult<ParallelMember> => attempt.status === "fulfilled")
        .map((attempt) => attempt.value);
      if (interrupted) {
        const liveTaskIds = new Set(live.map((member) => member.task.id));
        const unstarted = tasks.filter((task) => !liveTaskIds.has(task.id));
        const activeTaskIds = live.map((member) => member.task.id);
        await this.#governanceMutation("task-block", async () => {
          await persistInterruptedMembers(live, "parallel execution interrupted during batch startup");
          for (const task of unstarted) {
            const recoveryCommand = `legion-cli task amend ${task.id} --unblock`;
            await this.#transitionTaskTo(task.id, "blocked");
            progress(task.id, "blocked");
            await this.#audit("execute", "executing", "agent", {
              status: "blocked",
              reason: "parallel execution was interrupted before this child started",
              recoveryCommand,
            }, task.id);
          }
          await this.#writeState({
            ...(await this.#readState()),
            phase: "executing",
            currentTaskId: activeTaskIds[0] ?? unstarted[0]?.id ?? null,
            activeTaskIds,
          });
        });
        const guidance = unstarted.map((task) => `legion-cli task amend ${task.id} --unblock`).join("; ");
        throw new Error(
          `parallel execution interrupted during batch startup; child jails were preserved for recovery${guidance ? `; unblock unstarted tasks with: ${guidance}` : ""}`,
        );
      }
      const failed = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
      if (failed) {
        const startReason = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
        await this.#governanceMutation("task-block", async () => {
          await persistInterruptedMembers(live, "parallel batch start failed");
          for (const task of tasks) {
            await this.#transitionTaskTo(task.id, "blocked");
            progress(task.id, "blocked");
            await this.#audit("execute", "executing", "agent", {
              status: "blocked",
              reason: `parallel batch start failed: ${startReason}`,
            }, task.id);
          }
          await this.#writeState({
            ...(await this.#readState()),
            phase: "executing",
            currentTaskId: tasks[0]?.id ?? null,
            activeTaskIds: [],
          });
        });
        throw failed.reason;
      }
      return attempts.map((attempt) => (attempt as PromiseFulfilledResult<ParallelMember>).value);
      });
    } catch (err) {
      removeInterruptHandlers();
      throw err;
    }
    if (!setup) {
      removeInterruptHandlers();
      return [];
    }

    try {
    for (const member of setup) {
      progress(member.task.id, "running", member.started.runId);
      const degraded = Boolean(opts.allowNoSandbox) && !member.started.sandbox?.hardened;
      await this.#audit(degraded ? "sandbox_degraded" : "sandbox_start", "executing", "agent", {
        backend: member.started.sandbox?.backend,
        hardened: member.started.sandbox?.hardened,
        degraded,
      }, member.task.id);
    }
    const waitAll = Promise.all(setup.map((member) => waitStartedSpawn(member.started)));
    const waitOutcome = waitAll.then(
      (values) => ({ kind: "completed" as const, values }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    let outcome;
    try {
      outcome = await Promise.race([
        waitOutcome,
        interruptedSignal.then(() => ({ kind: "interrupted" as const })),
      ]);
    } finally {
      removeInterruptHandlers();
    }
    if (outcome.kind === "interrupted") {
      // Let waitStartedSpawn finish its own resume write when abort made it settle,
      // but never let an unresponsive child hold interruption recovery open.
      await settleWithin(waitOutcome, 250);
      await persistInterruptedMembers(setup, "parallel execution interrupted");
      throw new Error("parallel execution interrupted; child jails were preserved for recovery");
    }
    if (outcome.kind === "failed") {
      await persistInterruptedMembers(setup, "parallel execution wait failed");
      throw outcome.error;
    }
    const waited = outcome.values;
    setup.forEach((member) => progress(member.task.id, "agent-complete", member.started.runId));

    const prepared: PreparedSandboxSpawn[] = [];
    for (const member of setup) {
      progress(member.task.id, "integrating", member.started.runId);
      prepared.push(await prepareSandboxedSpawn(member.started));
    }

    type Integrated = {
      member: (typeof setup)[number];
      waited: (typeof waited)[number];
      prepared: PreparedSandboxSpawn;
      status: "verifying" | "blocked";
      extras: string[];
      incident: boolean;
      headMoved: boolean;
      reason?: string;
      ticketId?: string;
    };
    const ownRunIds = setup.map((member) => member.started.runId);
    const integrated = await this.#withLockOrRefuse(async (): Promise<Integrated[]> => {
      const baseRefs = new Set(prepared.map((item) => item.started.revertCtx.preSpawnRef ?? "UNBORN"));
      const expectedHead = prepared[0]?.started.revertCtx.preSpawnRef ?? "UNBORN";
      const headNow = tryGitHead(this.projectRoot) ?? "UNBORN";
      let batchHeadConflict = baseRefs.size !== 1 || headNow !== expectedHead;
      const out: Integrated[] = [];

      for (let index = 0; index < setup.length; index += 1) {
        const member = setup[index];
        const sealed = prepared[index];
        const wait = waited[index];
        if (!member || !sealed || !wait) continue;
        let extras = [...sealed.revert.extrasReverted];
        let incident = sealed.revert.incident;
        let headMoved = sealed.revert.headMoved || batchHeadConflict;
        let reason: string | undefined;
        let ticketId: string | undefined;
        let status: Integrated["status"] = "verifying";
        const exitProblem = agentExitProblem(wait);
        if (wait.error) reason = wait.error instanceof Error ? wait.error.message : String(wait.error);
        else if (exitProblem) reason = exitProblem;

        if (!reason && !batchHeadConflict) {
          if (this.#fakeBeforeParallelApply) {
            await this.#fakeBeforeParallelApply(member.task.id, index);
          }
          batchHeadConflict = (tryGitHead(this.projectRoot) ?? "UNBORN") !== expectedHead;
          headMoved ||= batchHeadConflict;
        }

        if (!reason && batchHeadConflict) reason = "integration refused because repository HEAD changed during the parallel batch";
        else if (!reason && (incident || extras.length > 0)) reason = "integration refused because the jail produced invalid or unsafe output";

        if (!reason) {
          const applied = await this.#governanceMutation("integration-start", async () => {
            const result = await applyPreparedSandboxSpawn(sealed, (paths) =>
              this.#recordGovernedAppliedFiles(member.started.runId, paths),
            );
            await this.#audit("sandbox_copyout", "executing", "agent", {
              backend: member.started.sandbox?.backend,
              hardened: member.started.sandbox?.hardened,
              copied: result.copied,
              dropped: result.dropped,
              conflicts: result.conflicts,
            }, member.task.id);
            return result;
          }).catch(async (error: unknown) => {
            await discardPreparedSandboxSpawn(sealed);
            throw error;
          });
          extras = [...new Set([...extras, ...applied.dropped])].sort();
          if (applied.conflicts.length > 0) {
            reason = `integration conflict: ${applied.conflicts.join(", ")}`;
          } else if (applied.dropped.length > 0) {
            reason = `integration dropped unsafe output: ${applied.dropped.join(", ")}`;
          }
          sealed.revert.sandboxCopied = applied.copied;
          sealed.revert.sandboxDropped = applied.dropped;
        } else {
          await discardPreparedSandboxSpawn(sealed);
        }

        const filed = await this.#governanceMutation("integration-complete", () =>
          this.#fileExtrasFromRun(member.started.runId, member.task.specId),
        );
        if (filed.invalid) {
          reason ??= "integration refused invalid extra.json evidence";
          ticketId = filed.ticketIds[0];
        }
        if (extras.length > 0 && !ticketId) {
          const filedScope = await this.#governanceMutation("integration-complete", () =>
            this.#fileTicketLocked({
              title: extras.length === 1 ? `FileContract extra: ${extras[0]}` : `FileContract extras: ${extras.join(", ")}`,
              parentId: member.task.id,
              fromAgent: true,
              type: "bug",
              notes: "type: scope. Parallel jail output was outside FileContract and was not applied.",
            }, member.task.specId),
          );
          ticketId = filedScope.task.id;
        }
        if (reason) {
          status = "blocked";
          await this.#governanceMutation("task-block", async () => {
            await this.#transitionTaskTo(member.task.id, "blocked");
            await updateResumeStage(this.projectRoot, member.started.runId, "blocked", {
              pid: null,
              pidStartedAt: null,
              engineOwnershipReleasedAt: new Date().toISOString(),
              childTerminationUncertain: false,
              interruptionReason: reason!,
              recoveryCommand: `legion-cli task amend ${member.task.id} --unblock`,
            });
            await clearLiveSpawnMarker(this.projectRoot, member.started.runId);
            await clearLiveRun(this.projectRoot, member.started.runId);
          });
          progress(member.task.id, "blocked", member.started.runId);
        } else {
          await this.#governanceMutation("task-verify", () => this.#transitionTaskTo(member.task.id, "verifying"));
        }
        out.push({ member, waited: wait, prepared: sealed, status, extras, incident, headMoved, reason, ticketId });
      }
      return out;
    }, { ownRunIds });

    const verification = new Map<string, { pass: boolean; reason?: string; trustTierNote?: string }>();
    const verificationProvenance = new Map<string, {
      approvalId: string;
      outputs: Array<{
        checkId: string;
        commandFingerprint: string;
        label: VerificationInformationFlow["label"];
        inventory: { path: string; beforeDigest: string | null; afterDigest: string };
      }>;
    }>();
    for (const item of integrated) {
      if (item.status !== "verifying") continue;
      progress(item.member.task.id, "verifying", item.member.started.runId);
      await updateResumeStage(this.projectRoot, item.member.started.runId, "verifying");
      let pass = false;
      let reason: string | undefined;
      let trustTierNote: string | undefined;
      try {
        if (this.#fakeOnVerify) await this.#fakeOnVerify();
        if (this.#fakeVerificationError) throw new Error(this.#fakeVerificationError);
        const loadedAssurance = await loadAssurance(this.store);
        const current = loadedAssurance.manifest?.security.mode === "information-flow"
          ? await this.#requireCurrentPlanApproval()
          : undefined;
        const assurancePlan = current?.assurance.manifest;
        const assuranceApproval = current?.assurance.approval;
        const flow = assurancePlan && assuranceApproval
          ? buildVerificationInformationFlow(assurancePlan, assuranceApproval, item.member.task)
          : undefined;
        const runs: Awaited<ReturnType<typeof runVerificationCommands>> = [];
        const outputs: Array<{
          checkId: string;
          commandFingerprint: string;
          label: VerificationInformationFlow["label"];
          inventory: { path: string; beforeDigest: string | null; afterDigest: string };
        }> = [];
        if (!flow) {
          runs.push(...await runVerificationCommands(this.projectRoot, item.member.task.contract.verificationCommands, {
            timeoutMs: this.#verificationTimeoutMs,
            runId: item.member.started.runId,
            secretEnvNames: configuredApiKeyEnvNames(configured),
            sandbox: configured.sandbox,
          }));
        } else {
          for (const [index, command] of item.member.task.contract.verificationCommands.entries()) {
            const before = await snapshotVerificationProduct(this.projectRoot);
            const commandRuns = await runVerificationCommands(this.projectRoot, [command], {
              timeoutMs: this.#verificationTimeoutMs,
              runId: `${item.member.started.runId}-verify-${index + 1}`,
              secretEnvNames: configuredApiKeyEnvNames(configured),
              sandbox: configured.sandbox,
              informationFlow: flow,
            });
            runs.push(...commandRuns);
            const after = await snapshotVerificationProduct(this.projectRoot);
            const changes = changedVerificationOutputs(before, after, item.member.task.contract.expectedArtifacts);
            const run = commandRuns[0];
            if (changes.length > 0 && (!run?.informationFlow || !assuranceApproval)) {
              throw new Error("verification outputs lack approved information-flow provenance");
            }
            if (run?.informationFlow && assuranceApproval) {
              const commandFingerprint = stableHash({ taskId: item.member.task.id, index, command });
              for (const inventory of changes) {
                outputs.push({
                  checkId: `verify-${commandFingerprint.slice(0, 32)}`,
                  commandFingerprint,
                  label: {
                    confidentiality: run.informationFlow.confidentiality,
                    integrity: run.informationFlow.integrity,
                    origins: [...run.informationFlow.origins],
                  },
                  inventory,
                });
              }
            }
          }
        }
        if (outputs.length > 0 && assuranceApproval) {
          verificationProvenance.set(item.member.task.id, { approvalId: assuranceApproval.approvalId, outputs });
        }
        pass = runs.length > 0 && runs.every((run) => run.ok);
        reason = verificationFailureReason(runs);
        trustTierNote = runs.find((run) => run.trustTierNote)?.trustTierNote;
      } catch (err) {
        reason = `verification failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      verification.set(item.member.task.id, { pass, reason, trustTierNote });
    }

    return await this.#withLockOrRefuse(async () => {
      const results: ExecuteTaskResult[] = [];
      for (const item of integrated) {
        const checked = verification.get(item.member.task.id);
        let status: ExecuteTaskResult["status"] = item.status === "blocked" ? "blocked" : checked?.pass ? "done" : "blocked";
        let reason = item.reason ?? checked?.reason;
        if (item.status === "verifying") {
          const provenance = verificationProvenance.get(item.member.task.id);
          if (status === "done" && provenance) {
            await this.#governanceMutation("task-verify", async () => {
              try {
                for (const output of provenance.outputs) {
                  await recordOpaqueVerificationOutputProvenance({
                    store: this.store,
                    withLock: (callback) => this.#withLockOrRefuse(callback, { ownRunId: item.member.started.runId }),
                    runId: item.member.started.runId,
                    approvalId: provenance.approvalId,
                    taskId: item.member.task.id,
                    checkId: output.checkId,
                    commandFingerprint: output.commandFingerprint,
                    label: output.label,
                    inventory: output.inventory,
                  });
                }
              } catch (err) {
                status = "blocked";
                reason = `verification output provenance failed: ${err instanceof Error ? err.message : String(err)}`;
              }
            });
          }
        }
        await this.#governanceMutation(status === "done" ? "task-complete" : "task-block", async () => {
          if (item.status === "verifying") {
            await this.#transitionTaskTo(item.member.task.id, status);
            await updateResumeStage(this.projectRoot, item.member.started.runId, status === "done" ? "completed" : "blocked", {
              pid: null,
              pidStartedAt: null,
              engineOwnershipReleasedAt: new Date().toISOString(),
              childTerminationUncertain: false,
              ...(reason ? { interruptionReason: reason } : {}),
              ...(status === "blocked" ? { recoveryCommand: `legion-cli task amend ${item.member.task.id} --unblock` } : {}),
            });
            await clearLiveSpawnMarker(this.projectRoot, item.member.started.runId);
            await clearLiveRun(this.projectRoot, item.member.started.runId);
          }
          progress(item.member.task.id, status, item.member.started.runId);
          const result: ExecuteTaskResult = {
            taskId: item.member.task.id,
            status,
            runId: item.member.started.runId,
            extrasReverted: item.extras,
            incident: item.incident,
            headMoved: item.headMoved,
            ...(item.ticketId ? { ticketId: item.ticketId } : {}),
            ...(item.status === "verifying" ? { verificationPass: Boolean(checked?.pass) && status === "done" } : {}),
            ...(reason ? { reason } : {}),
            ...(checked?.trustTierNote ? { trustTierNote: checked.trustTierNote } : {}),
            adapterId: item.member.started.resolution.id,
            resolutionSource: item.member.started.resolution.source,
            ...(item.member.started.resolution.profile ? { profile: item.member.started.resolution.profile } : {}),
            ...(item.waited.usage ? { usage: item.waited.usage } : {}),
            ...(item.waited.limitReason ? { limitReason: item.waited.limitReason } : {}),
          };
          await this.#audit("execute", "executing", "agent", {
            durationMs: item.waited.durationMs,
            timedOut: item.waited.timedOut,
            status,
            runId: item.member.started.runId,
            adapterId: result.adapterId,
            resolutionSource: result.resolutionSource,
            profile: result.profile,
            usage: result.usage,
            limitReason: result.limitReason,
            ...(reason ? { reason } : {}),
          }, item.member.task.id);
          if (item.waited.timedOut) {
            await this.#audit("timeout", "executing", "agent", {
              skillId: "execute",
              durationMs: item.waited.durationMs,
              adapterId: result.adapterId,
              resolutionSource: result.resolutionSource,
            }, item.member.task.id);
          }
          results.push(result);
        });
      }
      await this.#governanceMutation("task-complete", async () => {
        for (const specId of new Set(setup.map((member) => member.task.specId))) {
          await this.#promoteReadyTasks(specId, "executing", configured.control_mode);
        }
      });
      await this.#governanceMutation("integration-complete", async () => {
        const state = await this.#readState();
        await this.#writeState({
          ...state,
          phase: "executing",
          currentTaskId: results.find((result) => result.status === "blocked")?.taskId ?? results.at(-1)?.taskId ?? null,
          activeTaskIds: [],
        });
      });
      return results;
    }, { ownRunIds });
    } finally {
      await Promise.all(setup.map((member) => cleanupStartedSpawnResources(member.started)));
      // As in #relock: however the batch ended, its runs are over, so their markers must not make this
      // engine's next lock entry refuse its own finished workers (a still-alive agent keeps its marker).
      for (const member of setup) await this.#dropRunMarkerById(member.started.runId);
    }
  }

  async verify(taskId?: string, opts?: { adapter?: AdapterId; profile?: string }): Promise<VerifyResult> {
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

      const assurance = await loadAssurance(this.store);
      if (assurance.manifest?.security.mode === "information-flow") {
        refuse("optional verify is unavailable under information-flow assurance because it cannot receive governed context", HINT.doctor);
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
        exitCode: this.#fakeExitCode,
        omitSummary: this.#fakeOmitSummary,
        cliAdapter: opts?.adapter,
        cliProfile: opts?.profile,
        taskAdapter: task?.adapter,
        taskProfile: task?.profile,
      });
      const filedExtras = result.runId
        ? await this.#fileExtrasFromRun(result.runId, specId, {
            type: "fix",
            parentId: task?.id,
            agentSourceless: !task,
            inheritFrom: task
              ? {
                  id: task.id,
                  label: "verified task",
                  filesAllowed: task.contract.filesAllowed,
                  verificationCommands: task.contract.verificationCommands,
                }
              : undefined,
          })
        : undefined;
      const after = await this.snapshotTaskIds();
      const createdTaskIds = after.filter((id) => !before.includes(id));
      if (createdTaskIds.length > 0) {
        await this.#clampSpawnedTaskStatuses(createdTaskIds);
        await this.#promoteReadyTasks(specId, "executing", config.control_mode);
      }
      if (result.spawned && agentExitProblem(result)) {
        await this.#audit("verify", state.phase, "agent", {
          skillId: "verify",
          runId: result.runId,
          agentExitCode: result.exitCode ?? null,
        }, task?.id);
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
        createdTickets: filedExtras?.tickets ?? [],
        extrasReverted: result.revert?.extrasReverted ?? [],
        warnings: this.#verifyWarnings(result),
      };
    });
  }

  #verifyWarnings(result: OptionalSpawnResult): string[] {
    if (!result.spawned) {
      const via = result.resolution ? ` (${result.resolution.id}, via ${result.resolution.source})` : "";
      return [`verify skipped: no agent ran${via}; run \`legion-cli doctor\``];
    }
    const problem = agentExitProblem(result);
    return problem
      ? [`verify ${problem} (log: .legion-cli/cache/runs/${result.runId}/stderr.log); notes are optional`]
      : [];
  }

  async review(opts?: { adapter?: AdapterId; profile?: string }): Promise<ReviewResult> {
    // A direct review request is itself the operator's explicit request to (re)run independent review.
    return this.#runReview(opts, true);
  }

  /** `explicitRetry`: whether this round was explicitly requested, recorded on the review-start boundary. */
  async #runReview(opts: { adapter?: AdapterId; profile?: string } | undefined, explicitRetry: boolean): Promise<ReviewResult> {
    let specId: string | undefined;
    let config: LegionConfig | undefined;
    let before: string[] = [];
    let beforeFiles: TaskFileSnapshot | undefined;
    let started: StartedSkillSpawn | undefined;

    await this.#startLock(() => started, async () => {
      const state = await this.#readState();
      const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
      this.#assertCanReview(state, slice);
      specId = state.activeSpecId ?? undefined;
      if (!specId) {
        refuse("review requires an active spec", HINT.spec);
      }
      config = await this.#readConfig();
      await this.#assertSkillSpawnable(config, "review", { cliAdapter: opts?.adapter, cliProfile: opts?.profile });
      before = await this.snapshotTaskIds();
      beforeFiles = await snapshotTaskFiles(this.store.paths.tasksDir);
      // A notes file left by an earlier round must not satisfy this round's evidence check.
      await this.#governanceMutation("review-start", async () => {
        await rm(join(this.projectRoot, REVIEW_NOTES_PATH), { force: true });
        const governed = await this.#governedReviewSpawnOptions(config!, {
          adapter: opts?.adapter,
          profile: opts?.profile,
        });
        started = await startSkillSpawn({
          ...this.#skillSpawnFields(),
          config: config!,
          skillId: "review",
          specId: specId!,
          promptBody: [
            "Spec-level review of a terminal slice.",
            `Active spec: ${specId}`,
            `Read .legion-cli/specs/${specId}/SPEC.md and .legion-cli/tasks/*.md.`,
            "Write notes to .legion-cli/cache/runs/<id>/review.md (the engine keeps them at .legion-cli/qa/review.md).",
            "Include exactly one explicit `Verdict: PASS` or `Verdict: FAIL` line in that report.",
            "If the slice does not meet the spec, file tasks under .legion-cli/tasks/ (type: fix) or extra.json.",
            "Creating any new task id or rewriting existing TSK-*.md FAILs this review.",
            "PASS only if ids are unchanged and existing task files are byte-identical.",
            "Do not git add or git commit. Do not write packets.",
          ].join("\n"),
          required: true,
          cliAdapter: opts?.adapter,
          cliProfile: opts?.profile,
          ...(governed ? { governed } : {}),
        });
        this.#reviewProjection = started.spawned ? "running" : "unavailable";
      }, { explicitRetry });
    });

    const waited = started?.spawned ? await waitStartedSpawn(started) : { error: undefined, timedOut: false, durationMs: 0 };

    return this.#relock(started?.runId, async () => {
      const completedSpecId = specId;
      const completedConfig = config;
      if (!completedSpecId || !completedConfig) {
        refuse("review requires an active spec", HINT.spec);
      }
      const reviewSpecId = completedSpecId;
      const reviewConfig = completedConfig;
      return this.#governanceMutation("review-complete", async () => {
        try {
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
      const filedExtras = started?.runId
        ? await this.#fileExtrasFromRun(started.runId, reviewSpecId, { agentSourceless: true })
        : undefined;
      const after = await this.snapshotTaskIds();
      const createdTaskIds = after.filter((id) => !before.includes(id));
      if (createdTaskIds.length > 0) {
        await this.#clampSpawnedTaskStatuses(createdTaskIds);
        await this.#promoteReadyTasks(reviewSpecId, "executing", reviewConfig.control_mode);
      }
      // PASS needs positive evidence: exit 0 and non-empty notes written this run. The notes live in
      // the run cache because the engine restores everything the agent writes under .legion-cli/qa/.
      // A review that filed or rewrote tasks is a FAIL either way, so it needs no extra evidence.
      const notesRead = started?.spawned ? await readReviewNotes(this.projectRoot, started.runId) : { text: "" };
      const notes = notesRead.text;
      const reviewWarnings: string[] = [];
      let reviewError = waited.error;
      const wouldPass = createdTaskIds.length === 0 && rewrittenExistingTaskIds.length === 0;
      if (!reviewError && started?.spawned && wouldPass) {
        const log = `.legion-cli/cache/runs/${started.runId}/stderr.log`;
        const problem = agentExitProblem(waited);
        if (problem) {
          reviewError = new LegionRefuseError(
            `review failed: ${problem} (log: ${log}); no verdict recorded, re-run legion-cli review`,
            HINT.review,
          );
        } else if (notes.length === 0) {
          const why =
            notesRead.problem ??
            `agent wrote no notes to ${reviewRunNotesPath(started.runId)} (notes go in the run cache, not .legion-cli/qa/)`;
          reviewError = new LegionRefuseError(
            `review failed: ${why} (log: ${log}); no verdict recorded, re-run legion-cli review`,
            HINT.review,
          );
        }
      }
      if (started?.spawned && !wouldPass) {
        // A non-zero exit on a review that filed tasks stays a FAIL (recorded, blocks ship); say so.
        const problem = agentExitProblem(waited);
        if (problem) {
          reviewWarnings.push(
            `review ${problem} (log: .legion-cli/cache/runs/${started.runId}/stderr.log); the tasks it filed still make this a FAIL`,
          );
        }
      }
      await this.#refuseSpawnContract(
        "review",
        revert,
        reviewError,
        createdTaskIds,
        before,
        after,
        rewrittenExistingTaskIds,
      );
      if (notes.length > 0 && !notesRead.problem) {
        await mkdir(join(this.projectRoot, ".legion-cli", "qa"), { recursive: true });
        await writeTextFile(join(this.projectRoot, REVIEW_NOTES_PATH), `${notes}
`, { root: this.projectRoot });
      }
      const explicitReviewEvidence = notes.length > 0 && !notesRead.problem
        ? await readExplicitReviewEvidence(this.projectRoot)
        : null;
      const verdict = await this.#applyReviewSnapshotsLocked(
        await this.#readState(),
        before,
        after,
        rewrittenExistingTaskIds,
      );
      this.#reviewProjection = verdict === "PASS" ? "passed" : "failed";
      return {
        verdict,
        createdTaskIds,
        createdTickets: filedExtras?.tickets ?? [],
        extrasReverted: revert?.extrasReverted ?? [],
        rewrittenExistingTaskIds,
        ...(explicitReviewEvidence ? {
          explicitVerdict: explicitReviewEvidence.verdict,
          evidencePath: explicitReviewEvidence.evidencePath,
          evidenceFingerprint: explicitReviewEvidence.evidenceFingerprint,
          evidenceBody: explicitReviewEvidence.body,
        } : {}),
        warnings: reviewWarnings,
      };
        } catch (error) {
          this.#reviewProjection = "failed";
          throw error;
        }
      });
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
      const specDoc = await this.store.readSpec(specId);
      const spec = specDoc.data;
      const config = await this.#readConfig();
      const mode = opts.mode ?? config.qa.mode;
      let manualPassedCriterionIds: string[] | undefined;
      if (mode === "no-browser") {
        const receipt = await readChecklist(this.projectRoot);
        if (!checklistComplete(spec, receipt)) {
          refuse("no-browser qa requires legion-cli qa checklist", HINT.qaChecklist);
        }
        manualPassedCriterionIds = receipt?.ticks;
      }
      return {
        spec,
        config,
        mode,
        specHash: qaSpecHash(spec, specDoc.body),
        sourceHash: await qaSourceHash(this.projectRoot, slice),
        manualPassedCriterionIds,
      };
    });

    this.#lastQaWarnings = [];
    let score: QAScore;
    if (this.#fakeOnQa) await this.#fakeOnQa();
    if (opts.score) {
      if (!this.#fakeQaScoreInjection) {
        refuse("Injected QA scores are test-only; run configured QA reports", HINT.qa);
      }
      score = normalizeInjectedQaScore(
        QAScoreSchema.parse(opts.score),
        prepared.spec,
        prepared.specHash,
        prepared.sourceHash,
      );
    } else {
      const run = await runProjectQa({
        projectRoot: this.projectRoot,
        spec: prepared.spec,
        mode: prepared.mode,
        unitCommand: prepared.config.qa.unitCommand,
        secretEnvNames: configuredApiKeyEnvNames(prepared.config),
        specHash: prepared.specHash,
        sourceHash: prepared.sourceHash,
        manualPassedCriterionIds: prepared.manualPassedCriterionIds,
      });
      score = run.score;
      this.#lastQaWarnings = run.warnings;
    }

    return this.#withLockOrRefuse(async () => {
      const state = await this.#readState();
      const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
      this.#assertCanQa(state, slice);
      const activeSpecId = state.activeSpecId;
      if (!activeSpecId) refuse("qa requires an active spec", HINT.spec);
      const currentSpecDoc = await this.store.readSpec(activeSpecId);
      const currentSpecHash = qaSpecHash(currentSpecDoc.data, currentSpecDoc.body);
      const currentSourceHash = await qaSourceHash(this.projectRoot, slice);
      if (
        score.specId !== activeSpecId ||
        score.specHash !== currentSpecHash ||
        score.sourceHash !== currentSourceHash ||
        score.specHash !== prepared.specHash ||
        score.sourceHash !== prepared.sourceHash
      ) {
        refuse("QA evidence does not match the active spec and tested source; rerun QA", HINT.qa);
      }
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
        missingCriterionIds: score.missingCriterionIds,
        failedCriterionIds: score.failedCriterionIds,
        skippedCriterionIds: score.skippedCriterionIds,
        ...(this.#lastQaWarnings.length > 0 ? { warnings: this.#lastQaWarnings } : {}),
      });
      return score;
    });
  }

  async qaChecklist(ticks: string[], opts: { confirmSource?: "tty" | "piped" } = {}): Promise<void> {
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
      await this.#audit("qa_checklist", state.phase, "user", {
        specId,
        ticked: unique.length,
        confirmSource: opts.confirmSource ?? null,
      });
    });
  }

  /** Focused-profile amendment: records bounded bug work without writing or running a regression test. */
  async proposeFix(bug: string, opts: { adapter?: AdapterId; profile?: string } = {}): Promise<Task> {
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
      const config = await this.#readConfig();
      try {
        resolveAdapterId({ config, skillId: "execute", cliAdapter: opts.adapter, cliProfile: opts.profile });
      } catch (err) {
        refuse(err instanceof Error ? err.message : String(err), HINT.fix);
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
        adapter: opts.adapter,
        profile: opts.profile,
        contract: { filesAllowed, expectedArtifacts: [testPath], verificationCommands: [verifyCmd] },
      });
      const overlaps = overlappingFilesAllowed([probe, ...live]);
      if (overlaps.length > 0) refuse(`overlapping filesAllowed ${overlaps[0]}`, HINT.fix);
      await this.#failLastReviewLocked();
      return (await this.#fileTicketLocked({
        title,
        adapter: opts.adapter,
        profile: opts.profile,
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
    const initialAssurance = await loadAssurance(this.store);
    if ((Boolean(initialAssurance.manifest && initialAssurance.approval) || Boolean(opts.bundleDirectory)) && !opts.confirm) {
      refuse("delivery capture requires an explicit confirmation callback", HINT.ship);
    }

    let stagedPreview: ShipPreview | undefined;
    let governanceAdopted = false;
    let deliveryId: string | null = null;
    let preview: ShipPreview;
    try {
      preview = await this.#mutate(async () => this.#governanceMutation("ship-prepare", async () => {
        await healAuditChain(this.projectRoot);
        const state = await this.#readState();
        const adopted = await loadAssurance(this.store);
        governanceAdopted = Boolean(adopted.manifest && adopted.approval);
        if ((governanceAdopted || opts.bundleDirectory) && !opts.confirm) {
          refuse("delivery capture requires an explicit confirmation callback", HINT.ship);
        }
        await this.#assertCurrentShipGate(state, opts);
        const staged = await this.#stageShipLocked(state, governanceAdopted || Boolean(opts.bundleDirectory));
        stagedPreview = staged;
        deliveryId = governanceAdopted || opts.bundleDirectory ? randomUUID() : null;
        this.#shipProjection = {
          confirmationId: opts.confirm ? (deliveryId ?? randomUUID()) : null,
          previewFingerprint: stableHash({ productFingerprint: staged.productFingerprint, staged: staged.staged }),
          confirmed: false,
          status: "prepared",
        };
        return staged;
      }));
    } catch (error) {
      if (stagedPreview && governanceAdopted) {
        throw new AggregateError(
          [error],
          `Ship preparation failed after staging; shipping is refused and staged paths remain for operator recovery: ${stagedPreview.added.join(", ") || "(none)"}`,
        );
      }
      throw error;
    }

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
      const completion = await this.#governanceMutation(opts.confirm ? "ship-confirm" : "ship-complete", async () => {
        // The confirmation is part of this boundary: its begin records the unconfirmed preview and its
        // end the confirmed one. A refused gate restores the projection so the denial changes nothing.
        if (opts.confirm && this.#shipProjection) this.#shipProjection = { ...this.#shipProjection, confirmed: true };
        try {
          const state = await this.#readState();
          if (
            isGitRepo(this.projectRoot) &&
            shipProductIndexFingerprint(this.projectRoot) !== preview.productFingerprint
          ) {
            refuse(SHIP_STAGED_CHANGED, HINT.ship);
          }
          await this.#assertCurrentShipGate(state, opts);
          return await this.#completeShipLocked(state, opts, preview, deliveryId);
        } catch (error) {
          if (this.#shipProjection) this.#shipProjection = { ...this.#shipProjection, confirmed: false };
          throw error;
        }
      }).catch(async (error) => {
        if (this.#shipProjection) this.#shipProjection = { ...this.#shipProjection, confirmed: false };
        if (deliveryId) {
          try {
            const snapshot = await readDeliverySnapshot(this.store, deliveryId);
            if (snapshot.state === "prepared") await abortDeliverySnapshot(
              this.store,
              deliveryId,
              nowIso(),
              "capture-failed",
              tryGitHead(this.projectRoot),
              { assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); } },
            );
          } catch {
            // Preserve the original shipment failure.
          }
        }
        throw error;
      });
      if (completion.snapshotId && completion.preparedDigest && !completion.rollback) {
        const lock = { assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); } };
        let completedTrace: GovernanceTrace = { schemaVersion: SCHEMA_VERSION.governanceTrace, status: "not-adopted", frames: [] };
        let traceEndDigest: string | undefined;
        let durableOutcome = false;
        let snapshotCompleted = false;
        try {
          const adopted = await loadAssurance(this.store);
          if (adopted.approval) {
            const config = await this.#readConfig();
            const modelDigest = await this.#governanceModelDigest(config);
            await this.#governanceMutation("ship-complete", async () => undefined);
            completedTrace = await readGovernanceTrace(this.store, adopted.approval.approvalId, modelDigest);
            if (completedTrace.status !== "valid" || completedTrace.frames.at(-1)?.action !== "ship-complete" || completedTrace.frames.at(-1)?.outcome !== "success") {
              throw new Error("adopted ship-complete trace is not successful");
            }
            if (completedTrace.headDigest === null) throw new Error("adopted ship-complete trace has no head digest");
            traceEndDigest = completedTrace.headDigest;
          }
          const outcome: DeliveryOutcome = {
            schemaVersion: SCHEMA_VERSION.deliveryOutcome,
            confirmationId: completion.snapshotId,
            preparedDigest: completion.preparedDigest,
            confirmedSubjectDigest: (await readDeliverySnapshot(this.store, completion.snapshotId)).prepared.product.subjectDigest,
            commit: completion.receipt.commitSha ? { status: "verified", oid: completion.receipt.commitSha } : { status: "not-requested" },
            pullRequest: completion.receipt.prUrl
              ? { status: "created", number: Number(completion.receipt.prUrl.match(/\/pull\/(\d+)/)?.[1] ?? "0") }
              : { status: "not-requested" },
            recordedAt: nowIso(),
            ...(traceEndDigest ? { traceEndDigest } : {}),
          };
          await recordDeliveryOutcome(this.store, completion.snapshotId, outcome, lock);
          durableOutcome = true;
          await completeDeliverySnapshot(this.store, completion.snapshotId, outcome, completedTrace, lock);
          snapshotCompleted = true;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (!durableOutcome) {
            try { durableOutcome = (await readDeliveryOutcome(this.store, completion.snapshotId)) !== null; }
            catch { /* A damaged outcome cannot authorize recovery. */ }
          }
          const recoveryHint = durableOutcome
            ? opts.bundleDirectory
              ? `legion-cli ship export --snapshot ${completion.snapshotId} --out ${opts.bundleDirectory}`
              : `legion-cli ship export --snapshot ${completion.snapshotId} --out <new-directory>`
            : "No durable matching delivery outcome is available; export is blocked. Do not rerun shipment.";
          completion.receipt.deliverySnapshot = { status: "pending", error: reason, recoveryHint };
          if (opts.bundleDirectory) completion.receipt.bundle = {
            status: "failed",
            path: opts.bundleDirectory,
            reason,
            recoveryHint,
          };
        }
        if (snapshotCompleted && opts.bundleDirectory) {
          try {
            const exported = await exportDeliveryBundle(await readDeliverySnapshot(this.store, completion.snapshotId), opts.bundleDirectory);
            completion.receipt.bundle = {
              status: "exported",
              path: opts.bundleDirectory,
              manifestSha256: exported.manifestSha256,
              snapshotDigest: exported.snapshotDigest,
            };
            try {
              await recordDeliveryExportAttempt(this.store, {
                schemaVersion: SCHEMA_VERSION.deliveryExport,
                snapshotId: completion.snapshotId,
                snapshotDigest: exported.snapshotDigest,
                requestedOutput: opts.bundleDirectory,
                attemptId: randomUUID(),
                attemptedAt: nowIso(),
                result: "exported",
                reason: null,
              }, lock);
            } catch (error) {
              completion.receipt.bundle.warning = `Bundle was published, but export-attempt journaling failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            completion.receipt.bundle = {
              status: "failed",
              path: opts.bundleDirectory,
              reason,
              recoveryHint: `legion-cli ship export --snapshot ${completion.snapshotId} --out ${opts.bundleDirectory}.recovery`,
            };
            try {
              const complete = await readDeliverySnapshot(this.store, completion.snapshotId);
              await recordDeliveryExportAttempt(this.store, {
                schemaVersion: SCHEMA_VERSION.deliveryExport,
                snapshotId: completion.snapshotId,
                snapshotDigest: complete.state === "complete" ? complete.sealedDigest : complete.preparedDigest,
                requestedOutput: opts.bundleDirectory,
                attemptId: randomUUID(),
                attemptedAt: nowIso(),
                result: "failed",
                reason: reason.slice(0, 4096) || "Bundle export failed",
              }, lock);
            } catch {
              // Shipment remains complete when optional export or its journal fails.
            }
          }
        }
      }

      if (completion.rollback) {
        const rollback = completion.rollback;
        if (completion.snapshotId) {
          try {
            await abortDeliverySnapshot(
              this.store,
              completion.snapshotId,
              nowIso(),
              "pr-failed",
              rollback.keptRootCommit ? rollback.commitSha ?? null : null,
              { assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); } },
            );
          } catch {
            // A damaged snapshot record cannot replace the actual shipment result.
          }
        }
        await this.#governanceMutation("ship-rollback", async () => {
          if (rollback.priorHead && rollback.commitSha) gitResetMixed(this.projectRoot, rollback.priorHead);
          let receiptKept: string | undefined;
          if (!rollback.keptRootCommit) {
            try {
              await rm(toFsPath(this.projectRoot, rollback.receiptPath), { force: true });
            } catch (err) {
              receiptKept = err instanceof Error ? err.message : String(err);
            }
          }
          await this.#writeState(rollback.state, "ship-rollback");
          await this.#audit("ship_rolled_back", rollback.state.phase, rollback.actor, {
            specId: rollback.specId,
            receiptPath: rollback.receiptPath,
            reason: rollback.reason,
            ...(rollback.keptRootCommit ? { commitKept: rollback.commitSha } : {}),
            ...(receiptKept ? { receiptKept } : {}),
          });
          if (this.#shipProjection) this.#shipProjection = { ...this.#shipProjection, confirmed: false, status: "aborted" };
        });
        refuse(`gh pr create failed: ${rollback.reason}`, HINT.shipPrRetry);
      }
      return completion.receipt;
    });
  }

  async exportDeliverySnapshot(snapshotId: string, directory: string): Promise<ShipExportResult> {
    const attemptId = randomUUID();
    let snapshot = await readDeliverySnapshot(this.store, snapshotId);
    if (snapshot.state === "prepared") {
      await this.#mutate(async () => {
        const outcome = await readDeliveryOutcome(this.store, snapshotId);
        if (!outcome) throw new Error("Delivery outcome is not durably recorded; shipment must not be rerun");
        let completedTrace: GovernanceTrace = { schemaVersion: SCHEMA_VERSION.governanceTrace, status: "not-adopted", frames: [] };
        if (snapshot.prepared.approvalId) {
          const config = await this.#readConfig();
          completedTrace = await readGovernanceTrace(this.store, snapshot.prepared.approvalId, await this.#governanceModelDigest(config));
          if (completedTrace.status !== "valid" || completedTrace.frames.at(-1)?.action !== "ship-complete" || completedTrace.frames.at(-1)?.outcome !== "success") {
            throw new Error("Adopted delivery lacks a successful ship-complete trace");
          }
        }
        await completeDeliverySnapshot(this.store, snapshotId, outcome, completedTrace, {
          assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); },
        });
      });
      snapshot = await readDeliverySnapshot(this.store, snapshotId);
    }
    let exported: DeliveryBundleExport;
    try {
      exported = await exportDeliveryBundle(snapshot, directory);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.#mutate(async () => {
        await recordDeliveryExportAttempt(this.store, {
          schemaVersion: SCHEMA_VERSION.deliveryExport,
          snapshotId,
          snapshotDigest: snapshot.state === "complete" ? snapshot.sealedDigest : snapshot.preparedDigest,
          requestedOutput: directory,
          attemptId,
          attemptedAt: nowIso(),
          result: "failed",
          reason: reason.slice(0, 4096) || "Bundle export failed",
        }, { assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); } });
      });
      throw error;
    }
    await this.#mutate(async () => {
      await recordDeliveryExportAttempt(this.store, {
        schemaVersion: SCHEMA_VERSION.deliveryExport,
        snapshotId,
        snapshotDigest: exported.snapshotDigest,
        requestedOutput: directory,
        attemptId,
        attemptedAt: nowIso(),
        result: "exported",
        reason: null,
      }, { assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); } });
    });
    return { snapshotId, directory, ...exported };
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
      await this.#assertAgentAvailable("interview");
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
      await this.#assertAgentAvailable("discuss");
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
      if (state.phase === "spec_draft" && state.activeSpecId &&
          (await this.#readConfig()).workflow?.profile === "focused") {
        try {
          const existing = await this.store.readSpec(state.activeSpecId);
          if (existing.data.status === "draft") return existing.data;
        } catch {
          // A missing draft is reconstructed below from durable interview context.
        }
      }
      await this.#assertAgentAvailable("spec");
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
    const prepared = await this.#startLock(() => started, async () => {
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
      started = await this.#startOptionalSpawn("wireframe", specId, session.spawnPrompt, opts.adapter, opts.profile);
      return null;
    });
    if (prepared) return prepared;
    const waited = started?.spawned ? await waitStartedSpawn(started) : { error: undefined };
    return this.#relock(started?.runId, async () => {
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
    return this.#mutate(async () => this.#governanceMutation("abandon", async () => {
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
    }));
  }

  async undoLastTask(opts?: { taskId?: string }): Promise<UndoResult> {
    return this.#mutate(async () => this.#governanceMutation("undo", async () => {
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
    }));
  }

  async unblockTask(taskId: string): Promise<Task> {
    return this.#mutate(async () => this.#governanceMutation("unblock", async () => {
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
    }));
  }

  async recoverTask(taskId: string): Promise<Task> {
    // Own liveness check below (names the task); the central guard would hide that message.
    return this.#mutate(async () => this.#governanceMutation("recover", async () => {
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
      if (resume && ["live", "unknown"].includes(await inspectResumeOwner(resume))) {
        refuse(`cannot recover ${taskId} while verification is live`, HINT.status);
      }
      // The specific check above is about this task's run; any OTHER live run still refuses.
      refuseIfLiveRun((await liveRuns(this.projectRoot, { clearDead: true })).live);
      // Entered with allowLive, so the lock-entry append check was skipped: make it before the write.
      await assertAuditAppendable(this.projectRoot);
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
    }), { allowLive: true });
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
    cliProfile?: string,
  ): Promise<{ spawned: boolean; runId: string }> {
    let started: StartedSkillSpawn | undefined;
    await this.#startLock(() => started, async () => {
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
        cliProfile,
      });
    });
    if (!started?.spawned) {
      return { spawned: false, runId: started?.runId ?? "" };
    }
    const live = started;
    const waited = await waitStartedSpawn(live);
    return this.#relock(live.runId, async () => {
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
    await this.#read(async () => undefined);
  }

  async peekLiveSpawn(): Promise<{ taskId: string; runId: string } | null> {
    const state = await this.#readState();
    if (!state.currentTaskId) return null;
    try {
      const task = (await this.store.readTask(state.currentTaskId)).data;
      if (task.status !== "in_progress") return null;
      const resume = await findLatestTaskResume(this.projectRoot, task.id);
      // Same identity check as the hands-off guard, so doctor never reports a reused pid as live.
      if (resume && (await resumeAsLiveRun(resume))) return { taskId: task.id, runId: resume.runId };
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
    opts: { fix: boolean; adapter?: AdapterId; profile?: string; allowNoSandbox?: boolean; config?: LegionConfig; resumeRunId?: string; onProgress?: ExecuteOptions["onProgress"] },
  ): Promise<{ result: ExecuteTaskResult; config: LegionConfig }> {
    const executeStartedAt = Date.now();
    let task: Task | undefined;
    let config: LegionConfig | undefined = opts.config;
    let started: StartedSkillSpawn | undefined;
    let dirtyWarning: string | undefined;
    let governedApprovalId: string | undefined;
    let verificationFlow: VerificationInformationFlow | undefined;
    const verificationOutputs: Array<{
      checkId: string;
      commandFingerprint: string;
      label: VerificationInformationFlow["label"];
      inventory: { path: string; beforeDigest: string | null; afterDigest: string };
    }> = [];

    await this.#startLock(() => started, async () => {
      const state = await this.#readState();
      if (state.phase === "plan_failed") {
        refuse("Plan failed. Fix the FAIL list before executing", HINT.planRetry);
      }
      if (state.phase !== "plan_ready" && state.phase !== "executing") {
        refuse("Execute needs plan_ready or executing", HINT.plan);
      }
      config = opts.config ?? (await this.#readConfig());
      if (config.workflow?.profile === "focused") {
        config = (await this.#requireCurrentPlanApproval()).config;
      }
      if (config.control_mode === "advisory") {
        refuse("Execute is off in advisory mode", HINT.advisory);
      }

      // Refuse on a bad audit chain before any task or phase moves (the later audit append would).
      await assertAuditAppendable(this.projectRoot);
      if (opts.resumeRunId) {
        if (taskId === "auto") refuse("execute resume requires its recorded task", HINT.status);
        task = (await this.store.readTask(taskId)).data;
        if (task.status !== "in_progress") {
          refuse(`execute resume ${opts.resumeRunId} requires ${task.id} to remain in_progress`, HINT.status);
        }
      } else {
        task = await this.#resolveExecuteTask(taskId, state, config);
      }
      const taskForStart = task;
      opts.onProgress?.({ taskId: task.id, stage: "starting", elapsedMs: Date.now() - executeStartedAt });
      if (task.contract.filesAllowed.length === 0 || task.contract.verificationCommands.length === 0) {
        refuse("This task needs a file contract and verification commands", HINT.plan);
      }

      await this.#assertSkillSpawnable(config, "execute", {
        cliAdapter: opts.adapter,
        taskAdapter: task.adapter,
        cliProfile: opts.profile,
        taskProfile: task.profile,
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

      await this.#governanceMutation("task-start", async () => {
        if (!opts.resumeRunId) await this.#transitionTaskTo(taskForStart.id, "in_progress");
        await this.#writeState({
          ...(await this.#readState()),
          phase: "executing",
          currentTaskId: taskForStart.id,
        });
      });
      const extraAllowed = [...task.contract.filesAllowed, ...task.contract.expectedArtifacts];
      const promptBody = [
        `Task: ${task.id} ${task.title}`,
        `Priority: ${task.priority}`,
        opts.fix ? "This is a fix run. Keep the reproducing test. Do not delete tests." : "",
        `Read .legion-cli/specs/${task.specId}/SPEC.md.`,
        "Write only the files listed in FileContract. Do not git add or git commit.",
        "Link tests to SPEC criteria with @ac(AC-ID), and copy AC.priority as @p0/@p1/@p2.",
      ]
        .filter((line) => line !== "")
        .join("\n");

      try {
        const governed = await this.#governedExecuteSpawnOptions(task, config, {
          adapter: opts.adapter,
          profile: opts.profile,
        });
        if (governed) {
          governedApprovalId = governed.approval.approvalId;
          verificationFlow = buildVerificationInformationFlow(governed.plan, governed.approval, task);
        }
        const spawnOptions = {
          ...this.#skillSpawnFields(),
          config,
          skillId: "execute" as const,
          specId: task.specId,
          taskId: task.id,
          promptBody,
          fileContract: task.contract,
          extraAllowedRoots: extraAllowed,
          filesForbidden: task.contract.filesForbidden,
          required: true,
          cliAdapter: opts.adapter,
          taskAdapter: task.adapter,
          cliProfile: opts.profile,
          taskProfile: task.profile,
          allowNoSandbox: opts.allowNoSandbox,
          ...(governed ? { governed } : {}),
        };
        started = opts.resumeRunId
          ? await resumeHttpSkillSpawn({ ...spawnOptions, runId: opts.resumeRunId })
          : await startSkillSpawn(spawnOptions);
      } catch (err) {
        if (!opts.resumeRunId) await this.#governanceMutation("task-block", () => this.#transitionTaskTo(taskForStart.id, "blocked"));
        if (err instanceof SandboxError) {
          refuse(err.message, HINT.allowNoSandbox);
        }
        throw err;
      }
      if (!started.spawned) {
        await this.#governanceMutation("task-block", () => this.#transitionTaskTo(taskForStart.id, "blocked"));
      } else {
        const dirty = [...started.revertCtx.dirtyAtStart].filter(
          (posix) => !posix.startsWith(".legion-cli/") && isAllowedPath(posix, extraAllowed),
        );
        if (dirty.length > 0) {
          dirtyWarning = `execute ${task.id}: uncommitted changes inside filesAllowed (${dirty.join(", ")}); a failed task keeps them and the agent may overwrite them, so commit or stash first`;
        }
      }
      if (started?.spawned && started.sandbox) {
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
    const emitProgress = (stage: ExecuteProgress["stage"], runId?: string): void => {
      opts.onProgress?.({
        taskId: lockedTask.id,
        stage,
        elapsedMs: Date.now() - executeStartedAt,
        ...(runId ? { logPath: `.legion-cli/cache/runs/${runId}/stdout.log` } : {}),
      });
    };
    // The run marker outlives finishStartedSpawn: verification runs outside the lock and still
    // writes the tree, so the guard holds until the final relock (or an early exit) below.
    try {
      emitProgress("running", started?.runId);
      const waited = started?.spawned ? await waitStartedSpawn(started) : { error: undefined, timedOut: false, durationMs: 0 };
      emitProgress("agent-complete", started?.runId);
      emitProgress("integrating", started?.runId);

      const post = await this.#relockKeep(started?.runId, async () => {
        const preservedHttpInterruption = Boolean(
          waited.error &&
          started?.spawned &&
          started.resolution.id === "http" &&
          started.sandbox &&
          (waited.recovery === "resume" || waited.recovery === "manual"),
        );
        const resumableHttpInterruption = preservedHttpInterruption && waited.recovery === "resume";
        let revert = null;
        const integrationSpawn = started;
        if (preservedHttpInterruption && integrationSpawn?.spawned) {
          const interruptedSpawn = integrationSpawn;
          await this.#governanceMutation("integration-complete", () => preserveStartedHttpSpawnForRecovery(
            interruptedSpawn,
            waited.error instanceof Error ? waited.error.message : String(waited.error),
            waited.recovery === "resume"
              ? `legion-cli execute --resume ${interruptedSpawn.runId}`
              : `legion-cli task amend ${lockedTask.id} --unblock`,
          ));
        } else if (integrationSpawn?.spawned) {
          const completedSpawn = integrationSpawn;
          revert = await this.#governanceMutation("integration-complete", async () => {
            const applied = await finishStartedSpawn(completedSpawn, { keepMarker: true });
            if (applied.sandboxCopied?.length) await this.#recordGovernedAppliedFiles(completedSpawn.runId, applied.sandboxCopied);
            if (completedSpawn.sandbox) {
              await this.#audit("sandbox_copyout", "executing", "agent", {
                backend: completedSpawn.sandbox.backend,
                hardened: completedSpawn.sandbox.hardened,
                copied: applied.sandboxCopied ?? [],
                dropped: applied.sandboxDropped ?? [],
              }, lockedTask.id);
            }
            return applied;
          });
        }
        const extras = revert?.extrasReverted ?? [];
        const incident = Boolean(revert?.incident);
        const headMoved = Boolean(revert?.headMoved);
        const runId = started?.runId ?? "";
        const durationMs = waited.durationMs;
        const timedOut = Boolean(waited.timedOut);
        const adapterId = started && started.spawned ? started.resolution.id : started?.resolution?.id;
        const resolutionSource = started && started.spawned ? started.resolution.source : undefined;
        const profile = started?.resolution?.profile;
        const usage = waited.usage;
        const limitReason = waited.limitReason;
        const spawnAudit = {
          adapterId,
          binary: started && started.spawned ? started.binary : undefined,
          argvSummary: started && started.spawned ? started.argvSummary : undefined,
          resolutionSource,
          profile,
          usage,
          limitReason,
          ...(started?.spawned ? { agentExitCode: waited.exitCode ?? null } : {}),
        };
        const agentProblem = agentExitProblem(waited);
        const agentExitWarning = agentProblem
          ? `execute ${lockedTask.id}: ${agentProblem} (log: .legion-cli/cache/runs/${runId}/stderr.log); verification decides the result`
          : undefined;

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
          return {
            ...outcome,
            adapterId,
            resolutionSource,
            ...(profile ? { profile } : {}),
            ...(usage ? { usage } : {}),
            ...(limitReason ? { limitReason } : {}),
            ...(agentExitWarning ? { agentExitWarning } : {}),
          };
        };

        let extraJsonInvalid = false;
        let extraJsonTicketIds: string[] = [];
        const filedTickets: FiledTicketSummary[] = [];
        if (runId) {
          const filed = await this.#governanceMutation("integration-complete", () =>
            this.#fileExtrasFromRun(runId, lockedTask.specId, {
              inheritFrom: {
                id: lockedTask.id,
                label: "running task",
                filesAllowed: lockedTask.contract.filesAllowed,
                verificationCommands: lockedTask.contract.verificationCommands,
              },
            }),
          );
          extraJsonInvalid = filed.invalid;
          extraJsonTicketIds = filed.ticketIds;
          filedTickets.push(...filed.tickets);
        }
        if (incident || extras.length > 0 || extraJsonInvalid) {
          let ticketId: string | undefined;
          if (extras.length > 0) {
            const filed = await this.#governanceMutation("integration-complete", () =>
              this.#fileTicketLocked({
                inheritFrom: {
                  id: lockedTask.id,
                  label: "running task",
                  filesAllowed: lockedTask.contract.filesAllowed,
                  verificationCommands: lockedTask.contract.verificationCommands,
                },
                title: extras.length === 1
                  ? `FileContract extra: ${extras[0]}`
                  : `FileContract extras: ${extras.join(", ")}`,
                parentId: lockedTask.id,
                fromAgent: true,
                type: "bug",
                notes: "type: scope. Spawn wrote paths outside FileContract; extras were reverted.",
              }, lockedTask.specId),
            );
            ticketId = filed.task.id;
            filedTickets.push({
              id: filed.task.id,
              verificationCommands: filed.task.contract.verificationCommands,
              filesAllowed: filed.task.contract.filesAllowed,
              verificationSource: filed.verificationSource,
            });
          }
          ticketId ??= extraJsonTicketIds[0];
          return await this.#governanceMutation("task-block", async () => {
            await this.#transitionTaskTo(lockedTask.id, "blocked");
            await this.#writeState({
              ...(await this.#readState()),
              phase: "executing",
              currentTaskId: lockedTask.id,
            });
            if (runId) {
              await updateResumeStage(this.projectRoot, runId, "blocked", {
                pid: null,
                pidStartedAt: null,
                engineOwnershipReleasedAt: new Date().toISOString(),
                childTerminationUncertain: false,
                interruptionReason: incident ? "sandbox incident" : "file contract violation",
                recoveryCommand: `legion-cli task amend ${lockedTask.id} --unblock`,
              });
            }
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
                filedTickets,
              }),
            };
          });
        }

        if (waited.error || !started?.spawned) {
          const spawnReason = waited.error instanceof Error ? waited.error.message : "agent did not start";
          return await this.#governanceMutation("task-block", async () => {
            if (!resumableHttpInterruption) await this.#transitionTaskTo(lockedTask.id, "blocked");
            if (runId && !resumableHttpInterruption) {
              await updateResumeStage(this.projectRoot, runId, preservedHttpInterruption ? "interrupted" : "blocked", {
                pid: null,
                pidStartedAt: null,
                engineOwnershipReleasedAt: new Date().toISOString(),
                childTerminationUncertain: false,
                interruptionReason: spawnReason,
                recoveryCommand: `legion-cli task amend ${lockedTask.id} --unblock`,
              });
            }
            return {
              kind: "done" as const,
              result: await finish({
                taskId: lockedTask.id,
                status: "blocked",
                runId,
                extrasReverted: extras,
                incident,
                headMoved,
                reason: spawnReason,
              }),
            };
          });
        }

        await this.#governanceMutation("task-verify", async () => {
          await this.#transitionTaskTo(lockedTask.id, "verifying");
          await updateResumeStage(this.projectRoot, runId, "verifying");
        });
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
          profile,
          usage,
          limitReason,
          agentExitWarning,
          filedTickets,
        };
      });

      if (post.kind === "done") {
        emitProgress(post.result.status, post.result.runId);
        return { result: dirtyWarning ? { ...post.result, dirtyWarning } : post.result, config: lockedConfig };
      }

      let verificationPass = false;
      let reason: string | undefined;
      let trustTierNote: string | undefined;
      let verificationLogs: string[] = [];
      emitProgress("verifying", post.runId);
      const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
      try {
        if (this.#fakeOnVerify) await this.#fakeOnVerify();
        if (this.#fakeVerificationError) throw new Error(this.#fakeVerificationError);
        let verification: Awaited<ReturnType<typeof runVerificationCommands>>;
        if (verificationFlow) {
          verification = [];
          for (const [index, command] of lockedTask.contract.verificationCommands.entries()) {
            const before = await snapshotVerificationProduct(this.projectRoot);
            const [run] = await runVerificationCommands(this.projectRoot, [command], {
              timeoutMs: this.#verificationTimeoutMs,
              runId: `${post.runId}-verify-${index + 1}`,
              secretEnvNames: configuredApiKeyEnvNames(lockedConfig),
              sandbox: lockedConfig.sandbox,
              informationFlow: verificationFlow,
            });
            if (run) verification.push(run);
            const after = await snapshotVerificationProduct(this.projectRoot);
            const changes = changedVerificationOutputs(before, after, lockedTask.contract.expectedArtifacts);
            if (changes.length > 0 && (!run?.informationFlow || !governedApprovalId)) {
              throw new Error("verification outputs lack approved information-flow provenance");
            }
            if (run?.informationFlow && governedApprovalId) {
              const commandFingerprint = stableHash({ taskId: lockedTask.id, index, command });
              for (const inventory of changes) {
                verificationOutputs.push({
                  checkId: `verify-${commandFingerprint.slice(0, 32)}`,
                  commandFingerprint,
                  label: {
                    confidentiality: run.informationFlow.confidentiality,
                    integrity: run.informationFlow.integrity,
                    origins: [...run.informationFlow.origins],
                  },
                  inventory,
                });
              }
            }
          }
        } else {
          verification = await runVerificationCommands(this.projectRoot, lockedTask.contract.verificationCommands, {
            timeoutMs: this.#verificationTimeoutMs,
            runId: post.runId,
            secretEnvNames: configuredApiKeyEnvNames(lockedConfig),
            sandbox: lockedConfig.sandbox,
          });
        }
        verificationPass = verification.length > 0 && verification.every((run) => run.ok);
        verificationLogs = verification.flatMap((run) => (run.logPath ? [run.logPath] : []));
        reason = verificationFailureReason(verification);
        trustTierNote = verification.find((run) => run.trustTierNote)?.trustTierNote;
      } catch (err) {
        verificationPass = false;
        reason = `verification failed: ${describe(err)}`;
      }

      const result = await this.#relock(started?.runId, async () => {
        if (verificationOutputs.length > 0) {
          await this.#governanceMutation("task-verify", async () => {
            try {
              if (!governedApprovalId || !verificationFlow) throw new Error("verification authority is unavailable");
              for (const output of verificationOutputs) {
                await recordOpaqueVerificationOutputProvenance({
                  store: this.store,
                  withLock: (callback) => this.#withLockOrRefuse(callback, { ownRunId: post.runId }),
                  runId: post.runId,
                  approvalId: governedApprovalId,
                  taskId: lockedTask.id,
                  checkId: output.checkId,
                  commandFingerprint: output.commandFingerprint,
                  label: output.label,
                  inventory: output.inventory,
                });
              }
            } catch (err) {
              verificationPass = false;
              reason = `verification output provenance failed: ${describe(err)}`;
            }
          });
        }

        const action = verificationPass ? "task-complete" : "task-block";
        return this.#governanceMutation(action, async () => {
          if (verificationPass) {
            await this.#transitionTaskTo(lockedTask.id, "done");
            await this.#promoteReadyTasks(lockedTask.specId, "executing", lockedConfig.control_mode);
          } else {
            await this.#transitionTaskTo(lockedTask.id, "blocked");
          }
          const state = await this.#readState();
          const currentTaskId =
            state.currentTaskId && state.currentTaskId !== lockedTask.id ? state.currentTaskId : lockedTask.id;
          await this.#writeState({
            ...state,
            phase: "executing",
            currentTaskId,
          });
          const current = await this.#readState();
          await updateResumeStage(this.projectRoot, post.runId, verificationPass ? "completed" : "blocked", {
            pid: null,
            pidStartedAt: null,
            engineOwnershipReleasedAt: new Date().toISOString(),
            childTerminationUncertain: false,
            logs: {
              stdout: `.legion-cli/cache/runs/${post.runId}/stdout.log`,
              stderr: `.legion-cli/cache/runs/${post.runId}/stderr.log`,
              ...(verificationLogs.length > 0 ? { verification: verificationLogs } : {}),
            },
            ...(verificationPass
              ? {}
              : {
                  interruptionReason: reason ?? "verification failed",
                  recoveryCommand: `legion-cli task amend ${lockedTask.id} --unblock`,
                }),
          });
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
            ...(post.profile ? { profile: post.profile } : {}),
            ...(post.usage ? { usage: post.usage } : {}),
            ...(post.limitReason ? { limitReason: post.limitReason } : {}),
            ...(post.agentExitWarning ? { agentExitWarning: post.agentExitWarning } : {}),
            ...(post.filedTickets.length > 0 ? { filedTickets: post.filedTickets } : {}),
            ...(reason ? { reason } : {}),
            ...(trustTierNote ? { trustTierNote } : {}),
          };
        });
      });
      emitProgress(result.status, result.runId);
      return { result: dirtyWarning ? { ...result, dirtyWarning } : result, config: lockedConfig };
    } finally {
      await this.#dropRunMarker(started);
    }
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
    opts?: { cliAdapter?: AdapterId; taskAdapter?: AdapterId; cliProfile?: string; taskProfile?: string },
  ): Promise<void> {
    const resolution = resolveAdapterId({
      config,
      skillId,
      taskAdapter: opts?.taskAdapter,
      cliAdapter: opts?.cliAdapter,
      cliProfile: opts?.cliProfile,
      taskProfile: opts?.taskProfile,
    });
    const assurance = skillId === "execute" && resolution.id === "http" ? await loadAssurance(this.store) : null;
    const governedHttp = Boolean(
      assurance?.approval &&
      assurance.manifest?.security.mode === "information-flow",
    );
    if (!governedHttp && !(await isResolvedAdapterSpawnable(config, resolution.id))) {
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
    defaults?: {
      type?: NewTicket["type"];
      parentId?: string;
      inheritFrom?: TicketSource;
      agentSourceless?: boolean;
    },
  ): Promise<{ invalid: boolean; ticketIds: string[]; tickets: FiledTicketSummary[] }> {
    const abs = join(this.projectRoot, ".legion-cli", "cache", "runs", runId, "extra.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(abs, "utf8"));
    } catch {
      return { invalid: false, ticketIds: [], tickets: [] };
    }
    let invalid = false;
    const ticketIds: string[] = [];
    const tickets: FiledTicketSummary[] = [];
    for (const input of parseExtraJson(raw)) {
      const { task, coerced, verificationSource } = await this.#fileTicketLocked(
        {
          ...input,
          fromAgent: true,
          type: input.type ?? defaults?.type,
          parentId: input.parentId ?? defaults?.parentId,
          inheritFrom: defaults?.inheritFrom,
          agentSourceless: defaults?.agentSourceless,
        },
        specId,
      );
      if (coerced) invalid = true;
      ticketIds.push(task.id);
      tickets.push({
        id: task.id,
        verificationCommands: task.contract.verificationCommands,
        filesAllowed: task.contract.filesAllowed,
        verificationSource,
      });
    }
    return { invalid, ticketIds, tickets };
  }

  async #fileTicketLocked(
    input: NewTicket,
    specIdOverride?: string,
  ): Promise<{ task: Task; coerced: boolean; verificationSource: string }> {
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
    const sourceless = Boolean(input.fromAgent && input.agentSourceless);
    let parentId = sourceless ? undefined : input.parentId;
    let parentAdapter: AdapterId | undefined;
    let parentProfile: string | undefined;
    let parentSource: TicketSource | undefined;
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
        parentProfile = parent.profile;
        parentSource = {
          id: parent.id,
          label: "parent",
          filesAllowed: parent.contract.filesAllowed,
          verificationCommands: parent.contract.verificationCommands,
        };
      }
    }
    // Agent-filed tickets never bring their own verificationCommands (F-039): they run the
    // engine-supplied source task's commands (running/verified task), else the resolved
    // parent's, else the engine default. An empty source list also falls to the default, and
    // the returned label says which. Human tickets keep what the human typed.
    const source = input.fromAgent && !sourceless ? (input.inheritFrom ?? parentSource) : undefined;
    const agentVerification =
      source && source.verificationCommands.length > 0 ? [...source.verificationCommands] : undefined;
    const verificationSource = agentVerification && source ? source.label : "engine default (pnpm test)";
    // From file names (valid or not), under engine.lock, so a corrupt file's id is never
    // reused (F-004).
    const id = await nextFileId(this.store.paths.tasksDir, "TSK", 4);
    let ticket = ticketFromInput(id, specId, {
      ...input,
      title,
      parentId,
      adapter: input.profile ? undefined : (input.adapter ?? (parentProfile ? undefined : parentAdapter)),
      profile: input.adapter ? undefined : (input.profile ?? parentProfile),
      ...(input.fromAgent
        ? { contract: { ...input.contract, verificationCommands: agentVerification } }
        : {}),
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
        contract: defaultTicketContract(id, { verificationCommands: agentVerification }),
      };
      coerced = true;
    }
    // An agent ticket may only touch files its source task may touch; otherwise it could edit the
    // scripts/tests its inherited command runs (F-039). Outside that, it gets the default notes/ file.
    if (!coerced && input.fromAgent && source && (input.contract?.filesAllowed?.length ?? 0) > 0) {
      const allowed = new Set(source.filesAllowed.map((path) => normalizePathKey(path)));
      if (!ticket.contract.filesAllowed.every((path) => allowed.has(normalizePathKey(path)))) {
        ticket = {
          ...ticket,
          contract: defaultTicketContract(id, { verificationCommands: agentVerification }),
          notes: `${ticket.notes} filesAllowed outside ${source.id}'s were replaced by notes/${id}.md.`.trim(),
        };
      }
    }
    // Any agent ticket: no engine source means the agent's files are not trusted at all, and a source
    // never legitimises verification entry points (package.json, scripts, tests, CI, hooks, configs,
    // files named by the inherited commands). Those get the default notes/<id>.md contract.
    if (input.fromAgent && (input.contract?.filesAllowed?.length ?? 0) > 0) {
      const reason = sourceless
        ? "no engine-supplied source task"
        : touchesVerificationEntryPoint(ticket.contract.filesAllowed, ticket.contract.verificationCommands)
          ? "a verification entry point"
          : undefined;
      if (reason && ticket.contract.filesAllowed.some((path) => !path.startsWith("notes/"))) {
        ticket = {
          ...ticket,
          contract: defaultTicketContract(id, { verificationCommands: agentVerification }),
          notes: `${ticket.notes} filesAllowed replaced by notes/${id}.md (${reason}).`.trim(),
        };
      }
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
    return { task: promoted, coerced, verificationSource };
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
    cliProfile?: string,
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
      cliProfile,
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

  /** intent, discuss and spec need a real agent; canned template output must not pass as agent work. */
  async #assertAgentAvailable(skillId: "interview" | "discuss" | "spec"): Promise<void> {
    let config: LegionConfig;
    try {
      config = await this.#readConfig();
    } catch {
      return;
    }
    const resolution = resolveAdapterId({ config, skillId });
    if (!(await isResolvedAdapterSpawnable(config, resolution.id))) {
      refuse(
        `no agent available for ${skillId} (${resolution.id}, via ${resolution.source}); run \`legion-cli doctor\``,
        HINT.doctor,
      );
    }
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

  /**
   * Every phase change passes through here and is checked against the phase on disk (same-phase
   * writes are fine). `allow` names the one write that deliberately undoes a move:
   * a ship that failed after writing `shipped` (`shipped` back to `ready_to_ship`/`executing`).
   */
  async #writeState(state: StateFile, allow?: "ship-rollback"): Promise<void> {
    const onDisk = await this.#readState();
    // The one exemption is exactly the edge it names: a ship that failed after writing `shipped`.
    const shipRollback =
      allow === "ship-rollback" &&
      onDisk.phase === "shipped" &&
      (state.phase === "ready_to_ship" || state.phase === "executing");
    if (onDisk.phase !== state.phase && !shipRollback) assertCanTransition(onDisk.phase, state.phase);
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

  async #workflowPlanContext(configOverride?: LegionConfig, assuranceOverride?: AssurancePlan | null): Promise<{
    snapshot: WorkflowPlanSnapshot;
    spec: Spec;
    tasks: Task[];
    config: LegionConfig;
    assurance: AssuranceState;
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
    const assurance = assuranceOverride === undefined
      ? await loadAssurance(this.store)
      : { manifest: assuranceOverride, approval: null, ...(assuranceOverride ? { fingerprint: assuranceManifestDigest(assuranceOverride) } : {}) };
    const snapshot = createWorkflowPlanSnapshot({
      spec: specDoc,
      tasks: taskDocs,
      planBody,
      config,
      project,
      discoveryContext: await readWorkflowDiscoveryContext(this.projectRoot),
      ...(assurance.fingerprint !== undefined ? { assuranceFingerprint: assurance.fingerprint } : {}),
    });
    return { snapshot, spec: specDoc.data, tasks, config, assurance };
  }

  async #requireCurrentPlanApproval(): Promise<{
    approval: PlanApprovalReceipt;
    snapshot: WorkflowPlanSnapshot;
    spec: Spec;
    tasks: Task[];
    config: LegionConfig;
    assurance: AssuranceState;
  }> {
    const approval = await readPlanApproval(this.store);
    if (!approval) refuse("plan approval is required before execute", "legion-cli plan approve");
    const context = await this.#workflowPlanContext();
    const assurance = bindAssuranceApproval(context.assurance, approval, context.snapshot.planFingerprint);
    if (assurance?.status === "invalid") refuse(assurance.blocker ?? "assurance approval is invalid", "legion-cli plan approve");
    if (context.assurance.manifest) {
      await validateAssuranceContext(context.assurance.manifest, { ...context, projectRoot: this.projectRoot });
    }
    if (approval.specId !== context.snapshot.specId || approval.planFingerprint !== context.snapshot.planFingerprint) {
      refuse("plan approval is stale; review and approve the current plan", "legion-cli plan approve");
    }
    return { approval, ...context };
  }
  async #governanceDeliveryTraceStatus(
    config: LegionConfig,
    approvalId: string,
  ): Promise<"valid" | "incomplete" | "invalid" | "not-adopted"> {
    const modelDigest = await this.#governanceModelDigest(config);
    const trace = await readGovernanceTrace(this.store, approvalId, modelDigest);
    const currentBoundaryOpen = this.#governanceBoundaryActive &&
      trace.frames.at(-1)?.boundary === "begin" &&
      trace.frames.slice(0, -1).every((frame) => frame.boundary === "end" && !governanceOutcomeBlocks(frame.outcome));
    if (trace.status !== "valid" && !(trace.status === "incomplete" && currentBoundaryOpen)) return trace.status;
    return trace.frames.some((frame) => frame.boundary === "end" && governanceOutcomeBlocks(frame.outcome))
      ? "invalid"
      : "valid";
  }

  async #assertAdoptedTraceCurrentLocked(): Promise<void> {
    if (!this.store.holdsLock()) throw new Error("Governance trace validation requires the engine project lock");
    const adopted = await loadAssurance(this.store);
    if (!adopted.manifest || !adopted.approval) return;
    const context = await this.#requireCurrentPlanApproval();
    const approvalId = context.assurance.approval!.approvalId;
    const modelDigest = await this.#governanceModelDigest(context.config);
    const segment = `.legion-cli/audit/governance/${createHash("sha256").update(approvalId).digest("hex")}`;
    if (!(await this.store.pathExists(segment))) refuse("adopted governance trace is missing", "legion-cli plan approve");
    const trace = await reconcileGovernanceTrace(this.store, approvalId, modelDigest, {
      assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); },
    });
    if (trace.status !== "valid" || trace.frames.some((frame) => frame.boundary === "end" && governanceOutcomeBlocks(frame.outcome))) {
      refuse("adopted governance trace is invalid, incomplete, or records a failed operation", "legion-cli plan approve");
    }
  }

  /** The approval identity the latest epoch anchor must name: the adopted sidecar, else the plan receipt. */
  async #governanceEpochIdentity(assurance: AssuranceState): Promise<{ approvalId: string | null; adopted: boolean }> {
    return {
      approvalId: assurance.approval?.approvalId ?? (await readPlanApproval(this.store))?.approvalId ?? null,
      adopted: Boolean(assurance.approval),
    };
  }

  async #assertGovernanceEpochCurrentLocked(opts?: LockEntryOptions): Promise<void> {
    if (opts?.allowLive || opts?.allowInterruptedEpoch) return;
    let anchor: GovernanceEpochs | null;
    try {
      anchor = await readGovernanceEpochs(this.store);
    } catch (error) {
      if (!(error instanceof GovernanceEpochError)) throw error;
      refuse(`governance epoch anchor is invalid: ${error.message}`, "legion-cli context trace validate");
    }
    const assurance = await loadAssurance(this.store);
    if (!anchor) {
      if (assurance.approval) refuse("adopted governance epoch anchor is missing", "legion-cli plan approve");
      return;
    }
    const latest = anchor.epochs.at(-1)!;
    const identity = await this.#governanceEpochIdentity(assurance);
    if (latest.approvalId !== identity.approvalId || latest.adopted !== identity.adopted) {
      refuse(`governance epoch ${latest.approvalId} was interrupted; review and approve the current plan`, "legion-cli plan approve");
    }
  }
  async #governanceProjection(): Promise<GovernanceProjection> {
    const context = await this.#workflowPlanContext();
    const state = await this.#readState();
    const planApproval = await readPlanApproval(this.store);
    const currentApproval = planApproval && planApproval.specId === context.snapshot.specId &&
      planApproval.planFingerprint === context.snapshot.planFingerprint;
    const runStates = await liveRuns(this.projectRoot);
    const taskOwners = new Map<string, { owner: string; liveness: "live" | "dead" | "unknown" }>();
    for (const marker of [...runStates.dead, ...runStates.live]) {
      if (!marker.taskId) continue;
      const liveness = marker.unknown ? "unknown" : runStates.live.some((run) => run.runId === marker.runId) ? "live" : "dead";
      const prior = taskOwners.get(marker.taskId);
      if (!prior || liveness === "live") taskOwners.set(marker.taskId, { owner: marker.runId, liveness });
    }
    const tasks = [...context.tasks].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 256).map((task) => {
      const active = task.status === "in_progress" || task.status === "verifying";
      const owner = active ? taskOwners.get(task.id) : undefined;
      return {
        id: task.id,
        status: task.status,
        owner: owner?.owner ?? null,
        writes: [...task.contract.filesAllowed].sort().slice(0, 256),
        checks: task.status === "done" || task.status === "compacted" ? "passed" as const
          : task.status === "blocked" ? "failed" as const
            : active ? owner?.liveness === "live" ? "running" as const : "unavailable" as const
              : "not-run" as const,
      };
    });
    const receipt = await readWorkflowEvidence(this.store);
    const acceptance = await readAcceptanceReceipt(this.store);
    const productFingerprint = await workflowProductFingerprint(this.projectRoot, context.tasks);
    const evidenceCurrent = Boolean(
      receipt && currentApproval && planApproval && receipt.specId === planApproval.specId &&
      receipt.planFingerprint === planApproval.planFingerprint && receipt.approvalId === planApproval.approvalId &&
      receipt.productFingerprint === productFingerprint &&
      receipt.environmentFingerprint === workflowEnvironmentFingerprint() &&
      (!receipt.review || await workflowReviewEvidenceFresh(this.projectRoot, receipt.review)),
    );
    const integrationCount = planApproval?.verificationCommands.length ?? 0;
    const integrationStatus = !receipt ? "not-run" as const
      : !evidenceCurrent ? "stale" as const
        : receipt.integration.some((run) => !run.ok) ? "failed" as const
          : receipt.status === "running" && receipt.integration.length < integrationCount ? "running" as const
            : integrationCount === 0 && receipt.status !== "running" ? "passed" as const
              : receipt.integration.length > 0 && receipt.integration.length >= integrationCount ? "passed" as const
                // Only a recorded failing command is a failed integration (the stage execute --retry gates);
                // a receipt blocked before integration ran (a task failure or an interrupted command) is not.
                : "not-run" as const;
    const assuranceExecution = await readAssuranceExecution(this.store);
    const assuranceApproval = context.assurance.approval;
    const assuranceExecutionCurrent = Boolean(
      assuranceExecution && assuranceApproval && currentApproval && assuranceExecution.approvalId === assuranceApproval.approvalId &&
      assuranceExecution.manifestDigest === context.assurance.fingerprint &&
      assuranceExecution.productFingerprint === productFingerprint,
    );
    const components = (context.assurance.manifest?.validators ?? []).map((validator) => {
      const execution = assuranceExecution?.checks.find((check) => check.checkId === validator.id);
      return {
        checkId: validator.id,
        status: !assuranceExecution ? "not-run" as const
          : !assuranceExecutionCurrent ? "stale" as const
            : !execution ? "unavailable" as const
              : execution.result === "passed" ? "passed" as const
                : execution.result === "failed" ? "failed" as const : "unavailable" as const,
      };
    }).sort((a, b) => a.checkId.localeCompare(b.checkId)).slice(0, 256);
    const acceptanceCurrent = Boolean(
      acceptance && planApproval && currentApproval && acceptance.specId === planApproval.specId &&
      acceptance.planFingerprint === planApproval.planFingerprint && acceptance.approvalId === planApproval.approvalId &&
      acceptance.productFingerprint === productFingerprint,
    );
    let claim: { owner: string | null; liveness: "none" | "live" | "dead" | "unknown" } = { owner: null, liveness: "none" };
    try {
      const active = await this.store.readYaml(WORKFLOW_CLAIM_PATH, WorkflowClaimSchema);
      // Identity-checked like acquisition: a dead holder's reused PID must not read as a live claim,
      // or a takeover looks like a duplicate claim and a refusal looks like a state change.
      claim = { owner: active.token, liveness: await workflowClaimHolderLive(active) ? "live" : "dead" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const liveReview = runStates.live.some((run) => run.skillId === "review");
    const reviewStatus = this.#reviewProjection ?? (liveReview ? "running" as const
      : receipt?.review ? !evidenceCurrent ? "stale" as const
        : receipt.review.verdict === "PASS" ? "passed" as const : "failed" as const
        : state.lastReview === "PASS" ? "passed" as const
          : state.lastReview === "FAIL" ? "failed" as const : "not-run" as const);
    const acceptanceProjection = context.spec.acceptance.map((criterion) => {
      const item = acceptance?.entries.find((entry) => entry.id === criterion.id);
      return {
        id: criterion.id,
        status: item?.status === "passed" ? "passed" as const
          : item?.status === "failed" ? "failed" as const
            : item?.status === "not_applicable" ? "unknown" as const
              : item ? "not-recorded" as const : "not-recorded" as const,
        freshness: !acceptance ? "unknown" as const : acceptanceCurrent ? "current" as const : "stale" as const,
      };
    }).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 256);
    const ship = this.#shipProjection ?? {
      confirmationId: null,
      previewFingerprint: null,
      confirmed: false,
      status: state.phase === "shipped" ? "complete" as const : "none" as const,
    };
    const projection = {
      schemaVersion: SCHEMA_VERSION.governanceProjection,
      phase: state.phase, controlMode: context.config.control_mode, tasks,
      approval: { id: planApproval?.approvalId ?? null, freshness: !planApproval ? "unknown" as const : currentApproval ? "current" as const : "stale" as const },
      claim,
      integration: integrationStatus,
      components,
      review: reviewStatus,
      acceptance: acceptanceProjection,
      sourceFingerprint: productFingerprint,
      evidenceFingerprint: receipt ? stableHash(JSON.stringify({
        status: receipt.status, productFingerprint: receipt.productFingerprint,
        integration: receipt.integration.map((run) => run.ok), reviewed: Boolean(receipt.review),
      })) : null,
      ship,
    };
    return GovernanceProjectionSchema.parse(projection);
  }

  async #governanceModelDigest(config: LegionConfig): Promise<string> {
    return stableHash({
      adapter: config.adapter ?? null,
      profiles: config.adapter.profiles ?? null,
      skillProfiles: config.adapter.skillProfiles ?? null,
    });
  }

  async #governanceMutation<T>(
    action: GovernanceAction,
    operation: () => Promise<T>,
    options?: { explicitRetry?: boolean },
  ): Promise<T> {
    if (!this.store.holdsLock()) throw new Error("Governance mutation requires the engine project lock");
    if (this.#governanceBoundaryActive) throw new Error("Nested governance boundaries are not permitted");
    const adopted = await loadAssurance(this.store);
    if (!adopted.manifest || !adopted.approval) return operation();
    const context = await this.#requireCurrentPlanApproval();
    const modelDigest = await this.#governanceModelDigest(context.config);
    return this.#appendGovernanceBoundary(action, context.assurance.approval!.approvalId, modelDigest, operation, {
      explicitRetry: options?.explicitRetry ?? false,
    });
  }

  async #governanceMutationForApproval<T>(
    approvalId: string,
    config: LegionConfig,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.store.holdsLock()) throw new Error("Governance mutation requires the engine project lock");
    if (this.#governanceBoundaryActive) throw new Error("Nested governance boundaries are not permitted");
    const modelDigest = await this.#governanceModelDigest(config);
    return this.#appendGovernanceBoundary("approval-adopt", approvalId, modelDigest, operation, { allowMissing: true, explicitRetry: false });
  }

  async #appendGovernanceBoundary<T>(
    action: GovernanceAction,
    approvalId: string,
    modelDigest: string,
    operation: () => Promise<T>,
    options: { allowMissing?: boolean; explicitRetry: boolean },
  ): Promise<T> {
    const segment = `.legion-cli/audit/governance/${createHash("sha256").update(approvalId).digest("hex")}`;
    const lock = { assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); } };
    if (await this.store.pathExists(segment)) {
      const trace = await reconcileGovernanceTrace(this.store, approvalId, modelDigest, lock);
      if (trace.status !== "valid" || trace.frames.some((frame) => frame.boundary === "end" && governanceOutcomeBlocks(frame.outcome))) {
        refuse("adopted governance trace is invalid, incomplete, or records a failed operation", "legion-cli plan approve");
      }
    } else if (!options.allowMissing) {
      refuse("adopted governance trace is missing", "legion-cli plan approve");
    }
    const fault = this.#fakeGovernanceFault;
    const correlationId = randomUUID();
    const explicitRetry = options.explicitRetry;
    const previousBoundaryActive = this.#governanceBoundaryActive;
    const before = await this.#governanceProjection();
    await appendGovernanceBegin(this.store, {
      approvalId, modelDigest, correlationId, action, before, explicitRetry, recordedAt: nowIso(),
    }, lock, fault ? { afterFrame: () => fault("after-begin-frame"), afterHead: () => fault("after-begin-head") } : undefined);
    this.#governanceBoundaryActive = true;
    try {
      const result = await operation();
      if (fault) await fault("after-mutation");
      await appendGovernanceEnd(this.store, {
        approvalId, modelDigest, correlationId, action, after: await this.#governanceProjection(),
        outcome: "success", explicitRetry, recordedAt: nowIso(),
      }, lock, fault ? { afterFrame: () => fault("after-end-frame"), afterHead: () => fault("after-end-head") } : undefined);
      return result;
    } catch (error) {
      try {
        const after = await this.#governanceProjection();
        // A typed refusal that left the governed projection untouched is a precondition denial, not a
        // failed operation: it must not poison the epoch. Any state change keeps the blocking outcome.
        const outcome = error instanceof LegionRefuseError && canonicalJson(after) === canonicalJson(before) ? "refused" : "failed";
        await appendGovernanceEnd(this.store, {
          approvalId, modelDigest, correlationId, action, after, outcome, explicitRetry, recordedAt: nowIso(),
        }, lock);
      } catch (boundaryError) {
        throw new AggregateError([error, boundaryError], "Governance failure boundary could not be safely appended");
      }
      throw error;
    } finally {
      this.#governanceBoundaryActive = previousBoundaryActive;
    }
  }

  /**
   * Information-flow posture plus the completed tasks whose latest governed execute run is not current. A run is
   * current when it completed under the current approval, or under a predecessor approval whose recorded authority is
   * exactly what the current approval would grant (same manifest, policy, contract, prompt, configuration, provider).
   */
  async #governedExecutionEvidence(
    assurance: AssuranceState,
    tasks: readonly Task[],
  ): Promise<{ posture: NonNullable<AssuranceState["status"]>["informationFlow"]; staleTaskIds: string[] }> {
    const plan = assurance.manifest;
    if (plan?.security.mode !== "information-flow") return { posture: "not-enforced", staleTaskIds: [] };
    const approval = assurance.approval;
    const manifestDigest = assurance.fingerprint;
    if (!approval || !manifestDigest) return { posture: "pending", staleTaskIds: [] };
    const completed = tasks.filter((task) => task.status === "done" || task.status === "compacted");
    if (completed.length === 0) return { posture: "pending", staleTaskIds: [] };
    const config = await this.#readConfig();
    const resumes = await listCacheResumes(this.projectRoot);
    const staleTaskIds: string[] = [];
    for (const task of completed) {
      const resume = resumes
        .filter((item) => item.taskId === task.id && item.skillId === "execute")
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      const governed = resume && resume.schemaVersion === SCHEMA_VERSION.resume && resume.adapterId === "http"
        ? await inspectGovernedRun({ store: this.store, runId: resume.runId, manifestDigest }).catch(() => null)
        : null;
      if (!resume || governed?.checkpoint.status !== "complete" || governed.checkpoint.phase !== "program") {
        staleTaskIds.push(task.id);
        continue;
      }
      const identities = governed.checkpoint.identities;
      if (identities.approvalId === approval.approvalId) continue;
      const resolution = resolveAdapterId({ config, skillId: "execute", taskAdapter: task.adapter, taskProfile: task.profile });
      const effectiveConfig = resolution.profileConfig
        ? applyProfileArgs(config, {
            adapterId: resolution.id,
            source: resolution.source,
            ...(resolution.profile ? { profile: resolution.profile } : {}),
            config: resolution.profileConfig,
          })
        : config;
      const http = effectiveConfig.adapter.http;
      const profile = resolution.profile ?? "default";
      const provider = http ? { endpoint: http.baseUrl, model: http.model, profile } : null;
      const schemaIdentities = await readGovernedRunSchemaIdentities(this.store, resume.runId, identities.policyFingerprint).catch(() => null);
      const current = resolution.id === "http" && provider !== null && schemaIdentities !== null &&
        canonicalJson(identities.provider) === canonicalJson(provider) &&
        identities.configurationFingerprint === governedConfigurationFingerprint(effectiveConfig, profile, resolution.profileConfig) &&
        identities.contractFingerprint === stableHash(task.contract) &&
        identities.promptFingerprint === stableHash("legion-cli-approved-task-planner/v1") &&
        identities.policyFingerprint === currentGovernedTaskPolicyFingerprint({
          plan, approval, task, provider, manifestDigest, config: effectiveConfig, recordedSchemaFingerprints: schemaIdentities,
        });
      if (!current) staleTaskIds.push(task.id);
    }
    const posture = staleTaskIds.length === 0
      ? completed.length === tasks.length ? "enforced" : "pending"
      : staleTaskIds.length < completed.length ? "partial" : "not-enforced";
    return { posture, staleTaskIds };
  }

  /** Posture driving component-stage policy status; adapter-default manifests are never information-flow enforced. */
  async #componentPolicyPosture(assurance: AssuranceState, tasks: readonly Task[]): Promise<NonNullable<AssuranceState["status"]>["informationFlow"]> {
    return (await this.#governedExecutionEvidence(assurance, tasks)).posture;
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

  async #readLastQa(state: StateFile): Promise<AnyQAScore | null> {
    if (!state.lastQaId) return null;
    const abs = join(this.store.paths.qaDir, "scores", `${state.lastQaId}.json`);
    try {
      const raw = JSON.parse(await readFile(abs, "utf8"));
      return AnyQAScoreSchema.parse(raw);
    } catch {
      return null;
    }
  }

  async #currentQaEvidence(state: StateFile): Promise<QAScore | null> {
    const score = await this.#readLastQa(state);
    if (!score || score.schemaVersion !== SCHEMA_VERSION.qa || !state.activeSpecId) return null;
    if (score.specId !== state.activeSpecId) return null;
    let specDoc: Awaited<ReturnType<LegionStore["readSpec"]>>;
    try {
      specDoc = await this.store.readSpec(state.activeSpecId);
    } catch {
      return null;
    }
    const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
    const freshness = await evaluateQaEvidenceFreshness({
      projectRoot: this.projectRoot,
      activeSpecId: state.activeSpecId,
      spec: specDoc.data,
      specBody: specDoc.body,
      tasks: slice,
      score,
    });
    return freshness.current ? score : null;
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

  async #assertCurrentShipGate(state: StateFile, opts: ShipOptions): Promise<void> {
    const config = await this.#readConfig();
    const adopted = await loadAssurance(this.store);
    if (adopted.manifest && adopted.approval && !this.#governanceBoundaryActive) {
      const context = await this.#requireCurrentPlanApproval();
      const approvalId = adopted.approval.approvalId;
      const modelDigest = await this.#governanceModelDigest(context.config);
      const segment = `.legion-cli/audit/governance/${createHash("sha256").update(approvalId).digest("hex")}`;
      if (!(await this.store.pathExists(segment))) refuse("adopted governance trace is missing", "legion-cli plan approve");
      const trace = await reconcileGovernanceTrace(this.store, approvalId, modelDigest, {
        assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); },
      });
      if (trace.status !== "valid" || trace.frames.some((frame) => frame.boundary === "end" && governanceOutcomeBlocks(frame.outcome))) {
        refuse("adopted governance trace is invalid, incomplete, or records a failed operation", "legion-cli plan approve");
      }
    }
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
    const lastQa = await this.#currentQaEvidence(state);
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
    const p0NotPassed = lastQa.criteria.filter(
      (criterion) => criterion.priority === "P0" && criterion.outcome !== "passed",
    );
    if (p0NotPassed.length > 0 || lastQa.buckets.p0.failed > 0) {
      refuse("ship --allow-degraded-qa requires passing evidence for every P0 criterion", HINT.qa);
    }
    if (lastQa.reportFailures > 0) {
      refuse("ship --allow-degraded-qa cannot waive failed test reports", HINT.qa);
    }
    if (state.phase !== "executing" && state.phase !== "ready_to_ship") {
      refuse("ship requires ready_to_ship (or --allow-degraded-qa)", HINT.qa);
    }
  }

  async #stageShipLocked(state: StateFile, captureDelivery = false): Promise<ShipPreview> {
    const slice = sliceTasks(await this.#listGateTasks(), state.activeSpecId);
    const allowedFiles = unionDoneFilesAllowed(slice);
    const allowedSet = new Set(allowedFiles);
    const qa = await this.#currentQaEvidence(state);
    const qaCoverage = {
      missing: qa?.missingCriterionIds ?? [],
      failed: qa?.failedCriterionIds ?? [],
      skipped: qa?.skippedCriterionIds ?? [],
    };
    const empty: ShipPreview = {
      staged: [],
      added: [],
      stagedDisplay: "(none)",
      diff: "",
      unrelatedUnchanged: true,
      unrelated: [],
      productFingerprint: "",
      qaCoverage,
    };
    if (!isGitRepo(this.projectRoot)) {
      return captureDelivery
        ? { ...empty, productFingerprint: (await deliveryProductInventory(this.projectRoot)).subjectDigest }
        : empty;
    }

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
      qaCoverage,
    };
  }

  async #unstageShip(added: readonly string[]): Promise<void> {
    await this.#mutate(async () => this.#governanceMutation("ship-rollback", async () => {
      if (added.length > 0 && isGitRepo(this.projectRoot)) gitRestoreStaged(this.projectRoot, [...added]);
      if (this.#shipProjection) this.#shipProjection = { ...this.#shipProjection, confirmed: false, status: "aborted" };
    }));
  }

  async #completeShipLocked(
    state: StateFile,
    opts: ShipOptions,
    preview: ShipPreview,
    deliveryId: string | null,
  ): Promise<{
    receipt: ShipReceipt;
    snapshotId?: string;
    preparedDigest?: string;
    rollback?: {
      state: StateFile;
      specId: string;
      actor: string;
      receiptPath: string;
      reason: string;
      priorHead: string | null;
      keptRootCommit: boolean;
      commitSha?: string;
    };
  }> {
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

    let preparedDigest: string | undefined;
    if (deliveryId) {
      const adopted = await loadAssurance(this.store);
      const isAdopted = Boolean(adopted.manifest && adopted.approval);
      const product = await deliveryProductInventory(this.projectRoot);
      const preparedAt = nowIso();
      const config = await this.#readConfig();
      const modelDigest = isAdopted ? await this.#governanceModelDigest(config) : null;
      let trace: GovernanceTrace;
      if (isAdopted) {
        const current = await readGovernanceTrace(this.store, adopted.approval!.approvalId, modelDigest!);
        if (current.frames.at(-1)?.action !== "ship-confirm" || current.frames.at(-1)?.boundary !== "begin") {
          throw new Error("Adopted delivery preparation requires the open ship-confirm boundary");
        }
        const frames = current.frames.slice(0, -1);
        trace = {
          schemaVersion: SCHEMA_VERSION.governanceTrace,
          status: "valid",
          approvalId: adopted.approval!.approvalId,
          modelDigest: modelDigest!,
          headDigest: frames.at(-1)?.digest ?? null,
          frames,
        };
      } else trace = { schemaVersion: SCHEMA_VERSION.governanceTrace, status: "not-adopted", frames: [] };

      const tokenMapping: PreparedDeliverySnapshot["tokenMapping"] = [];
      const localTokens = new Map<string, string>();
      const addToken = (kind: PreparedDeliverySnapshot["tokenMapping"][number]["kind"], localId: string): string => {
        const key = `${kind}:${localId}`;
        const existing = localTokens.get(key);
        if (existing) return existing;
        const token = randomUUID();
        localTokens.set(key, token);
        tokenMapping.push({ token, localId, kind });
        return token;
      };
      const confirmationToken = addToken("confirmation", deliveryId);
      const approvalId = adopted.approval?.approvalId ?? null;
      const approvalToken = approvalId ? addToken("approval", approvalId) : null;
      const specToken = specId ? addToken("spec", specId) : null;
      const manifestDigest = adopted.fingerprint ?? null;
      const mode: PreparedDeliverySnapshot["evidence"]["mode"] = isAdopted ? adopted.manifest!.security.mode : "not-adopted";
      const environmentFingerprint = sha256Hex(Buffer.from(canonicalJson(config), "utf8"));
      const manifest = adopted.manifest;
      const identities: PreparedDeliverySnapshot["predicate"]["identities"] = [
        ...(manifest?.taskIds.map((id) => ({ token: addToken("task", id), kind: "task" as const, digest: null })) ?? []),
        ...(manifest?.acceptanceIds.map((id) => ({ token: addToken("acceptance", id), kind: "acceptance" as const, digest: null })) ?? []),
        ...(manifest?.validators.map((item) => ({ token: addToken("check", item.id), kind: "check" as const, digest: item.componentSha256 })) ?? []),
        // Configured profile and model names stay private: only their opaque tokens reach the public predicate.
        ...Object.keys(config.adapter.profiles ?? {}).sort().map((name) => ({ token: addToken("profile", name), kind: "profile" as const, digest: null })),
        ...(config.adapter.http ? [{ token: addToken("model", `http:${config.adapter.http.model}`), kind: "model" as const, digest: null }] : []),
      ];
      const artifacts = await Promise.all((manifest?.delivery.artifacts ?? []).map(async (artifact) => {
        const descriptor = product.entries.find((entry) => entry.path === artifact.path);
        if (!descriptor || descriptor.kind === "gitlink" || (descriptor.kind === "blob" && descriptor.mode === "120000")) {
          throw new Error(`Approved artifact must be a regular product file: ${artifact.path}`);
        }
        const absolute = toFsPath(this.projectRoot, artifact.path);
        await assertNoLinkInPath(absolute, { root: this.projectRoot });
        const stats = await lstat(absolute);
        if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Approved artifact must be a regular non-symlink file: ${artifact.path}`);
        return { name: artifact.name, path: artifact.path, sha256: descriptor.sha256, size: descriptor.size };
      }));
      const assuranceEvidence = isAdopted
        ? await inspectAssuranceEvidence(this.store, adopted, manifest!.acceptanceIds, await this.#componentPolicyPosture(adopted, sliceTasks(await this.#listGateTasks(), state.activeSpecId)))
        : null;
      const hostIdentities = new Map<string, { token: string; kind: "host"; digest: string }>();
      const checkEvidence = assuranceEvidence
        ? await Promise.all(assuranceEvidence.checks.map(async (check) => {
          if (check.reusedFrom) addToken("check", check.reusedFrom);
          if (check.executionId) addToken("check", check.executionId);
          const receipt = await readDeliveryCheckEvidence(
            this.store,
            approvalId!,
            check.checkId,
            check.executionId,
            adopted.approval!.nativeHost,
          );
          if (receipt.runtime) {
            const digest = sha256Hex(Buffer.from(canonicalJson(receipt.runtime), "utf8"));
            hostIdentities.set(receipt.runtime.target, {
              token: addToken("host", receipt.runtime.target),
              kind: "host",
              digest,
            });
          }
          return {
            id: check.checkId,
            status: check.result === "passed" ? "passed" as const : check.result === "failed" ? "failed" as const : "unavailable" as const,
            inputDigest: check.inputDigest,
            observationDigest: receipt.observationDigest,
            executionId: check.executionId,
            reusedFrom: check.reusedFrom,
            trustTier: "component-closed-input" as const,
            moduleDigest: manifest!.validators.find((item) => item.id === check.checkId)?.componentSha256 ?? null,
            runtimeDigest: receipt.runtime ? sha256Hex(Buffer.from(canonicalJson(receipt.runtime), "utf8")) : null,
            recordedAt: receipt.recordedAt ?? preparedAt,
          };
        }))
        : [];
      identities.push(...hostIdentities.values());
      const acceptanceReceipt = isAdopted ? await readAcceptanceReceipt(this.store) : null;
      const acceptanceEvidence = (manifest?.acceptanceIds ?? []).map((id) => {
        const matchingReceipt = acceptanceReceipt?.approvalId === approvalId ? acceptanceReceipt : null;
        const entry = matchingReceipt?.entries.find((item) => item.id === id);
        const status = entry?.status === "passed" ? "passed" as const : entry?.status === "failed" ? "failed" as const : "unknown" as const;
        const recordedAt = matchingReceipt?.recordedAt ?? preparedAt;
        const evidenceDigest = status === "unknown"
          ? null
          : sha256Hex(Buffer.from(canonicalJson({
            approvalId,
            planFingerprint: matchingReceipt!.planFingerprint,
            productFingerprint: matchingReceipt!.productFingerprint,
            recordedAt: matchingReceipt!.recordedAt,
            entry,
          }), "utf8"));
        return { id, status, evidenceDigest, recordedAt };
      });
      for (const acceptance of acceptanceEvidence) addToken("acceptance", acceptance.id);
      const publicChecks = checkEvidence.map((check) => ({
        token: addToken("check", check.id),
        status: check.status,
        inputDigest: check.inputDigest,
        resultDigest: check.observationDigest,
      }));
      const publicAcceptance = acceptanceEvidence.map((item) => ({
        token: addToken("acceptance", item.id),
        status: item.status,
        evidenceDigest: item.evidenceDigest,
      }));
      const traceStatus: PreparedDeliverySnapshot["predicate"]["traceStatus"] = isAdopted ? "valid" : "not-adopted";
      const predicate: PreparedDeliverySnapshot["predicate"] = {
        schemaVersion: SCHEMA_VERSION.deliveryPredicate,
        confirmation: confirmationToken,
        approval: approvalToken,
        spec: specToken,
        assuranceManifestDigest: manifestDigest,
        subjectDigest: product.subjectDigest,
        executionDigest: preview.productFingerprint,
        mode,
        traceStatus,
        modelDigest,
        policyDigest: manifestDigest,
        identities,
        checks: publicChecks,
        acceptance: publicAcceptance,
        preparedAt,
      };
      const prepared: PreparedDeliverySnapshot = {
        confirmationId: deliveryId,
        approvalId,
        captureMode: isAdopted ? "adopted" : "legacy-bundle",
        preparedAt,
        executionFingerprint: preview.productFingerprint,
        environmentFingerprint,
        product,
        artifacts: { artifacts },
        evidence: {
          approvalId,
          specId: specId || null,
          manifestDigest,
          executionFingerprint: preview.productFingerprint,
          environmentFingerprint,
          mode,
          checks: checkEvidence,
          acceptance: acceptanceEvidence,
          policyDigest: manifestDigest,
          modelDigest,
          sourceScope: isAdopted ? "declared-component-inputs" : "whole-working-product",
        },
        trace,
        predicate,
        tokenMapping,
      };
      preparedDigest = await prepareDeliverySnapshot(this.store, prepared, {
        assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); },
      });
      receipt.snapshotId = deliveryId;
    }

    assertCanTransition(state.phase, "shipped");
    await this.#writeState({
      ...state,
      phase: "shipped",
      currentTaskId: null,
    });
    if (this.#shipProjection) this.#shipProjection = { ...this.#shipProjection, status: "complete" };
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
      confirmSource: opts.confirmSource ?? null,
    });

    const priorHead = isGitRepo(this.projectRoot) ? tryGitHead(this.projectRoot) : null;
    if (isGitRepo(this.projectRoot)) {
      // Product paths were staged before confirm. Re-adding a staged deletion fails
      // (`pathspec did not match`); only pick up receipt / STATE / .legion-cli here.
      gitAdd(this.projectRoot, [".legion-cli"]);
      receipt.staged = gitStagedPaths(this.projectRoot);
      if (opts.commit && gitHasStaged(this.projectRoot)) {
        try {
          receipt.commitSha = gitCommitIndex(this.projectRoot, shipCommitMessage(specId));
          receipt.committed = true;
        } catch (error) {
          if (deliveryId) await abortDeliverySnapshot(this.store, deliveryId, nowIso(), "commit-failed", tryGitHead(this.projectRoot), {
            assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); },
          });
          throw error;
        }
      }
      if (deliveryId) {
        const prepared = await readDeliverySnapshot(this.store, deliveryId);
        const actualProduct = receipt.commitSha
          ? gitCommitProductInventory(this.projectRoot, receipt.commitSha)
          : await deliveryProductInventory(this.projectRoot);
        if (actualProduct.subjectDigest !== prepared.prepared.product.subjectDigest) {
          await abortDeliverySnapshot(this.store, deliveryId, nowIso(), "subject-changed", receipt.commitSha ?? null, {
            assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); },
          });
          refuse(SHIP_STAGED_CHANGED, HINT.ship);
        }
      }

    }
    if (!isGitRepo(this.projectRoot) && deliveryId) {
      const prepared = await readDeliverySnapshot(this.store, deliveryId);
      const actualProduct = await nativeProductInventory(this.projectRoot);
      if (actualProduct.subjectDigest !== prepared.prepared.product.subjectDigest) {
        await abortDeliverySnapshot(this.store, deliveryId, nowIso(), "subject-changed", null, {
          assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); },
        });
        refuse(SHIP_STAGED_CHANGED, HINT.ship);
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
      let created: { url?: string; error?: string };
      try {
        created = await (opts.prCreate
          ? opts.prCreate({ cwd: this.projectRoot, title, body })
          : tryCreatePullRequest(this.projectRoot, title, body));
      } catch (error) {
        if (deliveryId) await abortDeliverySnapshot(this.store, deliveryId, nowIso(), "pr-failed", receipt.commitSha ?? null, {
          assertLockOwned: () => { if (!this.store.holdsLock()) throw new Error("Engine lock is not owned"); },
        });
        throw error;
      }
      if (created.error || !created.url) {
        const keptRootCommit = Boolean(receipt.commitSha) && !priorHead;
        return {
          receipt,
          rollback: {
            state,
            specId,
            actor,
            receiptPath,
            reason: created.error ?? "no pull request url",
            priorHead,
            keptRootCommit,
            ...(receipt.commitSha ? { commitSha: receipt.commitSha } : {}),
          },
          ...(deliveryId && preparedDigest ? { snapshotId: deliveryId, preparedDigest } : {}),
        };
      }
      receipt.prUrl = created.url;
    }

    return {
      receipt,
      ...(deliveryId && preparedDigest ? { snapshotId: deliveryId, preparedDigest } : {}),
    };
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
    } catch (err) {
      // Best-effort except tamper: I/O and validation failures are swallowed, a tampered or
      // unreadable chain is never hidden (lock entry also checks it before mutating).
      if (err instanceof AuditTamperError) throw err;
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
      exitCode: this.#fakeExitCode,
      omitSummary: this.#fakeOmitSummary,
      holdWait: this.#fakeHoldWait,
      onWait: this.#fakeOnWait,
      handlePid: this.#fakeHandlePid,
    };
  }
  async #governedExecuteSpawnOptions(
    task: Task,
    config: LegionConfig,
    selection: { adapter?: AdapterId; profile?: string },
  ) {
    const assuranceState = await loadAssurance(this.store);
    if (!assuranceState.manifest || assuranceState.manifest.security.mode !== "information-flow") return undefined;
    const current = await this.#requireCurrentPlanApproval();
    const plan = current.assurance.manifest;
    const approval = current.assurance.approval;
    if (!plan || !approval || plan.security.mode !== "information-flow") return undefined;
    const resolution = resolveAdapterId({
      config,
      skillId: "execute",
      taskAdapter: task.adapter,
      cliAdapter: selection.adapter,
      taskProfile: task.profile,
      cliProfile: selection.profile,
    });
    if (resolution.id !== "http") {
      refuse("information-flow execute requires the approved HTTP controller; the selected adapter cannot enforce it", HINT.doctor);
    }
    const effectiveConfig = resolution.profileConfig
      ? applyProfileArgs(config, {
          adapterId: resolution.id,
          source: resolution.source,
          ...(resolution.profile ? { profile: resolution.profile } : {}),
          config: resolution.profileConfig,
        })
      : config;
    const http = effectiveConfig.adapter.http;
    if (!http) refuse("information-flow execute requires a configured HTTP provider", HINT.plan);
    const spec = current.spec;
    const profile = resolution.profile ?? "default";
    const provider = { endpoint: http.baseUrl, model: http.model, profile };
    const runtimeOptions = {
      store: this.store,
      plan,
      approval,
      spec,
      task,
      runId: "",
      skillId: "execute" as const,
      config: effectiveConfig,
      profile,
      provider,
      promptFingerprint: stableHash("legion-cli-approved-task-planner/v1"),
      configurationFingerprint: governedConfigurationFingerprint(effectiveConfig, profile, resolution.profileConfig),
      contractFingerprint: stableHash(task.contract),
      sourceFingerprint: "",
      jailFingerprint: "",
      jailRoot: "",
      manifestDigest: current.assurance.fingerprint ?? assuranceManifestDigest(plan),
      allowedWrites: [...task.contract.filesAllowed],
      filesForbidden: [...task.contract.filesForbidden],
      artifactPaths: [...task.contract.expectedArtifacts],
    };
    return {
      ...runtimeOptions,
      withLock: <T>(runId: string, callback: () => Promise<T>) =>
        this.#withLockOrRefuse(callback, { ownRunId: runId }),
      resolveCurrentContext: async (identity: {
        runId: string;
        sourceFingerprint: string;
        jailFingerprint: string;
        jailRoot: string;
        allowedWrites: readonly string[];
        filesForbidden: readonly string[];
        artifactPaths: readonly string[];
        /** The running spawn's descriptors; omitted outside a run, where the current tools are listed live. */
        externalTools?: readonly GovernedMcpDescriptor[];
      }) => {
        const refreshed = await this.#requireCurrentPlanApproval();
        const refreshedPlan = refreshed.assurance.manifest;
        const refreshedApproval = refreshed.assurance.approval;
        if (!refreshedPlan || !refreshedApproval || refreshedPlan.security.mode !== "information-flow") {
          refuse("information-flow authority is no longer approved", "legion-cli plan approve");
        }
        const currentTask = refreshed.tasks.find((candidate) => candidate.id === task.id);
        if (!currentTask) refuse("approved execute task no longer exists", "legion-cli plan approve");
        const currentResolution = resolveAdapterId({
          config: refreshed.config,
          skillId: "execute",
          taskAdapter: currentTask.adapter,
          cliAdapter: selection.adapter,
          taskProfile: currentTask.profile,
          cliProfile: selection.profile,
        });
        if (currentResolution.id !== "http") refuse("information-flow execute adapter changed", HINT.doctor);
        const currentConfig = currentResolution.profileConfig
          ? applyProfileArgs(refreshed.config, {
              adapterId: currentResolution.id,
              source: currentResolution.source,
              ...(currentResolution.profile ? { profile: currentResolution.profile } : {}),
              config: currentResolution.profileConfig,
            })
          : refreshed.config;
        const currentHttp = currentConfig.adapter.http;
        if (!currentHttp) refuse("information-flow provider configuration was removed", HINT.plan);
        const currentProfile = currentResolution.profile ?? "default";
        return buildApprovedHttpAssuranceContext({
          ...runtimeOptions,
          plan: refreshedPlan,
          approval: refreshedApproval,
          spec: refreshed.spec,
          task: currentTask,
          config: currentConfig,
          profile: currentProfile,
          provider: { endpoint: currentHttp.baseUrl, model: currentHttp.model, profile: currentProfile },
          promptFingerprint: stableHash("legion-cli-approved-task-planner/v1"),
          configurationFingerprint: governedConfigurationFingerprint(currentConfig, currentProfile, currentResolution.profileConfig),
          contractFingerprint: stableHash(currentTask.contract),
          runId: identity.runId,
          sourceFingerprint: identity.sourceFingerprint,
          jailFingerprint: identity.jailFingerprint,
          jailRoot: identity.jailRoot,
          allowedWrites: identity.allowedWrites,
          filesForbidden: identity.filesForbidden,
          artifactPaths: identity.artifactPaths,
          externalTools: identity.externalTools ?? await currentGovernedMcpDescriptors(currentConfig, refreshedPlan),
          manifestDigest: refreshed.assurance.fingerprint ?? assuranceManifestDigest(refreshedPlan),
        });
      },
    };
  }

  async #governedReviewSpawnOptions(
    config: LegionConfig,
    selection: { adapter?: AdapterId; profile?: string },
  ) {
    const assuranceState = await loadAssurance(this.store);
    if (!assuranceState.manifest || assuranceState.manifest.security.mode !== "information-flow") return undefined;
    const current = await this.#requireCurrentPlanApproval();
    const plan = current.assurance.manifest;
    const approval = current.assurance.approval;
    if (!plan || !approval) refuse("information-flow review requires current approval", "legion-cli plan approve");
    const resolution = resolveAdapterId({ config, skillId: "review", cliAdapter: selection.adapter, cliProfile: selection.profile });
    if (resolution.id !== "http") refuse("information-flow review requires the governed HTTP controller", HINT.doctor);
    const effectiveConfig = resolution.profileConfig
      ? applyProfileArgs(config, {
          adapterId: resolution.id,
          source: resolution.source,
          ...(resolution.profile ? { profile: resolution.profile } : {}),
          config: resolution.profileConfig,
        })
      : config;
    const http = effectiveConfig.adapter.http;
    if (!http) refuse("information-flow review requires a configured HTTP provider", HINT.plan);
    const profile = resolution.profile ?? "default";
    const makeReviewContract = (tasks: readonly Task[], runId?: string) => ({
      kind: "independent-review",
      artifact: `.legion-cli/cache/runs/${runId ?? "<runId>"}/review.md`,
      acceptance: current.spec.acceptance.map(({ id, statement }) => ({ id, statement })),
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        filesAllowed: task.contract.filesAllowed,
        filesForbidden: task.contract.filesForbidden,
        expectedArtifacts: task.contract.expectedArtifacts,
      })),
    });
    const reviewContract = makeReviewContract(current.tasks);
    const runtimeOptions = {
      store: this.store,
      plan,
      approval,
      spec: current.spec,
      task: null,
      runId: "",
      skillId: "review" as const,
      config: effectiveConfig,
      profile,
      provider: { endpoint: http.baseUrl, model: http.model, profile },
      promptFingerprint: stableHash("legion-cli-independent-review/v1"),
      configurationFingerprint: governedConfigurationFingerprint(effectiveConfig, profile, resolution.profileConfig),
      contractFingerprint: stableHash(reviewContract),
      sourceFingerprint: "",
      jailFingerprint: "",
      jailRoot: "",
      manifestDigest: current.assurance.fingerprint ?? assuranceManifestDigest(plan),
      allowedWrites: [] as string[],
      filesForbidden: [] as string[],
      artifactPaths: [] as string[],
      reviewContract,
    };
    const resolveCurrentContext = async (identity: {
      runId: string; sourceFingerprint: string; jailFingerprint: string; jailRoot: string;
      allowedWrites: readonly string[]; filesForbidden: readonly string[]; artifactPaths: readonly string[];
      externalTools?: readonly GovernedMcpDescriptor[];
    }) => {
      const refreshed = await this.#requireCurrentPlanApproval();
      const refreshedPlan = refreshed.assurance.manifest;
      const refreshedApproval = refreshed.assurance.approval;
      if (!refreshedPlan || !refreshedApproval || refreshedPlan.security.mode !== "information-flow") {
        refuse("information-flow review authority is no longer approved", "legion-cli plan approve");
      }
      const currentResolution = resolveAdapterId({
        config: refreshed.config, skillId: "review", cliAdapter: selection.adapter, cliProfile: selection.profile,
      });
      if (currentResolution.id !== "http") refuse("information-flow review adapter changed", HINT.doctor);
      const currentConfig = currentResolution.profileConfig
        ? applyProfileArgs(refreshed.config, {
            adapterId: currentResolution.id,
            source: currentResolution.source,
            ...(currentResolution.profile ? { profile: currentResolution.profile } : {}),
            config: currentResolution.profileConfig,
          })
        : refreshed.config;
      const currentHttp = currentConfig.adapter.http;
      if (!currentHttp) refuse("information-flow review provider was removed", HINT.plan);
      const currentProfile = currentResolution.profile ?? "default";
      const currentReviewContract = makeReviewContract(refreshed.tasks, identity.runId);
      return buildApprovedHttpAssuranceContext({
        ...runtimeOptions,
        plan: refreshedPlan,
        approval: refreshedApproval,
        spec: refreshed.spec,
        config: currentConfig,
        profile: currentProfile,
        provider: { endpoint: currentHttp.baseUrl, model: currentHttp.model, profile: currentProfile },
        configurationFingerprint: governedConfigurationFingerprint(currentConfig, currentProfile, currentResolution.profileConfig),
        contractFingerprint: stableHash(currentReviewContract),
        reviewContract: currentReviewContract,
        runId: identity.runId,
        sourceFingerprint: identity.sourceFingerprint,
        jailFingerprint: identity.jailFingerprint,
        jailRoot: identity.jailRoot,
        allowedWrites: identity.allowedWrites,
        filesForbidden: identity.filesForbidden,
        artifactPaths: identity.artifactPaths,
        externalTools: identity.externalTools ?? await currentGovernedMcpDescriptors(currentConfig, refreshedPlan),
        manifestDigest: refreshed.assurance.fingerprint ?? assuranceManifestDigest(refreshedPlan),
      });
    };
    return {
      ...runtimeOptions,
      withLock: <T>(runId: string, callback: () => Promise<T>) =>
        this.#withLockOrRefuse(callback, { ownRunId: runId }),
      resolveCurrentContext,
    };
  }

  async #recordGovernedAppliedFiles(runId: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const governed = await inspectGovernedRun({ store: this.store, runId });
    if (!governed || governed.checkpoint.phase !== "program") return;
    const checkpoint = governed.checkpoint;
    for (const projectRelativePath of paths) {
      const operation = checkpoint.program.operations.find(
        (candidate) => candidate.kind === "write" && normalizePathKey(candidate.path) === normalizePathKey(projectRelativePath),
      );
      if (!operation || operation.kind !== "write") continue;
      const absolute = toFsPath(this.projectRoot, projectRelativePath);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("governed applied artifact exceeds its bounded provenance size");
      const bytes = await readFile(absolute);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const effect = checkpoint.effects.find((candidate) =>
        candidate.kind === "write" &&
        candidate.operationId === operation.id &&
        candidate.state === "completed" &&
        candidate.outcome?.kind === "success" &&
        candidate.resultDigest === digest,
      );
      if (!effect) throw new Error(`applied governed output ${projectRelativePath} has no matching completed write action`);
      await recordAppliedFileProvenance({
        store: this.store,
        withLock: (callback) => this.#withLockOrRefuse(callback, { ownRunId: runId }),
        approvalId: checkpoint.identities.approvalId,
        runId,
        actionId: effect.actionId,
        projectRelativePath,
        bytes,
      });
    }
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
      if (resume && ["live", "unknown"].includes(await inspectResumeOwner(resume))) {
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
    // Only a task that is (or may be) in flight needs a run lookup: skip the cache/runs scan when
    // there is no current task and the summary index shows no in_progress/verifying task. An
    // unreadable task (ok:false) can never be recovered (readTask throws below), so it is ignored.
    // Assumption: the summary index is an mtime+size cache under index/ (agents cannot write it); a
    // status flip that keeps both identical would hide an in-flight task until the next lock entry
    // sees a changed file. Reading every task file instead would cost O(tasks) parsing per lock entry.
    if (!state.currentTaskId) {
      const summaries = await listTaskSummaries(this.projectRoot);
      const inFlight = summaries.some(
        (row) => row.ok && (row.status === "in_progress" || row.status === "verifying"),
      );
      if (!inFlight) return;
    }
    const resumes = await listCacheResumes(this.projectRoot);
    const latestByTask = new Map<string, (typeof resumes)[number]>();
    for (const resume of resumes) {
      if (!resume.taskId) continue;
      const prev = latestByTask.get(resume.taskId);
      if (!prev || resume.startedAt > prev.startedAt) latestByTask.set(resume.taskId, resume);
    }
    const candidateIds = new Set(latestByTask.keys());
    if (state.currentTaskId) candidateIds.add(state.currentTaskId);
    for (const taskId of state.activeTaskIds ?? []) candidateIds.add(taskId);
    let current = state.currentTaskId ?? null;
    let changedCurrent = false;
    const active = new Set(state.activeTaskIds ?? []);
    let changedActive = false;
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
      if (resume && ["live", "unknown"].includes(await inspectResumeOwner(resume))) continue;
      const isCurrent = current === task.id;
      if (!resume && !isCurrent) continue;
      const httpRecovery = await classifyHttpCrashRecovery(this.projectRoot, task, resume);
      if (httpRecovery.kind === "safe" && resume?.schemaVersion === SCHEMA_VERSION.resume) {
        // Already preserved for `execute --resume` (released ownership, resume hint recorded): nothing to recover,
        // and a read-only entry must not re-run a governed mutation for it.
        if (resume.stage === "interrupted" && resume.engineOwnershipReleasedAt &&
            resume.recoveryCommand === `legion-cli execute --resume ${resume.runId}`) continue;
        await this.#governanceMutation("recover", async () => {
          await updateResumeStage(this.projectRoot, resume.runId, "interrupted", {
            pid: null,
            pidStartedAt: null,
            engineOwnershipReleasedAt: nowIso(),
            childTerminationUncertain: false,
            interruptionReason: "HTTP execution was interrupted and has a compatible checkpoint",
            recoveryCommand: `legion-cli execute --resume ${resume.runId}`,
          });
          await this.#audit(
            "recover",
            state.phase,
            "cli",
            { from: task.status, to: task.status, reason: "compatible HTTP checkpoint retained" },
            task.id,
          );
        });
        continue;
      }
      await this.#governanceMutation("recover", async () => {
        if (task.status === "verifying") {
          await this.#audit(
            "recover",
            state.phase,
            "cli",
            { from: "verifying", to: "blocked", reason: "verification was interrupted" },
            task.id,
          );
        }
        if (resume?.schemaVersion === SCHEMA_VERSION.resume) {
          await updateResumeStage(this.projectRoot, resume.runId, "interrupted", {
            interruptionReason:
              httpRecovery.kind === "manual"
                ? httpRecovery.reason
                : task.status === "verifying"
                  ? "verification was interrupted"
                  : "execution was interrupted",
            recoveryCommand: `legion-cli task amend ${task.id} --unblock`,
          });
        }
        await this.#transitionTaskTo(task.id, "blocked");
        if (active.delete(task.id)) changedActive = true;
        if (isCurrent) {
          current = null;
          changedCurrent = true;
        }
      });
    }
    if (changedCurrent || changedActive) {
      await this.#governanceMutation("recover", async () =>
        this.#writeState({
          ...(await this.#readState()),
          ...(changedCurrent ? { currentTaskId: null } : {}),
          ...(changedActive ? { activeTaskIds: [...active] } : {}),
        }),
      );
    }
  }

  async #withLockOrRefuse<T>(
    fn: () => Promise<T>,
    opts?: LockEntryOptions,
  ): Promise<T> {
    try {
      const already = this.store.holdsLock();
      return await this.store.withLock(
        async () => {
          let guardError: unknown;
          if (!already) {
            // Fail closed before any state change if the audit chain is unreadable or rewound.
            await assertAuditChainUsable(this.projectRoot);
            // Writers also get the exact append-time check (full replay only for an old-format chain),
            // so a bad chain refuses before any state moves; read-only entries keep the cheap check.
            if (!opts?.allowLive) await assertAuditAppendable(this.projectRoot);
            // Provably dead run markers are dropped here; live ones keep their open command
            // (reconcile skips them) and refuse every mutating entry below.
            const { live } = await liveRuns(this.projectRoot, { clearDead: true });
            if (!this.#reconciled) {
              await this.store.reconcileUnfinished();
              this.#reconciled = live.length === 0;
            }
            // Writers refuse when the approval identity disagrees with the latest governance epoch
            // anchor (an interrupted or rolled-back reapproval) before recovery can append frames.
            if (!opts?.allowLive) {
              try {
                await this.#assertGovernanceEpochCurrentLocked(opts);
              } catch (err) {
                if (!(err instanceof LegionRefuseError)) throw err;
                guardError = err;
              }
            }
            if (!guardError) await this.#recoverDeadInProgressLocked();
            // "Hands off during execute": one guard for every mutating verb. The run this call
            // is finishing (`ownRunId`) is exempt so execute's relock never refuses itself.
            const resumeRun = opts?.allowLive || guardError ? null : await this.#liveResumeRun(live);
            const running = resumeRun ? [...live, resumeRun] : live;
            if (!opts?.allowLive && !guardError && running.length > 0) {
              try {
                refuseIfLiveRun(running, {
                  ownRunId: opts?.ownRunId,
                  ownRunIds: opts?.ownRunIds,
                });
              } catch (err) {
                guardError = err;
              }
            }
          }
          try {
            if (guardError) throw guardError;
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

  async #mutate<T>(fn: () => Promise<T>, opts?: LockEntryOptions): Promise<T> {
    return this.#withLockOrRefuse(fn, opts);
  }

  /**
   * A run with no marker (an older binary, or a hand-built fixture) is still live while the current
   * task is in_progress/verifying and its resume.json names a process that holds its recorded identity.
   */
  async #liveResumeRun(known: readonly LiveRunMarker[]): Promise<LiveRunMarker | null> {
    const state = await this.#readState();
    if (!state.currentTaskId) return null;
    let task: Task;
    try {
      task = (await this.store.readTask(state.currentTaskId)).data;
    } catch {
      return null;
    }
    if (task.status !== "in_progress" && task.status !== "verifying") return null;
    const resume = await findLatestTaskResume(this.projectRoot, task.id);
    if (!resume || known.some((marker) => marker.runId === resume.runId)) return null;
    return resumeAsLiveRun(resume);
  }

  /** Same as #dropRunMarker, from a run id alone (reads the recorded agent pid). */
  async #dropRunMarkerById(runId: string | undefined): Promise<void> {
    if (!runId) return;
    const marker = await readLiveRun(this.projectRoot, runId);
    const pid = marker?.agentPid;
    if (pid && pid !== process.pid && isPidAlive(pid)) return;
    await clearLiveRun(this.projectRoot, runId);
    await clearLiveSpawnMarker(this.projectRoot, runId);
  }

  /** Drop the run's marker unless its agent process is still alive (that keeps the guard). */
  async #dropRunMarker(started: StartedSkillSpawn | undefined): Promise<void> {
    if (!started?.spawned) return;
    const pid = started.handle.pid;
    if (pid && pid !== process.pid && isPidAlive(pid)) return;
    await clearLiveRun(this.projectRoot, started.runId);
    await clearLiveSpawnMarker(this.projectRoot, started.runId);
  }

  /** Lock entry that finishes run `runId`: the live-run guard exempts that run's own marker. */
  async #relock<T>(runId: string | undefined, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.#withLockOrRefuse(async () => {
        await this.#assertAdoptedTraceCurrentLocked();
        return fn();
      }, { ownRunId: runId });
    } finally {
      // Whatever happened (refused, lock timeout, a throw before finishStartedSpawn), the run is over:
      // its marker must not outlive it in a long-lived process. A still-alive agent keeps it.
      await this.#dropRunMarkerById(runId);
    }
  }

  /** Like #relock, but keeps the marker: execute's verification still runs after this entry. */
  async #relockKeep<T>(runId: string | undefined, fn: () => Promise<T>): Promise<T> {
    return this.#withLockOrRefuse(async () => {
      await this.#assertAdoptedTraceCurrentLocked();
      return fn();
    }, { ownRunId: runId });
  }

  /** The lock entry that starts a spawn: if it throws after the agent started, stop the agent and drop its marker. */
  async #startLock<T>(getStarted: () => StartedSkillSpawn | undefined, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.#withLockOrRefuse(fn);
    } catch (err) {
      const started = getStarted();
      if (started?.spawned) {
        await started.handle.abort().catch(() => undefined);
        await started.sandbox?.destroy().catch(() => undefined);
        await this.#dropRunMarker(started);
      }
      throw err;
    }
  }

  /** Read-only entry: allowed while a run is live (status, next, doctor, brief, search). */
  async #read<T>(fn: () => Promise<T>): Promise<T> {
    return this.#withLockOrRefuse(fn, { allowLive: true });
  }

  /** Persist must not import wiki; catalog is engine-authored while holding the lock. */
  async #refreshWikiCatalogLocked(): Promise<void> {
    await writeWikiCatalog(this.store);
  }

  /**
   * `ingest --distill` runs an agent on untrusted content (F-042/A-002). Refuse up front, before
   * anything is written, when the agent would have to run without a hardened sandbox. An adapter
   * that cannot spawn stays a soft skip (nothing would run), and the fake test adapter runs no agent.
   */
  async #assertDistillSandbox(): Promise<void> {
    let config: LegionConfig;
    try {
      config = await this.#readConfig();
    } catch {
      return;
    }
    const resolution = resolveAdapterId({ config, skillId: "ingest" });
    if (resolution.id === "fake") return;
    if (!(await isResolvedAdapterSpawnable(config, resolution.id))) return;
    const hardened = this.#fakeDistillSandboxHardened ?? hardenedSandboxAvailable(config.sandbox);
    if (hardened) return;
    refuse(
      "ingest --distill runs an agent on untrusted content and needs a hardened sandbox: bwrap on Linux, seatbelt on macOS, or Docker (on Windows without Docker, distill is unavailable)",
      HINT.distillNoSandbox,
    );
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

const REVIEW_NOTES_PATH = ".legion-cli/qa/review.md";

function reviewRunNotesPath(runId: string): string {
  return `.legion-cli/cache/runs/${runId}/review.md`;
}

const REVIEW_NOTES_MAX_BYTES = 1024 * 1024;

/** The notes file is agent-controlled: never follow a symlink, never read a non-regular or oversized file. */
async function readReviewNotes(projectRoot: string, runId: string): Promise<{ text: string; problem?: string }> {
  const rel = reviewRunNotesPath(runId);
  const abs = join(projectRoot, rel);
  let st;
  try {
    st = await lstat(abs);
  } catch {
    return { text: "" };
  }
  if (!st.isFile()) {
    return { text: "", problem: `${rel} is not a regular file (symlinks and directories are refused)` };
  }
  if (st.size > REVIEW_NOTES_MAX_BYTES) {
    return { text: "", problem: `${rel} is larger than ${REVIEW_NOTES_MAX_BYTES} bytes` };
  }
  try {
    return { text: (await readFile(abs, "utf8")).trim() };
  } catch {
    return { text: "" };
  }
}

export function createLegionEngine(projectRoot: string, options?: LegionEngineOptions): LegionEngine {
  return new LegionEngine(projectRoot, undefined, options);
}
