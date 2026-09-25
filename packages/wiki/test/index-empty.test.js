import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";

import { indexDbUsable, legionPaths, LegionStore, queryIndex } from "@9thlevelsoftware/legion-cli-persist";

import { wikiIndexReady } from "../dist/index.js";
import { copyFixtureProject, withTempDir } from "./helpers.js";

test("empty index DB is not ready and the first rebuild fills pages", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const paths = legionPaths(dir);
    await mkdir(paths.indexDir, { recursive: true });
    await writeFile(paths.db, "", "utf8");
    assert.equal(indexDbUsable(dir), false, "empty-db");
    assert.equal(wikiIndexReady(dir), false, "empty-db");
    const store = new LegionStore(dir);
    await store.rebuild();
    assert.equal(indexDbUsable(dir), true);
    assert.equal(wikiIndexReady(dir), true);
    const pages = queryIndex(dir, "SELECT id FROM pages");
    assert.ok(pages.length >= 1);
  });
});
