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
export { createLegionEngine, LegionEngine } from "./engine.js";
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
export { HEAD_MOVED_WARNING, revertExtras } from "./revert.js";
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
export { runVerificationCommands, splitCommand } from "./verify.js";
export { argvSummarySafe, findSkillsDir, optionalSkillSpawn } from "./spawn.js";
export { WIREFRAME_PALETTE, palettePresent, uniqueScreenPages } from "./wireframes.js";
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
} from "./types.js";
