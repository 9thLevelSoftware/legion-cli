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

test("sandbox does not depend on http, core, wiki, or agents", async () => {
  const pkg = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "@9thlevelsoftware/legion-cli-sandbox");
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  };
  assert.ok(deps["@9thlevelsoftware/legion-cli-persist"]);
  assert.ok(deps["@9thlevelsoftware/legion-cli-schema"]);
  assert.equal(deps["@9thlevelsoftware/legion-cli-core"], undefined);
  assert.equal(deps["@9thlevelsoftware/legion-cli-wiki"], undefined);
  assert.equal(deps["@9thlevelsoftware/legion-cli-agents"], undefined);
  assert.equal(deps["@9thlevelsoftware/legion-cli-http"], undefined);
});

test("source uses persist path guards and does not import http or winjob", async () => {
  const files = await listTs(join(pkgRoot, "src"));
  assert.ok(files.length > 0);
  const joined = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    joined.push(text);
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*import\b/.test(line)) continue;
      assert.doesNotMatch(line, /legion-cli-http/, file);
      assert.doesNotMatch(line, /legion-cli-core/, file);
      assert.doesNotMatch(line, /legion-cli-wiki/, file);
      assert.doesNotMatch(line, /filterSpawnEnv/, file);
    }
    assert.doesNotMatch(text, /winjob/i, file);
  }
  const src = joined.join("\n");
  assert.match(src, /toFsPath/);
  assert.match(src, /PathEscapeError/);
  assert.doesNotMatch(src, /filterSpawnEnv/);
});
