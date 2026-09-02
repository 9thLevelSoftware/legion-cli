export { HINT, LegionRefuseError, refuse } from "./errors.js";
export {
  SKILL_CONTRACTS,
  executeAllowedRoots,
  isAllowedPath,
  isEngineOwned,
  matchesGlob,
  skillContract,
} from "./contracts.js";
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
  regressionSlug,
  regressionTestPath,
  regressionTestSource,
  regressionVerifyCommand,
} from "./fix.js";
export { runVerificationCommands, splitCommand } from "./verify.js";
export { findSkillsDir, optionalSkillSpawn } from "./spawn.js";
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
  assertTaskStatusTransition,
  canTransitionTaskStatus,
  isTerminalTaskStatus,
  LEGAL_TASK_TRANSITIONS,
  OPEN_TASK_STATUSES,
} from "./tasks.js";
export type {
  Actor,
  AmendTaskOptions,
  DecisionInput,
  ExecuteOptions,
  ExecuteResult,
  ExecuteTaskResult,
  FileContract,
  IngestOpts,
  IngestReceipt,
  IngestSource,
  InitOptions,
  IntentState,
  LegionEngineOptions,
  NewTicket,
  Phase,
  QaOptions,
  QAScore,
  Readiness,
  ReviewResult,
  ReviewVerdict,
  SearchHit,
  SessionBrief,
  VerifyResult,
  ShipOptions,
  ShipReceipt,
  Spec,
  Task,
} from "./types.js";
