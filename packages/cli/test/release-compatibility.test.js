import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { normalize, runCli } from "./helpers.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readRepoFile(name) {
  return readFileSync(join(repoRoot, name), "utf8");
}

test("release docs preserve the canonical ten-verb lifecycle", () => {
  const help = normalize(runCli(["help", "--all"]).stdout);
  const lifecycle = ["init", "intent", "discuss", "spec", "plan", "execute", "verify", "review", "qa", "ship"];
  const lifecycleSection = help.split("Always-on operations:", 1)[0];
  for (const verb of lifecycle) {
    assert.match(lifecycleSection, new RegExp(`^  ${verb}(?: |\\n)`, "m"), verb);
  }

  const agents = readRepoFile("AGENTS.md");
  const design = readRepoFile("docs/design/product-engineering-cli.md");
  for (const text of [agents, design]) {
    assert.match(text, /10-verb lifecycle core/);
    for (const verb of lifecycle) assert.match(text, new RegExp(`\\b${verb}\\b`), verb);
  }
});

test("release docs keep brownfield artifacts and worktrees distinct", () => {
  const agents = readRepoFile("AGENTS.md");
  const design = readRepoFile("docs/design/product-engineering-cli.md");
  const text = `${agents}\n${design}`;

  assert.match(text, /init --mode brownfield/);
  assert.match(text, /legion-cli brownfield/);
  assert.match(text, /\.legion-cli\/runs/);
  assert.match(text, /\.legion-cli\/worktrees\/<run>\/pr-N\//);
  assert.match(text, /execute`? stays .*in-place/i);
  assert.match(text, /--execute.*worktree/i);
});

test("release docs retain the verified vendor argv contract", () => {
  const readme = readRepoFile("README.md");
  const agents = readRepoFile("AGENTS.md");
  const design = readRepoFile("docs/design/product-engineering-cli.md");
  const text = `${readme}\n${agents}\n${design}`;

  for (const argv of ["grok -p", "codex exec", "mimo run", "mcode exec"]) {
    assert.match(text, new RegExp(argv.replace(" ", "\\s+")), argv);
  }
  assert.match(text, /\{\{pointer\}\}/);
});
