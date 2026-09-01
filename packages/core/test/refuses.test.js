import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  HINT,
  LegionRefuseError,
  evaluateReadiness,
  filesAllowedFailsPlan,
  PHASES,
} from "../dist/index.js";
import {
  initProject,
  makeQaScore,
  makeSpec,
  makeTask,
  patchState,
  seedFrozenSpec,
  seedPlanReady,
  withEngine,
  writeQaFile,
  writeTask,
} from "./helpers.js";

function isRefuse(err, hintPattern) {
  assert.equal(err instanceof LegionRefuseError, true, `expected LegionRefuseError, got ${err?.name}: ${err?.message}`);
  assert.match(err.nextHint, hintPattern);
  return true;
}

const failingQa = makeQaScore({
  id: "qa-fail",
  buckets: {
    p0: { points: 40, max: 40, failed: 0 },
    p1: { points: 24, max: 30, passRate: 0.8 },
    p2: { points: 12, max: 15, passRate: 0.8 },
    visual: { points: 0, max: 15, regressions: 1 },
  },
  total: 76,
  pass: false,
  evidencePaths: [".legion-cli/qa/scores/qa-fail.json"],
});

const cases = [
  {
    name: "plan before spec_frozen",
    hint: /legion-cli spec/,
    setup: async ({ engine }) => {
      await initProject(engine);
    },
    act: ({ engine }) => engine.plan(),
  },
  {
    name: "execute with empty filesAllowed",
    hint: /legion-cli plan/,
    setup: async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, {
        task: { contract: { filesAllowed: [], expectedArtifacts: ["src/main.ts"] } },
      });
    },
    act: ({ engine }) => engine.execute("TSK-0001"),
  },
  {
    name: "execute with empty verificationCommands",
    hint: /legion-cli plan/,
    setup: async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, {
        task: { contract: { verificationCommands: [] } },
      });
    },
    act: ({ engine }) => engine.execute("TSK-0001"),
  },
  {
    name: "execute TSK-x if not ready",
    hint: /legion-cli status --blockers/,
    setup: async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, { task: { status: "todo" } });
    },
    act: ({ engine }) => engine.execute("TSK-0001"),
  },
  {
    name: "execute in advisory",
    hint: /^legion-cli$/,
    setup: async ({ engine, store }) => {
      await initProject(engine, { controlMode: "advisory" });
      await seedPlanReady(store);
    },
    act: ({ engine }) => engine.execute("auto"),
  },
  {
    name: "execute from plan_failed",
    hint: /legion-cli plan/,
    setup: async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, { phase: "plan_failed", lastReadiness: "FAIL" });
    },
    act: ({ engine }) => engine.execute("auto"),
  },
  {
    name: "qa if any slice task is ready",
    hint: /legion-cli (next|execute)/,
    setup: async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, { phase: "executing", lastReview: "PASS" });
    },
    act: ({ engine }) => engine.qa({ score: makeQaScore() }),
  },
  {
    name: "qa if any P0 task is not done",
    hint: /legion-cli status --blockers/,
    setup: async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, {
        phase: "executing",
        lastReview: "PASS",
        task: { status: "blocked" },
      });
    },
    act: ({ engine }) => engine.qa({ score: makeQaScore() }),
  },
  {
    name: "qa if lastReview is not PASS",
    hint: /legion-cli review/,
    setup: async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, {
        phase: "executing",
        lastReview: "FAIL",
        task: { status: "done" },
      });
    },
    act: ({ engine }) => engine.qa({ score: makeQaScore() }),
  },
  {
    name: "review if the slice is not terminal",
    hint: /legion-cli (execute|next)/,
    setup: async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, { phase: "executing", task: { status: "in_progress" } });
    },
    act: ({ engine }) => engine.review(),
  },
  {
    name: "ship if last QA pass is not true",
    hint: /legion-cli qa/,
    setup: async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, {
        phase: "executing",
        lastReview: "PASS",
        lastQaId: "qa-fail",
        task: { status: "done" },
      });
      await writeQaFile(store, failingQa);
    },
    act: ({ engine }) => engine.ship(),
  },
  {
    name: "ship if spec review is not PASS",
    hint: /legion-cli review/,
    setup: async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, {
        phase: "ready_to_ship",
        lastReview: "FAIL",
        lastQaId: "qa-1",
        task: { status: "done" },
      });
      await writeQaFile(store, makeQaScore());
    },
    act: ({ engine }) => engine.ship(),
  },
  {
    name: "ship if any P0 task is not done",
    hint: /legion-cli status --blockers/,
    setup: async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, {
        phase: "ready_to_ship",
        lastReview: "PASS",
        lastQaId: "qa-1",
        task: { status: "blocked" },
      });
      await writeQaFile(store, makeQaScore());
    },
    act: ({ engine }) => engine.ship(),
  },
  {
    name: "expanding the current task",
    hint: /legion-cli ticket create --parent/,
    setup: async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, { phase: "executing", currentTaskId: "TSK-0001" });
    },
    act: ({ engine }) => engine.expandCurrentTask("also do X"),
  },
  {
    name: "ingest of private-network URL",
    hint: /in-repo path/,
    setup: async ({ engine }) => {
      await initProject(engine);
    },
    act: ({ engine }) => engine.ingest(["https://127.0.0.1/secret"], { noCommit: true }),
  },
  {
    name: "ingest of RFC1918 URL",
    hint: /in-repo path/,
    setup: async ({ engine }) => {
      await initProject(engine);
    },
    act: ({ engine }) => engine.ingest(["https://192.168.1.10/wiki"], { noCommit: true }),
  },
  {
    name: "ingest of http URL",
    hint: /in-repo path/,
    setup: async ({ engine }) => {
      await initProject(engine);
    },
    act: ({ engine }) => engine.ingest(["http://example.com/doc"], { noCommit: true }),
  },
  {
    name: "ingest of file: outside the workspace",
    hint: /in-repo path/,
    setup: async ({ engine }) => {
      await initProject(engine);
    },
    act: async ({ engine }) => {
      const outside = join(tmpdir(), `legion-outside-${Date.now()}.md`);
      await writeFile(outside, "secret\n", "utf8");
      return engine.ingest([pathToFileURL(outside).href], { noCommit: true });
    },
  },
  {
    name: "ingest of github: source is v1",
    hint: /save markdown and ingest the file/,
    setup: async ({ engine }) => {
      await initProject(engine);
    },
    act: ({ engine }) => engine.ingest(["github:pr:123"], { noCommit: true }),
  },
  {
    name: "control_mode autonomous",
    hint: /guarded or surgical/,
    setup: async () => {},
    act: ({ engine }) => engine.init({ name: "Checkin", adapter: "fake", controlMode: "autonomous" }),
  },
  {
    name: "init --mode brownfield",
    hint: /greenfield/,
    setup: async () => {},
    act: ({ engine }) => engine.init({ name: "Checkin", adapter: "fake", mode: "brownfield" }),
  },
  {
    name: "ingest from uninitialized",
    hint: /legion-cli init/,
    setup: async () => {},
    act: ({ engine }) => engine.ingest(["README.md"], { noCommit: true }),
  },
  {
    name: "spec new before shipped",
    hint: /legion-cli spec new/,
    setup: async ({ engine }) => {
      await initProject(engine);
    },
    act: ({ engine }) => engine.newSpec(),
  },
];

for (const row of cases) {
  test(`§2.5 refuses: ${row.name}`, async () => {
    await withEngine(async (ctx) => {
      await row.setup(ctx);
      await assert.rejects(() => row.act(ctx), (err) => isRefuse(err, row.hint));
    });
  });
}

test("§2.5 filesAllowed globs are plan FAIL", async () => {
  assert.equal(filesAllowedFailsPlan(["src/**"]), true);
  assert.equal(filesAllowedFailsPlan(["src/*.ts"]), true);
  assert.equal(filesAllowedFailsPlan(["src/foo?.ts"]), true);
  assert.equal(filesAllowedFailsPlan([".git/config"]), true);
  assert.equal(filesAllowedFailsPlan(["src/main.ts"]), false);

  const report = evaluateReadiness({
    spec: makeSpec({
      status: "frozen",
      frozenAt: "2026-09-01T12:00:00.000Z",
      frozenBy: "t",
    }),
    tasks: [makeTask({ contract: { filesAllowed: ["src/**"] } })],
    hasStories: true,
    skipWireframes: false,
    openNonBlockingAssumptions: false,
  });
  assert.equal(report.readiness, "FAIL");
  assert.ok(report.fails.some((line) => /concrete paths/.test(line)));

  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
    await writeFile(join(store.paths.specsDir, "spec-checkin", "stories.yaml"), "stories: []\n", "utf8");
    await writeTask(store, makeTask());
    await writeTask(
      store,
      makeTask({
        id: "TSK-glob",
        contract: { filesAllowed: ["src/**"], expectedArtifacts: ["src/glob.ts"] },
      }),
    );
    const readiness = await engine.plan("spec-checkin");
    assert.equal(readiness, "FAIL");
    assert.equal((await engine.getState()).phase, "plan_failed");
  });
});

test("plan_concerns is not a phase", () => {
  assert.equal(PHASES.includes("plan_concerns"), false);
  assert.equal(HINT.plan.includes("plan_concerns"), false);
});

test("empty verificationCommands is plan FAIL", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedFrozenSpec(store);
    await writeTask(store, makeTask({ contract: { verificationCommands: [] } }));
    const readiness = await engine.plan("spec-checkin");
    assert.equal(readiness, "FAIL");
    assert.equal((await engine.getState()).phase, "plan_failed");
    assert.equal((await engine.getState()).lastReadiness, "FAIL");
  });
});
