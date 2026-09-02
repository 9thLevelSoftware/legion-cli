import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { LegionRefuseError } from "../dist/index.js";
import {
  git,
  gitHead,
  initGitRepo,
  initProject,
  makeQaScore,
  seedPlanReady,
  withEngine,
  writeQaFile,
} from "./helpers.js";

async function seedReadyToShip(store, extra = {}) {
  const seeded = await seedPlanReady(store, {
    phase: extra.phase ?? "ready_to_ship",
    lastReview: "PASS",
    lastQaId: extra.lastQaId ?? "qa-1",
    task: { status: "done", ...(extra.task ?? {}) },
    extraTasks: extra.extraTasks,
  });
  await writeQaFile(store, extra.score ?? makeQaScore());
  return seeded;
}

test("ship receipt records QA mode/score and writes events.jsonl", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    const taskBefore = await store.readTask("TSK-0001");
    const receipt = await engine.ship();
    assert.equal(receipt.phase, "shipped");
    assert.equal(receipt.qaMode, "full");
    assert.equal(receipt.qaScore, 94);
    assert.equal(receipt.qaPass, true);
    assert.equal((await engine.getState()).phase, "shipped");
    const receiptMd = await readFile(join(store.paths.auditDir, "ship-spec-checkin.md"), "utf8");
    assert.match(receiptMd, /qa\.mode: full/);
    assert.match(receiptMd, /qa\.total: 94/);
    const jsonl = await readFile(join(store.paths.auditDir, "events.jsonl"), "utf8");
    assert.match(jsonl, /"type":"ship"/);
    assert.match(jsonl, /"qaMode":"full"/);
    const taskAfter = await store.readTask("TSK-0001");
    assert.equal(taskAfter.body, taskBefore.body);
    assert.deepEqual(taskAfter.data, taskBefore.data);
  });
});

test("ship stages filesAllowed union plus .legion-cli and leaves unrelated files", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    await writeFile(join(dir, "unrelated.ts"), "leave me\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "src", "main.ts"), "export const ok = false;\n", "utf8");
    await writeFile(join(dir, "unrelated.ts"), "changed\n", "utf8");

    const receipt = await engine.ship({
      confirm: async (preview) => {
        assert.equal(preview.unrelatedUnchanged, false);
        assert.ok(preview.unrelated.includes("unrelated.ts"));
        assert.match(preview.stagedDisplay, /src\//);
        assert.match(preview.stagedDisplay, /\.legion-cli\//);
        return true;
      },
    });
    assert.equal(receipt.phase, "shipped");
    const staged = git(dir, ["diff", "--cached", "--name-only"]);
    assert.match(staged, /src\/main\.ts/);
    assert.doesNotMatch(staged, /unrelated\.ts/);
    const status = git(dir, ["status", "--porcelain", "unrelated.ts"]);
    assert.match(status, /unrelated\.ts/);
  });
});

test("ship --commit creates a commit after confirm", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    const before = initGitRepo(dir);
    await writeFile(join(dir, "src", "main.ts"), "export const shipped = true;\n", "utf8");
    const receipt = await engine.ship({ commit: true });
    assert.equal(receipt.committed, true);
    assert.ok(receipt.commitSha);
    assert.notEqual(gitHead(dir), before);
    const msg = git(dir, ["log", "-1", "--pretty=%s"]);
    assert.match(msg, /legion-cli ship: spec-checkin/);
  });
});

test("ship --pr uses gh via the test seam", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    initGitRepo(dir);
    const receipt = await engine.ship({
      pr: true,
      prCreate: ({ title, body }) => {
        assert.match(title, /spec-checkin/);
        assert.match(body, /QA mode: full/);
        return { url: "https://example.test/pr/1" };
      },
    });
    assert.equal(receipt.prUrl, "https://example.test/pr/1");
  });
});

test("ship cancel unstages and does not rewrite task bodies", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "src", "main.ts"), "export const dirty = true;\n", "utf8");
    const taskBefore = await store.readTask("TSK-0001");
    await assert.rejects(
      () => engine.ship({ confirm: async () => false }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /cancelled/);
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "ready_to_ship");
    const staged = git(dir, ["diff", "--cached", "--name-only"]);
    assert.equal(staged.trim(), "");
    const taskAfter = await store.readTask("TSK-0001");
    assert.equal(taskAfter.body, taskBefore.body);
  });
});

test("ship --allow-degraded-qa from executing after no-browser QA", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store, {
      phase: "executing",
      score: makeQaScore({
        mode: "no-browser",
        pass: false,
        total: 70,
        buckets: {
          p0: { points: 40, max: 40, failed: 0 },
          p1: { points: 18, max: 30, passRate: 0.6 },
          p2: { points: 12, max: 15, passRate: 0.8 },
          visual: { points: 15, max: 15, regressions: 0 },
        },
      }),
    });
    const receipt = await engine.ship({ allowDegradedQa: true });
    assert.equal(receipt.phase, "shipped");
    assert.equal(receipt.qaMode, "no-browser");
    assert.equal(receipt.qaScore, 70);
    assert.equal(receipt.qaPass, false);
    assert.equal(receipt.allowDegradedQa, true);
  });
});

test("abandon writes audit event and message", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
    await engine.abandon("scope changed");
    assert.equal((await engine.getState()).phase, "abandoned");
    const jsonl = await readFile(join(store.paths.auditDir, "events.jsonl"), "utf8");
    assert.match(jsonl, /"type":"abandon"/);
    assert.match(jsonl, /scope changed/);
    const md = await readFile(join(store.paths.auditDir, "abandon-spec-checkin.md"), "utf8");
    assert.match(md, /scope changed/);
  });
});

test("spec new appends an audit event and does not compact tasks", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    const taskBefore = await store.readTask("TSK-0001");
    await engine.ship();
    await engine.newSpec();
    assert.equal((await engine.getState()).phase, "intent_draft");
    const jsonl = await readFile(join(store.paths.auditDir, "events.jsonl"), "utf8");
    assert.match(jsonl, /"type":"spec_new"/);
    const taskAfter = await store.readTask("TSK-0001");
    assert.equal(taskAfter.data.status, "done");
    assert.equal(taskAfter.body, taskBefore.body);
  });
});
