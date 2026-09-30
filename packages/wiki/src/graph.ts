import { queryIndex } from "@9thlevelsoftware/legion-cli-persist";

export type WikiLinkRow = {
  from_id: string;
  to_id: string;
  kind: string;
};

export type WikiPageRow = {
  id: string;
  path: string;
  title: string;
  body: string;
  trust: "untrusted" | "reviewed";
  aliases_json?: string;
  updated_at?: number;
};

export function loadWikiLinks(projectRoot: string): WikiLinkRow[] {
  return queryIndex<WikiLinkRow>(
    projectRoot,
    "SELECT from_id, to_id, kind FROM links",
  );
}

export type WikiPageHead = Omit<WikiPageRow, "body">;

/** Same rows as loadWikiPages without the (large) body column. */
export function loadWikiPageHeads(projectRoot: string): WikiPageHead[] {
  return queryIndex<WikiPageHead>(projectRoot, "SELECT id, path, title, trust FROM pages");
}

/** Bodies for a bounded set of page ids (chunked to stay under SQLite's variable limit). */
export function loadWikiBodies(projectRoot: string, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = queryIndex<{ id: string; body: string }>(
      projectRoot,
      `SELECT id, body FROM pages WHERE id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
    for (const row of rows) out.set(row.id, row.body);
  }
  return out;
}

export function loadWikiPages(projectRoot: string): WikiPageRow[] {
  return queryIndex<WikiPageRow>(
    projectRoot,
    "SELECT id, path, title, body, trust, aliases_json, updated_at FROM pages",
  );
}

export function backlinks(links: readonly WikiLinkRow[], pageId: string): string[] {
  const ids = new Set<string>();
  for (const link of links) {
    if (link.to_id === pageId) ids.add(link.from_id);
  }
  return [...ids];
}

/** Depth-1 neighbors in either direction. */
export function neighbors(links: readonly WikiLinkRow[], pageId: string): string[] {
  const ids = new Set<string>();
  for (const link of links) {
    if (link.from_id === pageId) ids.add(link.to_id);
    if (link.to_id === pageId) ids.add(link.from_id);
  }
  ids.delete(pageId);
  return [...ids];
}

export function hubs(
  links: readonly WikiLinkRow[],
  limit = 10,
): Array<{ id: string; inDegree: number }> {
  const degrees = new Map<string, number>();
  for (const link of links) {
    degrees.set(link.to_id, (degrees.get(link.to_id) ?? 0) + 1);
  }
  return [...degrees.entries()]
    .map(([id, inDegree]) => ({ id, inDegree }))
    .sort((a, b) => b.inDegree - a.inDegree || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function wikiGraph(projectRoot: string): {
  pages: WikiPageRow[];
  links: WikiLinkRow[];
  hubs: Array<{ id: string; inDegree: number }>;
} {
  const pages = loadWikiPages(projectRoot);
  const links = loadWikiLinks(projectRoot);
  return { pages, links, hubs: hubs(links) };
}
