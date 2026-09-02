import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSUMED_EXTRA_BINARIES,
  CLAUDE_FROZEN_ARGV,
  DEFAULT_GENERIC_ARGS,
  EXTRA_ADAPTER_IDS,
  FROZEN_ARGV_TABLE,
  POINTER_PLACEHOLDER,
  POINTER_PROMPT_MAX_CHARS,
  SPAWNABLE_ADAPTER_IDS,
  extraArgsOrDefault,
  argsIncludePointer,
  buildClaudeArgv,
  buildGenericArgv,
  buildPointerPrompt,
  genericArgsOrDefault,
  templateArgv,
} from "../dist/index.js";

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
  assert.match(prompt, /BEGIN SHERPA UNTRUSTED CONTENT/);
  assert.match(prompt, /Do not `git add` or `git commit`/);
  assert.match(prompt, /\.legion-cli\/cache\/runs\/abc\/summary\.md/);
});

test("frozen argv table marks extra adapters spawnable with fillable generic-style argv", () => {
  assert.deepEqual([...EXTRA_ADAPTER_IDS], ["grok", "openai", "codex", "mimo", "minimax"]);
  assert.deepEqual(ASSUMED_EXTRA_BINARIES, {
    grok: "grok",
    openai: "codex",
    codex: "codex",
    mimo: "mimo",
    minimax: "mcode",
  });
  for (const id of EXTRA_ADAPTER_IDS) {
    assert.equal(FROZEN_ARGV_TABLE[id].spawnable, true);
    assert.equal(FROZEN_ARGV_TABLE[id].binary, ASSUMED_EXTRA_BINARIES[id]);
    assert.equal(argsIncludePointer(FROZEN_ARGV_TABLE[id].argv), true);
    assert.ok(SPAWNABLE_ADAPTER_IDS.includes(id));
  }
  assert.deepEqual([...FROZEN_ARGV_TABLE.grok.argv], [...DEFAULT_GENERIC_ARGS]);
  assert.deepEqual([...FROZEN_ARGV_TABLE.mimo.argv], [...DEFAULT_GENERIC_ARGS]);
  assert.deepEqual([...FROZEN_ARGV_TABLE.minimax.argv], [...DEFAULT_GENERIC_ARGS]);
  assert.deepEqual([...FROZEN_ARGV_TABLE.openai.argv], ["exec", "{{pointer}}"]);
  assert.deepEqual([...FROZEN_ARGV_TABLE.codex.argv], ["exec", "{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("openai"), ["exec", "{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("codex"), ["exec", "{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("grok"), [...DEFAULT_GENERIC_ARGS]);
  assert.deepEqual(extraArgsOrDefault("openai", ["{{pointer}}"]), ["exec", "{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("codex", ["exec", "{{pointer}}"]), ["exec", "{{pointer}}"]);
  assert.deepEqual(extraArgsOrDefault("openai", ["{{pointer}}"], process.execPath), ["{{pointer}}"]);
  assert.equal(FROZEN_ARGV_TABLE.fake.spawnable, true);
  assert.equal(FROZEN_ARGV_TABLE.claude.spawnable, true);
  assert.equal(FROZEN_ARGV_TABLE.generic.spawnable, true);
});

test("templateArgv leaves {{pointer}} unexpanded and omits the pointer-prompt body", () => {
  const pointer = buildPointerPrompt("run-9", "execute");
  const config = {
    adapter: {
      default: "claude",
      claude: { extraArgs: ["--model", "opus"] },
      grok: { args: ["--model", "grok-4", "{{pointer}}"] },
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
  assert.deepEqual([...grok.argv], ["--model", "grok-4", POINTER_PLACEHOLDER]);
  assert.ok(!grok.argv.includes(pointer));

  const generic = templateArgv("generic", config);
  assert.equal(generic.binary, "node");
  assert.deepEqual([...generic.argv], ["-p", POINTER_PLACEHOLDER]);

  const fake = templateArgv("fake", config);
  assert.equal(fake.binary, "(in-process)");
  assert.deepEqual([...fake.argv], []);

  const minimax = templateArgv("minimax", config);
  assert.equal(minimax.binary, "custom-mcode");
  assert.deepEqual([...minimax.argv], [...DEFAULT_GENERIC_ARGS]);
});

test("templateArgv uses assumed extra binaries and default {{pointer}} argv", () => {
  const config = { adapter: { default: "claude" } };
  for (const id of EXTRA_ADAPTER_IDS) {
    const tmpl = templateArgv(id, config);
    assert.equal(tmpl.binary, ASSUMED_EXTRA_BINARIES[id]);
    assert.deepEqual([...tmpl.argv], [...DEFAULT_GENERIC_ARGS]);
    assert.equal(argsIncludePointer(tmpl.argv), true);
  }
  const generic = templateArgv("generic", config);
  assert.equal(generic.binary, FROZEN_ARGV_TABLE.generic.binary);
  assert.deepEqual([...generic.argv], [...DEFAULT_GENERIC_ARGS]);
});
