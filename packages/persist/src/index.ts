export {
  AuditTamperError,
  EngineLockedError,
  MinisignError,
  PathEscapeError,
  PersistError,
  PersistValidationError,
  RestoreRefusedError,
  SymlinkRefusedError,
} from "./errors.js";
export {
  assertNoLinkInPath,
  assertNotSymlink,
  atomicWriteFile,
  isWin32BusyError,
  retryFsOp,
  RETRY_FS_OP_TOTAL_MS,
} from "./atomic-write.js";
export { nextFileId } from "./ids.js";
export {
  identitySpawnEnv,
  IDENTITY_TIMEOUT_MS,
  ownProcessStartedAt,
  PROCESS_START_TOLERANCE_MS,
  processIdentity,
  PROC_READ_MAX_BYTES,
  PROC_READ_TIMEOUT_MS,
  sameProcessStart,
  startedAfterRecorded,
} from "./process-identity.js";
export {
  invalidTaskMessage,
  listTaskFiles,
  listTaskSummaries,
  rememberTaskWrite,
  TASK_SUMMARIES_STORE,
} from "./tasks-list.js";
export type { TaskFileEntry, TaskSummary } from "./tasks-list.js";
export {
  abandonReceiptBody,
  abandonReceiptPath,
  appendAuditEvent,
  AUDIT_RETENTION_DAYS,
  AUDIT_VIEW_CAP,
  auditDayFromTs,
  auditDayPath,
  auditEventsPath,
  formatAuditDayLine,
  readAuditCursor,
  readAuditDelta,
  readAuditEvents,
  readAuditEventsDetailed,
  retainAuditDayFiles,
  shipReceiptBody,
  shipReceiptPath,
  summarizeAuditMetrics,
} from "./audit.js";
export type { AuditCursor, AuditReadOpts, AuditReadResult, LocalMetrics } from "./audit.js";
export {
  A007_FILE_COUNT,
  A007_STEP_BUDGET_MS,
  A007_TOLERANCE,
  evaluateA007Gate,
} from "./perf-harness.js";
export type { A007GateResult, A007Measurement } from "./perf-harness.js";
export {
  commitIngest,
  commitPaths,
  gitAdd,
  gitBranchCreate,
  gitBranchExists,
  gitCheckIgnore,
  gitCommitIndex,
  gitDiffCached,
  gitDiscoverChanges,
  gitHasStaged,
  gitHead,
  gitPathExistsAtRef,
  gitPathTracked,
  gitPorcelainPaths,
  gitResetMixed,
  gitRevParse,
  gitRestoreStaged,
  gitRestoreWorktree,
  gitRmWorktree,
  gitStagedPaths,
  gitStatusPorcelain,
  gitWorktreeAdd,
  gitWorktreeRemove,
  isGitRepo,
  listGitWorktrees,
  sameWorktreePath,
  tryGitBranch,
  tryGitHead,
} from "./git.js";
export type { GitWorktree } from "./git.js";
export { ensureGitignore, GITIGNORE_ENTRIES, GITIGNORE_TEMPLATE } from "./gitignore.js";
export { ingestDocumentStorePath, ingestFiles } from "./ingest.js";
export type { IngestDocument } from "./ingest.js";
export {
  assumptionPath,
  decisionPath,
  DEFAULT_LOCK_TIMEOUT_MS,
  MAX_LOCK_HOLD_MS,
  INDEX_DB_BASENAME,
  ingestReceiptPath,
  LEGION_DIR,
  legionPaths,
  LOCK_BASENAME,
  MAX_INGEST_FILE_BYTES,
  MAX_INGEST_TREE_BYTES,
  MAX_ZIPBALL_BYTES,
  MAX_ZIPBALL_ENTRIES,
  runPagePath,
  runResumePath,
  runStorePath,
  packetPath,
  serveJsonPath,
  specPath,
  taskPath,
  wikiPageStorePath,
  wikiRunPagePath,
  worktreeNodeStorePath,
  worktreeStorePath,
} from "./layout.js";
export type { LegionPaths } from "./layout.js";
export { acquireEngineLock, EMPTY_LOCK_STALE_MS, isPidAlive } from "./lock.js";
export type { HeldLock } from "./lock.js";
export {
  formatMarkdownDocument,
  formatYamlDocument,
  isTaskMarkdownPath,
  parseMarkdownDocument,
  parseYamlDocument,
  parseWithSchema,
  persistWork,
  readMarkdownFile,
  readYamlFile,
  resetPersistWork,
  SOT_READ_ATTEMPTS,
  SOT_READ_RETRY_MS,
  writeMarkdownFile,
  writeTextFile,
  writeYamlFile,
} from "./markdown.js";
export type { MarkdownDoc, WriteTextOpts } from "./markdown.js";
export {
  appendAuditChainLine,
  assertStoreRootsNotLinked,
  auditLineDigest,
  closeEngineCommand,
  isPinnedEngineSot,
  isRestoreManifestPath,
  journaledRemove,
  journaledWriteFile,
  journalPostWrite,
  journalPreWrite,
  listIncidents,
  listJournalEntries,
  listOpenCommandIds,
  listRestoreManifestPaths,
  openEngineCommand,
  posixFromAbs,
  readAuditChain,
  readBlob,
  readCommandRecord,
  reconcileUnfinishedCommands,
  restoreEngineState,
  sha256Content,
  shouldJournalPath,
  verifyAuditChain,
  writeIncident,
} from "./pre-image.js";
export type {
  AuditChainState,
  EngineCommandRecord,
  EngineRestoreResult,
  IncidentRecord,
  JournalEntry,
  JournalKind,
  JournalOp,
} from "./pre-image.js";
export {
  assertInsideProject,
  assertResolvedInside,
  canonicalizePath,
  resolveProjectPath,
  toFsPath,
  toPosixPath,
  toProjectRelativePosix,
  toStorePath,
} from "./paths.js";
export {
  fetchPublicHttpsBinary,
  fetchPublicHttpsPinned,
  isPrivateOrLocalHost,
  resolvePublicAddress,
  SsrfError,
} from "./ssrf.js";
export type { FetchedBinary, FetchPublicHttpsBinaryOpts, FetchPublicHttpsPinnedOpts, SsrfLookup } from "./ssrf.js";
export {
  fetchGithubZipball,
  GITHUB_ZIPBALL_HOSTS,
  githubZipballUrl,
  parseGithubRepoSource,
} from "./github-fetch.js";
export type { GithubRepoRef } from "./github-fetch.js";
export { unzipZipball } from "./unzip.js";
export { hashTreeFiles, hashTreeRecords } from "./hash-tree.js";
export {
  NINTHLEVEL_MINISIGN_PUB_PATH,
  readNinthlevelMinisignPub,
  verifyMinisign,
} from "./minisign.js";
export { hasSecretPattern, redactSecrets } from "./redact.js";
export { indexDbUsable, openIndexDb, queryIndex, rebuildIndex, REBUILD_SQL } from "./sqlite.js";
export { createLegionStore, LegionStore } from "./store.js";
export type { LegionReader, LegionStoreOptions, LockClock } from "./store.js";
export {
  DECISION_FILE_SCHEMA_VERSION,
  DecisionFileSchema,
  extractWikiLinks,
  wikiIdFromStorePath,
  WIKI_PAGE_SCHEMA_VERSION,
  WikiPageSchema,
} from "./wiki-page.js";
export type { DecisionFile, WikiPage } from "./wiki-page.js";
