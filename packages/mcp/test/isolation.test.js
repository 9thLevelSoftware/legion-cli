import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function listTs(dir) {
  const names = await readdir(dir, { recursive: true });
  return names.filter((name) => name.endsWith(".ts")).map((name) => join(dir, name));
}

test("package does not depend on core or execute", async () => {
  const pkg = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "@9thlevelsoftware/legion-cli-mcp");
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  };
  assert.equal(deps["@9thlevelsoftware/legion-cli-core"], undefined);
  // Documented layering leak (parked): MCP → dashboard → core. Isolation is the
  // read-only tool surface, not the dependency cone. Do not fail CI on dashboard.
  assert.ok(deps["@9thlevelsoftware/legion-cli-agents"]);
  assert.ok(deps["@9thlevelsoftware/legion-cli-persist"]);
  assert.ok(deps["@9thlevelsoftware/legion-cli-schema"]);
  assert.ok(deps["@9thlevelsoftware/legion-cli-wiki"]);
  assert.ok(deps["@9thlevelsoftware/legion-cli-graph"]);
});

test("reader sliceTasks matches core: missing activeSpecId is empty, not all tasks", async () => {
  const src = await readFile(join(pkgRoot, "src", "reader.ts"), "utf8");
  assert.match(src, /if \(!activeSpecId\) return \[\]/);
  assert.doesNotMatch(src, /if \(!activeSpecId\) return \[\.\.\.tasks\]/);
  assert.doesNotMatch(src, /slice\.length > 0 \? slice : \[\.\.\.tasks\]/);
});

test("reader nextCommand shares CLI brownfield and wouldExecute branch literals", async () => {
  const cli = await readFile(join(pkgRoot, "..", "cli", "src", "next.ts"), "utf8");
  const mcp = await readFile(join(pkgRoot, "src", "reader.ts"), "utf8");
  const shared = [
    'state.phase === "initialized" && mode === "brownfield"',
    "state.phase === \"plan_ready\" || (state.phase === \"executing\" && !isSliceTerminal(slice))",
    "controlMode === \"advisory\" && wouldExecute",
  ];
  for (const snippet of shared) {
    assert.ok(cli.includes(snippet), `cli next.ts missing ${snippet}`);
    assert.ok(mcp.includes(snippet), `mcp reader.ts missing ${snippet}`);
  }
});

test("task graph ready context loads assumptions from the store", async () => {
  const src = await readFile(join(pkgRoot, "src", "reader.ts"), "utf8");
  assert.match(src, /assumptions: await listAssumptions\(store\)/);
});

test("source must not import core/execute or take the engine lock", async () => {
  const files = await listTs(join(pkgRoot, "src"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /\.rebuild\s*\(/, file);
    assert.doesNotMatch(text, /ensureWikiIndex/, file);
    assert.doesNotMatch(text, /acquireLock|acquireEngineLock|withLock/, file);
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*import\b/.test(line)) continue;
      assert.doesNotMatch(line, /legion-cli-core/, file);
      assert.doesNotMatch(line, /\bexecute\b/, file);
      assert.doesNotMatch(line, /optionalSkillSpawn/, file);
    }
  }
});

test("http.ts does not import core and uses the reader store", async () => {
  const src = await readFile(join(pkgRoot, "src", "http.ts"), "utf8");
  assert.doesNotMatch(src, /legion-cli-core/);
  assert.doesNotMatch(src, /createReaderStore/);
  assert.match(src, /createLegionMcpServer/);
  assert.match(src, /handleRequest/);
  assert.match(src, /StreamableHTTPServerTransport/);
});
