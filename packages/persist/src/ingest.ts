import { randomBytes } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { IngestReceipt } from "@9thlevelsoftware/legion-cli-schema";
import { IngestReceiptSchema } from "@9thlevelsoftware/legion-cli-schema";
import { PathEscapeError } from "./errors.js";
import { ingestReceiptPath, MAX_INGEST_FILE_BYTES, MAX_INGEST_TREE_BYTES, wikiPageStorePath } from "./layout.js";
import { parseMarkdownDocument, type MarkdownDoc } from "./markdown.js";
import { assertInsideProject, resolveProjectPath, toStorePath } from "./paths.js";
import { WIKI_PAGE_SCHEMA_VERSION, type WikiPage } from "./wiki-page.js";

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

export async function ingestFiles(opts: {
  projectRoot: string;
  sources: string[];
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

  const uniqueSources = [...new Set(sourcePosix)];
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
    if (body.trim() === "") {
      skipped.push(file.posix);
      continue;
    }

    const existing = alreadyWiki ? await opts.readWikiPage(pagePath) : null;
    const page: WikiPage = {
      schemaVersion: WIKI_PAGE_SCHEMA_VERSION,
      title: titleFromSource(file.posix, raw),
      aliases: existing?.data.aliases ?? [],
      tags: existing?.data.tags ?? [],
      trust: existing?.data.trust ?? "untrusted",
      updated: existing && sameBody(existing.body, body) ? existing.data.updated : updatedAt,
      source: existing?.data.source ?? file.posix,
    };

    if (existing && sameBody(existing.body, body)) {
      skipped.push(file.posix);
      continue;
    }

    const existed = existing !== null || (await opts.wikiExists(pagePath));
    await opts.writeWikiPage(pagePath, page, body);
    if (existed) pagesUpdated.push(pagePath);
    else pagesCreated.push(pagePath);
  }

  const receipt = IngestReceiptSchema.parse({
    schemaVersion: "legion-cli-ingest/v1",
    id,
    sources: uniqueSources.length > 0 ? uniqueSources : opts.sources.map((s) => toStorePath(s)),
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
