import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createRequire } from "node:module";
import {
  AssumptionSchema,
  TaskSchema,
} from "@9thlevelsoftware/legion-cli-schema";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { retryFsOp } from "./atomic-write.js";
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
DROP TABLE IF EXISTS meta;

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
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`.trim();

/** Written last into `meta`; a db without this row is a partial or pre-upgrade index and is rebuilt. */
export const INDEX_SCHEMA_VERSION = "2";

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

/** False for missing, empty, partial or version-less DBs (they mean "rebuild", not "corrupt"). */
export function indexDbUsable(projectRoot: string): boolean {
  const dbPath = legionPaths(projectRoot).db;
  try {
    const st = statSync(dbPath);
    if (!st.isFile() || st.size === 0) return false;
  } catch {
    return false;
  }
  try {
    const rows = queryIndex<{ value: string }>(
      projectRoot,
      "SELECT value FROM meta WHERE key = 'schema_version'",
    );
    return rows[0]?.value === INDEX_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

async function collectPages(
  projectRoot: string,
  wikiDir: string,
  skipped: string[],
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
      skipped.push(`${storePath} (unsupported schemaVersion)`);
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

export type IndexRebuildResult = {
  /** Pages written to the new index. */
  pages: number;
  /** Store paths of files left out of the index, each with a short reason. */
  skipped: string[];
};

async function collectIndexRows<T>(
  projectRoot: string,
  dir: string,
  skipped: string[],
  read: (frontmatter: unknown, storePath: string) => T | null,
): Promise<T[]> {
  const rows: T[] = [];
  for (const abs of (await listFilesRecursive(dir)).filter(isMarkdown)) {
    const storePath = toProjectRelativePosix(projectRoot, abs);
    try {
      const { frontmatter } = parseMarkdownDocument(await readTextFile(abs));
      const row = read(frontmatter, toPosixPath(storePath));
      if (row) rows.push(row);
      else skipped.push(`${storePath} (invalid frontmatter)`);
    } catch {
      skipped.push(`${storePath} (unreadable)`);
    }
  }
  return rows;
}

/**
 * Rebuild into `legion-cli.db.tmp` and rename over the live db. Every read happens before any
 * write, so a failure or crash leaves the previous index untouched (and a leftover tmp file is
 * simply replaced). Caller holds the engine lock.
 */
export async function rebuildIndex(projectRoot: string): Promise<IndexRebuildResult> {
  const paths = legionPaths(projectRoot);
  await mkdir(paths.indexDir, { recursive: true });
  const skipped: string[] = [];
  const pages = await collectPages(projectRoot, paths.wikiDir, skipped);
  const decisions = await collectIndexRows(projectRoot, paths.decisionsDir, skipped, (fm, storePath) => {
    const parsed = DecisionFileSchema.safeParse(fm);
    return parsed.success
      ? { id: parsed.data.id, path: storePath, status: parsed.data.status, summary: parsed.data.summary }
      : null;
  });
  const tasks = await collectIndexRows(projectRoot, paths.tasksDir, skipped, (fm) => {
    const parsed = TaskSchema.safeParse(fm);
    return parsed.success
      ? {
          id: parsed.data.id,
          status: parsed.data.status,
          spec_id: parsed.data.specId,
          blocked_by_json: JSON.stringify(parsed.data.blockedBy),
        }
      : null;
  });
  const assumptions = await collectIndexRows(projectRoot, paths.assumptionsDir, skipped, (fm) => {
    const parsed = AssumptionSchema.safeParse(fm);
    return parsed.success
      ? { id: parsed.data.id, status: parsed.data.status, blocking: parsed.data.blocking ? 1 : 0 }
      : null;
  });

  const tmp = `${paths.db}.tmp`;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) await rm(`${tmp}${suffix}`, { force: true });
  const db = openIndexDb(tmp);
  let written = 0;
  try {
    db.exec(REBUILD_SQL);
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
    const insertMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (@key, @value)`);

    const tx = db.transaction(() => {
      for (const page of pages) {
        try {
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
        } catch {
          // A duplicate id or path (two files mapping to one page): report it, keep the rest.
          skipped.push(`${page.path} (duplicate page id or path)`);
          continue;
        }
        written += 1;
        for (const to of page.links) {
          insertLink.run({ from_id: page.id, to_id: to, kind: "wikilink" });
        }
      }
      db.exec(
        `INSERT INTO pages_fts(rowid, title, body, path)
         SELECT rowid, title, body, path FROM pages`,
      );
      for (const row of decisions) insertDecision.run(row);
      for (const row of tasks) insertTask.run(row);
      for (const row of assumptions) insertAssumption.run(row);
      insertMeta.run({ key: "schema_version", value: INDEX_SCHEMA_VERSION });
    });
    tx();
    db.close();
  } catch (err) {
    db.close();
    await rm(tmp, { force: true });
    throw err;
  }
  await retryFsOp(() => rename(tmp, paths.db));
  if (skipped.length > 0) {
    process.stderr.write(
      `legion-cli: index rebuild skipped ${skipped.length} file(s): ${skipped.slice(0, 5).join("; ")}${skipped.length > 5 ? "; ..." : ""}
`,
    );
  }
  return { pages: written, skipped };
}
