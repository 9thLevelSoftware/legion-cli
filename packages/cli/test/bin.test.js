import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { normalize, runCli } from "./helpers.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

test("registers bin legion-cli only", () => {
  assert.deepEqual(Object.keys(pkg.bin), ["legion-cli"]);
});

test("help mentions pnpm exec legion-cli and does not take bin legion", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /pnpm exec legion-cli/);
  assert.match(out, /status/);
  assert.match(out, /init/);
  assert.match(out, /doctor/);
  assert.match(out, /Does not register bin legion/);
});

test("help --all lists the v0 command surface", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /Available now:/);
  assert.match(out, /Full v0 command surface:/);
  assert.match(out, /legion-cli intent/);
  assert.match(out, /legion-cli plan/);
  assert.match(out, /legion-cli next/);
  assert.match(out, /legion-cli ticket create/);
  assert.match(out, /legion-cli task amend/);
  assert.match(out, /legion-cli dashboard/);
  assert.match(out, /packet new/);
  assert.match(out, /packet respond/);
  assert.match(out, /legion-cli verify/);
  assert.match(out, /legion-cli review/);
  assert.match(out, /legion-cli qa/);
  assert.match(out, /legion-cli fix/);
  assert.match(out, /legion-cli ship/);
  assert.match(out, /legion-cli abandon/);
  assert.match(out, /pnpm exec legion-cli/);
  assert.match(out, /--metrics/);
});

test("help --all lists dashboard as available now", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /Available now:/);
  assert.match(out, /dashboard/);
  assert.match(out, /--no-open, --port, --expose/);
});

test("mcp is a read-only stdio command", () => {
  const help = runCli(["mcp", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  const out = normalize(help.stdout);
  assert.match(out, /read-only/i);
  assert.match(out, /stdio/i);
  const all = runCli(["help", "--all"]);
  assert.match(normalize(all.stdout), /Available now:[\s\S]*\bmcp\b/);
});
