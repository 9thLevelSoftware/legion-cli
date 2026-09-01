export {
  extractWikiLinks,
  wikiIdFromStorePath,
  WikiPageSchema,
  WIKI_PAGE_SCHEMA_VERSION,
} from "@9thlevelsoftware/legion-cli-persist";
export type { WikiPage } from "@9thlevelsoftware/legion-cli-persist";

export function twoLineSummary(body: string): string {
  const lines = body
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return lines.slice(0, 2).join("\n");
}

export function titleFromHtml(html: string): string | undefined {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title && title.length > 0 ? title : undefined;
}

export function excerptHtml(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? `${text}\n` : "";
}

export function looksLikeHtml(body: string, contentType = ""): boolean {
  if (/html/i.test(contentType)) return true;
  const head = body.slice(0, 256).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html");
}
