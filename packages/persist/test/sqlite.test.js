import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { indexDbUsable, legionPaths, queryIndex, rebuildIndex } from "../dist/index.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-sqlite-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedWiki(dir, names) {
  const wiki = legionPaths(dir).wikiDir;
  await mkdir(wiki, { recursive: true });
  for (const name of names) await writeFile(join(wiki, `${name}.md`), `# ${name}\n\nbody of ${name}\n`, "utf8");
}

test("a failure during rebuild leaves the previous index intact and usable", async () => {
  await withTempDir(async (dir) => {
    await seedWiki(dir, ["alpha", "beta"]);
    await rebuildIndex(dir);
    assert.equal(indexDbUsable(dir), true);
    // Make the next rebuild fail while reading pages: the wiki dir becomes a file.
    const wiki = legionPaths(dir).wikiDir;
    await rm(wiki, { recursive: true, force: true });
    await writeFile(wiki, "not a dir", "utf8");
    await assert.rejects(() => rebuildIndex(dir));
    assert.equal(indexDbUsable(dir), true);
    const rows = queryIndex(dir, "SELECT id FROM pages ORDER BY id");
    assert.equal(rows.length, 2, "the previous rows must survive a failed rebuild");
  });
});

test("a leftover partial temp db from a crashed rebuild is ignored and replaced", async () => {
  await withTempDir(async (dir) => {
    await seedWiki(dir, ["alpha"]);
    await rebuildIndex(dir);
    await writeFile(`${legionPaths(dir).db}.tmp`, "partial garbage", "utf8");
    assert.equal(indexDbUsable(dir), true, "the live db is still the usable one");
    await rebuildIndex(dir);
    assert.equal(queryIndex(dir, "SELECT id FROM pages").length, 1);
  });
});

test("a version-less db (pre-upgrade layout) is not usable, and a rebuild upgrades it cleanly", async () => {
  await withTempDir(async (dir) => {
    await seedWiki(dir, ["alpha", "beta"]);
    const dbPath = legionPaths(dir).db;
    await mkdir(legionPaths(dir).indexDir, { recursive: true });
    const old = new Database(dbPath);
    old.exec("CREATE TABLE pages (id TEXT); INSERT INTO pages VALUES ('stale');");
    old.close();
    assert.equal(indexDbUsable(dir), false, "no schema-version row means rebuild, not usable");
    await rebuildIndex(dir);
    assert.equal(indexDbUsable(dir), true);
    assert.equal(queryIndex(dir, "SELECT id FROM pages").length, 2);
  });
});

test("skipped files are counted and reported", async () => {
  await withTempDir(async (dir) => {
    await seedWiki(dir, ["alpha"]);
    const tasks = legionPaths(dir).tasksDir;
    await mkdir(tasks, { recursive: true });
    await writeFile(join(tasks, "TSK-0001.md"), "---\nid: nope\n---\n", "utf8");
    const result = await rebuildIndex(dir);
    assert.equal(result.pages, 1);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /TSK-0001\.md/);
  });
});
