export {
  EngineLockedError,
  PathEscapeError,
  PersistError,
  PersistValidationError,
} from "./errors.js";
export {
  abandonReceiptBody,
  abandonReceiptPath,
  appendAuditEvent,
  auditDayFromTs,
  auditDayPath,
  auditEventsPath,
  formatAuditDayLine,
  shipReceiptBody,
  shipReceiptPath,
} from "./audit.js";
export {
  commitIngest,
  commitPaths,
  gitAdd,
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
  gitRestoreStaged,
  gitRestoreWorktree,
  gitRmWorktree,
  gitStagedPaths,
  gitStatusPorcelain,
  gitWorktreeAdd,
  isGitRepo,
  listGitWorktrees,
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
  INDEX_DB_BASENAME,
  ingestReceiptPath,
  LEGION_DIR,
  legionPaths,
  LOCK_BASENAME,
  MAX_INGEST_FILE_BYTES,
  MAX_INGEST_TREE_BYTES,
  runPagePath,
  runResumePath,
  runStorePath,
  packetPath,
  specPath,
  taskPath,
  wikiPageStorePath,
  wikiRunPagePath,
  worktreeStorePath,
} from "./layout.js";
export type { LegionPaths } from "./layout.js";
export { acquireEngineLock } from "./lock.js";
export type { HeldLock } from "./lock.js";
export {
  formatMarkdownDocument,
  formatYamlDocument,
  parseMarkdownDocument,
  parseYamlDocument,
  parseWithSchema,
  readMarkdownFile,
  readYamlFile,
  writeMarkdownFile,
  writeTextFile,
  writeYamlFile,
} from "./markdown.js";
export type { MarkdownDoc } from "./markdown.js";
export {
  assertInsideProject,
  canonicalizePath,
  resolveProjectPath,
  toFsPath,
  toPosixPath,
  toProjectRelativePosix,
  toStorePath,
} from "./paths.js";
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
