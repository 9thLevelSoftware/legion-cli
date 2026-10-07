export { HINT, LegionRefuseError, refuse, refuseKind } from "./errors.js";
export { ASSURANCE_PLAN_PATH, ASSURANCE_APPROVAL_PATH, ASSURANCE_EXECUTION_PATH, ASSURANCE_TRACE_PREREQUISITE, assuranceManifestDigest, assuranceUnitClosure, assuranceImpact, readAssuranceDraft, resolveAssuranceHost, prepareAssuranceCheck, runAssuranceChecks, readAssuranceExecution, inspectAssuranceEvidence } from "./assurance.js";
export type { AssuranceState, AssuranceStatus, AssuranceCheckDecision, AssuranceCriterionEvidence, AssuranceUnitEvidence, AssuranceEvidenceReport, AssuranceImpactReport } from "./assurance.js";
export {
  SKILL_CONTRACTS,
  executeAllowedRoots,
  isAllowedPath,
  isEngineOwned,
  isImplicitForbidden,
  isRestoreManifestPath,
  matchesGlob,
  skillContract,
} from "./contracts.js";
export { COMPACT_AUDIT_POINTER, compactTaskBody, outcomeFromTask } from "./compact.js";
export {
  applyChatAction,
  buildChatPrompt,
  chatActionPhaseRefusal,
  chatResumeRetryableMessage,
  createChatSession,
  forkChatSession,
  gateChatAction,
  idleTurnsFromSession,
  isChatProposalAction,
  loadChatSession,
  persistForkedChatSession,
  resumeOrCreateChatSession,
  saveChatSession,
  routeChatTurn,
  sanitizeChatAction,
  scanChatSessions,
} from "./chat.js";
export type { ChatApplyResult, ChatRouteOpts, ChatTurnKind, ChatTurnResult } from "./chat.js";
export { setUndoGitResetHard, setUndoGitRevert, undoLastTask } from "./undo.js";
export type { UndoResult } from "./undo.js";
export {
  COMMUNITY_RECIPE_LOCK_MESSAGE,
  COMMUNITY_RECIPE_PATH_MESSAGE,
  RECIPE_ARGV_ONLY_MESSAGE,
  assertRecipeExecutionPolicy,
  canonicalCommunityRecipePath,
  loadRecipe,
  loadRecipeFile,
  recipesLockPath,
  runRecipe,
} from "./recipes.js";
export type { LoadedRecipe, RecipeExecutionResult } from "./recipes.js";
export { createLegionEngine, DISTILL_SOURCE_MAX_CHARS, LegionEngine } from "./engine.js";
export { readWorkflowPreparation, inspectWorkflowPreparation, inspectPreparationRecord, validateWorkflowPreparation,
  bindPreparationArtifacts, writeWorkflowPreparation } from "./workflow-preparation.js";
export type { PreparationValidation } from "./workflow-preparation.js";
export { incompleteApprovedWorkflowTasks } from "./workflow.js";
export * from "./planning-assistance.js";
export {
  SPEC_CHALLENGE_THINKING_SUFFIX,
  specChallengeReceiptPath,
  specChallengeThinkingPath,
} from "./spec-challenge.js";
export {
  assertDiscoverySelection,
  DISCOVERY_PATH,
  prepareDiscovery,
  recordDiscoverySelection,
} from "./discovery.js";
export type { DiscoveryResult, DiscoverySelection } from "./discovery.js";
export type { MapLspMode, MapOptions, MapResult } from "./map.js";
export {
  assertIngestSourceAllowed,
  isGithubSource,
  isPrivateOrLocalHost,
  isUrlSource,
} from "./ingest-guard.js";
export {
  INTENT_Q,
  MAX_INTENT_ROUNDS,
  applyIntentAnswers,
  emptyIntentAnswers,
  formatIntentBrief,
  intentProgress,
  requiredSlotsFilled,
  specIdFromName,
  splitLines,
  splitMustNotAndOutOfScope,
} from "./intent.js";
export {
  HEAD_MOVED_WARNING,
  openEngineCommand,
  restoreChangedTaskFiles,
  restoreEngineState,
  RestoreRefusedError,
  revertExtras,
  snapshotTaskFiles,
} from "./revert.js";
export type { TaskFileSnapshot } from "./revert.js";
export {
  ensureRegressionTest,
  fixFilesAllowed,
  LIKELY_PRODUCT_PATHS,
  PRODUCT_ENTRY,
  productSourcePaths,
  regressionSlug,
  regressionTestPath,
  regressionTestSource,
  regressionVerifyCommand,
} from "./fix.js";
export {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  resetVerificationWork,
  resolveVerificationTrustTier,
  runVerificationCommands,
  splitCommand,
  verificationFailureReason,
  verificationWork,
} from "./verify.js";
export type { VerificationRun, VerificationTrustPosture } from "./verify.js";
export {
  argvSummarySafe,
  defaultAllowCopyJail,
  findSkillsDir,
  governedMcpConfigIdentity,
  governedMcpToolContractIdentity,
  inspectResumeOwner,
  listRunRecoveryStatuses,
  listCacheResumesCalls,
  optionalSkillSpawn,
  preserveStartedHttpSpawnForRecovery,
  refuseIfLiveRun,
  resetListCacheResumesCalls,
  resolveSkillDir,
  resumeHttpSkillSpawn,
  resumeRunIsLive,
  updateResumeStage,
} from "./spawn.js";
export type { ResumeOwnerStatus, RunRecoveryStatus } from "./spawn.js";
export { evaluateQaEvidenceFreshness, projectSourceIdentity, qaSourceHash, qaSpecHash } from "./qa-evidence.js";
export {
  WIREFRAME_PALETTE,
  assertWireframeHtml,
  palettePresent,
  uniqueScreenPages,
} from "./wireframes.js";
export { SKIP_WIREFRAMES_NOTE, buildSpecFromIntent, specMarkdownBody, quoteDecision } from "./spec-build.js";
export { assertCanTransition, assertCanUndoTransition, assertLegalPhase, hintForIllegalTransition, PHASES } from "./phases.js";
export {
  canTransition,
  LEGAL_PHASE_TRANSITIONS,
  UNDO_ONLY_PHASE_TRANSITIONS,
} from "@9thlevelsoftware/legion-cli-schema";
export {
  evaluateReadiness,
  expectedArtifactsFailsPlan,
  filesAllowedFailsPlan,
  overlappingFilesAllowed,
} from "./readiness.js";
export type { ReadinessReport } from "./readiness.js";
export { isSliceTerminal, p0TasksNotDone, sliceHasOpenWork, sliceTasks } from "./slice.js";
export { createHttpToolHost, engineSotRefuseReason, httpAllowedWrites } from "./http-host.js";
export type { HttpHostOpts } from "./http-host.js";

export {
  approveGovernedAction,
  buildApprovedHttpAssuranceContext,
  createGovernedHttpCapability,
  governedBootstrapProgramFingerprint,
  inspectGovernedRun,
  recordAppliedFileProvenance,
} from "./assurance-flow.js";
export type {
  ApproveGovernedActionOptions,
  CreateGovernedHttpCapabilityOptions,
  BuildGovernedHttpAssuranceContextOptions,
  CreateGovernedHttpCapabilityResult,
  GovernedMcpDescriptor,
  InspectGovernedRunOptions,
  RecordAppliedFileProvenanceOptions,
} from "./assurance-flow.js";
export {
  displayStagedRoots,
  isShipAllowedPath,
  SHIP_COMMIT_PREFIX,
  SHIP_STAGED_CHANGED,
  shipAddPaths,
  shipCommitMessage,
  shipProductIndexFingerprint,
  unrelatedDirty,
  unionDoneFilesAllowed,
} from "./ship.js";
export { assertTaskStatusTransition } from "./tasks.js";
export {
  canTransitionTaskStatus,
  isTerminalTaskStatus,
  LEGAL_TASK_TRANSITIONS,
  OPEN_TASK_STATUSES,
  statusAfterUndoDependency,
} from "@9thlevelsoftware/legion-cli-schema";
export * from "./brownfield/index.js";
export type {
  Actor,
  AmendTaskOptions,
  Assumption,
  BrownfieldAnalysisOutputStatus,
  BrownfieldArtifactPaths,
  BrownfieldBlockingAssumption,
  BrownfieldDagNodeSummary,
  BrownfieldDagResult,
  BrownfieldEffort,
  BrownfieldEvidenceOptions,
  BrownfieldEvidenceResult,
  BrownfieldIgnoredBlock,
  BrownfieldInitResult,
  BrownfieldMergeResult,
  BrownfieldOptions,
  BrownfieldPatternsOptions,
  BrownfieldPatternsResult,
  BrownfieldPrPlanResult,
  BrownfieldResult,
  BrownfieldReviewItem,
  BrownfieldReviewStatusOptions,
  BrownfieldReviewStatusResult,
  BrownfieldReviewVerdict,
  BrownfieldRosterResult,
  BrownfieldSeverity,
  BrownfieldStateResult,
  BrownfieldWorktreeOptions,
  BrownfieldWorktreeResult,
  CompactOptions,
  CompactResult,
  CompactedTask,
  DecisionInput,
  ExecuteOptions,
  ExecuteProgress,
  ExecuteResult,
  ExecuteTaskResult,
  ExecuteWorkflowOptions,
  FiledTicketSummary,
  TicketSource,
  FileContract,
  GardenReport,
  GovernanceFaultPoint,
  GovernanceInspection,
  IngestOpts,
  IngestReceipt,
  IngestResult,
  IngestSource,
  InitOptions,
  IntentState,
  LegionEngineOptions,
  NewPacket,
  NewTicket,
  Packet,
  PacketRespondInput,
  PacketResult,
  PlanApprovalOptions,
  PlanApprovalReceipt,
  Phase,
  PromoteRunOptions,
  PromoteRunResult,
  QaOptions,
  QAScore,
  Readiness,
  ReviewResult,
  ReviewVerdict,
  SearchHit,
  SessionBrief,
  VerifyResult,
  ShipOptions,
  ShipPreview,
  ShipReceipt,
  ShipBundleStatus,
  ShipDeliverySnapshotStatus,
  ShipExportResult,
  SkippedCompactTask,
  Spec,
  Task,
  AcceptanceEvidenceInput,
  AcceptanceReceipt,
  WireframeOptions,
  WireframeResult,
  WorkflowAcceptanceStatus,
  WorkflowEvidenceReceipt,
  WorkflowExecutionResult,
  WorkflowStatus,
  SpecChallengeDisposition,
  SpecChallengeManualQuestionKey,
  SpecChallengeManualReviewInput,
  SpecChallengeResolutionInput,
  SpecChallengeResult,
  SpecChallengeStatus,
} from "./types.js";
