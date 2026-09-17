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
  assert.match(out, /Does not register bin legion/);
  assert.match(out, /^status \(default\) {2}/m);
  assert.match(out, /^doctor {2}/m);
  assert.match(out, /^help --all {2}/m);
  for (const verb of ["init", "intent", "discuss", "spec", "plan", "execute", "verify", "review", "qa", "ship"]) {
    assert.match(out, new RegExp(`^${verb} {2}`, "m"), `Layer-1 missing command ${verb}`);
  }
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
  assert.match(out, /--yes \(ignored by intent confirm, ship, and discuss\)/);
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

test("unknown command still hints help --all", () => {
  const result = runCli(["xyzzy"]);
  assert.equal(result.status, 1);
  const err = normalize(result.stderr);
  assert.match(err, /unknown command 'xyzzy'/);
  assert.match(err, /help --all/);
});

test("help --all does not call control-mode later", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  const later = helpSection(out, "Later, not this series:", "v0 gap");
  assert.doesNotMatch(later, /control-mode/);
  assert.doesNotMatch(later, /vendor extra-adapter argv/);
  assert.match(out, /v0 gap; follow-up PRs in this series/);
  const gap = helpSection(out, "v0 gap; follow-up PRs in this series:", "Not in this product:");
  assert.match(gap, /control-mode/);
  assert.match(gap, /verified vendor extra-adapter argv/);
});

test("help --all init lists --mode; intent drops --resume; dashboard is view-only", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  const lifecycle = helpSection(out, "Lifecycle core:", "Always-on operations:");
  assert.match(lifecycle, /--mode greenfield\|brownfield/);
  assert.doesNotMatch(lifecycle, /--resume/);
  assert.match(lifecycle, /--done/);
  assert.doesNotMatch(out, /optional writes/);
  assert.match(out, /view-only/);
  assert.match(out, /untrusted until wiki trust/);
});

test("init --mode help does not call brownfield v1", () => {
  const result = runCli(["init", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /--mode/);
  assert.doesNotMatch(out, /greenfield \(v0\)/);
  assert.doesNotMatch(out, /brownfield \(v1\)/);
});

test("--yes help is ignored by intent confirm, ship, and discuss", () => {
  const result = runCli(["discuss", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(normalize(result.stdout), /ignored by intent confirm, ship, and discuss/);
});

test("intent --help does not list --resume", () => {
  const result = runCli(["intent", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.doesNotMatch(out, /--resume/);
  assert.match(out, /--done/);
});

test("intent --resume is an unknown option", () => {
  const result = runCli(["intent", "--resume"]);
  assert.equal(result.status, 1);
  const err = normalize(result.stderr);
  assert.match(err, /unknown option '--resume'/i);
});

test("control-mode is an unknown command (verb lands in a follow-up PR)", () => {
  const result = runCli(["control-mode"]);
  assert.equal(result.status, 1);
  const err = normalize(result.stderr);
  assert.match(err, /unknown command 'control-mode'/);
  assert.match(err, /help --all/);
});

test("parent verbs require a subcommand and print Next", () => {
  const cases = [
    ["wiki", /wiki requires trust/, /Next: legion-cli wiki trust <page>/],
    ["ticket", /ticket requires create/, /Next: legion-cli ticket create --title <title>/],
    ["task", /task requires amend/, /Next: legion-cli task amend <id>/],
    ["context", /context requires compact/, /Next: legion-cli context compact/],
    ["run", /run requires promote/, /Next: legion-cli run promote <id>/],
  ];
  for (const [verb, requires, next] of cases) {
    const result = runCli([verb]);
    assert.equal(result.status, 1, verb);
    const err = normalize(result.stderr);
    assert.match(err, requires, verb);
    assert.match(err, next, verb);
    assert.doesNotMatch(err, /too many arguments/, verb);
  }
});

test("run promote --help says untrusted until wiki trust", () => {
  const result = runCli(["run", "promote", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(normalize(result.stdout), /untrusted until wiki trust/);
});
