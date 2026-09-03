import { queryIndex } from "@9thlevelsoftware/legion-cli-persist";
import { loadWikiLinks, loadWikiPages, neighbors, type WikiPageRow } from "./graph.js";

export type SearchHit = {
  id: string;
  path: string;
  title: string;
  trust: "untrusted" | "reviewed";
  snippet: string;
  via: "fts" | "neighbor" | "mentions" | "catalog";
};

function ftsPhrase(q: string): string {
  return `"${q.trim().replaceAll('"', '""')}"`;
}

function titleOrPathMatches(page: WikiPageRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle.length === 0) return false;
  if (page.title.toLowerCase().includes(needle)) return true;
  if (page.path.toLowerCase().includes(needle)) return true;
  if (page.id.toLowerCase().includes(needle)) return true;
  try {
    const aliases = JSON.parse(page.aliases_json ?? "[]") as unknown;
    if (Array.isArray(aliases) && aliases.some((alias) => String(alias).toLowerCase().includes(needle))) {
      return true;
    }
  } catch {
    // aliases_json is advisory
  }
  return false;
}

function snippetFor(page: WikiPageRow, includeUntrusted: boolean, q: string): string {
  if (page.trust === "untrusted" && !includeUntrusted) return "";
  const body = page.body.replaceAll("\r\n", "\n");
  const needle = q.trim();
  const idx = body.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) {
    return body.trim().slice(0, 180);
  }
  const start = Math.max(0, idx - 40);
  return body.slice(start, start + 180).trim();
}

function pageById(pages: WikiPageRow[]): Map<string, WikiPageRow> {
  const map = new Map<string, WikiPageRow>();
  for (const page of pages) map.set(page.id, page);
  return map;
}

export function searchWiki(
  projectRoot: string,
  q: string,
  opts?: { includeUntrusted?: boolean; mentions?: boolean },
): SearchHit[] {
  const query = q.trim();
  if (query.length === 0) return [];
  const includeUntrusted = opts?.includeUntrusted === true;
  const pages = loadWikiPages(projectRoot);
  const byId = pageById(pages);

  if (opts?.mentions) {
    const links = loadWikiLinks(projectRoot);
    const target = pages.find(
      (page) => page.id === query || page.title === query || page.path === query || page.path.endsWith(`/${query}.md`),
    );
    const targetId = target?.id ?? query;
    const hits: SearchHit[] = [];
    for (const link of links) {
      if (link.to_id !== targetId) continue;
      const page = byId.get(link.from_id);
      if (!page) continue;
      if (page.trust === "untrusted" && !includeUntrusted && !titleOrPathMatches(page, query)) continue;
      hits.push({
        id: page.id,
        path: page.path,
        title: page.title,
        trust: page.trust,
        snippet: snippetFor(page, includeUntrusted, query),
        via: "mentions",
      });
    }
    return hits;
  }

  let matched: WikiPageRow[] = [];
  try {
    matched = queryIndex<WikiPageRow>(
      projectRoot,
      `SELECT pages.id, pages.path, pages.title, pages.body, pages.trust, pages.aliases_json
       FROM pages_fts
       JOIN pages ON pages.rowid = pages_fts.rowid
       WHERE pages_fts MATCH ?`,
      [ftsPhrase(query)],
    );
  } catch {
    const needle = `%${query.replaceAll("%", "")}%`;
    matched = queryIndex<WikiPageRow>(
      projectRoot,
      `SELECT id, path, title, body, trust, aliases_json FROM pages
       WHERE title LIKE ? OR path LIKE ? OR id LIKE ?`,
      [needle, needle, needle],
    );
  }

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const page of matched) {
    const untrustedBodyOnly = page.trust === "untrusted" && !includeUntrusted && !titleOrPathMatches(page, query);
    if (untrustedBodyOnly) continue;
    seen.add(page.id);
    hits.push({
      id: page.id,
      path: page.path,
      title: page.title,
      trust: page.trust,
      snippet: snippetFor(page, includeUntrusted, query),
      via: "fts",
    });
  }

  const links = loadWikiLinks(projectRoot);
  for (const hit of [...hits]) {
    for (const neighborId of neighbors(links, hit.id)) {
      if (seen.has(neighborId)) continue;
      const page = byId.get(neighborId);
      if (!page) continue;
      seen.add(neighborId);
      hits.push({
        id: page.id,
        path: page.path,
        title: page.title,
        trust: page.trust,
        snippet: page.trust === "reviewed" || includeUntrusted ? twoLineFromBody(page.body) : "",
        via: "neighbor",
      });
    }
  }

  if (hits.length === 0) {
    const catalog = pages.find(
      (page) =>
        page.id === "index" ||
        page.path === ".legion-cli/wiki/index.md" ||
        posixEndsWithWikiIndex(page.path),
    );
    if (catalog) {
      hits.push({
        id: catalog.id,
        path: catalog.path,
        title: catalog.title,
        trust: catalog.trust,
        snippet: snippetFor(catalog, includeUntrusted, query),
        via: "catalog",
      });
    }
  }

  return hits;
}

function posixEndsWithWikiIndex(path: string): boolean {
  return path.replaceAll("\\", "/").endsWith("/wiki/index.md");
}

function twoLineFromBody(body: string): string {
  return body
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, 2)
    .join("\n");
}
