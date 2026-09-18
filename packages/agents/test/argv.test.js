import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSUMED_EXTRA_BINARIES,
  CLAUDE_FROZEN_ARGV,
  CODEX_FROZEN_ARGV,
  DEFAULT_GENERIC_ARGS,
  EXTRA_ADAPTER_IDS,
  FROZEN_ARGV_TABLE,
  GROK_FROZEN_ARGV,
  KD7_EXTRA_ARGV,
  MIMO_FROZEN_ARGV,
  MINIMAX_FROZEN_ARGV,
  POINTER_PLACEHOLDER,
  POINTER_PROMPT_MAX_CHARS,
  SPAWNABLE_ADAPTER_IDS,
  extraArgsOrDefault,
  extraArgvIsSpawnable,
  extraArgvPrefixCompatible,
  extraVendorPrefix,
  argsIncludePointer,
  buildClaudeArgv,
  buildGenericArgv,
  buildPointerPrompt,
  genericArgsOrDefault,
  templateArgv,
  usesAssumedExtraBinary,
} from "../dist/index.js";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("frozen claude argv is -p --output-format json pointerPrompt", () => {
  const pointer = buildPointerPrompt("run-9", "execute");
  assert.deepEqual(CLAUDE_FROZEN_ARGV, ["-p", "--output-format", "json"]);
  assert.deepEqual(buildClaudeArgv(pointer), ["-p", "--output-format", "json", pointer]);
  assert.equal(
    FROZEN_ARGV_TABLE.claude.argv.join(" "),
    "-p --output-format json {{pointer}}",
  );
  assert.ok(!buildClaudeArgv(pointer).includes("--dangerously-skip-permissions"));
});

test("claude extraArgs are an escape hatch before the pointer", () => {
  const pointer = "PTR";
  assert.deepEqual(buildClaudeArgv(pointer, ["--model", "opus"]), [
    "-p",
    "--output-format",
    "json",
    "--model",
    "opus",
    pointer,
  ]);
});

test("generic argv substitutes {{pointer}}", () => {
  const pointer = buildPointerPrompt("run-2", "plan");
  assert.deepEqual(buildGenericArgv(["-p", "--output-format", "json", "{{pointer}}"], pointer), [
    "-p",
    "--output-format",
    "json",
    pointer,
  ]);
  assert.match(pointer, /Do not `git add` or `git commit`/);
});

test("empty generic args default to {{pointer}}; explicit args without it are rejected", () => {
  assert.deepEqual(genericArgsOrDefault([]), [POINTER_PLACEHOLDER]);
  assert.deepEqual(genericArgsOrDefault([]), [...DEFAULT_GENERIC_ARGS]);
  assert.equal(argsIncludePointer(genericArgsOrDefault([])), true);
  assert.equal(argsIncludePointer(["-p", "--output-format", "json"]), false);
  assert.equal(argsIncludePointer(["-p", "{{pointer}}"]), true);
});

test("pointer prompt includes run/skill paths and forbids git commit", () => {
  const prompt = buildPointerPrompt("abc", "review");
  assert.ok(prompt.length <= POINTER_PROMPT_MAX_CHARS);
  assert.match(prompt, /runId=abc/);
  assert.match(prompt, /skill=review/);
  assert.match(prompt, /\.legion-cli\/cache\/runs\/abc\/prompt\.md/);
  assert.match(prompt, /\.legion-cli\/cache\/skills\/abc\/SKILL\.md/);
  assert.doesNotMatch(prompt, /SHERPA/);
  assert.match(prompt, /BEGIN LEGION CLI UNTRUSTED CONTENT/);
  assert.match(prompt, /do not load their bodies/);
  assert.match(prompt, /Do not run legion-cli/);
  assert.match(prompt, /Do not `git add` or `git commit`/);
  assert.match(prompt, /\.legion-cli\/cache\/runs\/abc\/summary\.md/);
});

test("frozen argv table deepEquals the KD-7 vendor rows", () => {
  assert.deepEqual([...EXTRA_ADAPTER_IDS], ["grok", "openai", "codex", "mimo", "minimax"]);
  assert.deepEqual(ASSUMED_EXTRA_BINARIES, {
    grok: "grok",
    openai: "codex",
    codex: "codex",
    mimo: "mimo",
    minimax: "mcode",
  });
  assert.deepEqual([...GROK_FROZEN_ARGV], ["-p", "{{pointer}}"]);
  assert.deepEqual([...CODEX_FROZEN_ARGV], ["exec", "{{pointer}}"]);
  assert.deepEqual([...MIMO_FROZEN_ARGV], ["run", "{{pointer}}"]);
  assert.deepEqual([...MINIMAX_FROZEN_ARGV], ["exec", "{{pointer}}"]);
  assert.deepEqual([...KD7_EXTRA_ARGV.grok], ["-p", "{{pointer}}"]);
  assert.deepEqual([...KD7_EXTRA_ARGV.openai], ["exec", "{{pointer}}"]);
  assert.deepEqual([...KD7_EXTRA_ARGV.codex], ["exec", "{{pointer}}"]);
  assert.deepEqual([...KD7_EXTRA_ARGV.mimo], ["run", "{{pointer}}"]);
  assert.deepEqual([...KD7_EXTRA_ARGV.minimax], ["exec", "{{pointer}}"]);
  for (const id of EXTRA_ADAPTER_IDS) {
    assert.equal(FROZEN_ARGV_TABLE[id].spawnable, true);
    assert.equal(FROZEN_ARGV_TABLE[id].binary, ASSUMED_EXTRA_BINARIES[id]);
    assert.deepEqual([...FROZEN_ARGV_TABLE[id].argv], [...KD7_EXTRA_ARGV[id]]);
    assert.equal(argsIncludePointer(FROZEN_ARGV_TABLE[id].argv), true);
    assert.ok(SPAWNABLE_ADAPTER_IDS.includes(id));
    assert.notDeepEqual([...FROZEN_ARGV_TABLE[id].argv], [...DEFAULT_GENERIC_ARGS]);
  }
  assert.deepEqual(extraArgsOrDefault("grok"), ["-p", "{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("mimo"), ["run", "{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("minimax"), ["exec", "{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("openai"), ["exec", "{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("codex"), ["exec", "{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("openai", ["{{pointer}}"]), ["{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("codex", ["exec", "{{pointer}}"]), ["exec", "{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("openai", ["{{pointer}}"], process.execPath), ["{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("grok", ["-p", "{{pointer}}", "--model", "grok-4"]), [
    "-p",
    "{{pointer}}",
    "--model",
    "grok-4",
  ]);
  assert.equal(FROZEN_ARGV_TABLE.fake.spawnable, true);
  assert.equal(FROZEN_ARGV_TABLE.claude.spawnable, true);
  assert.equal(FROZEN_ARGV_TABLE.generic.spawnable, true);
  assert.equal(FROZEN_ARGV_TABLE.http.binary, "(http)");
  assert.equal(FROZEN_ARGV_TABLE.http.argv, null);
  assert.equal(FROZEN_ARGV_TABLE.http.spawnable, false);
  assert.equal(SPAWNABLE_ADAPTER_IDS.includes("http"), false);
});

test("extra argv is prefix-compatible with the frozen vendor template", () => {
  assert.equal(extraVendorPrefix("grok"), "-p");
  assert.equal(extraVendorPrefix("openai"), "exec");
  assert.equal(extraVendorPrefix("codex"), "exec");
  assert.equal(extraVendorPrefix("mimo"), "run");
  assert.equal(extraVendorPrefix("minimax"), "exec");
  assert.equal(usesAssumedExtraBinary("grok"), true);
  assert.equal(usesAssumedExtraBinary("grok", "grok.exe"), true);
  assert.equal(usesAssumedExtraBinary("openai", "codex"), true);
  assert.equal(usesAssumedExtraBinary("minimax", "mcode"), true);
  assert.equal(usesAssumedExtraBinary("grok", process.execPath), false);
  assert.equal(extraArgvPrefixCompatible("grok", ["-p", "{{pointer}}"]), true);
  assert.equal(extraArgvPrefixCompatible("grok", ["-p", "{{pointer}}", "--model", "x"]), true);
  assert.equal(extraArgvPrefixCompatible("grok", ["-p", "--model", "x", "{{pointer}}"]), false);
  assert.equal(extraArgvPrefixCompatible("grok", ["{{pointer}}"]), false);
  assert.equal(extraArgvPrefixCompatible("openai", ["{{pointer}}"]), false);
  assert.equal(extraArgvPrefixCompatible("mimo", ["{{pointer}}"]), false);
  assert.equal(extraArgvPrefixCompatible("minimax", ["{{pointer}}"]), false);
  assert.equal(extraArgvPrefixCompatible("openai", ["exec", "{{pointer}}"]), true);
  assert.equal(extraArgvPrefixCompatible("grok", ["{{pointer}}"], process.execPath), true);
  assert.equal(extraArgvIsSpawnable("grok"), true);
  assert.equal(extraArgvIsSpawnable("grok", ["-p", "{{pointer}}", "--model", "x"]), true);
  assert.equal(extraArgvIsSpawnable("grok", ["-p", "--model", "x", "{{pointer}}"]), false);
  assert.equal(extraArgvIsSpawnable("grok", ["{{pointer}}"]), false);
  assert.equal(extraArgvIsSpawnable("grok", ["-p"]), false);
  assert.equal(extraArgvIsSpawnable("grok", ["{{pointer}}"], process.execPath), true);
  assert.equal(extraArgvIsSpawnable("openai", ["exec", "--sandbox", "{{pointer}}"]), true);
});

test("templateArgv leaves {{pointer}} unexpanded and omits the pointer-prompt body", () => {
  const pointer = buildPointerPrompt("run-9", "execute");
  const config = {
    adapter: {
      default: "claude",
      claude: { extraArgs: ["--model", "opus"] },
      grok: { args: ["-p", "{{pointer}}", "--model", "grok-4"] },
      generic: { binary: "node", args: ["-p", "{{pointer}}"] },
      minimax: { binary: "custom-mcode" },
    },
  };
  const claude = templateArgv("claude", config);
  assert.equal(claude.binary, "claude");
  assert.deepEqual(claude.argv, ["-p", "--output-format", "json", "--model", "opus", POINTER_PLACEHOLDER]);
  assert.ok(!claude.argv.includes(pointer));
  assert.ok(claude.argv.every((arg) => !arg.includes("Do not `git add`")));

  const grok = templateArgv("grok", config);
  assert.equal(grok.binary, ASSUMED_EXTRA_BINARIES.grok);
  assert.deepEqual([...grok.argv], ["-p", POINTER_PLACEHOLDER, "--model", "grok-4"]);
  assert.ok(!grok.argv.includes(pointer));

  const generic = templateArgv("generic", config);
  assert.equal(generic.binary, "node");
  assert.deepEqual([...generic.argv], ["-p", POINTER_PLACEHOLDER]);

  const fake = templateArgv("fake", config);
  assert.equal(fake.binary, "(in-process)");
  assert.deepEqual([...fake.argv], []);

  const http = templateArgv("http", config);
  assert.equal(http.binary, "(http)");
  assert.deepEqual([...http.argv], []);

  const minimax = templateArgv("minimax", config);
  assert.equal(minimax.binary, "custom-mcode");
  assert.deepEqual([...minimax.argv], ["exec", "{{pointer}}"]);
});

test("agents source has no fetch( or completions client", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) files.push(abs);
    }
  };
  walk(srcRoot);
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\bfetch\s*\(/, file);
    assert.doesNotMatch(text, /\bcompletions\b/i, file);
  }
});

test("templateArgv uses assumed extra binaries and frozen extra argv", () => {
  const config = { adapter: { default: "claude" } };
  for (const id of EXTRA_ADAPTER_IDS) {
    const tmpl = templateArgv(id, config);
    assert.equal(tmpl.binary, ASSUMED_EXTRA_BINARIES[id]);
    assert.deepEqual([...tmpl.argv], extraArgsOrDefault(id));
    assert.equal(argsIncludePointer(tmpl.argv), true);
  }
  const generic = templateArgv("generic", config);
  assert.equal(generic.binary, FROZEN_ARGV_TABLE.generic.binary);
  assert.deepEqual([...generic.argv], [...DEFAULT_GENERIC_ARGS]);
});
