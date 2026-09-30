import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { indexDbUsable, legionPaths, queryIndex, rebuildIndex } from "../dist/index.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-sqlite2-"));
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

function captureStderr() {
  const seen = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    seen.push(String(chunk));
    return true;
  };
  return {
    seen,
    restore: () => {
      process.stderr.write = real;
    },
  };
}

test("a failure after the tmp db is built leaves the live db byte-identical and removes the tmp file", async () => {
  await withTempDir(async (dir) => {
    await seedWiki(dir, ["alpha", "beta"]);
    await rebuildIndex(dir);
    const db = legionPaths(dir).db;
    const before = await readFile(db);
    await seedWiki(dir, ["gamma"]);
    await assert.rejects(
      () =>
        rebuildIndex(dir, {
          beforeRename: () => {
            throw new Error("simulated crash before rename");
          },
        }),
      /simulated crash/,
    );
    assert.deepEqual(await readFile(db), before, "the live index is untouched by a failed rebuild");
    assert.equal(existsSync(`${db}.tmp`), false);
    assert.equal(indexDbUsable(dir), true);
    assert.equal(queryIndex(dir, "SELECT id FROM pages").length, 2);
  });
});

test("a garbage file at the live db path is not usable and a rebuild replaces it", async () => {
  await withTempDir(async (dir) => {
    await seedWiki(dir, ["alpha"]);
    await mkdir(legionPaths(dir).indexDir, { recursive: true });
    await writeFile(legionPaths(dir).db, "this is not a sqlite database at all, ".repeat(20), "utf8");
    assert.equal(indexDbUsable(dir), false);
    await rebuildIndex(dir);
    assert.equal(indexDbUsable(dir), true);
    assert.equal(queryIndex(dir, "SELECT id FROM pages").length, 1);
  });
});

test("a garbage tmp file from a crashed rebuild is cleared, not opened", async () => {
  await withTempDir(async (dir) => {
    await seedWiki(dir, ["alpha"]);
    await mkdir(legionPaths(dir).indexDir, { recursive: true });
    await writeFile(`${legionPaths(dir).db}.tmp`, "not a database ".repeat(100), "utf8");
    await rebuildIndex(dir);
    assert.equal(existsSync(`${legionPaths(dir).db}.tmp`), false);
    assert.equal(indexDbUsable(dir), true);
  });
});

test("a stale rollback journal beside the old db is removed, not replayed into the new one", async () => {
  await withTempDir(async (dir) => {
    await seedWiki(dir, ["alpha"]);
    await rebuildIndex(dir);
    const db = legionPaths(dir).db;
    await writeFile(`${db}-journal`, Buffer.alloc(512, 1));
    await rebuildIndex(dir);
    assert.equal(existsSync(`${db}-journal`), false);
    assert.equal(indexDbUsable(dir), true);
    assert.equal(queryIndex(dir, "SELECT id FROM pages").length, 1);
  });
});

test("skipped files are reported on stderr once per distinct list, not on every rebuild", async () => {
  await withTempDir(async (dir) => {
    await seedWiki(dir, ["alpha"]);
    const tasks = legionPaths(dir).tasksDir;
    await mkdir(tasks, { recursive: true });
    await writeFile(join(tasks, "TSK-0042.md"), "---\nid: nope\n---\n", "utf8");
    const cap = captureStderr();
    try {
      await rebuildIndex(dir);
      await rebuildIndex(dir);
    } finally {
      cap.restore();
    }
    const lines = cap.seen.filter((line) => line.includes("index rebuild skipped"));
    assert.equal(lines.length, 1, `stderr: ${cap.seen.join("|")}`);
    assert.match(lines[0], /TSK-0042\.md/);
  });
});
