import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  LegionRefuseError,
  regressionTestPath,
} from "../dist/index.js";
import {
  initGitRepo,
  initProject,
  makeQaScore,
  quoteArg,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

function unitCommand(payload) {
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`;
  return `${quoteArg(process.execPath)} -e ${quoteArg(script)}`;
}

async function seedQaReady(store, extra = {}) {
  return seedPlanReady(store, {
    phase: "executing",
    lastReview: "PASS",
    task: { status: "done", ...(extra.task ?? {}) },
    spec: extra.spec,
  });
}

test("in-process scorer writes QAScore and can pass to ready_to_ship", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedQaReady(store, {
      spec: {
        acceptance: [{ id: "AC-01", statement: "API returns 200 for health", kind: "test", priority: "P0" }],
        wireframesIndex: null,
      },
    });
    const config = await store.readConfig();
    await store.writeConfig({
      ...config,
      qa: {
        ...config.qa,
        unitCommand: unitCommand({
          tests: [
            { title: "health @p0", status: "passed" },
            { title: "lists @p1", status: "passed" },
            { title: "optional @p2", status: "passed" },
          ],
        }),
      },
    });
    const score = await engine.qa();
    assert.equal(score.pass, true);
    assert.equal(score.buckets.visual.points, 15);
    assert.equal(score.buckets.visual.regressions, 0);
    assert.equal((await engine.getState()).phase, "ready_to_ship");
  });
});

test("visual regression is a ship blocker even at 85 functional points", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedQaReady(store);
    const score = makeQaScore({
      buckets: {
        p0: { points: 40, max: 40, failed: 0 },
        p1: { points: 30, max: 30, passRate: 1 },
        p2: { points: 15, max: 15, passRate: 1 },
        visual: { points: 0, max: 15, regressions: 1 },
      },
      total: 85,
      pass: false,
    });
    const recorded = await engine.qa({ score });
    assert.equal(recorded.pass, false);
    assert.equal(recorded.buckets.visual.points, 0);
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("no-browser qa requires checklist and cannot pass", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedQaReady(store, {
      spec: {
        acceptance: [{ id: "AC-01", statement: "API returns 200 for health", kind: "test", priority: "P0" }],
        wireframesIndex: null,
      },
    });
    await assert.rejects(
      () => engine.qa({ mode: "no-browser" }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /checklist/);
        assert.match(err.nextHint, /qa checklist/);
        return true;
      },
    );
    await engine.qaChecklist(["AC-01"]);
    const config = await store.readConfig();
    await store.writeConfig({
      ...config,
      qa: {
        ...config.qa,
        mode: "no-browser",
        unitCommand: unitCommand({ tests: [{ title: "health @p0", status: "passed" }] }),
      },
    });
    const score = await engine.qa({ mode: "no-browser" });
    assert.equal(score.mode, "no-browser");
    assert.ok(score.total <= 70);
    assert.equal(score.pass, false);
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("qa checklist rejects unknown AC ids", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedQaReady(store);
    await assert.rejects(
      () => engine.qaChecklist(["AC-NOPE"]),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /unknown acceptance criterion/);
        return true;
      },
    );
  });
});

test("fix writes a RED @p0 test then execute can go GREEN", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
        initGitRepo(dir);
        const bug = "board does not refresh";
        const testPath = regressionTestPath(bug);
        const task = await engine.fix(bug);
        assert.equal(task.type, "bug");
        assert.equal(task.priority, "P0");
        assert.equal(task.status, "ready");
        assert.ok(task.contract.filesAllowed.includes(testPath));
        assert.equal((await engine.getState()).lastReview, "FAIL");
        const passing = [
          'import test from "node:test";',
          `test(${JSON.stringify(`${bug} @p0`)}, () => {});`,
          "",
        ].join("\n");
        await mkdir(join(dir, "tests", "unit", "regression"), { recursive: true });
        await writeFile(join(dir, testPath), passing, "utf8");
        const result = await engine.execute(task.id, { fix: true });
        assert.equal(result.status, "done");
        assert.equal((await store.readTask(task.id)).data.status, "done");
      },
      { skillsDir },
    );
  });
});

test("fix refuses when the reproducing test is already GREEN", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
    const bug = "already green bug";
    const testPath = regressionTestPath(bug);
    await mkdir(join(dir, "tests", "unit", "regression"), { recursive: true });
    await writeFile(
      join(dir, testPath),
      ['import test from "node:test";', `test(${JSON.stringify(`${bug} @p0`)}, () => {});`, ""].join("\n"),
      "utf8",
    );
    await assert.rejects(
      () => engine.fix(bug),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /this does not reproduce/);
        return true;
      },
    );
  });
});

test("fix files a type:bug P0 task from a RED template", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", task: { status: "done" } });
    const task = await engine.fix("tap misses");
    assert.equal(task.type, "bug");
    assert.equal(task.priority, "P0");
    assert.match(task.contract.filesAllowed[0], /@p0|regression/);
    assert.equal((await store.readTask(task.id)).data.type, "bug");
  });
});
