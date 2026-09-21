import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { controlProjectDirPath, ownProcessStartedAt, processIdentity } from "@9thlevelsoftware/legion-cli-persist";
import { LegionRefuseError, serializeProtectedSnapshot, snapshotProtected } from "../dist/index.js";
import {
  commitAll,
  controlDir,
  ensureGitRepo,
  gitHead,
  initProject,
  makeTask,
  passingVerificationCommand,
  patchState,
  seedPlanReady,
  spawnSleeper,
  withEngine,
  withFakeAdapter,
} from "./helpers.js";

const MINUTE = 60 * 1000;

/** A pid that existed and is gone: the crashed engine of the run under test. */
async function deadPid() {
  const sleeper = spawnSleeper();
  await sleeper.stop();
  return sleeper.pid;
}

function sha256(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * Write the control records a crashed run leaves behind: the resume record, the persisted P
 * snapshot, the tree manifest and its pre-spawn backups. No live marker and no `finished`
 * tombstone — that is exactly what a killed engine looks like.
 */
async function seedCrashedRun(dir, opts) {
  const runId = opts.runId ?? "execute-crashed-1";
  const control = controlDir(dir, runId);
  await mkdir(join(control, "pre"), { recursive: true });
  await writeFile(
    join(control, "resume.json"),
    `${JSON.stringify({
      schemaVersion: "legion-cli-resume/v1",
      runId,
      taskId: opts.taskId ?? "TSK-0001",
      skillId: "execute",
      preSpawnRef: opts.preSpawnRef ?? "UNBORN",
      startedAt: new Date(Date.now() - MINUTE).toISOString(),
      timeoutMs: 20 * MINUTE,
      pid: opts.agentPid ?? null,
      ...(opts.agentPidStartedAt !== undefined ? { agentPidStartedAt: opts.agentPidStartedAt } : {}),
      enginePid: opts.enginePid,
      engineStartedAt: opts.engineStartedAt ?? Date.now() - MINUTE,
      adapterId: "fake",
    })}\n`,
    "utf8",
  );
  if (opts.protectedSnapshot) {
    await writeFile(join(control, "protected-snapshot.json"), opts.protectedSnapshot, "utf8");
  }
  if (opts.manifestEntries) {
    await writeFile(
      join(control, "tree-manifest.json"),
      `${JSON.stringify({
        runId,
        projectRoot: dir,
        preSpawnRef: opts.preSpawnRef ?? null,
        takenAt: new Date().toISOString(),
        backupBytes: 0,
        unprotected: [],
        entries: opts.manifestEntries,
      })}\n`,
      "utf8",
    );
  }
  return { runId, control };
}

test("a crashed run is replayed on the next verb: out-of-contract and P files are quarantined and restored, and the task is blocked", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedPlanReady(store, { phase: "executing", task: { status: "in_progress" } });
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "main.ts"), "export const original = 1;\n", "utf8");
      await writeFile(join(dir, "local.env"), "TOKEN=original\n", "utf8");
      ensureGitRepo(dir);
      commitAll(dir, "seed src");
      const head = gitHead(dir);

      // The run had started: STATE names it, and the P snapshot was taken.
      const runId = "execute-crashed-1";
      await patchState(store, { activeRun: { runId, taskId: "TSK-0001" }, currentTaskId: "TSK-0001" });
      const snapshot = serializeProtectedSnapshot(await snapshotProtected(dir));
      const { control } = await seedCrashedRun(dir, {
        runId,
        enginePid: await deadPid(),
        preSpawnRef: head,
        protectedSnapshot: snapshot,
        manifestEntries: [
          { path: "src/main.ts", cls: "tracked-clean", restoreFrom: "git" },
          { path: "local.env", cls: "untracked", restoreFrom: "backup" },
        ],
      });
      const backup = join(control, "pre", "0001.bin");
      const manifestPath = join(control, "tree-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const envEntry = manifest.entries.find((entry) => entry.path === "local.env");
      if (envEntry) envEntry.backup = backup;
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
      await writeFile(backup, "TOKEN=original\n", "utf8");

      // Then the agent wrote, and the engine was killed before the finish.
      await writeFile(join(dir, "src", "main.ts"), "export const agent = 'wrote this';\n", "utf8");
      await writeFile(join(dir, "local.env"), "TOKEN=stolen\n", "utf8");
      await writeFile(join(dir, ".legion-cli", "wiki", "README.md"), "agent rewrote the wiki\n", "utf8");

      await engine.recoverStaleInProgress();

      assert.equal(
        (await readFile(join(dir, "src", "main.ts"), "utf8")).replace(/\r\n/g, "\n"),
        "export const original = 1;\n",
      );
      assert.equal(
        (await readFile(join(dir, "local.env"), "utf8")).replace(/\r\n/g, "\n"),
        "TOKEN=original\n",
      );
      assert.match(await readFile(join(dir, ".legion-cli", "wiki", "README.md"), "utf8"), /^(?!agent rewrote)/);
      assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
      const state = await engine.getState();
      assert.notEqual(state.lastReview, "PASS");
      assert.equal(state.activeRun ?? null, null);
      const audit = await readFile(join(dir, ".legion-cli", "audit", "events.jsonl"), "utf8");
      assert.match(audit, /"type":"run_replayed"/);
      assert.match(audit, /an interrupted run was reverted/);
      // The pre-spawn backups are plaintext copies of ignored files; the replay drops them.
      assert.equal(existsSync(join(control, "pre")), false);
    });
  });
});

test("R-21: a forged lastReview PASS in the persisted snapshot does not survive the replay", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedPlanReady(store, { phase: "executing", task: { status: "in_progress" } });
      ensureGitRepo(dir);
      const runId = "execute-crashed-2";
      await patchState(store, { activeRun: { runId, taskId: "TSK-0001" }, currentTaskId: "TSK-0001" });

      const raw = JSON.parse(serializeProtectedSnapshot(await snapshotProtected(dir)));
      const scope = raw.scopes[0];
      const entry = scope.entries.find(([rel]) => rel === ".legion-cli/STATE.md");
      assert.ok(entry, "STATE.md is in the protected set");
      const forged = Buffer.from(entry[1].b64, "base64")
        .toString("utf8")
        .replace(/lastReview: .*/m, "lastReview: PASS");
      assert.match(forged, /lastReview: PASS/);
      entry[1].b64 = Buffer.from(forged, "utf8").toString("base64");
      entry[1].size = Buffer.byteLength(forged, "utf8");
      entry[1].sha256 = sha256(forged);

      await seedCrashedRun(dir, {
        runId,
        enginePid: await deadPid(),
        protectedSnapshot: JSON.stringify(raw),
      });

      await engine.recoverStaleInProgress();

      // The forged bytes were restored, and then the replay failed the review anyway.
      const state = await engine.getState();
      assert.notEqual(state.lastReview, "PASS");
      assert.equal(state.lastReview, "FAIL");
      assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
    });
  });
});

test("a run whose engine PID is alive but started after the record is dead, and its process is not killed", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedPlanReady(store, { phase: "executing", task: { status: "in_progress" } });
      ensureGitRepo(dir);
      const sleeper = spawnSleeper();
      try {
        const runId = "execute-reused-pid";
        await patchState(store, { activeRun: { runId, taskId: "TSK-0001" } });
        await seedCrashedRun(dir, {
          runId,
          enginePid: sleeper.pid,
          // Recorded long before this process started: the PID has been reused since.
          engineStartedAt: Date.now() - 6 * 60 * MINUTE,
          agentPid: sleeper.pid,
          agentPidStartedAt: Date.now() - 6 * 60 * MINUTE,
          protectedSnapshot: serializeProtectedSnapshot(await snapshotProtected(dir)),
        });

        // The freeze does not hold (the recorded engine is gone) and the replay still runs...
        await engine.recoverStaleInProgress();
        assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
        // ...but the process that happens to hold that PID now is untouched.
        assert.equal(sleeper.alive(), true);
      } finally {
        await sleeper.stop();
      }
    });
  });
});

test("a live marker older than its timeout plus the grace no longer freezes writes", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedPlanReady(store);
      const sleeper = spawnSleeper();
      try {
        const runId = "execute-aged-out";
        const control = controlDir(dir, runId);
        await mkdir(control, { recursive: true });
        const sleeperStartedAt = await processIdentity(sleeper.pid);
        assert.ok(typeof sleeperStartedAt === "number");
        const marker = {
          runId,
          skillId: "execute",
          enginePid: sleeper.pid,
          engineStartedAt: sleeperStartedAt,
          startedAt: new Date(Date.now() - 26 * MINUTE).toISOString(),
          timeoutMs: 20 * MINUTE,
        };
        await writeFile(join(control, "live.json"), `${JSON.stringify(marker)}\n`, "utf8");
        // 26 minutes old with a 20-minute timeout and a 5-minute grace: dead, live PID or not.
        assert.equal(await engine.liveAgentRun(), null);

        const fresh = { ...marker, startedAt: new Date().toISOString() };
        await writeFile(join(control, "live.json"), `${JSON.stringify(fresh)}\n`, "utf8");
        const live = await engine.liveAgentRun();
        assert.equal(live?.state, "live");
      } finally {
        await sleeper.stop();
      }
    });
  });
});

test("doctor --clear-stale-run replays a corrupted record, and refuses while a matching process is alive", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedPlanReady(store, { phase: "executing", task: { status: "in_progress" } });
      ensureGitRepo(dir);
      const runId = "execute-corrupt-1";
      await patchState(store, { activeRun: { runId, taskId: "TSK-0001" } });
      const { control } = await seedCrashedRun(dir, {
        runId,
        enginePid: process.pid,
        engineStartedAt: ownProcessStartedAt(),
        protectedSnapshot: serializeProtectedSnapshot(await snapshotProtected(dir)),
      });
      // A control record that cannot be read counts as LIVE: the freeze fails closed (KD-2).
      await writeFile(join(control, "live.json"), "{ this is not json\n", "utf8");
      const frozen = await engine.liveAgentRun();
      assert.equal(frozen?.state, "unreadable");
      await assert.rejects(
        () => engine.fileTicket({ title: "blocked by the freeze" }),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /agent run/);
          return true;
        },
      );

      const sleeper = spawnSleeper();
      try {
        // While the recorded engine is really alive, the override refuses.
        const sleeperStartedAt = await processIdentity(sleeper.pid);
        assert.ok(typeof sleeperStartedAt === "number");
        await writeFile(
          join(control, "resume.json"),
          (await readFile(join(control, "resume.json"), "utf8"))
            .replace(/"enginePid":\d+/, `"enginePid":${sleeper.pid}`)
            .replace(/"engineStartedAt":[0-9.]+/, `"engineStartedAt":${sleeperStartedAt}`),
          "utf8",
        );
        await assert.rejects(
          () => engine.clearStaleRun(),
          (err) => {
            assert.equal(err instanceof LegionRefuseError, true);
            assert.match(err.message, /still running/);
            return true;
          },
        );
      } finally {
        await sleeper.stop();
      }

      // With nothing alive, it replays the run and unblocks writes.
      const dead = await deadPid();
      await writeFile(
        join(control, "resume.json"),
        (await readFile(join(control, "resume.json"), "utf8")).replace(/"enginePid":\d+/, `"enginePid":${dead}`),
        "utf8",
      );
      const cleared = await engine.clearStaleRun();
      assert.equal(cleared.runId, runId);
      assert.equal(await engine.liveAgentRun(), null);
      assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
      const audit = await readFile(join(dir, ".legion-cli", "audit", "events.jsonl"), "utf8");
      assert.match(audit, /"type":"stale_run_cleared"/);
      const ticket = await engine.fileTicket({ title: "writes work again" });
      assert.ok(ticket.id);
    });
  });
});

test("a finished run's control dir clears STATE.activeRun without a replay", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedPlanReady(store, {
        phase: "executing",
        task: { status: "ready", contract: { verificationCommands: [passingVerificationCommand()] } },
        extraTasks: [makeTask({ id: "TSK-0002", status: "ready", contract: { filesAllowed: ["src/two.ts"], expectedArtifacts: ["src/two.ts"] } })],
      });
      ensureGitRepo(dir);
      const result = await engine.execute("TSK-0001");
      assert.equal(result.status, "done");
      // A clean finish takes its control dir with it and leaves no activeRun behind.
      assert.equal((await engine.getState()).activeRun ?? null, null);
      const runs = await readdir(controlProjectDirPath(dir)).catch(() => []);
      assert.equal(runs.length, 0);
      assert.equal((await store.readTask("TSK-0001")).data.status, "done");
    });
  });
});
