import { randomBytes } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { IngestReceipt } from "@9thlevelsoftware/legion-cli-schema";
import { IngestReceiptSchema } from "@9thlevelsoftware/legion-cli-schema";
import { PathEscapeError } from "./errors.js";
import { ingestReceiptPath, MAX_INGEST_FILE_BYTES, MAX_INGEST_TREE_BYTES, wikiPageStorePath } from "./layout.js";
import { parseMarkdownDocument, type MarkdownDoc } from "./markdown.js";
import { assertInsideProject, resolveProjectPath, toStorePath } from "./paths.js";
import { redactSecrets } from "./redact.js";
import { WIKI_PAGE_SCHEMA_VERSION, type WikiPage } from "./wiki-page.js";

export type IngestDocument = {
  source: string;
  body: string;
  title?: string;
};

const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".legion-cli"]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".wasm",
  ".mp3",
  ".mp4",
  ".webm",
  ".mov",
  ".avi",
  ".sqlite",
  ".db",
]);

function newIngestId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function titleFromSource(storePath: string, body: string): string {
  try {
    const { frontmatter, body: inner } = parseMarkdownDocument(body);
    const fm = frontmatter && typeof frontmatter === "object" ? (frontmatter as Record<string, unknown>) : {};
    if (typeof fm.title === "string" && fm.title.trim().length > 0) return fm.title.trim();
    const heading = /^#\s+(.+)$/m.exec(inner);
    if (heading?.[1]) return heading[1].trim();
  } catch {
    const heading = /^#\s+(.+)$/m.exec(body);
    if (heading?.[1]) return heading[1].trim();
  }
  return basename(storePath, extname(storePath));
}

function excerptBody(raw: string): string {
  try {
    const parsed = parseMarkdownDocument(raw);
    return parsed.body.trimEnd() + (parsed.body.trim().length > 0 ? "\n" : "");
  } catch {
    return raw.endsWith("\n") ? raw : `${raw}\n`;
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(abs)));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

function isBinaryExtension(posix: string): boolean {
  return BINARY_EXTENSIONS.has(extname(posix).toLowerCase());
}

function looksBinaryBuffer(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  const text = buf.toString("utf8");
  return !Buffer.from(text, "utf8").equals(buf);
}

function sameBody(a: string, b: string): boolean {
  return a.replaceAll("\r\n", "\n").trim() === b.replaceAll("\r\n", "\n").trim();
}

function safeSlugSegment(part: string): string {
  return part.replace(/[^A-Za-z0-9._~-]+/g, "_");
}

/** Store path for a non-file ingest (URL, transcript, diff). */
export function ingestDocumentStorePath(source: string): string {
  let slug = source;
  if (/^https:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      const path = url.pathname.replace(/\/+$/, "") || "index";
      slug = `urls/${url.hostname}${path}`;
    } catch {
      slug = `urls/${source.replace(/^https:\/\//i, "")}`;
    }
  } else if (source.startsWith("diff:")) {
    slug = `diffs/${source.slice("diff:".length)}`;
  } else if (source.startsWith("transcript:")) {
    slug = `transcripts/${source.slice("transcript:".length)}`;
  }
  const posix = toStorePath(slug)
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .map(safeSlugSegment)
    .join("/");
  return wikiPageStorePath(posix || "note");
}

async function upsertWikiPage(opts: {
  pagePath: string;
  source: string;
  title: string;
  body: string;
  updatedAt: string;
  wikiExists: (storePath: string) => Promise<boolean>;
  readWikiPage: (storePath: string) => Promise<MarkdownDoc<WikiPage> | null>;
  writeWikiPage: (storePath: string, data: WikiPage, body: string) => Promise<void>;
}): Promise<"created" | "updated" | "skipped"> {
  const body = redactSecrets(opts.body);
  if (body.trim() === "") return "skipped";

  let existing: MarkdownDoc<WikiPage> | null = null;
  try {
    existing = await opts.readWikiPage(opts.pagePath);
  } catch {
    existing = null;
  }

  const page: WikiPage = {
    schemaVersion: WIKI_PAGE_SCHEMA_VERSION,
    title: opts.title.trim() || titleFromSource(opts.source, body),
    aliases: existing?.data.aliases ?? [],
    tags: existing?.data.tags ?? [],
    trust: existing?.data.trust ?? "untrusted",
    updated: existing && sameBody(existing.body, body) ? existing.data.updated : opts.updatedAt,
    source: existing?.data.source ?? opts.source,
  };

  if (existing && sameBody(existing.body, body)) return "skipped";

  const existed = existing !== null || (await opts.wikiExists(opts.pagePath));
  await opts.writeWikiPage(opts.pagePath, page, body);
  return existed ? "updated" : "created";
}

export async function ingestFiles(opts: {
  projectRoot: string;
  sources: string[];
  documents?: IngestDocument[];
  wikiExists: (storePath: string) => Promise<boolean>;
  readWikiPage: (storePath: string) => Promise<MarkdownDoc<WikiPage> | null>;
  writeWikiPage: (storePath: string, data: WikiPage, body: string) => Promise<void>;
  writeReceipt: (storePath: string, data: IngestReceipt, body: string) => Promise<void>;
}): Promise<IngestReceipt> {
  const id = newIngestId();
  const sourcePosix: string[] = [];
  const pagesCreated: string[] = [];
  const pagesUpdated: string[] = [];
  const skipped: string[] = [];
  let treeBytes = 0;

  const files: Array<{ abs: string; posix: string; explicit: boolean }> = [];

  for (const source of opts.sources) {
    const posixHint = toStorePath(source);
    try {
      const resolved = resolveProjectPath(opts.projectRoot, source);
      const real = await realpath(resolved);
      const posix = assertInsideProject(opts.projectRoot, real);
      sourcePosix.push(posix);
      const info = await stat(real);
      if (info.isDirectory()) {
        const walked = await walkFiles(real);
        for (const abs of walked) {
          const filePosix = assertInsideProject(opts.projectRoot, await realpath(abs));
          files.push({ abs, posix: filePosix, explicit: false });
        }
      } else if (info.isFile()) {
        files.push({ abs: real, posix, explicit: true });
      } else {
        skipped.push(posix);
      }
    } catch (err) {
      if (err instanceof PathEscapeError) throw err;
      skipped.push(posixHint);
    }
  }

  const uniqueFiles: typeof files = [];
  const seenPosix = new Set<string>();
  for (const file of files) {
    if (seenPosix.has(file.posix)) continue;
    seenPosix.add(file.posix);
    uniqueFiles.push(file);
  }

  const updatedAt = new Date().toISOString();

  for (const file of uniqueFiles) {
    const underLegion = file.posix === ".legion-cli" || file.posix.startsWith(".legion-cli/");
    const alreadyWiki = file.posix.startsWith(".legion-cli/wiki/");
    if (underLegion && !alreadyWiki) {
      skipped.push(file.posix);
      continue;
    }
    if (alreadyWiki && !file.explicit) {
      skipped.push(file.posix);
      continue;
    }
    if (isBinaryExtension(file.posix)) {
      skipped.push(file.posix);
      continue;
    }

    const info = await stat(file.abs);
    if (info.size > MAX_INGEST_FILE_BYTES) {
      skipped.push(file.posix);
      continue;
    }
    treeBytes += info.size;
    if (treeBytes > MAX_INGEST_TREE_BYTES) {
      skipped.push(file.posix);
      continue;
    }

    let buf: Buffer;
    try {
      buf = await readFile(file.abs);
    } catch {
      skipped.push(file.posix);
      continue;
    }
    if (looksBinaryBuffer(buf)) {
      skipped.push(file.posix);
      continue;
    }
    const raw = buf.toString("utf8");
    const pagePath = alreadyWiki ? file.posix : wikiPageStorePath(file.posix);
    const body = excerptBody(raw);
    const result = await upsertWikiPage({
      pagePath,
      source: file.posix,
      title: titleFromSource(file.posix, raw),
      body,
      updatedAt,
      wikiExists: opts.wikiExists,
      readWikiPage: alreadyWiki ? opts.readWikiPage : async () => null,
      writeWikiPage: opts.writeWikiPage,
    });
    if (result === "created") pagesCreated.push(pagePath);
    else if (result === "updated") pagesUpdated.push(pagePath);
    else skipped.push(file.posix);
  }

  for (const doc of opts.documents ?? []) {
    const pagePath = ingestDocumentStorePath(doc.source);
    const body = excerptBody(doc.body);
    const result = await upsertWikiPage({
      pagePath,
      source: doc.source,
      title: doc.title ?? titleFromSource(doc.source, doc.body),
      body,
      updatedAt,
      wikiExists: opts.wikiExists,
      readWikiPage: opts.readWikiPage,
      writeWikiPage: opts.writeWikiPage,
    });
    sourcePosix.push(doc.source);
    if (result === "created") pagesCreated.push(pagePath);
    else if (result === "updated") pagesUpdated.push(pagePath);
    else skipped.push(doc.source);
  }

  const allSources = [...new Set(sourcePosix)];
  const receipt = IngestReceiptSchema.parse({
    schemaVersion: "legion-cli-ingest/v1",
    id,
    sources:
      allSources.length > 0
        ? allSources
        : opts.sources.map((s) => toStorePath(s)),
    pagesCreated,
    pagesUpdated,
    skipped,
  });

  const summaryLines = [
    `Ingest ${id}`,
    `created: ${pagesCreated.length}`,
    `updated: ${pagesUpdated.length}`,
    `skipped: ${skipped.length}`,
    "",
  ];
  await opts.writeReceipt(ingestReceiptPath(id), receipt, summaryLines.join("\n"));
  return receipt;
}
