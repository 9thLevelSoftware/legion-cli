export {
  EngineLockedError,
  PathEscapeError,
  PersistError,
  PersistValidationError,
} from "./errors.js";
export {
  commitIngest,
  commitPaths,
  gitCheckIgnore,
  gitDiscoverChanges,
  gitHead,
  gitPathExistsAtRef,
  gitRestoreWorktree,
  gitRmWorktree,
  gitStatusPorcelain,
  isGitRepo,
  tryGitHead,
} from "./git.js";
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
  specPath,
  taskPath,
  wikiPageStorePath,
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
