import assert from "node:assert/strict";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { normalize, runCli, withTempDir } from "./helpers.js";

function quoteArg(value) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function unitCommand(payload) {
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`;
  return `${quoteArg(process.execPath)} -e ${quoteArg(script)}`;
}

async function seedQaReady(dir, extra = {}) {
  const engine = createLegionEngine(dir);
  await engine.init({ name: "Checkin", adapter: "fake" });
  await engine.store.writeSpec(
    {
      schemaVersion: "legion-cli-spec/v1",
      id: "spec-checkin",
      title: "Office check-in",
      status: "frozen",
      mustBeTrue: ["API returns 200 for health"],
      mustNotChange: ["auth"],
      outOfScope: ["payroll"],
      acceptance: [
        {
          id: "AC-01",
          statement: extra.ac ?? "API returns 200 for health",
          kind: "test",
          priority: "P0",
        },
      ],
      personas: ["teammates"],
      happyPath: "Call health, see 200.",
      wireframesIndex: null,
      frozenAt: "2026-09-01T12:00:00.000Z",
      frozenBy: "tester",
    },
    "Spec body.\n",
  );
  const project = await engine.store.readProject();
  await engine.store.writeProject({ ...project.data, activeSpecId: "spec-checkin" }, project.body);
  const state = await engine.store.readState();
  await engine.store.writeState(
    {
      ...state.data,
      phase: "executing",
      activeSpecId: "spec-checkin",
      lastReadiness: "PASS",
      lastReview: "PASS",
    },
    state.body,
  );
  await engine.store.writeTask(
    {
      schemaVersion: "legion-cli-task/v1",
      id: "TSK-0001",
      title: "health endpoint",
      status: "done",
      type: "feature",
      priority: "P0",
      specId: "spec-checkin",
      blockedBy: [],
      blocks: [],
      assignee: "agent",
      notes: "",
      contract: {
        filesAllowed: ["src/health.ts"],
        filesForbidden: [".git/**"],
        expectedArtifacts: ["src/health.ts"],
        verificationCommands: ["pnpm test"],
        maxFilesTouched: 20,
      },
    },
    "Health endpoint.\n",
  );
  const config = await engine.store.readConfig();
  await engine.store.writeConfig({
    ...config,
    qa: {
      ...config.qa,
      unitCommand: extra.unitCommand ?? unitCommand({ tests: [{ title: "health @p0", status: "passed" }] }),
    },
  });
  return engine;
}

test("qa scores in-process JSON and prints the visual bucket", async () => {
  await withTempDir(async (dir) => {
    await seedQaReady(dir, {
      unitCommand: unitCommand({
        tests: [
          { title: "health @p0", status: "passed" },
          { title: "lists @p1", status: "passed" },
          { title: "optional @p2", status: "passed" },
        ],
      }),
    });
    const result = runCli(["qa", "--project", dir]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /QA score 100/);
    assert.match(out, /visual 15\/15, regressions 0/);
    assert.match(out, /PASS\. Next: legion-cli ship/);
  });
});

test("qa --mode no-browser requires checklist and cannot pass", async () => {
  await withTempDir(async (dir) => {
    await seedQaReady(dir);
    const refused = runCli(["qa", "--mode", "no-browser", "--project", dir]);
    assert.equal(refused.status, 1);
    assert.match(normalize(refused.stderr), /qa checklist/);

    const ticks = runCli(["qa", "checklist", "--tick", "AC-01", "--project", dir]);
    assert.equal(ticks.status, 0, `${ticks.stdout}\n${ticks.stderr}`);
    assert.match(normalize(ticks.stdout), /Checklist saved/);

    const scored = runCli(["qa", "--mode", "no-browser", "--project", dir]);
    assert.equal(scored.status, 1, `${scored.stdout}\n${scored.stderr}`);
    const out = normalize(scored.stdout);
    assert.match(out, /QA score 70/);
    assert.match(out, /FAIL \(no-browser, cap 70\)/);
    assert.match(out, /--allow-degraded-qa/);
  });
});

test("help lists qa and fix", () => {
  const all = runCli(["help", "--all"]);
  assert.equal(all.status, 0, all.stderr);
  const out = normalize(all.stdout);
  assert.match(out, /legion-cli qa/);
  assert.match(out, /legion-cli qa checklist/);
  assert.match(out, /legion-cli fix/);
  const qa = runCli(["help", "qa"]);
  assert.match(normalize(qa.stdout), /mode/);
  const fix = runCli(["help", "fix"]);
  assert.match(normalize(fix.stdout), /bug/);
});
