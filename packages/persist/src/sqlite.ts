import { createHash } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createRequire } from "node:module";
import {
  AssumptionSchema,
  TaskSchema,
} from "@9thlevelsoftware/legion-cli-schema";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { legionPaths } from "./layout.js";
import { parseMarkdownDocument, readTextFile } from "./markdown.js";
import { toPosixPath, toProjectRelativePosix } from "./paths.js";
import {
  DecisionFileSchema,
  extractWikiLinks,
  wikiIdFromStorePath,
  WikiPageSchema,
} from "./wiki-page.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

export const REBUILD_SQL = `
DROP TABLE IF EXISTS pages_fts;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS decisions;
DROP TABLE IF EXISTS tasks_idx;
DROP TABLE IF EXISTS assumptions_idx;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS pages;

CREATE TABLE pages (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  trust TEXT NOT NULL DEFAULT 'untrusted',
  body_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE pages_fts USING fts5(
  title,
  body,
  path,
  content='pages',
  content_rowid='rowid'
);
CREATE TABLE links (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE TABLE tasks_idx (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  blocked_by_json TEXT NOT NULL
);
CREATE TABLE assumptions_idx (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  blocking INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  adapter TEXT,
  brief_hash TEXT
);
`.trim();

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  let rels: string[];
  try {
    rels = await readdir(dir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const files: string[] = [];
  for (const rel of rels) {
    const abs = join(dir, rel);
    try {
      const info = await stat(abs);
      if (info.isFile()) files.push(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw err;
    }
  }
  return files;
}

function isMarkdown(absPath: string): boolean {
  return absPath.toLowerCase().endsWith(".md");
}

export function openIndexDb(
  dbPath: string,
  opts?: { readonly?: boolean },
): SqliteDatabase {
  return new Database(dbPath, {
    readonly: opts?.readonly ?? false,
    fileMustExist: opts?.readonly ?? false,
  });
}

export function queryIndex<T>(projectRoot: string, sql: string, params: unknown[] = []): T[] {
  const db = openIndexDb(legionPaths(projectRoot).db, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

async function collectPages(
  projectRoot: string,
  wikiDir: string,
): Promise<
  Array<{
    id: string;
    path: string;
    title: string;
    body: string;
    aliases_json: string;
    tags_json: string;
    trust: string;
    body_hash: string;
    updated_at: number;
    links: string[];
  }>
> {
  const files = (await listFilesRecursive(wikiDir)).filter(isMarkdown);
  const pages = [];
  for (const abs of files) {
    const storePath = toProjectRelativePosix(projectRoot, abs);
    const raw = await readTextFile(abs);
    let frontmatter: unknown = {};
    let body = raw;
    try {
      const parsed = parseMarkdownDocument(raw);
      frontmatter = parsed.frontmatter;
      body = parsed.body;
    } catch {
      body = raw;
    }
    const wiki = WikiPageSchema.safeParse(frontmatter);
    const fm = frontmatter && typeof frontmatter === "object" ? (frontmatter as Record<string, unknown>) : {};
    if (
      typeof fm.schemaVersion === "string" &&
      fm.schemaVersion !== "legion-cli-wiki-page/v1"
    ) {
      continue;
    }
    const title = wiki.success
      ? wiki.data.title
      : typeof fm.title === "string" && fm.title.length > 0
        ? fm.title
        : basename(storePath, ".md");
    const aliases = wiki.success ? wiki.data.aliases : [];
    const tags = wiki.success ? wiki.data.tags : [];
    const trust = wiki.success ? wiki.data.trust : "untrusted";
    const updatedAt = wiki.success ? Date.parse(wiki.data.updated) || 0 : 0;
    const id = wikiIdFromStorePath(storePath);
    pages.push({
      id,
      path: toPosixPath(storePath),
      title,
      body,
      aliases_json: JSON.stringify(aliases),
      tags_json: JSON.stringify(tags),
      trust,
      body_hash: sha256(body),
      updated_at: Number.isFinite(updatedAt) ? updatedAt : 0,
      links: extractWikiLinks(body),
    });
  }
  return pages;
}

export async function rebuildIndex(projectRoot: string): Promise<void> {
  const paths = legionPaths(projectRoot);
  await mkdir(paths.indexDir, { recursive: true });
  const db = openIndexDb(paths.db);
  try {
    db.exec(REBUILD_SQL);

    const pages = await collectPages(projectRoot, paths.wikiDir);
    const insertPage = db.prepare(
      `INSERT INTO pages (id, path, title, body, aliases_json, tags_json, trust, body_hash, updated_at)
       VALUES (@id, @path, @title, @body, @aliases_json, @tags_json, @trust, @body_hash, @updated_at)`,
    );
    const insertLink = db.prepare(
      `INSERT OR IGNORE INTO links (from_id, to_id, kind) VALUES (@from_id, @to_id, @kind)`,
    );
    const insertDecision = db.prepare(
      `INSERT OR REPLACE INTO decisions (id, path, status, summary) VALUES (@id, @path, @status, @summary)`,
    );
    const insertTask = db.prepare(
      `INSERT OR REPLACE INTO tasks_idx (id, status, spec_id, blocked_by_json)
       VALUES (@id, @status, @spec_id, @blocked_by_json)`,
    );
    const insertAssumption = db.prepare(
      `INSERT OR REPLACE INTO assumptions_idx (id, status, blocking) VALUES (@id, @status, @blocking)`,
    );

    const tx = db.transaction(() => {
      for (const page of pages) {
        insertPage.run({
          id: page.id,
          path: page.path,
          title: page.title,
          body: page.body,
          aliases_json: page.aliases_json,
          tags_json: page.tags_json,
          trust: page.trust,
          body_hash: page.body_hash,
          updated_at: page.updated_at,
        });
        for (const to of page.links) {
          insertLink.run({ from_id: page.id, to_id: to, kind: "wikilink" });
        }
      }
      db.exec(
        `INSERT INTO pages_fts(rowid, title, body, path)
         SELECT rowid, title, body, path FROM pages`,
      );
    });
    tx();

    for (const abs of (await listFilesRecursive(paths.decisionsDir)).filter(isMarkdown)) {
      const storePath = toProjectRelativePosix(projectRoot, abs);
      try {
        const raw = await readTextFile(abs);
        const { frontmatter } = parseMarkdownDocument(raw);
        const parsed = DecisionFileSchema.safeParse(frontmatter);
        if (!parsed.success) continue;
        insertDecision.run({
          id: parsed.data.id,
          path: toPosixPath(storePath),
          status: parsed.data.status,
          summary: parsed.data.summary,
        });
      } catch {
        continue;
      }
    }

    for (const abs of (await listFilesRecursive(paths.tasksDir)).filter(isMarkdown)) {
      try {
        const raw = await readTextFile(abs);
        const { frontmatter } = parseMarkdownDocument(raw);
        const parsed = TaskSchema.safeParse(frontmatter);
        if (!parsed.success) continue;
        insertTask.run({
          id: parsed.data.id,
          status: parsed.data.status,
          spec_id: parsed.data.specId,
          blocked_by_json: JSON.stringify(parsed.data.blockedBy),
        });
      } catch {
        continue;
      }
    }

    for (const abs of (await listFilesRecursive(paths.assumptionsDir)).filter(isMarkdown)) {
      try {
        const raw = await readTextFile(abs);
        const { frontmatter } = parseMarkdownDocument(raw);
        const parsed = AssumptionSchema.safeParse(frontmatter);
        if (!parsed.success) continue;
        insertAssumption.run({
          id: parsed.data.id,
          status: parsed.data.status,
          blocking: parsed.data.blocking ? 1 : 0,
        });
      } catch {
        continue;
      }
    }
  } finally {
    db.close();
  }
}
