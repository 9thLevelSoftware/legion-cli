import assert from "node:assert/strict";
import test from "node:test";

import { REPL_BANNER } from "../dist/repl.js";
import { normalize, runCli, withTempDir } from "./helpers.js";

test("REPL banner is host-mode and does not claim Sandboxed", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["repl", "--project", dir], { input: ".exit\n" });
    assert.equal(result.status, 0, result.stderr);
    const out = normalize(result.stdout);
    assert.match(out, /host mode, NO SANDBOX/i);
    assert.doesNotMatch(out, /\bSandboxed\b/);
    assert.match(REPL_BANNER, /NO SANDBOX/);
    assert.doesNotMatch(REPL_BANNER, /Sandboxed/);
  });
});

test("repl --lang unknown is refused instead of shelling out", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["repl", "--lang", "sh", "--project", dir], { input: ".exit\n" });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /repl --lang sh is not allowed/);
  });
});

test("repl persists node VM bindings across turns, scrubs secrets, and recovers from errors", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["repl", "--project", dir], {
      input: [
        "const x = 2;",
        "x + 3",
        "{ a: 1, b: x }",
        "throw new Error('boom')",
        "x * 10",
        "process.env.OPENAI_API_KEY === undefined && process.cwd().length > 0",
        ".exit",
      ].join("\n") + "\n",
      env: { OPENAI_API_KEY: "sk-repl-secret-should-be-scrubbed" },
    });
    assert.equal(result.status, 0, result.stderr);
    const out = normalize(result.stdout);
    const err = normalize(result.stderr);
    assert.match(out, /^5$/m);
    assert.match(out, /\{ a: 1, b: 2 \}/);
    assert.match(out, /^20$/m);
    assert.match(out, /^true$/m);
    assert.match(err, /Error: boom/);
  });
});

test("repl --lang ts strips TypeScript types and preserves state across turns", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["repl", "--lang", "ts", "--project", dir], {
      input: [
        "interface Box { value: number }",
        "const base: number = 40;",
        "const add = (a: number, b: number): number => a + b;",
        "add(base, 2)",
        ".exit",
      ].join("\n") + "\n",
    });
    assert.equal(result.status, 0, result.stderr);
    const out = normalize(result.stdout);
    assert.match(out, /^42$/m);
  });
});
