export { HINT, LegionRefuseError, refuse } from "./errors.js";
export { createLegionEngine, LegionEngine } from "./engine.js";
export { assertIngestSourceAllowed, isPrivateOrLocalHost, isUrlSource } from "./ingest-guard.js";
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
  ExecuteResult,
  IngestReceipt,
  IngestSource,
  InitOptions,
  Phase,
  QaOptions,
  QAScore,
  Readiness,
  ReviewResult,
  ReviewVerdict,
  ShipOptions,
  ShipReceipt,
  Spec,
  Task,
} from "./types.js";
