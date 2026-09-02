import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { normalize, runCli, withTempDir } from "./helpers.js";

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function initGitRepo(dir) {
  git(dir, ["init"]);
  git(dir, ["config", "user.name", "9thLevelSoftware"]);
  git(dir, ["config", "user.email", "engineering@9thlevelsoftware.com"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
}

async function seedReadyToShip(dir, extra = {}) {
  const engine = createLegionEngine(dir);
  await engine.init({ name: "Checkin", adapter: "fake" });
  await engine.store.writeSpec(
    {
      schemaVersion: "legion-cli-spec/v1",
      id: "spec-checkin",
      title: "Office check-in",
      status: "frozen",
      mustBeTrue: ["People can tap in or out on their phone in under five seconds"],
      mustNotChange: ["auth"],
      outOfScope: ["payroll"],
      acceptance: [
        {
          id: "AC-01",
          statement: "Tap in or out on a phone completes in under five seconds",
          kind: "behavior",
          priority: "P0",
        },
      ],
      personas: ["teammates"],
      happyPath: "Open the board, tap In.",
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
      phase: extra.phase ?? "ready_to_ship",
      activeSpecId: "spec-checkin",
      lastReadiness: "PASS",
      lastReview: "PASS",
      lastQaId: "qa-1",
    },
    state.body,
  );
  await engine.store.writeTask(
    {
      schemaVersion: "legion-cli-task/v1",
      id: "TSK-0001",
      title: "in/out button",
      status: "done",
      type: "feature",
      priority: "P0",
      specId: "spec-checkin",
      blockedBy: [],
      blocks: [],
      assignee: "agent",
      notes: "keep this body",
      contract: {
        filesAllowed: ["src/main.ts"],
        filesForbidden: [".git/**"],
        expectedArtifacts: ["src/main.ts"],
        verificationCommands: ["pnpm test"],
        maxFilesTouched: 20,
      },
    },
    "Task body stays.\n",
  );
  await mkdir(join(engine.store.paths.qaDir, "scores"), { recursive: true });
  await writeFile(
    join(engine.store.paths.qaDir, "scores", "qa-1.json"),
    `${JSON.stringify(
      extra.score ?? {
        schemaVersion: "legion-cli-qa/v1",
        id: "qa-1",
        specId: "spec-checkin",
        mode: "full",
        buckets: {
          p0: { points: 40, max: 40, failed: 0 },
          p1: { points: 27, max: 30, passRate: 0.9 },
          p2: { points: 12, max: 15, passRate: 0.8 },
          visual: { points: 15, max: 15, regressions: 0 },
        },
        total: 94,
        pass: true,
        evidencePaths: [".legion-cli/qa/scores/qa-1.json"],
        createdAt: "2026-09-01T12:00:00Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
  return engine;
}

test("ship stages, asks Y/n, writes receipt, and does not compact tasks", async () => {
  await withTempDir(async (dir) => {
    await seedReadyToShip(dir);
    initGitRepo(dir);
    await writeFile(join(dir, "src", "main.ts"), "export const shipped = true;\n", "utf8");
    const result = runCli(["ship", "--project", dir], { input: "y\n" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /Staged:/);
    assert.match(out, /Unrelated files unchanged:/);
    assert.match(out, /Acceptance criteria met\?/);
    assert.match(out, /Ship receipt written/);
    const receipt = await readFile(join(dir, ".legion-cli", "audit", "ship-spec-checkin.md"), "utf8");
    assert.match(receipt, /qa\.mode: full/);
    assert.match(receipt, /qa\.total: 94/);
    const events = await readFile(join(dir, ".legion-cli", "audit", "events.jsonl"), "utf8");
    assert.match(events, /"type":"ship"/);
    const task = await readFile(join(dir, ".legion-cli", "tasks", "TSK-0001.md"), "utf8");
    assert.match(task, /keep this body/);
    assert.match(task, /Task body stays/);
    assert.match(task, /status: done/);
  });
});

test("ship n cancels without shipping", async () => {
  await withTempDir(async (dir) => {
    await seedReadyToShip(dir);
    initGitRepo(dir);
    const result = runCli(["ship", "--project", dir], { input: "n\n" });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(normalize(`${result.stdout}\n${result.stderr}`), /cancelled/);
    const state = await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8");
    assert.match(state, /phase: ready_to_ship/);
  });
});

test("ship --commit after Y creates a commit", async () => {
  await withTempDir(async (dir) => {
    await seedReadyToShip(dir);
    initGitRepo(dir);
    await writeFile(join(dir, "src", "main.ts"), "export const shipped = true;\n", "utf8");
    const result = runCli(["ship", "--project", dir, "--commit"], { input: "Y\n" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const msg = git(dir, ["log", "-1", "--pretty=%s"]);
    assert.match(msg, /legion-cli ship: spec-checkin/);
  });
});

test("abandon --message writes audit and stops the spec", async () => {
  await withTempDir(async (dir) => {
    await seedReadyToShip(dir);
    const result = runCli(["abandon", "--project", dir, "--message", "not this increment"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(normalize(result.stdout), /Spec abandoned/);
    const state = await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8");
    assert.match(state, /phase: abandoned/);
    const events = await readFile(join(dir, ".legion-cli", "audit", "events.jsonl"), "utf8");
    assert.match(events, /"type":"abandon"/);
    assert.match(events, /not this increment/);
  });
});

test("spec new after ship starts the next increment", async () => {
  await withTempDir(async (dir) => {
    await seedReadyToShip(dir);
    const ship = runCli(["ship", "--project", dir, "--json"], { input: "y\n" });
    assert.equal(ship.status, 0, `${ship.stdout}\n${ship.stderr}`);
    const next = runCli(["spec", "new", "--project", dir, "--json"]);
    assert.equal(next.status, 0, `${next.stdout}\n${next.stderr}`);
    assert.match(normalize(next.stdout), /intent_draft/);
    const spec = await readFile(join(dir, ".legion-cli", "specs", "spec-checkin", "SPEC.md"), "utf8");
    assert.match(spec, /status: superseded/);
  });
});
