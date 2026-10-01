import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  benchmarkHybridRetrieval,
  rankHybridRetrieval,
  rankHybridRetrievalFromVectorResults,
  rankHybridRetrievalWithLocalEmbeddings,
  searchWiki,
} from "../dist/index.js";
import { withStore } from "./helpers.js";

const candidates = [
  { id: "lexical", path: "docs/lexical.md", title: "Lexical match", trust: "reviewed", lexicalScore: 10, vector: [0, 1] },
  { id: "semantic", path: "docs/semantic.md", title: "Semantic match", trust: "reviewed", lexicalScore: 2, vector: [1, 0] },
  { id: "untrusted", path: "docs/untrusted.md", title: "Untrusted", trust: "untrusted", lexicalScore: 100, vector: [1, 0] },
  { id: "no-vector", path: "docs/no-vector.md", title: "No vector", trust: "reviewed", lexicalScore: 1 },
];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const repositoryQuestionCorpus = [
  { question: "What is the local-first CLI called?", query: "Legion CLI", source: "README.md", path: ".legion-cli/wiki/benchmark/readme.md", title: "Legion CLI", queryVector: [1, 0, 0, 0, 0] },
  { question: "Which document defines the product lifecycle engine?", query: "Product Engineering lifecycle engine", source: "docs/design/product-engineering-cli.md", path: ".legion-cli/wiki/benchmark/product-design.md", title: "Product Engineering lifecycle engine", queryVector: [0, 1, 0, 0, 0] },
  { question: "Where are adapter routes described?", query: "Adapter routing", source: "docs/design/adapter-routing.md", path: ".legion-cli/wiki/benchmark/adapter-routing.md", title: "Adapter routing", queryVector: [0, 0, 1, 0, 0] },
  { question: "What product does the fixture project describe?", query: "office check-in", source: "packages/persist/test/fixtures/project/legion-cli/PROJECT.md", path: ".legion-cli/wiki/benchmark/fixture-project.md", title: "Fixture project", queryVector: [0, 0, 0, 1, 0] },
  { question: "Which interface comes first for the fixture product?", query: "Phone first", source: "packages/persist/test/fixtures/project/legion-cli/CONTEXT.md", path: ".legion-cli/wiki/benchmark/fixture-context.md", title: "Fixture context", queryVector: [0, 0, 0, 0, 1] },
];

test("experimental hybrid retrieval fuses supplied vectors deterministically and keeps untrusted candidates out", () => {
  const ranked = rankHybridRetrieval(candidates, { queryVector: [1, 0] });

  assert.deepEqual(ranked.map((hit) => hit.id), ["semantic", "lexical", "no-vector"]);
  assert.equal(ranked.some((hit) => hit.id === "untrusted"), false);
  assert.equal(ranked[0].vectorRank, 1);
  assert.equal(ranked[2].vectorRank, null);

  const tied = rankHybridRetrieval([
    { id: "z", path: "z", title: "z", trust: "reviewed", lexicalScore: 1, vector: [1, 0] },
    { id: "a", path: "a", title: "a", trust: "reviewed", lexicalScore: 1, vector: [1, 0] },
  ], { queryVector: [1, 0] });
  assert.deepEqual(tied.map((hit) => hit.id), ["a", "z"]);
});

test("fixed tracked repository-question corpus measures existing BM25 rankings before hybrid fusion", async () => {
  await withStore(async ({ dir, store }) => {
    for (const page of repositoryQuestionCorpus) {
      await store.writeWikiPage(
        page.path,
        {
          schemaVersion: "legion-cli-wiki-page/v1",
          title: page.title,
          aliases: [],
          tags: ["benchmark"],
          trust: "reviewed",
          updated: "2026-09-30T00:00:00.000Z",
        },
        await readFile(join(repoRoot, page.source), "utf8"),
      );
    }
    await store.rebuild();
    const vectors = new Map(repositoryQuestionCorpus.map((page) => [page.path.slice(".legion-cli/wiki/".length).replace(/\.md$/, ""), page.queryVector]));
    const searchStartedAt = performance.now();
    const cases = repositoryQuestionCorpus.map((page) => {
      const hits = searchWiki(dir, page.query);
      const expectedId = page.path.slice(".legion-cli/wiki/".length).replace(/\.md$/, "");
      assert.ok(hits.some((hit) => hit.id === expectedId), `BM25 must return ${expectedId}`);
      return {
        question: page.question,
        expectedId,
        queryVector: page.queryVector,
        candidates: hits.map((hit, index) => ({
          ...hit,
          lexicalScore: hits.length - index,
          vector: vectors.get(hit.id),
        })),
      };
    });
    const lexicalSearchLatencyMs = performance.now() - searchStartedAt;
    const report = benchmarkHybridRetrieval({ cases });

    assert.equal(report.cases, 5);
    assert.ok(report.lexical.reciprocalRank > 0);
    assert.ok(report.hybrid.reciprocalRank > 0);
    assert.ok(report.lexicalLatencyMs >= 0);
    assert.ok(report.hybridLatencyMs >= 0);
    assert.ok(report.latencyMs >= 0);
    assert.deepEqual(report.install, {
      mode: "precomputed-vectors",
      dependency: "none",
      sqliteVec: "not-required",
      localEmbeddings: "operator-supplied",
    });
    if (process.env.LEGION_CAPTURE_BENCHMARK === "1") {
      console.log(JSON.stringify({ lexicalSearchLatencyMs, cases: cases.map(({ question, expectedId, candidates }) => ({ question, expectedId, lexical: candidates.map((candidate) => candidate.id) })), report }));
    }
  });
});

test("hybrid experiment accepts sqlite-vec-style results or an explicit local embedding callback", () => {
  const fromIndex = rankHybridRetrievalFromVectorResults(candidates, {
    vectorResults: [
      { id: "untrusted", distance: 0 },
      { id: "semantic", distance: 0 },
      { id: "lexical", distance: 1 },
    ],
  });
  assert.deepEqual(fromIndex.map((hit) => hit.id), ["semantic", "lexical", "no-vector"]);

  const embedded = rankHybridRetrievalWithLocalEmbeddings(candidates, {
    queryText: "semantic intent",
    embed: ({ kind, id }) => kind === "query" || id === "semantic" ? [1, 0] : [0, 1],
  });
  assert.equal(embedded[0].id, "semantic");
});
