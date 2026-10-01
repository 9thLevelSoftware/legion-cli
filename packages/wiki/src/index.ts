export {
  WIKI_INDEX_ID,
  WIKI_INDEX_STORE_PATH,
  WIKI_TOPICS_STORE_PATH,
  writeWikiCatalog,
} from "./catalog.js";
export {
  assembleSessionBrief,
  briefCounters, // @internal test support
  buildSessionBrief,
  resetBriefCounters, // @internal test support
  ensureWikiIndex,
  renderSessionBrief,
  SESSION_BRIEF_CHAR_CAP,
  wikiIndexReady,
} from "./brief.js";
export { assertSpawnPathAllowed, isForbiddenSpawnPath } from "./contract.js";
export {
  duplicateTitleGroups,
  gardenReport,
  orphanPages,
  staleUntrustedPages,
  titlesSimilar,
} from "./garden.js";
export type { GardenDuplicateGroup, GardenPage, GardenReport } from "./garden.js";
export {
  backlinks,
  hubs,
  loadWikiLinks,
  loadWikiPages,
  neighbors,
  wikiGraph,
} from "./graph.js";
export type { WikiLinkRow, WikiPageRow } from "./graph.js";
export {
  excerptHtml,
  extractWikiLinks,
  looksLikeHtml,
  titleFromHtml,
  twoLineSummary,
  wikiIdFromStorePath,
  WIKI_PAGE_SCHEMA_VERSION,
  WikiPageSchema,
} from "./parser.js";
export type { WikiPage } from "./parser.js";
export { searchWiki } from "./search.js";
export type { SearchHit } from "./search.js";
export {
  benchmarkHybridRetrieval,
  rankHybridRetrieval,
  rankHybridRetrievalFromVectorResults,
  rankHybridRetrievalWithLocalEmbeddings,
} from "./experimental-hybrid.js";
export type {
  ExperimentalRetrievalCandidate,
  ExperimentalVectorSearchResult,
  FixedCorpusRetrievalCase,
  HybridRetrievalBenchmark,
  HybridRetrievalHit,
  HybridLocalEmbeddingOptions,
  HybridRetrievalOptions,
  HybridVectorResultOptions,
} from "./experimental-hybrid.js";
export { showPage } from "./show.js";
export type { ShownPage } from "./show.js";
export { materializeIngestSources } from "./sources.js";
export type { MaterializedIngest } from "./sources.js";
export {
  fetchPublicHttps,
  fileUrlToPath,
  isGithubSource,
  isPrivateOrLocalHost,
  isUrlSource,
  resolvePublicAddress,
  SsrfError,
} from "./ssrf.js";
export { trustWikiPage } from "./trust.js";
export {
  renderExecutePromptWithUntrusted,
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
  UNTRUSTED_POINTER_REMINDER,
  wrapUntrustedContent,
} from "./untrusted.js";
