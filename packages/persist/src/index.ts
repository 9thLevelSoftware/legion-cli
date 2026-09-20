export {
  EngineLockedError,
  MinisignError,
  PathEscapeError,
  PersistError,
  PersistValidationError,
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
  controlDirPath,
  controlProjectDirPath,
  ensureControlDir,
  ensureOwnerDir,
  ensureQuarantineRoot,
  projectHash,
  quarantineRootPath,
  userStateDir,
} from "./state-dir.js";
export {
  ownProcessStartedAt,
  PROCESS_START_TOLERANCE_MS,
  processIdentity,
  sameProcessStart,
  startedAfterRecorded,
} from "./process-identity.js";
export { invalidTaskMessage, listTaskFiles } from "./tasks-list.js";
export type { TaskFileEntry } from "./tasks-list.js";
export {
  abandonReceiptBody,
  abandonReceiptPath,
  appendAuditEvent,
  appendDeferredAuditEvent,
  DEFERRABLE_AUDIT_TYPES,
  DEFERRED_AUDIT_BASENAME,
  drainDeferredAuditEvents,
  MAX_DEFERRED_AUDIT_BYTES,
  MAX_DEFERRED_AUDIT_EVENTS,
  auditDayFromTs,
  auditDayPath,
  auditEventsPath,
  formatAuditDayLine,
  readAuditEvents,
  shipReceiptBody,
  shipReceiptPath,
  summarizeAuditMetrics,
} from "./audit.js";
export type { LocalMetrics } from "./audit.js";
export {
  commitIngest,
  commitPaths,
  gitAdd,
  gitAllRefs,
  gitBlobIdsAtRef,
  gitBundleCreate,
  gitBranchCreate,
  gitBranchExists,
  gitCatFileFiltered,
  gitCheckIgnore,
  gitCheckIgnoreMany,
  gitCommitIndex,
  gitControlDirs,
  gitDiffCached,
  gitDiffRevision,
  gitHashObjects,
  gitHasStaged,
  gitHead,
  gitIgnoredEntries,
  gitIndexEntries,
  gitIsAncestor,
  gitLsFiles,
  gitPathExistsAtRef,
  gitPathTracked,
  gitPorcelainPaths,
  gitResetIndexPaths,
  gitResetMixed,
  gitRevListRange,
  gitRevParse,
  gitRestoreStaged,
  gitStagedPaths,
  gitStatusPorcelain,
  gitStatusRecords,
  gitUpdateRef,
  gitWorktreeAdd,
  gitWorktreeRemove,
  isGitRepo,
  listGitWorktrees,
  resolveGitBinary,
  runGit,
  runGitBuffer,
  sameWorktreePath,
  tryGitBranch,
  tryGitHead,
} from "./git.js";
export type { GitKind, GitRunOpts, GitStatusRecord, GitWorktree } from "./git.js";
export { ensureGitignore, GITIGNORE_ENTRIES, GITIGNORE_TEMPLATE } from "./gitignore.js";
export { ingestDocumentStorePath, ingestFiles } from "./ingest.js";
export type { IngestDocument } from "./ingest.js";
export {
  assumptionPath,
  decisionPath,
  DEFAULT_LOCK_TIMEOUT_MS,
  INDEX_DB_BASENAME,
  ingestReceiptPath,
  isProtectedSetExcluded,
  PROTECTED_SET_EXCLUDED,
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
  parseMarkdownDocument,
  parseYamlDocument,
  parseWithSchema,
  readMarkdownFile,
  readYamlFile,
  SOT_READ_ATTEMPTS,
  SOT_READ_RETRY_MS,
  writeMarkdownFile,
  writeTextFile,
  writeYamlFile,
} from "./markdown.js";
export type { MarkdownDoc, WriteTextOpts } from "./markdown.js";
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
export { openIndexDb, queryIndex, rebuildIndex, REBUILD_SQL } from "./sqlite.js";
export { createLegionStore, LegionStore } from "./store.js";
export type { LegionReader } from "./store.js";
export {
  DECISION_FILE_SCHEMA_VERSION,
  DecisionFileSchema,
  extractWikiLinks,
  wikiIdFromStorePath,
  WIKI_PAGE_SCHEMA_VERSION,
  WikiPageSchema,
} from "./wiki-page.js";
export type { DecisionFile, WikiPage } from "./wiki-page.js";
