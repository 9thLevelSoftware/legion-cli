import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  LegionRefuseError,
  PRODUCT_ENTRY,
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
    const jsonl = await readFile(join(store.paths.auditDir, "events.jsonl"), "utf8");
    assert.match(jsonl, /"type":"qa"/);
    assert.match(jsonl, /"pass":true/);
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
        assert.ok(task.contract.filesAllowed.includes(PRODUCT_ENTRY));
        assert.equal((await engine.getState()).lastReview, "FAIL");
        const result = await engine.execute(task.id, { fix: true });
        assert.equal(result.status, "done");
        assert.equal((await store.readTask(task.id)).data.status, "done");
        assert.equal(existsSync(join(dir, ...PRODUCT_ENTRY.split("/"))), true);
        const testBody = await readFile(join(dir, ...testPath.split("/")), "utf8");
        assert.match(testBody, /this does not reproduce/);
        assert.match(testBody, /mod\.ok/);
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: PRODUCT_ENTRY, content: "export const ok = true;\n" }],
      },
    );
  });
});

test("fix execute reverts product files that are not in filesAllowed", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
        initGitRepo(dir);
        const task = await engine.fix("unlisted extra");
        assert.equal(task.contract.filesAllowed.includes("src/secret.ts"), false);
        const result = await engine.execute(task.id, { fix: true });
        assert.equal(result.status, "blocked");
        assert.ok(result.tasks[0].extrasReverted.includes("src/secret.ts"));
        assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: "src/secret.ts", content: "export const leaked = true;\n" }],
      },
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
    assert.match(task.contract.filesAllowed[0], /regression/);
    assert.ok(task.contract.filesAllowed.includes("src/main.js"));
    assert.ok(task.contract.filesAllowed.includes("src/main.ts"));
    assert.equal((await store.readTask(task.id)).data.type, "bug");
  });
});
