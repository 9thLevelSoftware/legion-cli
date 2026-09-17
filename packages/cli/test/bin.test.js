import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { bin, normalize, runCli, withTempDir } from "./helpers.js";
import { RUN_BOUNDED_MAX_BUFFER, runBounded } from "../dist/which.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

const INVOCATION_LINES = [
  "Supported commands: pnpm exec legion-cli   |   legion (alias)",
  "Plugin installer: npx @9thlevelsoftware/legion --claude   (bin legion-plugins)",
];

const REAL_INSTALLER_HELP = [
  "Usage:",
  "  npx @9thlevelsoftware/legion [options]",
  "",
  "Runtime (pick one):",
  "  --claude      Claude Code",
  "  --copilot     GitHub Copilot CLI",
  "  --kiro        Kiro CLI (preferred)",
  "",
  "Actions:",
  "  --uninstall   Remove all Legion files",
].join("\n");

const INSTALLER_FLAGS = [
  "--claude",
  "--codex",
  "--cursor",
  "--copilot",
  "--gemini",
  "--antigravity",
  "--agy",
  "--kiro",
  "--amazon-q",
  "--windsurf",
  "--opencode",
  "--kilo",
  "--kilo-code",
  "--kilocode",
  "--aider",
  "--uninstall",
  "--update",
  "install",
  "uninstall",
  "add",
  "remove",
  "update",
  "upgrade",
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

function assertInvocationLines(out) {
  const lines = out.split("\n");
  for (const line of INVOCATION_LINES) {
    assert.ok(lines.includes(line), `missing exact line: ${line}`);
  }
}

function assertLayer1(out) {
  assertInvocationLines(out);
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
  assertInvocationLines(out);
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
  const adjacent = helpSection(out, "Shipped adjacent", "");
  assert.match(adjacent, /skills list/);
  assert.match(adjacent, /skills show <id>/);
  assert.match(adjacent, /skills install <dir\|github:owner\/repo@tag>/);
  assert.doesNotMatch(out, /Later, not this series/);
  assert.doesNotMatch(out, /Not in this product/);
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
  const adjacent = helpSection(out, "Shipped adjacent", "");
  assert.match(adjacent, /^ {2}serve$/m);
  assert.match(adjacent, /--mcp-http\/--no-mcp-http/);
  assert.match(adjacent, /--webmcp/);
  assert.doesNotMatch(out, /Later, not this series/);
  assert.doesNotMatch(out, /Not in this product/);
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
  assert.doesNotMatch(out, /Later, not this series/);
  assert.doesNotMatch(out, /Not in this product/);
  const adjacent = helpSection(out, "Shipped adjacent (not the default window):");
  assert.match(adjacent, /^ {2}map$/m);
  assert.match(adjacent, /--refresh, --lsp, --no-lsp/);
  assert.doesNotMatch(out, /v0 gap; follow-up PRs in this series/);
  assert.doesNotMatch(out, /v0 gap/);
  const alwaysOn = helpSection(out, "Always-on operations:", "Board extras:");
  assert.match(alwaysOn, /control-mode \[mode\]/);
  assert.match(alwaysOn, /^ {2}chat$/m);
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

async function writeLegionHelpStub(dir, helpText) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "help.txt"), helpText.endsWith("\n") ? helpText : `${helpText}\n`);
  if (process.platform === "win32") {
    const abs = join(dir, "legion.cmd");
    await writeFile(
      abs,
      [
        "@echo off",
        'if not "%~1"=="--help" (',
        "  echo missing --help 1>&2",
        "  exit /b 1",
        ")",
        'type "%~dp0help.txt"',
        "",
      ].join("\r\n"),
    );
    return abs;
  }
  const abs = join(dir, "legion");
  await writeFile(
    abs,
    '#!/bin/sh\nif [ "$1" != "--help" ]; then echo missing --help >&2; exit 1; fi\ncat "$(dirname "$0")/help.txt"\n',
  );
  await chmod(abs, 0o755);
  return abs;
}

function pathEnvWith(dir) {
  const current = process.env.PATH ?? process.env.Path ?? "";
  const value = [dir, current].join(delimiter);
  return process.platform === "win32" ? { PATH: value, Path: value } : { PATH: value };
}

test("doctor warns when PATH legion --help matches the plugin installer", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const stubDir = join(dir, "installer-bin");
    await writeLegionHelpStub(stubDir, REAL_INSTALLER_HELP);
    const result = runCli(["doctor", "--project", dir, "--json"], {
      env: {
        LEGION_CLI_ADAPTER: "fake",
        ...pathEnvWith(stubDir),
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
    await writeLegionHelpStub(stubDir, `${INVOCATION_LINES.join("\n")}\nProduct Engineering lifecycle engine\n`);
    const result = runCli(["doctor", "--project", dir, "--json"], {
      env: {
        LEGION_CLI_ADAPTER: "fake",
        ...pathEnvWith(stubDir),
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

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("runBounded timeout kills cmd grandchild / node target", async () => {
  await withTempDir(async (dir) => {
    const hang = join(dir, "hang.cjs");
    const pidFile = join(dir, "pid.txt");
    await writeFile(
      hang,
      `const { writeFileSync } = require("node:fs");\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    );
    let probe;
    if (process.platform === "win32") {
      const inner = join(dir, "hang-inner.cmd");
      await writeFile(inner, `@echo off\r\n"${process.execPath}" "${hang}"\r\n`);
      probe = join(dir, "legion.cmd");
      await writeFile(probe, `@echo off\r\ncall "${inner}"\r\n`);
    } else {
      probe = join(dir, "legion");
      await writeFile(probe, `#!/bin/sh\n${JSON.stringify(process.execPath)} ${JSON.stringify(hang)}\n`);
      await chmod(probe, 0o755);
    }
    const started = Date.now();
    const result = await runBounded(probe, ["--help"], 800);
    assert.equal(result.timedOut, true);
    assert.equal(result.truncated, false);
    assert.ok(Date.now() - started < 4000);
    const deadline = Date.now() + 2000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(existsSync(pidFile), "hang fixture never wrote pid");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(isAlive(pid), false, `grandchild pid ${pid} still alive`);
  });
});

test("runBounded caps stdout at 1 MiB and kills the process tree", async () => {
  await withTempDir(async (dir) => {
    assert.equal(RUN_BOUNDED_MAX_BUFFER, 1024 * 1024);
    const floodChunk = 64 * 1024;
    const flood = join(dir, "flood.cjs");
    const pidFile = join(dir, "pid.txt");
    await writeFile(
      flood,
      [
        'const { writeFileSync } = require("node:fs");',
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `const chunk = Buffer.alloc(${floodChunk}, 97);`,
        "function flood() {",
        "  while (process.stdout.write(chunk)) {}",
        '  process.stdout.once("drain", flood);',
        "}",
        "flood();",
        "",
      ].join("\n"),
    );
    const started = Date.now();
    const result = await runBounded(process.execPath, [flood], 10_000);
    assert.equal(result.truncated, true, result.stderr);
    assert.equal(result.timedOut, false);
    const stdoutBytes = Buffer.byteLength(result.stdout);
    assert.ok(stdoutBytes <= RUN_BOUNDED_MAX_BUFFER, `stdout ${stdoutBytes} over cap`);
    assert.ok(
      stdoutBytes > RUN_BOUNDED_MAX_BUFFER - floodChunk,
      `stdout ${stdoutBytes} not within one ${floodChunk}-byte flood chunk of the cap`,
    );
    assert.ok(Buffer.byteLength(result.stderr) <= RUN_BOUNDED_MAX_BUFFER);
    assert.ok(Date.now() - started < 4000);
    const deadline = Date.now() + 2000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(existsSync(pidFile), "flood fixture never wrote pid");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(isAlive(pid), false, `flood pid ${pid} still alive`);
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

test("init --adapter http persists adapter.http and pid is not spawned", async () => {
  await withTempDir(async (dir) => {
    const result = runCli([
      "init",
      "--project",
      dir,
      "--name",
      "Checkin",
      "--adapter",
      "http",
      "--http-base-url",
      "https://api.openai.com/v1",
      "--http-model",
      "gpt-4",
      "--http-api-key-env",
      "OPENAI_API_KEY",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const engine = createLegionEngine(dir);
    const config = await engine.store.readConfig();
    assert.equal(config.adapter.default, "http");
    assert.equal(config.adapter.http?.baseUrl, "https://api.openai.com/v1");
    assert.equal(config.adapter.http?.model, "gpt-4");
    assert.equal(config.adapter.http?.apiKeyEnv, "OPENAI_API_KEY");
    assert.equal(config.adapter.http?.allowLoopback, false);
    assert.equal(config.adapter.http?.apiKey, undefined);
  });
});

test("init --adapter http requires http flags", () => {
  const result = runCli(["init", "--name", "Checkin", "--adapter", "http"]);
  assert.equal(result.status, 1);
  const err = normalize(result.stderr);
  assert.match(err, /adapter\.http\.baseUrl is required/);
  assert.match(err, /--http-base-url/);
  assert.match(err, /--http-model/);
  assert.match(err, /--http-api-key-env/);
});

test("init --adapter http validates flags before writing the workspace", async () => {
  await withTempDir(async (dir) => {
    const badKey = runCli([
      "init",
      "--project",
      dir,
      "--name",
      "Checkin",
      "--adapter",
      "http",
      "--http-base-url",
      "https://api.openai.com/v1",
      "--http-model",
      "gpt-4",
      "--http-api-key-env",
      "foo",
    ]);
    assert.equal(badKey.status, 1);
    assert.match(normalize(badKey.stderr), /must match pattern|apiKeyEnv|adapter\.http/);
    const badUrl = runCli([
      "init",
      "--project",
      dir,
      "--name",
      "Checkin",
      "--adapter",
      "http",
      "--http-base-url",
      "http://example.com/v1",
      "--http-model",
      "gpt-4",
      "--http-api-key-env",
      "OPENAI_API_KEY",
    ]);
    assert.equal(badUrl.status, 1);
    assert.match(normalize(badUrl.stderr), /https:|allowLoopback|adapter\.http/);
  });
});

test("help --all drops HTTP model router and lists http init flags", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.doesNotMatch(out, /HTTP model router/);
  assert.match(out, /--http-base-url/);
  assert.match(out, /--http-model/);
  assert.match(out, /--http-api-key-env/);
  assert.doesNotMatch(out, /Later, not this series/);
  assert.doesNotMatch(out, /Not in this product/);
});
