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
};

export function loadWikiLinks(projectRoot: string): WikiLinkRow[] {
  return queryIndex<WikiLinkRow>(
    projectRoot,
    "SELECT from_id, to_id, kind FROM links",
  );
}

export function loadWikiPages(projectRoot: string): WikiPageRow[] {
  return queryIndex<WikiPageRow>(
    projectRoot,
    "SELECT id, path, title, body, trust, aliases_json FROM pages",
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
