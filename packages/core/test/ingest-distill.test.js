import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { WIKI_INDEX_STORE_PATH } from "@9thlevelsoftware/legion-cli-wiki";

import { DISTILL_SOURCE_MAX_CHARS } from "../dist/index.js";
import {
  git,
  initGitRepo,
  initProject,
  readLatestRunPrompt,
  withEngine,
  withFakeAdapter,
  writeUnspawnableGrok,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

function wikiPageMarkdown(opts) {
  return [
    "---",
    "schemaVersion: legion-cli-wiki-page/v1",
    `title: ${opts.title}`,
    "aliases: []",
    "tags: []",
    `trust: ${opts.trust}`,
    "updated: 2026-09-03T00:00:00.000Z",
    opts.source ? `source: ${opts.source}` : null,
    "---",
    "",
    opts.body,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

async function ingestRunNames(dir) {
  const runsDir = join(dir, ".legion-cli", "cache", "runs");
  if (!existsSync(runsDir)) return [];
  return (await readdir(runsDir)).filter((name) => name.startsWith("ingest-"));
}

test("distill writing src/main.ts reverts", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ dir, engine }) => {
        await initProject(engine);
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
        const receipt = await engine.ingest(["notes.md"], { noCommit: true, distill: true });
        assert.equal(receipt.distillSkipped, undefined);
        assert.equal(receipt.distillRan, true);
        assert.ok((await ingestRunNames(dir)).length >= 1);
        assert.equal(existsSync(join(dir, "src", "main.ts")), false);
        assert.ok(receipt.pagesCreated.length >= 1);
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: "src/main.ts", content: "export const leaked = true;\n" }],
      },
    );
  });
});

test("distill writing trust: reviewed is forced back to untrusted", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ dir, engine, store }) => {
        await initProject(engine);
        await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
        const receipt = await engine.ingest(["notes.md"], { noCommit: true, distill: true });
        assert.equal(receipt.distillSkipped, undefined);
        assert.equal(receipt.distillRan, true);
        const pagePath = receipt.pagesCreated[0];
        assert.equal(pagePath, ".legion-cli/wiki/ingested/notes.md");
        const page = await store.readWikiPage(pagePath);
        assert.equal(page.data.trust, "untrusted");
        assert.match(page.body, /DISTILLED_TOKEN/);
      },
      {
        skillsDir,
        fakeArtifacts: [
          {
            path: ".legion-cli/wiki/ingested/notes.md",
            content: wikiPageMarkdown({
              title: "Notes",
              trust: "reviewed",
              source: "notes.md",
              body: "DISTILLED_TOKEN compiled notes.\n",
            }),
          },
        ],
      },
    );
  });
});

test("index.md after distill is engine-authored", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ dir, engine, store }) => {
        await initProject(engine);
        await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
        const receipt = await engine.ingest(["notes.md"], { noCommit: true, distill: true });
        assert.equal(receipt.distillSkipped, undefined);
        assert.equal(receipt.distillRan, true);
        assert.ok((await ingestRunNames(dir)).length >= 1);
        const index = await store.readWikiPage(WIKI_INDEX_STORE_PATH);
        assert.equal(index.data.title, "Wiki index");
        assert.equal(index.data.trust, "reviewed");
        assert.match(index.body, /Catalog of compiled pages/);
        assert.doesNotMatch(index.body, /Spawned catalog/);
      },
      {
        skillsDir,
        fakeArtifacts: [
          {
            path: ".legion-cli/wiki/index.md",
            content: wikiPageMarkdown({
              title: "Spawned catalog",
              trust: "reviewed",
              body: "# Spawned catalog\n",
            }),
          },
        ],
      },
    );
  });
});

test("ingest --distill skips spawn when source is over 64 KiB", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ dir, engine }) => {
        await initProject(engine);
        await writeFile(
          join(dir, "huge.md"),
          `# Huge\n\n${"a".repeat(DISTILL_SOURCE_MAX_CHARS)}\n`,
          "utf8",
        );
        const receipt = await engine.ingest(["huge.md"], { noCommit: true, distill: true });
        assert.equal(receipt.distillSkipped, "source too large");
        assert.equal(receipt.distillRan, undefined);
        assert.ok(receipt.pagesCreated.length >= 1);
        assert.deepEqual(await ingestRunNames(dir), []);
      },
      { skillsDir },
    );
  });
});

test("ingest --distill skips spawn when adapter is not spawnable", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeUnspawnableGrok(store, { default: "grok" });
    await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
    const receipt = await engine.ingest(["notes.md"], { noCommit: true, distill: true });
    assert.equal(receipt.distillSkipped, "no spawnable adapter");
    assert.equal(receipt.distillRan, undefined);
    assert.ok(receipt.pagesCreated.length >= 1);
    assert.deepEqual(await ingestRunNames(dir), []);
  }, { skillsDir });
});

test("ingest --distill skips when ingest skill is unavailable", async () => {
  const emptySkills = await mkdtemp(join(tmpdir(), "legion-skills-"));
  try {
    await withFakeAdapter(async () => {
      await withEngine(
        async ({ dir, engine }) => {
          await initProject(engine);
          await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
          const receipt = await engine.ingest(["notes.md"], { noCommit: true, distill: true });
          assert.equal(receipt.distillSkipped, "skill unavailable");
          assert.equal(receipt.distillRan, undefined);
          assert.ok(receipt.pagesCreated.length >= 1);
          assert.deepEqual(await ingestRunNames(dir), []);
        },
        { skillsDir: emptySkills },
      );
    });
  } finally {
    await rm(emptySkills, { recursive: true, force: true });
  }
});

test("ingest --distill skips when there is no source text", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ dir, engine }) => {
        await initProject(engine);
        await writeFile(join(dir, "empty.md"), "", "utf8");
        const receipt = await engine.ingest(["empty.md"], { noCommit: true, distill: true });
        assert.equal(receipt.distillSkipped, "no source");
        assert.equal(receipt.distillRan, undefined);
        assert.deepEqual(await ingestRunNames(dir), []);
      },
      { skillsDir },
    );
  });
});

test("ingest --distill does not report ran on spawn timeout", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ dir, engine }) => {
        await initProject(engine);
        await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
        const receipt = await engine.ingest(["notes.md"], { noCommit: true, distill: true });
        assert.equal(receipt.distillSkipped, "timed out");
        assert.equal(receipt.distillRan, undefined);
        assert.ok((await ingestRunNames(dir)).length >= 1);
      },
      { skillsDir, fakeTimedOut: true },
    );
  });
});

test("wiki trust page A stays reviewed when distill ingests B", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ dir, engine, store }) => {
        await initProject(engine);
        initGitRepo(dir);
        await writeFile(join(dir, "a.md"), "# A\n\nTrusted fact.\n", "utf8");
        const first = await engine.ingest(["a.md"]);
        const pageA = first.pagesCreated[0];
        await engine.wikiTrust(pageA);
        assert.equal((await store.readWikiPage(pageA)).data.trust, "reviewed");

        await writeFile(join(dir, "b.md"), "# B\n\nNew fact.\n", "utf8");
        const second = await engine.ingest(["b.md"], { distill: true });
        assert.equal(second.distillRan, true);
        assert.equal((await store.readWikiPage(pageA)).data.trust, "reviewed");

        const names = git(dir, ["show", "--name-only", "--pretty=format:", "HEAD"]);
        assert.doesNotMatch(names, /\.legion-cli\/wiki\/ingested\/a\.md/);
        assert.match(names, /\.legion-cli\/wiki\/ingested\/b\.md/);
      },
      { skillsDir },
    );
  });
});

test("default ingest does not spawn distill", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ dir, engine }) => {
        await initProject(engine);
        await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
        await engine.ingest(["notes.md"], { noCommit: true });
        assert.deepEqual(await ingestRunNames(dir), []);
        assert.equal(existsSync(join(dir, "src", "main.ts")), false);
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: "src/main.ts", content: "export const leaked = true;\n" }],
      },
    );
  });
});

test("distill prompt wraps untrusted source", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ dir, engine }) => {
        await initProject(engine);
        await writeFile(join(dir, "notes.md"), "# Notes\n\nDurable fact.\n", "utf8");
        const receipt = await engine.ingest(["notes.md"], { noCommit: true, distill: true });
        assert.equal(receipt.distillRan, true);
        const prompt = await readLatestRunPrompt(dir, "ingest");
        assert.match(prompt, /BEGIN LEGION CLI UNTRUSTED CONTENT/);
        assert.match(prompt, /Durable fact/);
        assert.match(prompt, /## SessionBrief/);
        assert.match(prompt, /skillId: ingest/);
      },
      { skillsDir },
    );
  });
});
