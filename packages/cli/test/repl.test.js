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
