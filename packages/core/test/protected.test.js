// PR 4 revert matrix (KD-1, KD-2, KD-15): `.legion-cli/` is uncommitted (the helper default),
// so nothing here relies on git to notice a forged engine file.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  rmdir,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  controlProjectDirPath,
  quarantineRootPath,
  readAuditEvents,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  LegionEngine,
  LegionRefuseError,
  listRetainedQuarantines,
  restoreProtected,
  snapshotProtected,
} from "../dist/index.js";
import { finishStartedSpawn } from "../dist/spawn.js";
import { moveFileNoOverwrite } from "../dist/quarantine.js";
import {
  git,
  holdPaths,
  initProject,
  makeTask,
  passingVerificationCommand,
  seedFrozenSpec,
  seedPlanReady,
  spawnSleeper,
  withEngine,
  withFakeAdapter,
  writeControlRecords,
} from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, "..", "..", "..", "skills");
const freezeProbe = join(here, "fixtures", "freeze-probe.js");

function taskMarkdown(task) {
  return [
    "---",
    "schemaVersion: legion-cli-task/v1",
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `type: ${task.type}`,
    `priority: ${task.priority}`,
    `specId: ${task.specId}`,
    "blockedBy: []",
    "blocks: []",
    "contract:",
    "  filesAllowed:",
    ...task.contract.filesAllowed.map((path) => `    - ${path}`),
    "  filesForbidden:",
    "    - .git/**",
    "  expectedArtifacts:",
    ...task.contract.expectedArtifacts.map((path) => `    - ${path}`),
    "  verificationCommands:",
    ...task.contract.verificationCommands.map((cmd) => `    - ${JSON.stringify(cmd)}`),
    "assignee: agent",
    'notes: ""',
    "---",
    "",
    `${task.title}.`,
    "",
  ].join("\n");
}

async function waitUntil(predicate, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Engine writes attempted from a real second process (KD-2 liveness comes from disk there). */
function runFreezeProbe(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [freezeProbe, dir], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr))));
  });
}

async function seedExecute(store, opts = {}) {
  return seedPlanReady(store, {
    task: {
      contract: {
        filesAllowed: ["src/main.ts"],
        expectedArtifacts: ["src/main.ts"],
        verificationCommands: [passingVerificationCommand()],
      },
    },
    ...opts,
  });
}

/** A review-ready slice: one done task, phase executing. */
async function seedReview(store) {
  return seedPlanReady(store, { phase: "executing", task: { status: "done" } });
}

async function quarantines(dir) {
  return listRetainedQuarantines(dir);
}

async function manifestOf(q) {
  return JSON.parse(await readFile(join(q.dir, "MANIFEST.json"), "utf8"));
}

async function storedBytes(q, entryPath) {
  const manifest = await manifestOf(q);
  const entry = manifest.entries.find((candidate) => candidate.path === entryPath);
  assert.ok(entry, `manifest lists ${entryPath}: ${JSON.stringify(manifest.entries.map((e) => e.path))}`);
  return readFile(join(q.dir, entry.stored), "utf8");
}

test("(a) F-001: an agent that marks a sibling task done and forges lastReview PASS is restored, quarantined and blocked as an incident", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, store }) => {
      const sibling = makeTask({
        id: "TSK-0002",
        status: "ready",
        contract: { filesAllowed: ["src/other.ts"], expectedArtifacts: ["src/other.ts"] },
      });
      const siblingPath = join(dir, ".legion-cli", "tasks", "TSK-0002.md");
      const statePath = join(dir, ".legion-cli", "STATE.md");
      let forgedTask = "";
      let forgedState = "";
      let beforeState;
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        // An unjailed agent running as the user writes engine state by absolute path.
        fakeOnWait: async () => {
          // Nothing writes STATE.md between the snapshot and here, so this is the snapshot's bytes.
          beforeState = await readFile(statePath);
          forgedTask = (await readFile(siblingPath, "utf8")).replace("status: ready", "status: done");
          await writeFile(siblingPath, forgedTask);
          forgedState = (await readFile(statePath, "utf8")).replace(/lastReview: .*/, "lastReview: PASS");
          await writeFile(statePath, forgedState);
        },
      });
      await initProject(engine);
      await seedExecute(store, { extraTasks: [sibling] });
      const beforeTask = await readFile(siblingPath);
      // The engine's own spawn-window writes (in_progress, currentTaskId) happen before the
      // snapshot, so the expected STATE is read inside the run.
      const result = await engine.execute("TSK-0001");
      assert.equal(result.status, "blocked");
      assert.equal(result.tasks[0].incident, true);
      assert.match(result.tasks[0].reason ?? "", /protected files/);
      assert.deepEqual(await readFile(siblingPath), beforeTask);
      assert.equal((await store.readTask("TSK-0002")).data.status, "ready");
      // Byte-identical, not merely "some earlier STATE.md" (R-27).
      assert.deepEqual(await readFile(statePath), beforeState);
      assert.notEqual((await store.readState()).data.lastReview, "PASS");
      assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");

      const [q] = await quarantines(dir);
      assert.ok(q, "a quarantine folder was created");
      assert.equal(await storedBytes(q, ".legion-cli/tasks/TSK-0002.md"), forgedTask);
      assert.equal(await storedBytes(q, ".legion-cli/STATE.md"), forgedState);
      const events = await readAuditEvents(dir);
      const created = events.find((event) => event.type === "quarantine_created");
      assert.ok(created);
      assert.equal(created.data.manifestSha256, sha256(await readFile(join(q.dir, "MANIFEST.json"), "utf8")));
      const restored = events.find((event) => event.type === "protected_restored");
      assert.ok(restored);
      assert.deepEqual([...restored.data.changed].sort(), [".legion-cli/STATE.md", ".legion-cli/tasks/TSK-0002.md"]);

      // (k) R-9: the quarantine is outside the project, so git never lists it.
      assert.equal(relative(dir, q.dir).startsWith(".."), true);
      assert.doesNotMatch(git(dir, ["status", "--porcelain", "-uall", "--ignored"]), /quarantine|MANIFEST/);
    });
  });
});

test("(b) F-025/F-047: a review that writes qa/checklist.json and qa/scores/x.json FAILs; both are restored and quarantined", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedReview(store);
        const checklist = join(dir, ".legion-cli", "qa", "checklist.json");
        await mkdir(dirname(checklist), { recursive: true });
        await writeFile(checklist, '{"specId":"spec-checkin","ticks":[],"updatedAt":"2026-09-01T00:00:00.000Z"}\n');
        const before = await readFile(checklist);
        const review = await engine.review();
        assert.equal(review.verdict, "FAIL");
        assert.equal(review.incident, true);
        assert.deepEqual([...review.protectedChanged].sort(), [
          ".legion-cli/qa/checklist.json",
          ".legion-cli/qa/scores/x.json",
        ]);
        assert.deepEqual(await readFile(checklist), before);
        assert.equal(existsSync(join(dir, ".legion-cli", "qa", "scores", "x.json")), false);
        assert.equal((await store.readState()).data.lastReview, "FAIL");
        const [q] = await quarantines(dir);
        assert.match(await storedBytes(q, ".legion-cli/qa/checklist.json"), /AC-forged/);
        assert.match(await storedBytes(q, ".legion-cli/qa/scores/x.json"), /"pass":true/);
      },
      {
        skillsDir,
        fakeArtifacts: [
          { path: ".legion-cli/qa/review.md", content: "Verdict: PASS\n" },
          { path: ".legion-cli/qa/checklist.json", content: '{"ticks":["AC-forged"]}\n' },
          { path: ".legion-cli/qa/scores/x.json", content: '{"pass":true}\n' },
        ],
      },
    );
  });
});

test("(c) R-22: an agent that plants core.fsmonitor in .git/config never gets it run; the config is restored", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, store }) => {
      const marker = join(dir, "fsmonitor-ran.txt");
      const script = join(dir, "fsmonitor.cjs").replaceAll("\\", "/");
      const configPath = join(dir, ".git", "config");
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeOnWait: async () => {
          await appendFile(
            configPath,
            `[core]\n\tfsmonitor = \\"${process.execPath.replaceAll("\\", "/")}\\" \\"${script}\\"\n`,
          );
        },
      });
      await initProject(engine);
      await seedReview(store);
      // The payload is already on disk (e.g. a committed test helper); only the config is forged.
      await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
      const before = await readFile(configPath);
      const review = await engine.review();
      assert.equal(review.verdict, "FAIL");
      assert.equal(review.incident, true);
      assert.deepEqual(await readFile(configPath), before);
      git(dir, ["status", "--porcelain"]);
      assert.equal(existsSync(marker), false, "the planted fsmonitor ran");
    });
  });
});

test("(d) R-41: writes from a second process during a held spawn are refused, audited after the finish, and cause no incident", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, store }) => {
      const { readyPath, releasePath } = holdPaths("d");
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeHoldWait: { readyPath, releasePath, timeoutMs: 60_000 },
      });
      await initProject(engine);
      await seedReview(store);
      await writeFile(join(dir, "notes.md"), "# Notes\n\nA fact.\n");
      const pending = engine.review();
      await waitUntil(() => existsSync(readyPath), 15_000, "review never reached wait()");

      const probe = await runFreezeProbe(dir);
      for (const [verb, outcome] of Object.entries(probe)) {
        assert.equal(outcome.refused, true, `${verb}: ${JSON.stringify(outcome)}`);
        assert.match(outcome.message, /an agent run [(]review [^)]*[)] is in progress/, verb);
      }
      // A `serve` started mid-run is still running at the finish, so serve.json stays in place:
      // it must not be an incident (R-31, R-41).
      const serveJson = join(dir, ".legion-cli", "serve.json");
      await writeFile(serveJson, '{"pid":1}\n');
      // Nothing of the refusals is in the project audit log while the run is live.
      const during = await readAuditEvents(dir);
      assert.equal(during.filter((event) => event.type === "refuse").length, 0);

      await writeFile(releasePath, "go\n");
      const review = await pending;
      assert.equal(review.verdict, "PASS");
      assert.equal(review.incident, undefined);
      const after = (await readAuditEvents(dir)).filter(
        (event) => event.type === "refuse" && /agent run [(]review/.test(String(event.data.message)),
      );
      assert.equal(after.length, 4);
      // Drained events are never engine events (R-18).
      for (const event of after) {
        assert.equal(event.actor, "deferred");
        assert.equal(event.data.deferred, true);
      }
      assert.equal((await readAuditEvents(dir)).some((event) => event.type === "protected_restored"), false);
      assert.equal(existsSync(serveJson), true);
      await unlink(serveJson);
    });
  });
});

test("(e) R-15/R-17: deleting the control record mid-run does not lift the freeze for another process", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, store }) => {
      let probe;
      let sameProcess;
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeOnWait: async () => {
          const control = controlProjectDirPath(dir);
          for (const name of await readdir(control)) await rm(join(control, name), { recursive: true, force: true });
          // The owner re-asserts its marker (heartbeat), so the deletion window is bounded.
          await waitUntil(
            async () => (await readdir(control).catch(() => [])).length > 0,
            10_000,
            "the owner never re-asserted its control record",
          );
          // A real second process: the in-memory `owned` map cannot answer for it (R-24).
          probe = await runFreezeProbe(dir);
          const second = new LegionEngine(dir, undefined, { skillsDir });
          try {
            await second.qaChecklist(["AC-1"]);
          } catch (err) {
            sameProcess = err;
          }
        },
      });
      await initProject(engine);
      await seedReview(store);
      const review = await engine.review();
      assert.equal(review.verdict, "PASS");
      assert.ok(sameProcess instanceof LegionRefuseError, String(sameProcess));
      for (const [verb, outcome] of Object.entries(probe)) {
        assert.equal(outcome.refused, true, `${verb}: ${JSON.stringify(outcome)}`);
        assert.match(outcome.message, /is in progress/, verb);
      }
    });
  });
});

test("R-17: a control dir whose live marker was deleted still freezes another process until it ages out", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    const other = spawnSleeper();
    try {
      const control = await writeControlRecords(
        dir,
        {
          schemaVersion: "legion-cli-resume/v1",
          runId: "review-deleted",
          taskId: null,
          skillId: "review",
          preSpawnRef: "UNBORN",
          startedAt: new Date().toISOString(),
          pid: other.pid,
          enginePid: other.pid,
        },
        { enginePid: other.pid, engineStartedAt: Date.now() },
      );
      await rm(join(control, "live.json"), { force: true });
      const live = await engine.liveAgentRun();
      assert.ok(live, "a markerless run dir still freezes");
      assert.equal(live.state, "unreadable");
      assert.match(live.detail, /live marker was removed while the run's process was still alive/);
      await assert.rejects(() => engine.qaChecklist(["AC-1"]), /is in progress/);
      // Past the run's own timeout plus grace it stops freezing: a deletion cannot wedge a project.
      const started = new Date(Date.now() - (21 + 11) * 60_000);
      const resumePath = join(control, "resume.json");
      const record = JSON.parse(await readFile(resumePath, "utf8"));
      await writeFile(resumePath, `${JSON.stringify({ ...record, startedAt: started.toISOString() })}\n`);
      for (const name of await readdir(control)) await utimes(join(control, name), started, started);
      await utimes(control, started, started);
      assert.equal(await engine.liveAgentRun(), null);
    } finally {
      await other.stop();
    }
  });
});

test("(f) R-1: a no-op jailed execute is not an incident and its sandbox_start event survives", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        const result = await engine.execute("TSK-0001");
        assert.equal(result.tasks[0].incident, false);
        assert.equal(result.status, "done");
        const events = await readAuditEvents(dir);
        const start = events.find((event) => event.type === "sandbox_start" || event.type === "sandbox_degraded");
        assert.ok(start, `sandbox event missing: ${events.map((event) => event.type).join(", ")}`);
        assert.equal(start.taskId, "TSK-0001");
        assert.equal(events.some((event) => event.type === "protected_restored"), false);
        assert.deepEqual(await quarantines(dir), []);
      },
      { skillsDir },
    );
  });
});

test("(g) R-2: a reviewer that files one new valid task gets FAIL plus one new ready task, and no incident", async () => {
  const fix = makeTask({
    id: "TSK-0002",
    title: "fix the button",
    status: "done",
    type: "fix",
    contract: { filesAllowed: ["src/fix.ts"], expectedArtifacts: ["src/fix.ts"] },
  });
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedReview(store);
        const review = await engine.review();
        assert.equal(review.verdict, "FAIL");
        assert.deepEqual(review.createdTaskIds, ["TSK-0002"]);
        assert.equal(review.incident, undefined);
        assert.equal((await store.readTask("TSK-0002")).data.status, "ready");
      },
      { skillsDir, fakeArtifacts: [{ path: ".legion-cli/tasks/TSK-0002.md", content: taskMarkdown(fix) }] },
    );
  });
});

test("R-2: a new task file whose id is taken is re-allocated; an invalid one is quarantined and FAILs normally", async () => {
  const colliding = makeTask({ id: "TSK-0001", title: "colliding fix", status: "todo", type: "fix" });
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedReview(store);
        await assert.rejects(
          () => engine.review(),
          (err) => err instanceof LegionRefuseError && /invalid task files: \.legion-cli\/tasks\/TSK-0009\.md/.test(err.message),
        );
        assert.equal((await store.readTask("TSK-0001")).data.title, "in/out button");
        const moved = (await readdir(join(dir, ".legion-cli", "tasks"))).sort();
        assert.deepEqual(moved, ["TSK-0001.md", "TSK-0010.md"]);
        assert.equal((await store.readTask("TSK-0010")).data.title, "colliding fix");
        assert.equal((await store.readState()).data.lastReview, "FAIL");
        const [q] = await quarantines(dir);
        assert.match(await storedBytes(q, ".legion-cli/tasks/TSK-0009.md"), /not a task/);
      },
      {
        skillsDir,
        fakeArtifacts: [
          { path: ".legion-cli/tasks/TSK-0003.md", content: taskMarkdown(colliding) },
          { path: ".legion-cli/tasks/TSK-0009.md", content: "---\nnot a task\n---\n" },
        ],
      },
    );
  });
});

test("(h) R-3: a jailed plan copies out a new task file, and a jailed review copies out qa/review.md", async () => {
  const planned = makeTask({ id: "TSK-0001", status: "todo" });
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      const config = await store.readConfig();
      await store.writeConfig({ ...config, sandbox: { ...config.sandbox, skills: ["plan", "review"] } });
      await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
      const planner = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [{ path: ".legion-cli/tasks/TSK-0001.md", content: taskMarkdown(planned) }],
      });
      await planner.plan("spec-checkin");
      assert.equal(existsSync(join(dir, ".legion-cli", "tasks", "TSK-0001.md")), true);
      assert.equal((await store.readTask("TSK-0001")).data.title, "in/out button");

      await seedReview(store);
      const reviewer = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [{ path: ".legion-cli/qa/review.md", content: "Verdict: PASS (jailed)\n" }],
      });
      const review = await reviewer.review();
      assert.equal(review.incident, undefined);
      assert.equal(await readFile(join(dir, ".legion-cli", "qa", "review.md"), "utf8"), "Verdict: PASS (jailed)\n");
      const copied = (await readAuditEvents(dir)).filter((event) => event.type === "protected_restored");
      assert.equal(copied.length, 0);
    });
  });
});

test("(i) R-17: tasks/ replaced by a junction to an outside folder: the outside file is untouched and the link is quarantined", { skip: process.platform !== "win32" && "junctions are win32" }, async () => {
  const outside = await mkdtemp(join(tmpdir(), "legion-outside-"));
  try {
    await withFakeAdapter(async () => {
      await withEngine(async ({ dir, store }) => {
        const tasksDir = join(dir, ".legion-cli", "tasks");
        const outsideTask = join(outside, "TSK-0001.md");
        await writeFile(outsideTask, "OUTSIDE — must never be overwritten\n");
        const engine = new LegionEngine(dir, undefined, {
          skillsDir,
          fakeOnWait: async () => {
            await rm(tasksDir, { recursive: true, force: true });
            await symlink(outside, tasksDir, "junction");
          },
        });
        await initProject(engine);
        await seedReview(store);
        const before = await readFile(join(tasksDir, "TSK-0001.md"));
        const review = await engine.review();
        assert.equal(review.verdict, "FAIL");
        assert.equal(review.incident, true);
        assert.equal(await readFile(outsideTask, "utf8"), "OUTSIDE — must never be overwritten\n");
        const st = await lstat(tasksDir);
        assert.equal(st.isSymbolicLink(), false);
        assert.equal(st.isDirectory(), true);
        assert.deepEqual(await readFile(join(tasksDir, "TSK-0001.md")), before);
        const [q] = await quarantines(dir);
        const manifest = await manifestOf(q);
        const link = manifest.entries.find((entry) => entry.kind === "link" && entry.path === ".legion-cli/tasks");
        assert.ok(link, JSON.stringify(manifest.entries));
        assert.match(link.linkTarget, /legion-outside-/);
      });
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

// R-26: the "quarantine first, restore only if that succeeded" ordering must be covered on both
// platforms, so the planted link is a junction on win32 and a symlink elsewhere.
test("(j) R-17: a planted link at the quarantine root is never used; the forged file is not restored over (fail closed)", async () => {
  const outside = await mkdtemp(join(tmpdir(), "legion-planted-"));
  try {
    await withFakeAdapter(async () => {
      await withEngine(
        async ({ engine, store, dir }) => {
          await initProject(engine);
          await seedReview(store);
          const root = quarantineRootPath(dir);
          await mkdir(dirname(root), { recursive: true });
          await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");
          const checklist = join(dir, ".legion-cli", "qa", "checklist.json");
          await mkdir(dirname(checklist), { recursive: true });
          await writeFile(checklist, '{"ticks":[]}\n');
          await assert.rejects(
            () => engine.review(),
            (err) => err instanceof LegionRefuseError && /NOT restored/.test(err.message),
          );
          assert.deepEqual(await readdir(outside), []);
          // Never lose the current bytes: without a quarantine, nothing is overwritten.
          assert.equal(await readFile(checklist, "utf8"), '{"ticks":["AC-forged"]}\n');
          assert.equal((await store.readState()).data.lastReview, "FAIL");
          // The link only, never its target.
          if (process.platform === "win32") await rmdir(root);
          else await unlink(root);
        },
        { skillsDir, fakeArtifacts: [{ path: ".legion-cli/qa/checklist.json", content: '{"ticks":["AC-forged"]}\n' }] },
      );
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("(k2) R-40: an earlier run's quarantine survives a later unjailed review that runs git clean -fdX", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, store }) => {
      const checklist = join(dir, ".legion-cli", "qa", "checklist.json");
      const forger = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [{ path: ".legion-cli/qa/checklist.json", content: '{"ticks":["AC-forged"]}\n' }],
      });
      await initProject(forger);
      await seedReview(store);
      await mkdir(dirname(checklist), { recursive: true });
      await writeFile(checklist, '{"ticks":[]}\n');
      assert.equal((await forger.review()).incident, true);
      const [first] = await quarantines(dir);
      const cleaner = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeOnWait: async () => {
          // Routine agent cleanup of ignored build output.
          git(dir, ["clean", "-fdX"]);
        },
      });
      await seedReview(store);
      await cleaner.review().catch(() => undefined);
      const still = (await quarantines(dir)).find((entry) => entry.dir === first.dir);
      assert.ok(still, "the earlier quarantine is gone");
      assert.equal(still.manifestSha256, first.manifestSha256);
      const audited = (await readAuditEvents(dir)).find(
        (event) => event.type === "quarantine_created" && event.data.dir === first.dir,
      );
      assert.equal(audited?.data.manifestSha256, still.manifestSha256);
    });
  });
});

test("(l) R-22: in a linked worktree (.git is a file), an agent edit to the common dir's config is restored", async () => {
  const main = await mkdtemp(join(tmpdir(), "legion-main-"));
  try {
    git(main, ["init"]);
    git(main, ["config", "user.name", "t"]);
    git(main, ["config", "user.email", "t@example.com"]);
    await writeFile(join(main, "README.md"), "main\n");
    git(main, ["add", "-A"]);
    git(main, ["commit", "-m", "main"]);
    const wt = join(main, "..", `${relative(dirname(main), main)}-wt`);
    git(main, ["worktree", "add", "-b", "feature", wt]);
    try {
      const commonConfig = join(main, ".git", "config");
      await withFakeAdapter(async () => {
        const engine = new LegionEngine(wt, undefined, {
          skillsDir,
          fakeOnWait: async () => {
            await appendFile(commonConfig, "[core]\n\thooksPath = /tmp/evil-hooks\n");
          },
        });
        await initProject(engine);
        await seedReview(engine.store);
        const before = await readFile(commonConfig);
        const dotGit = await readFile(join(wt, ".git"));
        const review = await engine.review();
        assert.equal(review.incident, true);
        assert.deepEqual(await readFile(commonConfig), before);
        assert.deepEqual(await readFile(join(wt, ".git")), dotGit);
      });
    } finally {
      git(main, ["worktree", "remove", "--force", wt]);
      await rm(wt, { recursive: true, force: true });
    }
  } finally {
    await rm(main, { recursive: true, force: true });
  }
});

test("R-1: a throwing jail copy-out still restores the protected set and is an incident (fail closed)", async () => {
  await withEngine(async ({ engine, dir }) => {
    await initProject(engine);
    const statePath = join(dir, ".legion-cli", "STATE.md");
    const before = await readFile(statePath);
    const snapshot = await snapshotProtected(dir);
    await writeFile(statePath, "forged by the agent\n");
    const events = [];
    const started = {
      spawned: true,
      runId: "execute-copyout",
      handle: { pid: process.pid, async wait() {}, async abort() {} },
      started: Date.now(),
      revertCtx: {
        projectRoot: dir,
        runId: "execute-copyout",
        skillId: "execute",
        preSpawnRef: null,
        allowedRoots: [],
        filesForbidden: undefined,
        snapshot: undefined,
        dirtyAtStart: new Set(),
        protectedSnapshot: snapshot,
        audit: async (type, data) => {
          events.push({ type, data });
        },
      },
      resolution: { id: "fake", source: "default" },
      binary: "(in-process)",
      argvSummary: "{{pointer}}",
      sandbox: {
        backend: "copy",
        hardened: false,
        jailRoot: join(dir, ".legion-cli", "sandbox", "execute-copyout"),
        spawnOpts: () => ({ cwd: dir, env: {} }),
        async copyOut() {
          throw Object.assign(new Error("EPERM: operation not permitted, scandir"), { code: "EPERM" });
        },
        async destroy() {},
      },
    };
    const revert = await finishStartedSpawn(started);
    assert.equal(revert.incident, true);
    assert.deepEqual(await readFile(statePath), before);
    assert.ok(revert.protected.unrestorable.some((entry) => /jail copy-out failed/.test(entry)));
    assert.ok(events.some((event) => event.type === "protected_restored"));
  });
});

test("R-29: a protected file over 4 MiB is quarantined, left in place and reported as unrestorable", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, store }) => {
      const big = join(dir, ".legion-cli", "wiki", "big.md");
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeOnWait: async () => {
          await appendFile(big, "APPENDED BY THE AGENT\n");
        },
      });
      await initProject(engine);
      await seedReview(store);
      await mkdir(dirname(big), { recursive: true });
      await writeFile(big, "x".repeat(5 * 1024 * 1024));
      await assert.rejects(
        () => engine.review(),
        (err) => err instanceof LegionRefuseError && /over 4 MiB/.test(err.message) && /NOT restored/.test(err.message),
      );
      // Never truncated: the agent's version stays, and a copy of it is in quarantine.
      const live = await readFile(big, "utf8");
      assert.match(live, /APPENDED BY THE AGENT/);
      const [q] = await quarantines(dir);
      assert.match(await storedBytes(q, ".legion-cli/wiki/big.md"), /APPENDED BY THE AGENT/);
      assert.equal((await store.readState()).data.lastReview, "FAIL");
    });
  });
});

test("R-3: a new task file with a bad id is quarantined and FAILs normally, not an incident", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedReview(store);
        await assert.rejects(
          () => engine.review(),
          (err) =>
            err instanceof LegionRefuseError &&
            /invalid task files: \.legion-cli\/tasks\/TSK-abc\.md/.test(err.message) &&
            !/protected files/.test(err.message),
        );
        assert.equal((await store.readState()).data.lastReview, "FAIL");
        assert.deepEqual((await readdir(join(dir, ".legion-cli", "tasks"))).sort(), ["TSK-0001.md"]);
        const [q] = await quarantines(dir);
        assert.match(await storedBytes(q, ".legion-cli/tasks/TSK-abc.md"), /not a task/);
        const restored = (await readAuditEvents(dir)).find((event) => event.type === "protected_restored");
        assert.equal(restored?.data.incident, false);
      },
      { skillsDir, fakeArtifacts: [{ path: ".legion-cli/tasks/TSK-abc.md", content: "---\nnot a task\n---\n" }] },
    );
  });
});

test("R-25: findLiveSpawn fail-closed and liveness branches", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    const control = await writeControlRecords(
      dir,
      {
        schemaVersion: "legion-cli-resume/v1",
        runId: "review-garbage",
        taskId: null,
        skillId: "review",
        preSpawnRef: "UNBORN",
        startedAt: new Date().toISOString(),
        pid: null,
      },
      { enginePid: 2_000_000_001, engineStartedAt: Date.now() },
    );
    // 1. An unreadable marker counts as live (fail closed).
    await writeFile(join(control, "live.json"), "{ garbage");
    const garbage = await engine.liveAgentRun();
    assert.equal(garbage?.state, "unreadable");
    await assert.rejects(() => engine.qaChecklist(["AC-1"]), /is in progress/);

    // 2. Past max timeout + grace it stops freezing (and a future mtime cannot wedge it, R-19).
    const old = new Date(Date.now() - (21 + 11) * 60_000);
    await utimes(join(control, "live.json"), old, old);
    for (const name of await readdir(control)) await utimes(join(control, name), old, old);
    await utimes(control, old, old);
    assert.equal(await engine.liveAgentRun(), null);

    const future = new Date(Date.now() + 365 * 24 * 3_600_000);
    await writeFile(join(control, "live.json"), "{ garbage");
    await utimes(join(control, "live.json"), future, future);
    const wedged = await engine.liveAgentRun();
    assert.equal(wedged?.state, "unreadable");
    assert.ok(wedged.expiresAt <= Date.now() + 21 * 60_000 + 11 * 60_000, "a future mtime still ages out");

    // 3. A valid marker whose engine PID is dead does not freeze.
    await writeControlRecords(
      dir,
      {
        schemaVersion: "legion-cli-resume/v1",
        runId: "review-dead",
        taskId: null,
        skillId: "review",
        preSpawnRef: "UNBORN",
        startedAt: new Date().toISOString(),
        pid: null,
      },
      { enginePid: 2_000_000_001, engineStartedAt: Date.now() },
    );
    await rm(control, { recursive: true, force: true });
    assert.equal(await engine.liveAgentRun(), null);
    // The marker proven dead is cleaned up, so the next command does not re-check it (R-16).
    assert.equal(existsSync(join(controlProjectDirPath(dir), "review-dead", "live.json")), false);
  });
});

test("R-28: the cross-volume quarantine move (copy, verify, delete) and non-overwriting moves", async () => {
  const alt = process.env.LEGION_CLI_TEST_ALT_VOLUME;
  const root = await mkdtemp(join(alt ?? tmpdir(), "legion-move-"));
  try {
    const src = join(root, "src.txt");
    const dest = join(root, "dest.txt");
    await writeFile(src, "payload\n");
    const sha = await moveFileNoOverwrite(src, dest);
    assert.equal(await readFile(dest, "utf8"), "payload\n");
    assert.equal(existsSync(src), false);
    assert.match(sha, /^[0-9a-f]{64}$/);
    // Never overwrite an existing quarantine entry.
    await writeFile(src, "second\n");
    await assert.rejects(() => moveFileNoOverwrite(src, dest), (err) => err.code === "EEXIST");
    assert.equal(await readFile(dest, "utf8"), "payload\n");
    assert.equal(existsSync(src), true, "a refused move keeps the source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  if (!alt) {
    // The fallback (EXDEV) path needs a second volume; set LEGION_CLI_TEST_ALT_VOLUME to cover it.
    assert.ok(true, "skipped: set LEGION_CLI_TEST_ALT_VOLUME to a path on another volume");
  }
});

test("(m) an untouched pre-dirty tracked user file survives a run byte-identical", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src", "user.ts"), "export const committed = 1;\n");
        await initProject(engine);
        await seedExecute(store);
        await writeFile(join(dir, "src", "user.ts"), "export const committed = 1;\n// my edit, not saved in git\n");
        const before = await readFile(join(dir, "src", "user.ts"));
        const result = await engine.execute("TSK-0001");
        assert.equal(result.tasks[0].incident, false);
        assert.deepEqual(await readFile(join(dir, "src", "user.ts")), before);
      },
      { skillsDir },
    );
  });
});
