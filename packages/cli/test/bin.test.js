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

function helpSection(out, header, nextHeader) {
  const start = out.indexOf(header);
  assert.notEqual(start, -1, `missing ${header}`);
  const from = out.slice(start);
  const end = nextHeader ? from.indexOf(`\n${nextHeader}`, header.length) : -1;
  return end === -1 ? from : from.slice(0, end);
}

function assertLayer1(out) {
  assert.match(out, /pnpm exec legion-cli/);
  assert.match(out, /status/);
  assert.match(out, /init/);
  assert.match(out, /doctor/);
  assert.match(out, /Does not register bin legion/);
  assert.match(out, /intent/);
  assert.match(out, /help --all/);
  assert.doesNotMatch(out, /\bsearch\b/);
  assert.doesNotMatch(out, /\bbrief\b/);
  assert.doesNotMatch(out, /wiki trust/);
  assert.doesNotMatch(out, /\bshow\b/);
  assert.doesNotMatch(out, /assume list/);
  assert.doesNotMatch(out, /assume answer/);
  assert.doesNotMatch(out, /index rebuild/);
}

test("help mentions pnpm exec legion-cli and does not take bin legion", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assertLayer1(normalize(result.stdout));
});

test("--help prints Layer 1 and omits search/brief/wiki trust/show", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assertLayer1(normalize(result.stdout));
});

test("help --all lists the grouped command surface", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /Lifecycle core:/);
  assert.match(out, /Always-on operations:/);
  assert.match(out, /Board extras:/);
  assert.match(out, /Shipped adjacent/);
  assert.doesNotMatch(out, /Available now:/);
  assert.doesNotMatch(out, /Full v0 command surface:/);
  assert.match(out, /^ {2}intent$/m);
  assert.match(out, /^ {2}plan$/m);
  assert.match(out, /^ {2}next$/m);
  assert.match(out, /ticket create/);
  assert.match(out, /task amend/);
  assert.match(out, /^ {2}dashboard$/m);
  assert.match(out, /packet new/);
  assert.match(out, /packet respond/);
  assert.match(out, /verify/);
  assert.match(out, /^ {2}review$/m);
  assert.match(out, /^ {2}qa$/m);
  assert.match(out, /fix/);
  assert.match(out, /^ {2}ship$/m);
  assert.match(out, /abandon/);
  assert.match(out, /pnpm exec legion-cli/);
  assert.match(out, /--metrics/);
  assert.match(out, /spec show/);
  assert.match(out, /spec approve/);
  assert.match(out, /spec new/);
  assert.match(out, /qa checklist/);
  const alwaysOn = helpSection(out, "Always-on operations:", "Board extras:");
  assert.match(alwaysOn, /index rebuild/);
  assert.doesNotMatch(alwaysOn, /assume list/);
  assert.doesNotMatch(alwaysOn, /assume answer/);
  const board = helpSection(out, "Board extras:", "Shipped adjacent");
  assert.match(board, /assume list/);
  assert.match(board, /assume answer/);
  assert.doesNotMatch(board, /index rebuild/);
});

test("help --all lists dashboard as shipped adjacent", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /Shipped adjacent/);
  assert.match(out, /dashboard/);
  assert.match(out, /--no-open, --port, --expose/);
  assert.equal([...out.matchAll(/^ {2}dashboard$/gm)].length, 1);
});

test("mcp is a read-only stdio command", () => {
  const help = runCli(["mcp", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  const out = normalize(help.stdout);
  assert.match(out, /read-only/i);
  assert.match(out, /stdio/i);
  const all = runCli(["help", "--all"]);
  assert.match(normalize(all.stdout), /Shipped adjacent[\s\S]*\bmcp\b/);
});
