import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runProjectQa } from "../dist/index.js";

const spec = {
  id: "spec-api",
  acceptance: [{ id: "AC-01", statement: "API returns 200 for health", kind: "test", priority: "P0" }],
  wireframesIndex: null,
};

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-qa-run-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("an unstartable unit command says why and scores P0 failed", async () => {
  await withTempDir(async (dir) => {
    const result = await runProjectQa({
      projectRoot: dir,
      spec,
      mode: "full",
      unitCommand: "legion-no-such-binary-xyz test",
      id: "qa-nostart",
      createdAt: "2026-09-01T12:00:00Z",
    });
    assert.deepEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /^unit command did not start: legion-no-such-binary-xyz: not found on PATH/);
    assert.equal(result.score.pass, false);
    assert.ok(result.score.buckets.p0.failed >= 1);
    assert.match(await readFile(join(dir, ".legion-cli", "qa", "unit.json"), "utf8"), /not found on PATH/);
  });
});

test("a unit command that times out says so", async () => {
  await withTempDir(async (dir) => {
    const result = await runProjectQa({
      projectRoot: dir,
      spec,
      mode: "full",
      unitCommand: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
      commandTimeoutMs: 500,
      id: "qa-timeout",
      createdAt: "2026-09-01T12:00:00Z",
    });
    assert.deepEqual(result.warnings, ["unit command timed out after 500 ms and was stopped"]);
    assert.equal(result.score.pass, false);
  });
});

test("an argv-only violation in the unit command does not start", async () => {
  await withTempDir(async (dir) => {
    const result = await runProjectQa({
      projectRoot: dir,
      spec,
      mode: "full",
      unitCommand: "pnpm test && pnpm lint",
      id: "qa-argv",
      createdAt: "2026-09-01T12:00:00Z",
    });
    assert.match(result.warnings[0], /unit command did not start: verificationCommands are argv-only/);
    assert.equal(result.score.pass, false);
  });
});

test("QA's unit command gets the scrubbed environment, DATABASE_URL kept", async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "emit.js");
    await writeFile(
      script,
      [
        "const names = Object.keys(process.env).map((key) => key.toUpperCase());",
        "const leaked = ['FOO_TOKEN','SENDGRID_APIKEY','GH_PAT','NPM_CONFIG__AUTHTOKEN','LEGION_TEST_PROVIDER_VAR'].filter((n) => names.includes(n));",
        "const ok = leaked.length === 0 && process.env.DATABASE_URL === 'postgres://fixture';",
        "process.stdout.write(JSON.stringify({ tests: [{ title: 'health @p0', status: ok ? 'passed' : 'failed' }], leaked }));",
      ].join("\n"),
      "utf8",
    );
    const vars = {
      FOO_TOKEN: "a",
      SENDGRID_APIKEY: "b",
      GH_PAT: "c",
      npm_config__authToken: "d",
      LEGION_TEST_PROVIDER_VAR: "e",
      DATABASE_URL: "postgres://fixture",
    };
    const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    try {
      const result = await runProjectQa({
        projectRoot: dir,
        spec,
        mode: "full",
        unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        secretEnvNames: ["LEGION_TEST_PROVIDER_VAR"],
        id: "qa-scrub",
        createdAt: "2026-09-01T12:00:00Z",
      });
      assert.deepEqual(result.warnings, []);
      const unit = JSON.parse(await readFile(join(dir, ".legion-cli", "qa", "unit.json"), "utf8"));
      assert.deepEqual(unit.leaked, []);
      assert.equal(unit.tests[0].status, "passed");
      assert.equal(result.score.buckets.p0.failed, 0);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
