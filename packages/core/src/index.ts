export { HINT, LegionRefuseError, refuse, refuseKind } from "./errors.js";
export {
  SKILL_CONTRACTS,
  executeAllowedRoots,
  isAllowedPath,
  isEngineOwned,
  matchesGlob,
  skillContract,
} from "./contracts.js";
export { COMPACT_AUDIT_POINTER, compactTaskBody, outcomeFromTask } from "./compact.js";
export {
  applyChatAction,
  buildChatPrompt,
  createChatSession,
  gateChatAction,
  isChatProposalAction,
  resumeOrCreateChatSession,
  routeChatTurn,
  sanitizeChatAction,
} from "./chat.js";
export type { ChatApplyResult, ChatRouteOpts, ChatTurnKind, ChatTurnResult } from "./chat.js";
export { createLegionEngine, DISTILL_SOURCE_MAX_CHARS, LegionEngine } from "./engine.js";
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
  restoreChangedTaskFiles,
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
export { DEFAULT_VERIFICATION_TIMEOUT_MS, runVerificationCommands, splitCommand } from "./verify.js";
export { argvSummarySafe, findSkillsDir, optionalSkillSpawn, resolveSkillDir, resumeRunIsLive } from "./spawn.js";
export {
  WIREFRAME_PALETTE,
  assertWireframeHtml,
  palettePresent,
  uniqueScreenPages,
} from "./wireframes.js";
export { SKIP_WIREFRAMES_NOTE } from "./spec-build.js";
export {
  assertCanTransition,
  assertLegalPhase,
  canTransition,
  hintForIllegalTransition,
  LEGAL_PHASE_TRANSITIONS,
  PHASES,
} from "./phases.js";
export {
  evaluateReadiness,
  expectedArtifactsFailsPlan,
  filesAllowedFailsPlan,
  overlappingFilesAllowed,
} from "./readiness.js";
export type { ReadinessReport } from "./readiness.js";
export { isSliceTerminal, p0TasksNotDone, sliceHasOpenWork, sliceTasks } from "./slice.js";
export {
  displayStagedRoots,
  isShipAllowedPath,
  shipAddPaths,
  unrelatedDirty,
  unionDoneFilesAllowed,
} from "./ship.js";
export {
  assertTaskStatusTransition,
  canTransitionTaskStatus,
  isTerminalTaskStatus,
  LEGAL_TASK_TRANSITIONS,
  OPEN_TASK_STATUSES,
} from "./tasks.js";
export { BROWNFIELD_PAGES } from "./brownfield.js";
export type {
  Actor,
  AmendTaskOptions,
  Assumption,
  BrownfieldOptions,
  BrownfieldResult,
  CompactOptions,
  CompactResult,
  CompactedTask,
  DecisionInput,
  ExecuteOptions,
  ExecuteResult,
  ExecuteTaskResult,
  FileContract,
  GardenReport,
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
  SkippedCompactTask,
  Spec,
  Task,
  WireframeOptions,
  WireframeResult,
} from "./types.js";
