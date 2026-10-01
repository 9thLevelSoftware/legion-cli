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
    assert.match(
      await readFile(join(dir, ".legion-cli", "qa", "runs", "qa-nostart", "unit.json"), "utf8"),
      /not found on PATH/,
    );
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
        "process.stdout.write(JSON.stringify({ tests: [{ title: 'health @p0 @ac(AC-01)', status: ok ? 'passed' : 'failed' }], leaked }));",
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
      const unit = JSON.parse(
        await readFile(join(dir, ".legion-cli", "qa", "runs", "qa-scrub", "unit.json"), "utf8"),
      );
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

test("nonzero unit exit blocks an all-passing JSON report", async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "unit-nonzero.js");
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({tests:[{title:'health @ac(AC-01)',status:'passed'}]}));process.exitCode=7;`,
      "utf8",
    );
    const result = await runProjectQa({
      projectRoot: dir,
      spec,
      mode: "full",
      unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      id: "qa-unit-nonzero",
    });
    assert.equal(result.score.criteria[0].outcome, "passed");
    assert.ok(result.score.reportFailures > 0);
    assert.equal(result.score.pass, false);
    assert.ok(
      result.warnings.some((line) => /unit command exited with code 7 without a report of failed tests/.test(line)),
      result.warnings.join("\n"),
    );
  });
});

test("nonzero unit exit with a reported failure adds no redundant runner warning", async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "unit-failed.js");
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({tests:[{title:'health @ac(AC-01)',status:'failed'}]}));process.exitCode=1;`,
      "utf8",
    );
    const result = await runProjectQa({
      projectRoot: dir,
      spec,
      mode: "full",
      unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      id: "qa-unit-failed",
    });
    assert.equal(result.score.pass, false);
    assert.deepEqual(result.warnings, []);
  });
});

test("unit command killed by a signal fails closed", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "unit-signal.js");
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({tests:[{title:'health @ac(AC-01)',status:'passed'}]}));process.kill(process.pid,'SIGKILL');`,
      "utf8",
    );
    const result = await runProjectQa({
      projectRoot: dir,
      spec,
      mode: "full",
      unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      id: "qa-unit-signal",
    });
    assert.equal(result.score.pass, false);
    assert.ok(result.warnings.some((line) => /killed by a signal/.test(line)), result.warnings.join("\n"));
  });
});

test("timed-out unit command blocks partial passing JSON", async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "unit-timeout.js");
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({tests:[{title:'health @ac(AC-01)',status:'passed'}]}));setInterval(()=>{},1000);`,
      "utf8",
    );
    const result = await runProjectQa({
      projectRoot: dir,
      spec,
      mode: "full",
      unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      commandTimeoutMs: 300,
      id: "qa-unit-timeout-json",
    });
    assert.ok(result.score.reportFailures > 0);
    assert.equal(result.score.pass, false);
    assert.deepEqual(result.warnings, ["unit command timed out after 300 ms and was stopped"]);
  });
});

test("nonzero Playwright exit blocks all-passing JSON", async () => {
  await withTempDir(async (dir) => {
    const unit = join(dir, "unit-pass.js");
    const playwright = join(dir, "playwright-nonzero.js");
    const payload = `JSON.stringify({tests:[{title:'health @ac(AC-01)',status:'passed'}]})`;
    await writeFile(unit, `process.stdout.write(${payload});`, "utf8");
    await writeFile(playwright, `process.stdout.write(${payload});process.exitCode=9;`, "utf8");
    const result = await runProjectQa({
      projectRoot: dir,
      spec: { ...spec, wireframesIndex: "wireframes/INDEX.html" },
      mode: "full",
      unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(unit)}`,
      playwrightCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(playwright)}`,
      id: "qa-playwright-nonzero",
    });
    assert.ok(result.score.reportFailures > 0);
    assert.equal(result.score.pass, false);
    assert.ok(
      result.warnings.some((line) => /playwright command exited with code 9 without a report of failed tests/.test(line)),
      result.warnings.join("\n"),
    );
  });
});

test("timed-out Playwright command blocks partial passing JSON", async () => {
  await withTempDir(async (dir) => {
    const unit = join(dir, "unit-pass.js");
    const playwright = join(dir, "playwright-timeout.js");
    const payload = `JSON.stringify({tests:[{title:'health @ac(AC-01)',status:'passed'}]})`;
    await writeFile(unit, `process.stdout.write(${payload});`, "utf8");
    await writeFile(playwright, `process.stdout.write(${payload});setInterval(()=>{},1000);`, "utf8");
    const result = await runProjectQa({
      projectRoot: dir,
      spec: { ...spec, wireframesIndex: "wireframes/INDEX.html" },
      mode: "full",
      unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(unit)}`,
      playwrightCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(playwright)}`,
      commandTimeoutMs: 300,
      id: "qa-playwright-timeout",
    });
    assert.ok(result.score.reportFailures > 0);
    assert.equal(result.score.pass, false);
  });
});

test("each QA run keeps its own evidence instead of overwriting a shared report", async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "emit.js");
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({tests:[{title:'health @ac(AC-01)',status:'passed'}]}))`,
      "utf8",
    );
    const base = {
      projectRoot: dir,
      spec,
      mode: "full",
      unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      createdAt: "2026-09-30T12:00:00Z",
      specHash: "a".repeat(64),
      sourceHash: "b".repeat(64),
    };
    const first = await runProjectQa({ ...base, id: "qa-first" });
    const second = await runProjectQa({ ...base, id: "qa-second" });
    assert.deepEqual(first.evidencePaths, [
      ".legion-cli/qa/runs/qa-first/unit.json",
      ".legion-cli/qa/runs/qa-first/unit.meta.json",
    ]);
    assert.deepEqual(second.evidencePaths, [
      ".legion-cli/qa/runs/qa-second/unit.json",
      ".legion-cli/qa/runs/qa-second/unit.meta.json",
    ]);
    assert.equal(JSON.parse(await readFile(join(dir, first.evidencePaths[0]), "utf8")).tests.length, 1);
    assert.equal(JSON.parse(await readFile(join(dir, second.evidencePaths[0]), "utf8")).tests.length, 1);
  });
});

test("rapid QA runs allocate distinct UUID-bearing evidence directories", async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "emit.js");
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({tests:[{title:'health @ac(AC-01)',status:'passed'}]}))`,
      "utf8",
    );
    const opts = {
      projectRoot: dir,
      spec,
      mode: "full",
      unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
    };
    const [first, second] = await Promise.all([runProjectQa(opts), runProjectQa(opts)]);
    assert.notEqual(first.score.id, second.score.id);
    assert.match(first.score.id, /^qa-[a-z0-9]+-[a-f0-9]{8}$/);
    assert.match(second.score.id, /^qa-[a-z0-9]+-[a-f0-9]{8}$/);
    assert.notEqual(first.evidencePaths[0], second.evidencePaths[0]);
    await readFile(join(dir, first.evidencePaths[0]), "utf8");
    await readFile(join(dir, second.evidencePaths[0]), "utf8");
  });
});
