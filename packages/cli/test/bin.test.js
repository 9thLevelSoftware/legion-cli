import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(pkgRoot, "dist", "bin.js");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

test("registers bin legion-cli only", () => {
  assert.deepEqual(Object.keys(pkg.bin), ["legion-cli"]);
});

test("prints uninitialized and exits 0", () => {
  const result = spawnSync(process.execPath, [bin], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "uninitialized\n");
  assert.equal(result.stderr, "");
});
