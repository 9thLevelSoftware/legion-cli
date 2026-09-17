import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { bin, normalize, runCli, withTempDir } from "./helpers.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

const INSTALLER_FLAGS = [
  "--claude",
  "--cursor",
  "--windsurf",
  "--codex",
  "--gemini",
  "--antigravity",
  "install",
  "plugin",
];

test("registers bin legion-cli and legion to the same script", () => {
  assert.deepEqual(pkg.bin, {
    "legion-cli": "./dist/bin.js",
    legion: "./dist/bin.js",
  });
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
  assert.match(out, /legion \(alias\)/);
  assert.match(out, /npx @9thlevelsoftware\/legion --claude/);
  assert.match(out, /bin legion-plugins/);
  assert.doesNotMatch(out, /Does not register bin legion/);
  assert.match(out, /^status \(default\) {2}/m);
  assert.match(out, /^doctor {2}/m);
  assert.match(out, /^help --all {2}/m);
  for (const verb of ["init", "intent", "discuss", "spec", "plan", "execute", "verify", "review", "qa", "ship"]) {
    assert.match(out, new RegExp(`^${verb} {2}`, "m"), `Layer-1 missing command ${verb}`);
  }
  assert.doesNotMatch(out, /\bsearch\b/);
  assert.doesNotMatch(out, /\bbrief\b/);
  assert.doesNotMatch(out, /^chat {2}/m);
  assert.doesNotMatch(out, /wiki trust/);
  assert.doesNotMatch(out, /\bshow\b/);
  assert.doesNotMatch(out, /assume list/);
  assert.doesNotMatch(out, /assume answer/);
  assert.doesNotMatch(out, /index rebuild/);
}

test("help mentions pnpm exec legion-cli and legion alias", () => {
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
  assert.match(out, /^ {2}wireframe$/m);
  assert.match(out, /packet new/);
  assert.match(out, /packet respond/);
  assert.match(out, /verify/);
  assert.match(out, /^ {2}review$/m);
  assert.match(out, /^ {2}qa$/m);
  assert.match(out, /fix/);
  assert.match(out, /^ {2}ship$/m);
  assert.match(out, /abandon/);
  assert.match(out, /pnpm exec legion-cli/);
  assert.match(out, /legion \(alias\)/);
  assert.match(out, /npx @9thlevelsoftware\/legion --claude/);
  assert.doesNotMatch(out, /Does not register bin legion/);
  assert.doesNotMatch(out, /does not register the legion bin/);
  assert.match(out, /--yes \(ignored by intent confirm and ship; discuss refuses\)/);
  assert.match(out, /--metrics/);
  assert.match(out, /spec show/);
  assert.match(out, /spec approve/);
  assert.match(out, /spec new/);
  assert.match(out, /qa checklist/);
  const alwaysOn = helpSection(out, "Always-on operations:", "Board extras:");
  assert.match(alwaysOn, /index rebuild/);
  assert.match(alwaysOn, /^ {2}chat$/m);
  assert.doesNotMatch(alwaysOn, /assume list/);
  assert.doesNotMatch(alwaysOn, /assume answer/);
  const board = helpSection(out, "Board extras:", "Shipped adjacent");
  assert.match(board, /assume list/);
  assert.match(board, /assume answer/);
  assert.doesNotMatch(board, /index rebuild/);
  const adjacent = helpSection(out, "Shipped adjacent", "Later, not this series:");
  assert.match(adjacent, /skills list/);
  assert.match(adjacent, /skills show <id>/);
  assert.match(adjacent, /skills install <dir\|github:owner\/repo@tag>/);
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

test("help --all lists serve as shipped adjacent and not later", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  const adjacent = helpSection(out, "Shipped adjacent", "Later, not this series:");
  const later = helpSection(out, "Later, not this series:", "Not in this product:");
  assert.match(adjacent, /^ {2}serve$/m);
  assert.match(adjacent, /--mcp-http\/--no-mcp-http/);
  assert.match(adjacent, /--webmcp/);
  assert.doesNotMatch(later, /\bserve\b/);
  assert.doesNotMatch(later, /skills list\|install/);
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
  const later = helpSection(out, "Later, not this series:", "Not in this product:");
  assert.doesNotMatch(later, /control-mode/);
  assert.doesNotMatch(later, /vendor extra-adapter argv/);
  assert.doesNotMatch(later, /\bmap\b/);
  assert.doesNotMatch(later, /wireframe/);
  assert.doesNotMatch(later, /\bserve\b/);
  assert.doesNotMatch(later, /skills list/);
  const adjacent = helpSection(out, "Shipped adjacent (not the default window):", "Later, not this series:");
  assert.match(adjacent, /^ {2}map$/m);
  assert.match(adjacent, /--refresh, --lsp, --no-lsp/);
  assert.doesNotMatch(out, /v0 gap; follow-up PRs in this series/);
  assert.doesNotMatch(out, /v0 gap/);
  const alwaysOn = helpSection(out, "Always-on operations:", "Board extras:");
  assert.match(alwaysOn, /control-mode \[mode\]/);
  const notIn = helpSection(out, "Not in this product:", "");
  assert.doesNotMatch(notIn, /\bchat\b/);
  assert.match(notIn, /HTTP model router/);
  assert.doesNotMatch(notIn, /bin legion/);
});

test("installer flags refuse with exit 2", () => {
  for (const flag of INSTALLER_FLAGS) {
    const result = runCli([flag]);
    assert.equal(result.status, 2, flag);
    const err = normalize(result.stderr);
    assert.match(err, /legion is Legion CLI/, flag);
    assert.match(err, /npx @9thlevelsoftware\/legion --claude/, flag);
    assert.match(err, /bin legion-plugins/, flag);
  }
});

test("bare invocation and status are not installer refuses", () => {
  const bare = runCli([]);
  assert.notEqual(bare.status, 2);
  const status = runCli(["status"]);
  assert.notEqual(status.status, 2);
  const after = runCli(["status", "--claude"]);
  assert.notEqual(after.status, 2);
});

test("legion alias is status and refuses --claude with exit 2", async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "legion");
    await writeFile(script, `import ${JSON.stringify(pathToFileURL(bin).href)};\n`);
    const runLegion = (args) =>
      spawnSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        cwd: dir,
        windowsHide: true,
      });

    const refused = runLegion(["--claude"]);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(normalize(refused.stderr), /legion is Legion CLI/);
    assert.match(normalize(refused.stderr), /npx @9thlevelsoftware\/legion --claude/);

    const asCli = runCli([], { cwd: dir });
    const asLegion = runLegion([]);
    assert.equal(asLegion.status, asCli.status);
    assert.equal(normalize(asLegion.stdout), normalize(asCli.stdout));

    const statusCli = runCli(["status"], { cwd: dir });
    const statusLegion = runLegion(["status"]);
    assert.equal(statusLegion.status, statusCli.status);
    assert.equal(normalize(statusLegion.stdout), normalize(statusCli.stdout));
  });
});

test("doctor warns when PATH legion --help matches the plugin installer", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const stubDir = join(dir, "installer-bin");
    await mkdir(stubDir);
    const name = process.platform === "win32" ? "legion.cmd" : "legion";
    const body =
      process.platform === "win32"
        ? "@echo off\r\necho @9thlevelsoftware/legion plugin installer\r\n"
        : "#!/bin/sh\necho '@9thlevelsoftware/legion plugin installer'\n";
    const abs = join(stubDir, name);
    await writeFile(abs, body, "utf8");
    if (process.platform !== "win32") await chmod(abs, 0o755);
    const pathValue = [stubDir, process.env.PATH ?? process.env.Path ?? ""].join(delimiter);
    const result = runCli(["doctor", "--project", dir, "--json"], {
      env: {
        LEGION_CLI_ADAPTER: "fake",
        PATH: pathValue,
        ...(process.platform === "win32" ? { Path: pathValue } : {}),
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.ok(
      report.warnings.some((warning) =>
        /PATH legion is the plugin installer; upgrade it to bin legion-plugins or put Legion CLI first/.test(
          warning,
        ),
      ),
      `expected installer fingerprint warning, got ${JSON.stringify(report.warnings)}`,
    );
  });
});

test("doctor does not warn when PATH legion --help is Legion CLI", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const stubDir = join(dir, "pe-bin");
    await mkdir(stubDir);
    const name = process.platform === "win32" ? "legion.cmd" : "legion";
    const body =
      process.platform === "win32"
        ? "@echo off\r\necho Product Engineering lifecycle engine\r\necho @9thlevelsoftware/legion plugin installer\r\n"
        : "#!/bin/sh\necho 'Product Engineering lifecycle engine'\necho '@9thlevelsoftware/legion plugin installer'\n";
    const abs = join(stubDir, name);
    await writeFile(abs, body, "utf8");
    if (process.platform !== "win32") await chmod(abs, 0o755);
    const pathValue = [stubDir, process.env.PATH ?? process.env.Path ?? ""].join(delimiter);
    const result = runCli(["doctor", "--project", dir, "--json"], {
      env: {
        LEGION_CLI_ADAPTER: "fake",
        PATH: pathValue,
        ...(process.platform === "win32" ? { Path: pathValue } : {}),
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.ok(
      !report.warnings.some((warning) => /PATH legion is the plugin installer/.test(warning)),
      `did not expect installer fingerprint warning, got ${JSON.stringify(report.warnings)}`,
    );
  });
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
  assert.match(out, /read-only viewer/);
  assert.match(out, /ticket\|wikiTrust\|qaChecklist/);
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

test("--yes help says discuss refuses", () => {
  const result = runCli(["discuss", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /ignored by intent confirm and ship; discuss refuses/);
  assert.doesNotMatch(out, /ignored by intent confirm, ship, and discuss/);
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

test("parent verbs require a subcommand and print Next", () => {
  const cases = [
    ["wiki", /wiki requires trust/, /Next: legion-cli wiki trust <page>/],
    ["ticket", /ticket requires create/, /Next: legion-cli ticket create --title <title>/],
    ["task", /task requires amend/, /Next: legion-cli task amend <id>/],
    ["context", /context requires compact/, /Next: legion-cli context compact/],
    ["run", /run requires promote/, /Next: legion-cli run promote <id>/],
    ["skills", /skills requires list, install, or show/, /Next: legion-cli skills list/],
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
  const out = normalize(result.stdout);
  assert.match(out, /untrusted until wiki trust/);
  assert.match(out, /--trust/);
  assert.match(out, /re-promote\s+overwrites/);
  assert.match(out, /Next is first page/);
  assert.match(out, /--yes does not review/);
});

test("init --adapter http refuses until http flags land", () => {
  const result = runCli(["init", "--name", "Checkin", "--adapter", "http"]);
  assert.equal(result.status, 1);
  const err = normalize(result.stderr);
  assert.match(err, /adapter http is not selectable yet/);
  assert.match(err, /--adapter claude\|generic\|fake\|grok\|openai\|codex\|mimo\|minimax/);
  assert.doesNotMatch(err, /\|http/);
});
