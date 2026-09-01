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
  assert.ok(deps["@9thlevelsoftware/legion-cli-persist"]);
  assert.ok(deps["@9thlevelsoftware/legion-cli-schema"]);
  assert.ok(deps["@9thlevelsoftware/legion-cli-wiki"]);
  assert.ok(deps["@9thlevelsoftware/legion-cli-graph"]);
});

test("source must not import core/execute", async () => {
  const files = await listTs(join(pkgRoot, "src"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*import\b/.test(line)) continue;
      assert.doesNotMatch(line, /legion-cli-core/, file);
      assert.doesNotMatch(line, /\bexecute\b/, file);
    }
  }
});
