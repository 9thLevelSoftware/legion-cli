import { loadWikiLinks, loadWikiPages, type WikiLinkRow, type WikiPageRow } from "./graph.js";

export type GardenPage = {
  id: string;
  path: string;
  title: string;
  trust: "untrusted" | "reviewed";
  updatedAt?: string;
};

export type GardenDuplicateGroup = {
  pages: GardenPage[];
};

export type GardenReport = {
  orphans: GardenPage[];
  duplicates: GardenDuplicateGroup[];
  staleUntrusted: GardenPage[];
};

function pageAliases(page: WikiPageRow): string[] {
  try {
    const aliases = JSON.parse(page.aliases_json ?? "[]") as unknown;
    return Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === "string") : [];
  } catch {
    return [];
  }
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleTokens(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(" ").filter((token) => token.length > 0));
}

export function titlesSimilar(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 8 && nb.length >= 8 && (na.includes(nb) || nb.includes(na))) return true;
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const token of ta) {
    if (tb.has(token)) inter += 1;
  }
  const union = ta.size + tb.size - inter;
  return union > 0 && inter >= 2 && inter / union >= 0.75;
}

function pageLabels(page: WikiPageRow): string[] {
  return [page.title, ...pageAliases(page)];
}

function pagesSimilar(a: WikiPageRow, b: WikiPageRow): boolean {
  const left = pageLabels(a);
  const right = pageLabels(b);
  return left.some((one) => right.some((two) => titlesSimilar(one, two)));
}

function toGardenPage(page: WikiPageRow): GardenPage {
  const updatedAt =
    typeof page.updated_at === "number" && page.updated_at > 0 ? new Date(page.updated_at).toISOString() : undefined;
  return {
    id: page.id,
    path: page.path,
    title: page.title,
    trust: page.trust,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function linkKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/\.md$/i, "").trim().toLowerCase();
}

function pageLookup(pages: readonly WikiPageRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const page of pages) {
    map.set(linkKey(page.id), page.id);
    map.set(linkKey(page.title), page.id);
    map.set(linkKey(page.path), page.id);
    const wikiPath = page.path.replace(/^\.legion-cli\/wiki\//i, "");
    map.set(linkKey(wikiPath), page.id);
    for (const alias of pageAliases(page)) {
      map.set(linkKey(alias), page.id);
    }
  }
  return map;
}

function resolveLink(lookup: Map<string, string>, target: string): string | undefined {
  return lookup.get(linkKey(target));
}

export function orphanPages(pages: readonly WikiPageRow[], links: readonly WikiLinkRow[]): WikiPageRow[] {
  const lookup = pageLookup(pages);
  const inbound = new Map<string, Set<string>>();
  for (const page of pages) inbound.set(page.id, new Set());
  for (const link of links) {
    const to = resolveLink(lookup, link.to_id);
    const from = resolveLink(lookup, link.from_id) ?? link.from_id;
    if (!to || to === from) continue;
    inbound.get(to)?.add(from);
  }
  return pages.filter((page) => (inbound.get(page.id)?.size ?? 0) === 0).sort((a, b) => a.id.localeCompare(b.id));
}

export function duplicateTitleGroups(pages: readonly WikiPageRow[]): WikiPageRow[][] {
  const parent = pages.map((_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      const next = parent[cursor] ?? cursor;
      parent[cursor] = parent[next] ?? next;
      cursor = next;
    }
    return cursor;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < pages.length; i += 1) {
    for (let j = i + 1; j < pages.length; j += 1) {
      const left = pages[i];
      const right = pages[j];
      if (!left || !right) continue;
      if (pagesSimilar(left, right)) unite(i, j);
    }
  }
  const clusters = new Map<number, WikiPageRow[]>();
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (!page) continue;
    const root = find(i);
    const group = clusters.get(root) ?? [];
    group.push(page);
    clusters.set(root, group);
  }
  return [...clusters.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort((a, b) => a.id.localeCompare(b.id)))
    .sort((a, b) => (a[0]?.id ?? "").localeCompare(b[0]?.id ?? ""));
}

export function staleUntrustedPages(pages: readonly WikiPageRow[]): WikiPageRow[] {
  return pages.filter((page) => page.trust === "untrusted").sort((a, b) => a.id.localeCompare(b.id));
}

export function gardenReport(projectRoot: string): GardenReport {
  const pages = loadWikiPages(projectRoot);
  const links = loadWikiLinks(projectRoot);
  return {
    orphans: orphanPages(pages, links).map(toGardenPage),
    duplicates: duplicateTitleGroups(pages).map((group) => ({ pages: group.map(toGardenPage) })),
    staleUntrusted: staleUntrustedPages(pages).map(toGardenPage),
  };
}
