import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function mappingBlock(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*$`, "m"));
  assert.ok(match, `missing top-level ${key}:`);
  const from = match.index + match[0].length;
  const rest = text.slice(from);
  const next = rest.search(/\n[A-Za-z]/);
  return (next === -1 ? rest : rest.slice(0, next)).replace(/^\r?\n/, "");
}

test("publish.yml is v* trusted publisher with provenance and no long-lived token", async () => {
  const publish = await readFile(join(repoRoot, ".github", "workflows", "publish.yml"), "utf8");
  const ci = await readFile(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const rootPkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));

  const onBlock = mappingBlock(publish, "on");
  assert.match(onBlock, /^\s*push:\s*$/m);
  assert.match(onBlock, /^\s*tags:\s*$/m);
  const tags = [...onBlock.matchAll(/^\s*-\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(tags, ["v*"]);
  assert.doesNotMatch(onBlock, /branches:/);
  assert.doesNotMatch(onBlock, /pull_request/);

  const permissions = mappingBlock(publish, "permissions");
  assert.match(permissions, /^\s*id-token:\s*write\s*$/m);

  assert.match(publish, /pnpm publish -r --access public --provenance/);
  assert.doesNotMatch(publish, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(publish, /NPM_TOKEN/);

  assert.doesNotMatch(ci, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(ci, /NPM_TOKEN/);
  assert.doesNotMatch(ci, /pnpm publish/);
  assert.match(ci, /pnpm typecheck/);
  assert.match(ci, /pnpm test/);

  assert.equal(rootPkg.private, true);
  assert.equal(rootPkg.bin, undefined);
});
