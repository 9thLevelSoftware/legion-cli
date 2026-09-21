import assert from "node:assert/strict";
import test from "node:test";
import { computeRepoPageRank, formatRepoMap } from "../dist/index.js";

test("computeRepoPageRank ranks hub modules higher than leaf modules", () => {
  const dummyHash = "0".repeat(64);
  const modules = [
    {
      path: "src/index.ts",
      language: "ts",
      exports: ["runApp"],
      imports: ["core", "utils"],
      hash: dummyHash,
    },
    {
      path: "src/core.ts",
      language: "ts",
      exports: ["Engine", "State"],
      imports: ["utils"],
      hash: dummyHash,
    },
    {
      path: "src/utils.ts",
      language: "ts",
      exports: ["formatString", "clamp"],
      imports: [],
      hash: dummyHash,
    },
  ];

  const ranked = computeRepoPageRank(modules);
  assert.equal(ranked.length, 3);
  // utils is imported by both index.ts and core.ts, so it should have the highest centrality
  assert.equal(ranked[0].path, "src/utils.ts");
  assert.equal(ranked[0].rank, 1);
});

test("formatRepoMap respects character budget and renders ranked list", () => {
  const ranked = [
    {
      path: "src/utils.ts",
      rank: 1.0,
      exports: ["formatString", "clamp"],
      imports: [],
      language: "ts",
    },
    {
      path: "src/core.ts",
      rank: 0.6,
      exports: ["Engine"],
      imports: ["utils"],
      language: "ts",
    },
  ];

  const formatted = formatRepoMap(ranked, 500);
  assert.match(formatted, /# Repository Architecture Map/);
  assert.match(formatted, /src\/utils\.ts \(rank: 1\.00\)/);
  assert.match(formatted, /src\/core\.ts \(rank: 0\.60\)/);
});
