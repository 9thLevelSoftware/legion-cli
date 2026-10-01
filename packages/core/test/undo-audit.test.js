import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LegionEngine } from "../dist/index.js";
import { appendChainedAuditLine, assertAuditChainUsable, verifyAuditChain } from "@9thlevelsoftware/legion-cli-persist";
import { specHasUi } from "@9thlevelsoftware/legion-cli-qa";
import {
  commitAll,
  git,
  initGitRepo,
  initProject,
  makeQaScore,
  makeTask,
  passingVerificationCommand,
  withEngine,
  withFakeAdapter,
  withReviewNotes,
  writeQaFile,
  writeTask,
} from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, "..", "..", "..", "skills");
const cliBin = join(here, "..", "..", "cli", "dist", "bin.js");

async function driveToPlanReady(engine, store, dir) {
  await engine.beginIntent();
  await engine.intentTurn(["Teammates who keep missing who's in the office.", "They ping five chat apps every morning."]);
  await engine.intentTurn(["People can tap in or out on their phone in under five seconds.", "No payroll, no badges, no calendar sync in v0."]);
  await engine.intentTurn(["existing auth"]);
  await engine.intentTurn(["Open the board, tap In, see yourself listed, tap Out, see yourself leave.", "Empty board, network error, changed mind."]);
  await engine.intentTurn(["board", "phone"]);
  await engine.intentTurn(["none", "none"]);
  await engine.confirmIntent({ id: "tester" });
  const proposed = await engine.startDiscuss();
  await engine.discuss(proposed.map((item) => ({ id: item.id, status: "accepted" })));
  const spec = await engine.draftSpec({ skipWireframes: true });
  await engine.approveSpec(spec.id, { id: "tester" }, { message: "looks right" });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
  await writeTask(
    store,
    makeTask({
      specId: spec.id,
      contract: {
        filesAllowed: ["src/main.ts"],
        expectedArtifacts: ["src/main.ts"],
        verificationCommands: [passingVerificationCommand()],
      },
    }),
  );
  await engine.plan(spec.id);
}

async function passingQaForActiveSpec(engine, store) {
  const state = await engine.getState();
  const spec = await store.readSpec(state.activeSpecId);
  const evidencePaths = [
    ".legion-cli/qa/runs/qa-1/unit.json",
    ".legion-cli/qa/runs/qa-1/unit.meta.json",
  ];
  if (specHasUi(spec.data)) {
    evidencePaths.push(
      ".legion-cli/qa/runs/qa-1/playwright.json",
      ".legion-cli/qa/runs/qa-1/playwright.meta.json",
    );
  }
  const score = makeQaScore({
    specId: spec.data.id,
    criteria: spec.data.acceptance.map(({ id, priority }) => ({ id, priority, outcome: "passed" })),
    evidencePaths,
  });
  await writeQaFile(store, score);
  return score;
}

function cli(dir, args) {
  const result = spawnSync(process.execPath, [cliBin, ...args, "--project", dir], {
    encoding: "utf8",
    env: { ...process.env, LEGION_CLI_ADAPTER: "fake" },
  });
  return { status: result.status, text: `${result.stdout}${result.stderr}` };
}

async function auditLines(dir) {
  const raw = await readFile(join(dir, ".legion-cli", "audit", "events.jsonl"), "utf8");
  return raw.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "");
}

for (const setup of ["tracked-before-ship", "older-baseline", "untracked-state", "audit-dir-ignored"]) {
  test(`undo of a ship commit keeps the audit log append-only and every verb usable (${setup})`, async () => {
    await withFakeAdapter(async () => {
      await withEngine(async ({ dir, engine, store }) => {
        await initProject(engine);
        await driveToPlanReady(engine, store, dir);
        initGitRepo(dir);
        if (setup === "untracked-state") {
          // .legion-cli is not tracked (the ship commit is the first to contain it): undo refuses.
          git(dir, ["rm", "-r", "--cached", "-q", ".legion-cli"]);
          git(dir, ["commit", "-m", "stop tracking legion state"]);
        }
        if (setup === "audit-dir-ignored") {
          // Only the audit directory is ignored: ship --commit succeeds with untracked audit files.
          await writeFile(join(dir, ".gitignore"), ".legion-cli/audit/\n.legion-cli/index/\n", "utf8");
          git(dir, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", ".legion-cli/index"]);
          git(dir, ["add", ".gitignore"]);
          git(dir, ["commit", "-m", "ignore the audit directory"]);
        }
        await engine.execute("auto");
        await new LegionEngine(dir, undefined, withReviewNotes({ skillsDir })).review();
        await engine.qa({ score: await passingQaForActiveSpec(engine, store) });
        if (setup === "tracked-before-ship" || setup === "audit-dir-ignored") commitAll(dir, "legion state before ship");
        await engine.ship({ commit: true });
        const beforeUndo = await auditLines(dir);

        if (setup === "untracked-state") {
          await assert.rejects(() => engine.undoLastTask(), /would remove/);
          assert.deepEqual((await auditLines(dir)).slice(0, beforeUndo.length), beforeUndo, "a refused undo only appends");
          await assertAuditChainUsable(dir);
          assert.doesNotMatch(cli(dir, ["status", "--plain"]).text, /audit chain/i);
          return;
        }
        await engine.undoLastTask();

        const after = await auditLines(dir);
        assert.deepEqual(after.slice(0, beforeUndo.length), beforeUndo, "undo never rewinds or edits the audit log");
        assert.equal(JSON.parse(after.at(-1)).type, "undo");
        await assertAuditChainUsable(dir);
        assert.equal((await verifyAuditChain(dir)).length, after.length);

        const status = cli(dir, ["status", "--plain"]);
        assert.doesNotMatch(status.text, /audit chain/i);
        const doctor = cli(dir, ["doctor"]);
        assert.doesNotMatch(doctor.text, /FAIL {2}audit chain/);
        assert.doesNotMatch(doctor.text, /rewind refused/);

        // A mutating verb must run on the reopened work.
        const run = await engine.execute("auto");
        assert.equal(run.status, "done");
        await assertAuditChainUsable(dir);
      });
    });
  });
}

test("a refused execute (audit chain) never leaves the task in_progress", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, engine, store }) => {
      await initProject(engine);
      await driveToPlanReady(engine, store, dir);
      initGitRepo(dir);
      // An old-format chain.json (no byteOffset) that claims one line more than the log has: the
      // cheap lock-entry check cannot see it, the append-time replay does.
      const chainPath = join(dir, ".legion-cli", "audit", "chain.json");
      await appendChainedAuditLine(dir, JSON.stringify({ type: "seed" }));
      const lines = await auditLines(dir);
      await mkdir(dirname(chainPath), { recursive: true });
      await writeFile(chainPath, `${JSON.stringify({ lastDigest: "0".repeat(64), length: lines.length + 1 })}\n`, "utf8");
      const before = await store.readTask("TSK-0001");
      await assert.rejects(() => engine.execute("auto"), /audit chain/);
      const after = await store.readTask("TSK-0001");
      assert.equal(after.data.status, before.data.status, "task status is untouched by the refusal");
      const state = await engine.getState();
      assert.equal(state.phase, "plan_ready", "phase is untouched by the refusal");
      assert.equal(state.currentTaskId, null);
    });
  });
});

test("every writer refuses on an untrusted audit chain before any state moves; readers and the rebaseline still work", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "done" }));
    await appendChainedAuditLine(dir, JSON.stringify({ type: "seed" }));
    // Old-format chain.json (no byteOffset) claiming one line more than the log has: the cheap
    // lock-entry check passes, only the append-time replay sees it.
    const chainPath = join(dir, ".legion-cli", "audit", "chain.json");
    const lines = await auditLines(dir);
    await writeFile(chainPath, `${JSON.stringify({ lastDigest: "0".repeat(64), length: lines.length + 1 })}\n`, "utf8");
    const phase = (await engine.getState()).phase;
    const taskBefore = (await store.readTask("TSK-0001")).data.status;
    const eventsBefore = await auditLines(dir);

    await assert.rejects(() => engine.beginIntent(), /audit chain/);
    await assert.rejects(() => engine.undoLastTask(), /audit chain/);
    assert.equal((await engine.getState()).phase, phase, "phase did not move");
    assert.equal((await store.readTask("TSK-0001")).data.status, taskBefore, "task status did not move");
    assert.deepEqual((await auditLines(dir)).slice(0, eventsBefore.length), eventsBefore);

    // Read entries do not throw from this check.
    assert.ok(await engine.getState());
    const status = cli(dir, ["status", "--plain"]);
    assert.match(status.text, /audit chain/i, "status reports the problem instead of crashing");
    const doctor = cli(dir, ["doctor"]);
    assert.match(doctor.text, /audit chain/i);

    const fixed = cli(dir, ["doctor", "--rebaseline-audit"]);
    assert.match(fixed.text, /re-baselined/);
    await engine.beginIntent();
    assert.notEqual((await engine.getState()).phase, phase, "the same verb works after the rebaseline");
  });
});

test("task recover refuses on an untrusted audit chain before the task moves", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeTask(store, makeTask({ id: "TSK-0001", status: "verifying" }));
    await appendChainedAuditLine(dir, JSON.stringify({ type: "seed" }));
    const chainPath = join(dir, ".legion-cli", "audit", "chain.json");
    const lines = await auditLines(dir);
    await writeFile(chainPath, `${JSON.stringify({ lastDigest: "0".repeat(64), length: lines.length + 1 })}\n`, "utf8");
    await assert.rejects(() => engine.recoverTask("TSK-0001"), /audit chain/);
    assert.equal((await store.readTask("TSK-0001")).data.status, "verifying");
  });
});
