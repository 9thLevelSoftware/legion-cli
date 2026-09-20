import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runVerificationCommands, verificationFailureReason } from "../dist/index.js";
import { quoteArg, withEngine } from "./helpers.js";

test("verification commands inherit DATABASE_URL", async () => {
  await withEngine(async ({ dir }) => {
    const script = join(dir, "print-env.js");
    const out = join(dir, "env-out.txt");
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://fixture";
    try {
      await writeFile(
        script,
        "require('node:fs').writeFileSync('env-out.txt', process.env.DATABASE_URL || '')\n",
      );
      const command = `${quoteArg(process.execPath)} ${quoteArg(script)}`;
      const runs = await runVerificationCommands(dir, [command]);
      assert.equal(runs[0]?.ok, true, JSON.stringify(runs));
      assert.equal(await readFile(out, "utf8"), "postgres://fixture");
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});

test("verification never throws: a missing binary is a failed run that did not start", async () => {
  await withEngine(async ({ dir }) => {
    const runs = await runVerificationCommands(dir, ["legion-no-such-binary-xyz --version", "never-reached"]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ok, false);
    assert.equal(runs[0].started, false);
    assert.match(
      verificationFailureReason(runs),
      /^verification command did not start: legion-no-such-binary-xyz --version: /,
    );
  });
});

test("2 MiB of verification output passes and lands in the run log", async () => {
  await withEngine(async ({ dir }) => {
    const command = `${quoteArg(process.execPath)} -e ${quoteArg("process.stdout.write('y'.repeat(2*1024*1024))")}`;
    const runs = await runVerificationCommands(dir, [command], { runId: "big-output" });
    assert.equal(runs[0]?.ok, true, JSON.stringify(runs));
    assert.equal(runs[0].logPath, ".legion-cli/cache/runs/big-output/verify-1.log");
    const log = await readFile(join(dir, ".legion-cli", "cache", "runs", "big-output", "verify-1.log"), "utf8");
    assert.equal(log.length, 2 * 1024 * 1024);
  });
});

test("`a && b` is refused as argv-only instead of running `a` with extra arguments", async () => {
  await withEngine(async ({ dir }) => {
    const runs = await runVerificationCommands(dir, [`${quoteArg(process.execPath)} -v && echo hi`]);
    assert.equal(runs[0].ok, false);
    assert.equal(runs[0].started, false);
    assert.equal(runs[0].error, "verificationCommands are argv-only; split it into separate commands");
  });
});
