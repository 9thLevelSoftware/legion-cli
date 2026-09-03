import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { TopicsFileSchema } from "@9thlevelsoftware/legion-cli-schema";
import {
  WIKI_INDEX_SEE_ALSO,
  WIKI_INDEX_STORE_PATH,
  WIKI_TOPICS_STORE_PATH,
} from "@9thlevelsoftware/legion-cli-wiki";

import { initProject, makeTask, withEngine, writeTask } from "./helpers.js";

test("engine ingest writes index.md catalog, topics.yaml, and excerpt [[index]] footer", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeFile(
      join(dir, "secret-note.md"),
      "# Secret note\n\nUNIQUE_UNTRUSTED_TOKEN lives only in the body.\n",
      "utf8",
    );
    const receipt = await engine.ingest(["secret-note.md"], { noCommit: true });
    assert.ok(receipt.pagesCreated.length >= 1);

    const index = await store.readWikiPage(WIKI_INDEX_STORE_PATH);
    assert.equal(index.data.title, "Wiki index");
    assert.equal(index.data.trust, "reviewed");
    assert.match(index.body, /\[\[ingested\/secret-note\]\]/);
    assert.doesNotMatch(index.body, /UNIQUE_UNTRUSTED_TOKEN/);

    const excerpt = await store.readWikiPage(receipt.pagesCreated[0]);
    assert.match(excerpt.body, new RegExp(WIKI_INDEX_SEE_ALSO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const topics = TopicsFileSchema.parse(await store.readYaml(WIKI_TOPICS_STORE_PATH, TopicsFileSchema));
    assert.equal(topics.schemaVersion, "legion-cli-topics/v1");
    assert.ok(topics.topics.wiki.includes("index"));
  });
});

test("wikiTrust and compactContext refresh the engine catalog; garden does not", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    assert.equal(await store.pathExists(WIKI_INDEX_STORE_PATH), false);

    const gardenBefore = await engine.garden();
    assert.ok(Array.isArray(gardenBefore.orphans));
    assert.equal(await store.pathExists(WIKI_INDEX_STORE_PATH), false);
    assert.equal(await store.pathExists(WIKI_TOPICS_STORE_PATH), false);

    await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
    const receipt = await engine.ingest(["notes.md"], { noCommit: true });
    await engine.wikiTrust(receipt.pagesCreated[0]);

    const afterTrust = await store.readWikiPage(WIKI_INDEX_STORE_PATH);
    assert.equal(afterTrust.data.trust, "reviewed");
    assert.match(afterTrust.body, /## Reviewed/);
    assert.match(afterTrust.body, /\[\[ingested\/notes\]\]/);
    assert.doesNotMatch(afterTrust.body, /UNIQUE_UNTRUSTED_TOKEN/);

    const shown = await store.readWikiPage(receipt.pagesCreated[0]);
    assert.equal(shown.data.trust, "reviewed");

    await writeFile(join(dir, ".legion-cli", "wiki", "index.md"), "spawn overwrote this\n", "utf8");
    await writeTask(store, makeTask({ status: "done" }), "Verbose spawn output.\n");
    await engine.compactContext();

    const afterCompact = await store.readWikiPage(WIKI_INDEX_STORE_PATH);
    assert.equal(afterCompact.data.title, "Wiki index");
    assert.equal(afterCompact.data.trust, "reviewed");
    assert.match(afterCompact.body, /Catalog of compiled pages/);

    const garden = await engine.garden();
    assert.equal(garden.orphans.some((page) => page.id === "ingested/notes"), false);
    assert.equal(await store.pathExists(receipt.pagesCreated[0]), true);
  });
});

test("engine search empty query is [] and FTS miss is via catalog", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
    await engine.ingest(["notes.md"], { noCommit: true });
    assert.deepEqual(await engine.search(""), []);
    assert.deepEqual(await engine.search("   "), []);
    const fallback = await engine.search("xyzzy-catalog-miss-9f3a");
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].via, "catalog");
    assert.equal(fallback[0].title, "Wiki index");
    const fts = await engine.search("Notes");
    assert.ok(fts.some((hit) => hit.via === "fts" || hit.title === "Notes"));
    assert.equal(fts.some((hit) => hit.via === "catalog"), false);
  });
});
