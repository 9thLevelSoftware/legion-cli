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

function pageTags(page: CatalogPage): string[] {
  try {
    const tags = JSON.parse(page.tags_json ?? "[]") as unknown;
    if (!Array.isArray(tags)) return [];
    return tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
  } catch {
    return [];
  }
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
    const summary = twoLineSummary(page.body);
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

function sameText(a: string, b: string): boolean {
  return a.replaceAll("\r\n", "\n") === b.replaceAll("\r\n", "\n");
}

async function writeIndexIfChanged(store: LegionStore, body: string): Promise<void> {
  try {
    const existing = await store.readWikiPage(WIKI_INDEX_STORE_PATH);
    if (
      existing.data.title === "Wiki index" &&
      existing.data.trust === "reviewed" &&
      sameText(existing.body, body)
    ) {
      return;
    }
  } catch {
    // missing or invalid; write engine catalog
  }
  await store.writeWikiPage(WIKI_INDEX_STORE_PATH, indexFrontmatter(), body);
}

async function writeTopicsIfChanged(store: LegionStore, topics: TopicsFile): Promise<void> {
  try {
    const existing = await store.readYaml(WIKI_TOPICS_STORE_PATH, TopicsFileSchema);
    if (JSON.stringify(existing) === JSON.stringify(topics)) return;
  } catch {
    // missing or invalid; write engine topics
  }
  await store.writeYaml(WIKI_TOPICS_STORE_PATH, topics);
}

/** Engine-authored git-reviewed catalog. Persist must not import wiki or call this from rebuild(). */
export async function writeWikiCatalog(store: LegionStore): Promise<void> {
  await ensureWikiIndex(store);
  const pages = loadCatalogPages(store.projectRoot);
  await writeIndexIfChanged(store, renderWikiIndex(pages));
  await writeTopicsIfChanged(store, topicsFromPages(pages));
  await store.rebuild();
}
