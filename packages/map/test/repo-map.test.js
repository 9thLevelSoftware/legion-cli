import assert from "node:assert/strict";
import test from "node:test";
import { computeRepoPageRank, formatRepoMap, repoMapWork, resetRepoMapWork } from "../dist/index.js";

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

function denseModules(n, importsPer = 3) {
  const dummyHash = "0".repeat(64);
  return Array.from({ length: n }, (_, i) => ({
    path: `src/m${i}.ts`,
    language: "ts",
    exports: [`e${i}`],
    imports: Array.from({ length: importsPer }, (_, k) => `m${(i + k + 1) % n}`),
    hash: dummyHash,
  }));
}

test("A-007 50k computeRepoPageRank", { skip: process.env.LEGION_A007_GATE !== "1" }, () => {
  const n = 50_000;
  resetRepoMapWork();
  const t0 = Date.now();
  const ranked = computeRepoPageRank(denseModules(n, 2));
  const ms = Date.now() - t0;
  assert.equal(ranked.length, n);
  assert.ok(ms <= 10_000 * 2, `computeRepoPageRank ${ms}ms exceeds A-007 budget`);
  process.stdout.write(`A007_MEASUREMENTS ${JSON.stringify([{ step: "computeRepoPageRank", ms, files: n }])}\n`);
});

test("F-024 suffix-scan iterations stay O(n) not O(n^2*k)", () => {
  const n = 40;
  const importsPer = 3;
  resetRepoMapWork();
  const ranked = computeRepoPageRank(denseModules(n, importsPer));
  assert.equal(ranked.length, n);
  // Memoized import index: no pairwise suffix scan. Bound is n.
  // Fail-first: inner j-loop is n*k*n = 4800.
  assert.ok(
    repoMapWork.suffixScanIterations <= n,
    `suffix-scan iterations ${repoMapWork.suffixScanIterations} exceed O(n) bound ${n}`,
  );
});

test("computeRepoPageRank resolves ESM ./foo.js -> foo.ts, ../, and /index barrels", () => {
  const dummyHash = "0".repeat(64);
  const modules = [
    {
      path: "src/index.ts",
      language: "ts",
      exports: ["main"],
      imports: ["./service.js", "./shared"],
      hash: dummyHash,
    },
    {
      path: "src/routes/api.ts",
      language: "ts",
      exports: ["route"],
      imports: ["../service.js", "../shared/index.js", "../utils/foo.js"],
      hash: dummyHash,
    },
    {
      path: "src/service.ts",
      language: "ts",
      exports: ["run"],
      imports: ["./utils/foo.js"],
      hash: dummyHash,
    },
    {
      path: "src/shared/index.ts",
      language: "ts",
      exports: ["Shared"],
      imports: ["./types.mjs", "../utils/foo.js"],
      hash: dummyHash,
    },
    {
      path: "src/shared/types.mts",
      language: "ts",
      exports: ["SharedType"],
      imports: [],
      hash: dummyHash,
    },
    {
      path: "src/utils/foo.ts",
      language: "ts",
      exports: ["fooHelper"],
      imports: [],
      hash: dummyHash,
    },
  ];

  const ranked = computeRepoPageRank(modules);
  // src/utils/foo.ts is imported by routes/api.ts, service.ts, and shared/index.ts via ./foo.js / ../utils/foo.js
  assert.equal(ranked[0].path, "src/utils/foo.ts");
  assert.equal(ranked[0].rank, 1);

  const byPath = new Map(ranked.map((m) => [m.path, m.rank]));
  assert.ok(byPath.get("src/utils/foo.ts") > byPath.get("src/index.ts"));
  assert.ok(byPath.get("src/shared/index.ts") > byPath.get("src/index.ts"));
  assert.ok(byPath.get("src/shared/types.mts") > byPath.get("src/index.ts"));
});

test("computeRepoPageRank disambiguates relative imports across monorepo sibling packages", () => {
  const dummyHash = "0".repeat(64);
  const modules = [
    {
      path: "packages/a/src/helper.ts",
      language: "ts",
      exports: ["aHelper"],
      imports: [],
      hash: dummyHash,
    },
    {
      path: "packages/b/src/index.ts",
      language: "ts",
      exports: ["bMain"],
      imports: ["./helper.js"],
      hash: dummyHash,
    },
    {
      path: "packages/b/src/caller.ts",
      language: "ts",
      exports: ["bCall"],
      imports: ["./helper.js"],
      hash: dummyHash,
    },
    {
      path: "packages/b/src/helper.ts",
      language: "ts",
      exports: ["bHelper"],
      imports: [],
      hash: dummyHash,
    },
  ];

  const ranked = computeRepoPageRank(modules);
  const byPath = new Map(ranked.map((m) => [m.path, m.rank]));
  assert.equal(ranked[0].path, "packages/b/src/helper.ts");
  assert.ok(byPath.get("packages/b/src/helper.ts") > byPath.get("packages/a/src/helper.ts"));
});

test("computeRepoPageRank resolves Python dotted/relative, Rust crate/super, and Go package suffix imports", () => {
  const dummyHash = "0".repeat(64);
  const pyModules = [
    { path: "pkg/app.py", language: "py", exports: ["main"], imports: ["pkg.core.db", "pkg.utils"], hash: dummyHash },
    { path: "pkg/sub/worker.py", language: "py", exports: ["work"], imports: ["..core.db", ".local"], hash: dummyHash },
    { path: "pkg/sub/local.py", language: "py", exports: ["loc"], imports: ["..utils"], hash: dummyHash },
    { path: "pkg/utils/__init__.py", language: "py", exports: ["util"], imports: ["pkg.core.db"], hash: dummyHash },
    { path: "pkg/core/db.py", language: "py", exports: ["connect"], imports: [], hash: dummyHash },
  ];
  const pyRanked = computeRepoPageRank(pyModules);
  assert.equal(pyRanked[0].path, "pkg/core/db.py");

  const rsModules = [
    { path: "crates/app/src/main.rs", language: "rs", exports: ["main"], imports: ["crate::core::db::Pool", "crate::api"], hash: dummyHash },
    { path: "crates/app/src/api/mod.rs", language: "rs", exports: ["serve"], imports: ["crate::core::db", "self::routes"], hash: dummyHash },
    { path: "crates/app/src/api/routes.rs", language: "rs", exports: ["route"], imports: ["super::super::core::db"], hash: dummyHash },
    { path: "crates/app/src/core/db.rs", language: "rs", exports: ["Pool"], imports: [], hash: dummyHash },
  ];
  const rsRanked = computeRepoPageRank(rsModules);
  assert.equal(rsRanked[0].path, "crates/app/src/core/db.rs");

  const goModules = [
    { path: "cmd/api/main.go", language: "go", exports: ["Main"], imports: ["fmt", "net/http", "github.com/acme/svc/internal/store"], hash: dummyHash },
    { path: "pkg/worker/run.go", language: "go", exports: ["Run"], imports: ["github.com/acme/svc/internal/store"], hash: dummyHash },
    { path: "internal/store/store.go", language: "go", exports: ["Store"], imports: [], hash: dummyHash },
    { path: "internal/http/client.go", language: "go", exports: ["Client"], imports: [], hash: dummyHash },
  ];
  const goRanked = computeRepoPageRank(goModules);
  const goByPath = new Map(goRanked.map((m) => [m.path, m.rank]));
  assert.equal(goRanked[0].path, "internal/store/store.go");
  // stdlib "net/http" must not falsely match internal/http/client.go
  assert.ok(goByPath.get("internal/store/store.go") > goByPath.get("internal/http/client.go"));
});

