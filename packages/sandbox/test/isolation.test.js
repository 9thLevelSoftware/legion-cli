import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

