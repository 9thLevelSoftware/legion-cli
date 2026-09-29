import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("qa evidence writes take the store lock; the command run does not", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "run.ts"), "utf8");
  const writeEvidence = src.slice(src.indexOf("async function writeEvidence"), src.indexOf("export async function runProjectQa"));
  assert.match(writeEvidence, /createLegionStore\([^)]*\)\.withLock/);
  assert.match(writeEvidence, /writeTextFile/);
  const runBody = src.slice(src.indexOf("export async function runProjectQa"));
  const commandRegion = runBody.slice(0, runBody.indexOf("writeEvidence"));
  assert.doesNotMatch(commandRegion, /withLock/);
});

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

async function scriptedUnit(dir, body) {
  const script = join(dir, "runner.js");
  await writeFile(script, body, "utf8");
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}

const allPassReport = `process.stdout.write(JSON.stringify({ tests: [
  { title: 'health @p0', status: 'passed' },
  { title: 'list @p1', status: 'passed' },
] }));`;

test("a runner that exits 1 with an all-pass report is scored failed", async () => {
  await withTempDir(async (dir) => {
    const unitCommand = await scriptedUnit(dir, `${allPassReport}\nprocess.exit(1);`);
    const result = await runProjectQa({ projectRoot: dir, spec, mode: "full", unitCommand, id: "qa-exit1" });
    assert.equal(result.score.pass, false);
    assert.ok(result.score.buckets.p0.failed >= 1);
    assert.equal(result.score.buckets.p0.points, 0);
    assert.ok(result.warnings.some((line) => /unit command exited with code 1 without a report of failed tests/.test(line)));
  });
});

test("a runner that exits 0 with the same report still passes", async () => {
  await withTempDir(async (dir) => {
    const unitCommand = await scriptedUnit(dir, allPassReport);
    const result = await runProjectQa({ projectRoot: dir, spec, mode: "full", unitCommand, id: "qa-exit0" });
    assert.equal(result.score.pass, true);
    assert.deepEqual(result.warnings, []);
  });
});

test("a plain non-zero exit whose report lists failed tests adds no extra warning", async () => {
  await withTempDir(async (dir) => {
    const unitCommand = await scriptedUnit(
      dir,
      `process.stdout.write(JSON.stringify({ tests: [{ title: 'health @p0', status: 'failed' }] }));\nprocess.exit(1);`,
    );
    const result = await runProjectQa({ projectRoot: dir, spec, mode: "full", unitCommand, id: "qa-counted" });
    assert.equal(result.score.pass, false);
    assert.deepEqual(result.warnings, []);
  });
});

test("a timeout with a partial all-pass report is scored failed", async () => {
  await withTempDir(async (dir) => {
    const unitCommand = await scriptedUnit(dir, `${allPassReport}\nsetInterval(() => {}, 1000);`);
    const result = await runProjectQa({
      projectRoot: dir,
      spec,
      mode: "full",
      unitCommand,
      commandTimeoutMs: 1500,
      id: "qa-partial-timeout",
    });
    assert.ok(result.warnings.some((line) => /timed out after 1500 ms/.test(line)));
    assert.equal(result.score.pass, false);
    assert.ok(result.score.buckets.p0.failed >= 1);
  });
});

test("an untagged suite with P0 criteria warns by name and still scores as before", async () => {
  await withTempDir(async (dir) => {
    const unitCommand = await scriptedUnit(
      dir,
      `process.stdout.write(JSON.stringify({ tests: [
        { title: 'health', status: 'passed' },
        { title: 'list', status: 'passed' },
      ] }));`,
    );
    const result = await runProjectQa({ projectRoot: dir, spec, mode: "full", unitCommand, id: "qa-untagged" });
    assert.deepEqual(result.warnings, [
      "spec has P0 acceptance criteria but no test is tagged @p0; untagged tests are scored P1 and do not fail the P0 gate",
    ]);
    assert.equal(result.score.pass, true);
  });
});
