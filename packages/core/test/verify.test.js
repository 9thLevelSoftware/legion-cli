import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runVerificationCommands } from "../dist/index.js";
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
      const runs = runVerificationCommands(dir, [command]);
      assert.equal(runs[0]?.ok, true, JSON.stringify(runs));
      assert.equal(await readFile(out, "utf8"), "postgres://fixture");
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
