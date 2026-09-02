import { z } from "zod";

export const WIKI_PAGE_SCHEMA_VERSION = "legion-cli-wiki-page/v1";
export const DECISION_FILE_SCHEMA_VERSION = "legion-cli-decision/v1";

export const WikiPageSchema = z.object({
  schemaVersion: z.literal(WIKI_PAGE_SCHEMA_VERSION),
  title: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  trust: z.enum(["untrusted", "reviewed"]).default("untrusted"),
  updated: z.string().min(1),
  source: z.string().min(1).optional(),
});
export type WikiPage = z.infer<typeof WikiPageSchema>;

export const DecisionFileSchema = z.object({
  schemaVersion: z.literal(DECISION_FILE_SCHEMA_VERSION),
  id: z.string().min(1),
  status: z.string().min(1),
  summary: z.string(),
});
export type DecisionFile = z.infer<typeof DecisionFileSchema>;

export function wikiIdFromStorePath(storePath: string): string {
  const prefix = ".legion-cli/wiki/";
  const rest = storePath.startsWith(prefix) ? storePath.slice(prefix.length) : storePath;
  return rest.replace(/\.md$/i, "");
}

export function extractWikiLinks(body: string): string[] {
  const links: string[] = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const target = match[1]?.trim();
    if (target) links.push(target);
  }
  return links;
}
