import {
  queryIndex,
  WIKI_PAGE_SCHEMA_VERSION,
  type LegionStore,
  type WikiPage,
} from "@9thlevelsoftware/legion-cli-persist";
import { SCHEMA_VERSION, TopicsFileSchema, type TopicsFile } from "@9thlevelsoftware/legion-cli-schema";
import { ensureWikiIndex } from "./brief.js";
import type { WikiPageRow } from "./graph.js";
import { twoLineSummary } from "./parser.js";

export const WIKI_INDEX_ID = "index";
export const WIKI_INDEX_STORE_PATH = ".legion-cli/wiki/index.md";
export const WIKI_TOPICS_STORE_PATH = ".legion-cli/wiki/topics.yaml";
export const WIKI_INDEX_SEE_ALSO = "See also: [[index]]";

type CatalogPage = WikiPageRow & { tags_json?: string };

function nowIso(): string {
  return new Date().toISOString();
}

function posixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isIndexPage(page: { id: string; path: string }): boolean {
  const path = posixPath(page.path);
  return page.id === WIKI_INDEX_ID || path === WIKI_INDEX_STORE_PATH || path.endsWith("/wiki/index.md");
}

function isExcerptPage(page: { id: string; path: string }): boolean {
  const path = posixPath(page.path);
  const id = posixPath(page.id);
  return path.includes("/wiki/ingested/") || id.startsWith("ingested/");
}

function hasIndexLink(body: string): boolean {
  return /\[\[index(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/i.test(body);
}

function withIndexFooter(body: string): string {
  if (hasIndexLink(body)) return body;
  const trimmed = body.replaceAll("\r\n", "\n").replace(/\s+$/, "");
  if (trimmed.length === 0) return `${WIKI_INDEX_SEE_ALSO}\n`;
  return `${trimmed}\n\n${WIKI_INDEX_SEE_ALSO}\n`;
}

function pageTags(page: CatalogPage): string[] {
  try {
    const tags = JSON.parse(page.tags_json ?? "[]") as unknown;
    if (!Array.isArray(tags)) return [];
    return tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
  } catch {
    return [];
  }
}

function catalogSummary(body: string): string {
  const stripped = body
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => !/^\s*See also:\s*\[\[index/i.test(line))
    .join("\n");
  return twoLineSummary(stripped);
}

function loadCatalogPages(projectRoot: string): CatalogPage[] {
  return queryIndex<CatalogPage>(
    projectRoot,
    "SELECT id, path, title, body, trust, aliases_json, tags_json, updated_at FROM pages",
  );
}

function renderWikiIndex(pages: readonly CatalogPage[]): string {
  const others = [...pages].filter((page) => !isIndexPage(page)).sort((a, b) => a.id.localeCompare(b.id));
  const reviewed = others.filter((page) => page.trust === "reviewed");
  const untrusted = others.filter((page) => page.trust === "untrusted");
  const lines: string[] = [
    "# Wiki index",
    "",
    "Catalog of compiled pages. Search is derived FTS5; this file is the git-reviewed map.",
    "",
    "## Reviewed",
  ];
  for (const page of reviewed) {
    lines.push(`- [[${page.id}]] — ${page.title}`);
    const summary = catalogSummary(page.body);
    if (summary.length > 0) {
      for (const summaryLine of summary.split("\n")) {
        lines.push(`  ${summaryLine}`);
      }
    }
  }
  lines.push("", "## Untrusted (titles only; run legion-cli wiki trust)");
  for (const page of untrusted) {
    lines.push(`- [[${page.id}]] — ${page.title} (${page.path})`);
  }
  lines.push("");
  return lines.join("\n");
}

function topicsFromPages(pages: readonly CatalogPage[]): TopicsFile {
  const grouped = new Map<string, Set<string>>();
  const add = (tag: string, id: string): void => {
    const set = grouped.get(tag) ?? new Set<string>();
    set.add(id);
    grouped.set(tag, set);
  };
  for (const page of pages) {
    if (isIndexPage(page)) continue;
    for (const tag of pageTags(page)) add(tag, page.id);
  }
  add("wiki", WIKI_INDEX_ID);
  add("catalog", WIKI_INDEX_ID);
  const topics: Record<string, string[]> = {};
  for (const tag of [...grouped.keys()].sort((a, b) => a.localeCompare(b))) {
    topics[tag] = [...(grouped.get(tag) ?? [])].sort((a, b) => a.localeCompare(b));
  }
  return TopicsFileSchema.parse({
    schemaVersion: SCHEMA_VERSION.topics,
    topics,
  });
}

function indexFrontmatter(): WikiPage {
  return {
    schemaVersion: WIKI_PAGE_SCHEMA_VERSION,
    title: "Wiki index",
    aliases: ["catalog", "index"],
    tags: ["wiki", "catalog"],
    trust: "reviewed",
    updated: nowIso(),
  };
}

/** Engine-authored git-reviewed catalog. Persist must not import wiki or call this from rebuild(). */
export async function writeWikiCatalog(store: LegionStore): Promise<void> {
  await ensureWikiIndex(store);
  const pages = loadCatalogPages(store.projectRoot);

  for (const page of pages) {
    if (!isExcerptPage(page) || isIndexPage(page) || hasIndexLink(page.body)) continue;
    const doc = await store.readWikiPage(page.path);
    await store.writeWikiPage(page.path, doc.data, withIndexFooter(doc.body));
  }

  await store.writeWikiPage(WIKI_INDEX_STORE_PATH, indexFrontmatter(), renderWikiIndex(pages));
  await store.writeYaml(WIKI_TOPICS_STORE_PATH, topicsFromPages(pages));
  await store.rebuild();
}
