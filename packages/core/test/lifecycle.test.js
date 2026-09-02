import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { INTENT_Q, LegionRefuseError, canTransition, PHASES } from "../dist/index.js";
import {
  initProject,
  makeQaScore,
  makeSpec,
  makeTask,
  patchState,
  seedFrozenSpec,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  writeSpec,
  writeTask,
} from "./helpers.js";

test("init writes initialized greenfield project", async () => {
  await withEngine(async ({ engine, store }) => {
    await engine.init({ name: "Checkin", adapter: "fake" });
    const state = await engine.getState();
    assert.equal(state.phase, "initialized");
    const project = await store.readProject();
    assert.equal(project.data.mode, "greenfield");
    assert.equal(project.data.controlMode, "guarded");
    const config = await store.readConfig();
    assert.equal(config.adapter.default, "fake");
    assert.equal(await store.pathExists(".legion-cli/wiki/README.md"), true);
    assert.equal(await store.pathExists(".legion-cli/design/craft/typography.md"), true);
    assert.match(
      await readFile(join(store.paths.designDir, "craft", "anti-ai-slop.md"), "utf8"),
      /Anti AI slop/,
    );
  });
});

test("CONCERNS is lastReadiness on plan_ready and execute is allowed", async () => {
  await withFakeAdapter(async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedFrozenSpec(store, { mustNotChange: [] });
    await writeTask(store, makeTask());
    const readiness = await engine.plan("spec-checkin");
    assert.equal(readiness, "CONCERNS");
    const state = await engine.getState();
    assert.equal(state.phase, "plan_ready");
    assert.equal(state.lastReadiness, "CONCERNS");
    assert.equal(PHASES.includes("plan_concerns"), false);

    const result = await engine.execute("auto");
    assert.equal(result.phase, "executing");
    assert.equal((await engine.getState()).phase, "executing");
  });
  });
});

test("PASS readiness lands in plan_ready", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
      await writeFile(join(store.paths.specsDir, "spec-checkin", "stories.yaml"), "stories: []\n", "utf8");
      await writeTask(store, makeTask());
      const readiness = await engine.plan("spec-checkin");
      assert.equal(readiness, "PASS");
      assert.equal((await engine.getState()).phase, "plan_ready");
    });
  });
});

test("executing stays until every slice task is done or blocked", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, {
      extraTasks: [makeTask({ id: "TSK-0002", contract: { filesAllowed: ["src/board.ts"], expectedArtifacts: ["src/board.ts"] } })],
    });

    await engine.execute("TSK-0001");
    assert.equal((await engine.getState()).phase, "executing");

    await engine.setTaskStatus("TSK-0001", "in_progress");
    await engine.setTaskStatus("TSK-0001", "verifying");
    await engine.setTaskStatus("TSK-0001", "done");
    assert.equal((await engine.getState()).phase, "executing");

    await engine.execute("TSK-0002");
    assert.equal((await engine.getState()).phase, "executing");
    await engine.setTaskStatus("TSK-0002", "blocked");
    assert.equal((await engine.getState()).phase, "executing");

    const slice = await engine.listSliceTasks();
    assert.deepEqual(
      slice.map((task) => `${task.id}:${task.status}`),
      ["TSK-0001:done", "TSK-0002:blocked"],
    );
    const review = await engine.review();
    assert.equal(review.verdict, "PASS");
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("slice is all tasks of activeSpecId", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", task: { status: "done" } });
    await writeTask(
      store,
      makeTask({
        id: "TSK-9999",
        specId: "spec-other",
        status: "ready",
        contract: { filesAllowed: ["src/other.ts"], expectedArtifacts: ["src/other.ts"] },
      }),
    );
    const slice = await engine.listSliceTasks();
    assert.deepEqual(
      slice.map((task) => task.id),
      ["TSK-0001"],
    );
    const review = await engine.review();
    assert.equal(review.verdict, "PASS");
  });
});

test("review PASS only if spawn created zero new tasks", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", task: { status: "done" } });

    const before = await engine.snapshotTaskIds();
    await writeTask(
      store,
      makeTask({
        id: "TSK-0003",
        type: "fix",
        parentId: "TSK-0001",
        status: "ready",
        contract: { filesAllowed: ["src/fix.ts"], expectedArtifacts: ["src/fix.ts"] },
      }),
    );
    const after = await engine.snapshotTaskIds();
    const verdict = await engine.applyReviewSnapshots(before, after);
    assert.equal(verdict, "FAIL");
    assert.equal((await engine.getState()).lastReview, "FAIL");
    assert.equal((await engine.getState()).phase, "executing");

    await assert.rejects(
      () => engine.qa({ score: makeQaScore() }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        // new ready fix task means the slice is no longer terminal
        assert.match(err.nextHint, /legion-cli (next|execute)/);
        return true;
      },
    );

    await engine.setTaskStatus("TSK-0003", "in_progress");
    await engine.setTaskStatus("TSK-0003", "verifying");
    await engine.setTaskStatus("TSK-0003", "done");
    await assert.rejects(
      () => engine.qa({ score: makeQaScore() }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.nextHint, /legion-cli review/);
        return true;
      },
    );
    const pass = await engine.review();
    assert.equal(pass.verdict, "PASS");
    assert.deepEqual(pass.createdTaskIds, []);
    assert.equal((await engine.getState()).lastReview, "PASS");
  });
});

test("qa.pass && lastReview PASS transitions to ready_to_ship", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, {
      phase: "executing",
      lastReview: "PASS",
      extraTasks: [makeTask({ id: "TSK-0002", priority: "P1", status: "blocked", contract: { filesAllowed: ["src/p1.ts"], expectedArtifacts: ["src/p1.ts"] } })],
      task: { status: "done" },
    });
    const score = await engine.qa({ score: makeQaScore() });
    assert.equal(score.pass, true);
    const state = await engine.getState();
    assert.equal(state.phase, "ready_to_ship");
    assert.equal(state.lastQaId, "qa-1");
  });
});

test("qa.pass false stays executing", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
    const score = makeQaScore({
      buckets: {
        p0: { points: 40, max: 40, failed: 0 },
        p1: { points: 24, max: 30, passRate: 0.8 },
        p2: { points: 12, max: 15, passRate: 0.8 },
        visual: { points: 0, max: 15, regressions: 1 },
      },
      total: 76,
      pass: false,
    });
    await engine.qa({ score });
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("spec new from shipped", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, {
      phase: "ready_to_ship",
      lastReview: "PASS",
      lastQaId: "qa-1",
      task: { status: "done" },
    });
    await writeFile(
      join(store.paths.qaDir, "scores", "qa-1.json"),
      `${JSON.stringify(makeQaScore(), null, 2)}\n`,
      "utf8",
    );
    const receipt = await engine.ship();
    assert.equal(receipt.phase, "shipped");
    assert.equal((await engine.getState()).phase, "shipped");
    assert.equal((await store.readSpec("spec-checkin")).data.status, "frozen");

    await store.writeIntentAnswers({
      schemaVersion: "legion-cli-intent-answers/v1",
      rounds: [{ n: 1, questions: ["old"], answers: ["old"] }],
      mapped: {
        personas: ["old persona"],
        problem: "old problem",
        mustBeTrue: ["old"],
        mustNotChange: [],
        outOfScope: ["old"],
        happyPath: "old",
        screens: ["old"],
      },
    });
    await engine.newSpec();
    const state = await engine.getState();
    assert.equal(state.phase, "intent_draft");
    assert.equal(state.activeSpecId ?? null, null);
    assert.equal(state.lastReview ?? null, null);
    assert.equal((await store.readSpec("spec-checkin")).data.status, "superseded");
    const intent = await engine.beginIntent();
    assert.equal(intent.nextQuestions[0], INTENT_Q.persona);
    assert.equal(intent.nextQuestions[1], INTENT_Q.problem);
    assert.deepEqual(intent.mapped.personas, []);
  });
});

test("ingest does not change phase", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    const src = join(dir, "notes.md");
    await writeFile(src, "# Notes\nDurable knowledge.\n", "utf8");
    const before = (await engine.getState()).phase;
    assert.equal(before, "initialized");
    const receipt = await engine.ingest(["notes.md"], { noCommit: true });
    assert.ok(receipt.pagesCreated.length + receipt.pagesUpdated.length + receipt.skipped.length >= 1);
    assert.equal((await engine.getState()).phase, "initialized");
  });
});

test("approveSpec refuses UI freeze when brand violation is set", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await writeSpec(store, makeSpec({ status: "draft", wireframesIndex: "wireframes/INDEX.html" }));
    await patchState(store, { phase: "spec_draft" });
    await writeFile(
      join(dir, ".legion-cli", "design", "active.yaml"),
      "schemaVersion: legion-cli-design-active/v1\npackageId: checkin\ncraft: []\nbrandViolation: true\n",
      "utf8",
    );
    await assert.rejects(
      () => engine.approveSpec("spec-checkin", { id: "human" }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /brand violation/);
        assert.match(err.nextHint, /design-system generate/);
        return true;
      },
    );
  });
});

test("approveSpec freezes a draft and moves to spec_frozen", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await writeSpec(store, makeSpec({ status: "draft" }));
    await patchState(store, { phase: "spec_draft" });
    await engine.approveSpec("spec-checkin", { id: "human" });
    const spec = await store.readSpec("spec-checkin");
    assert.equal(spec.data.status, "frozen");
    assert.equal(spec.data.frozenBy, "human");
    assert.equal((await engine.getState()).phase, "spec_frozen");
    assert.equal((await engine.getState()).activeSpecId, "spec-checkin");
  });
});

test("transition refuses plan_concerns and unknown phases", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    await assert.rejects(
      () => engine.transition("plan_concerns"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        return true;
      },
    );
  });
});

test("canTransition has no plan_concerns edge", () => {
  for (const phase of PHASES) {
    assert.equal(canTransition(phase, "plan_concerns"), false);
  }
});

test("plan walks spec_frozen → planning → plan_ready and transition cannot skip readiness", async () => {
  await withFakeAdapter(async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedFrozenSpec(store);
    await writeTask(store, makeTask());
    await assert.rejects(
      () => engine.transition("plan_ready"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.nextHint, /legion-cli plan/);
        return true;
      },
    );
    const readiness = await engine.plan("spec-checkin");
    assert.equal(readiness, "CONCERNS");
    assert.equal((await engine.getState()).phase, "plan_ready");
    assert.equal((await engine.getState()).lastReadiness, "CONCERNS");

    await patchState(store, { phase: "planning", lastReadiness: null });
    await assert.rejects(
      () => engine.transition("plan_ready"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.nextHint, /legion-cli plan/);
        return true;
      },
    );
    const again = await engine.plan("spec-checkin");
    assert.equal(again, "CONCERNS");
    assert.equal((await engine.getState()).phase, "plan_ready");
  });
  });
});

test("reopening a blocked slice task after review PASS invalidates lastReview", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, {
      phase: "executing",
      extraTasks: [
        makeTask({
          id: "TSK-0002",
          priority: "P1",
          status: "blocked",
          contract: { filesAllowed: ["src/p1.ts"], expectedArtifacts: ["src/p1.ts"] },
        }),
      ],
      task: { status: "done" },
    });
    const review = await engine.review();
    assert.equal(review.verdict, "PASS");
    assert.equal((await engine.getState()).lastReview, "PASS");

    await engine.setTaskStatus("TSK-0002", "ready");
    assert.equal((await engine.getState()).lastReview, "FAIL");
    assert.equal((await engine.getState()).phase, "executing");

    await engine.setTaskStatus("TSK-0002", "in_progress");
    await engine.setTaskStatus("TSK-0002", "verifying");
    await engine.setTaskStatus("TSK-0002", "done");
    await assert.rejects(
      () => engine.qa({ score: makeQaScore() }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.nextHint, /legion-cli review/);
        return true;
      },
    );
  });
});

test("qa is refused after a review that filed fix tasks until re-review PASS", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", task: { status: "done" } });
    const before = await engine.snapshotTaskIds();
    await writeTask(
      store,
      makeTask({
        id: "TSK-fix",
        type: "fix",
        status: "done",
        contract: { filesAllowed: ["src/fix.ts"], expectedArtifacts: ["src/fix.ts"] },
      }),
    );
    await engine.applyReviewSnapshots(before, await engine.snapshotTaskIds());
    await assert.rejects(() => engine.qa({ score: makeQaScore() }), LegionRefuseError);
    const later = await engine.review();
    assert.equal(later.verdict, "PASS");
    const score = await engine.qa({ score: makeQaScore() });
    assert.equal(score.pass, true);
    assert.equal((await engine.getState()).phase, "ready_to_ship");
  });
});
