import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
      commit: true,
      prCreate: ({ title, body }) => {
        assert.match(title, /spec-checkin/);
        assert.match(body, /QA mode: full/);
        assert.match(readFileSync(store.paths.stateMd, "utf8"), /phase: ready_to_ship/);
        return { url: "https://example.test/pr/1" };
      },
    });
    assert.equal(receipt.prUrl, "https://example.test/pr/1");
    assert.equal((await engine.getState()).phase, "shipped");
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

test("ship --allow-degraded-qa refuses missing last QA", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, {
      phase: "executing",
      lastReview: "PASS",
      lastQaId: null,
      task: { status: "done" },
    });
    await assert.rejects(
      () => engine.ship({ allowDegradedQa: true }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /no-browser QA score/);
        assert.match(err.nextHint, /legion-cli qa/);
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("ship --allow-degraded-qa refuses failed full QA including visual regressions", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store, {
      phase: "executing",
      score: makeQaScore({
        mode: "full",
        pass: false,
        total: 85,
        buckets: {
          p0: { points: 40, max: 40, failed: 0 },
          p1: { points: 30, max: 30, passRate: 1 },
          p2: { points: 15, max: 15, passRate: 1 },
          visual: { points: 0, max: 15, regressions: 1 },
        },
      }),
    });
    await assert.rejects(
      () => engine.ship({ allowDegradedQa: true }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /no-browser/);
        assert.match(err.nextHint, /legion-cli qa/);
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("ship stages deletions of tracked filesAllowed paths", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    initGitRepo(dir);
    await rm(join(dir, "src", "main.ts"));
    const receipt = await engine.ship({
      commit: true,
      confirm: async (preview) => {
        assert.match(preview.diff, /src\/main\.ts/);
        assert.match(preview.diff, /deleted file/);
        return true;
      },
    });
    assert.equal(receipt.phase, "shipped");
    const tree = git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]);
    assert.equal(
      tree.split(/\r?\n/).includes("src/main.ts"),
      false,
      `expected deletion committed, tree=${tree}`,
    );
  });
});

test("ship skips a never-created filesAllowed path", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store, {
      task: { contract: { filesAllowed: ["src/main.ts", "src/ghost.ts"], expectedArtifacts: ["src/main.ts"] } },
    });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    initGitRepo(dir);
    const receipt = await engine.ship();
    assert.equal(receipt.phase, "shipped");
    const staged = git(dir, ["diff", "--cached", "--name-only"]);
    assert.doesNotMatch(staged, /ghost\.ts/);
  });
});

test("ship --pr failure stays ready_to_ship", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    initGitRepo(dir);
    await assert.rejects(
      () =>
        engine.ship({
          pr: true,
          commit: true,
          prCreate: () => ({ error: "gh failed" }),
        }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /gh failed/);
        assert.match(err.nextHint, /legion-cli ship --pr --commit/);
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "ready_to_ship");
  });
});

test("ship --pr without --commit is refused", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    initGitRepo(dir);
    await assert.rejects(
      () => engine.ship({ pr: true, prCreate: () => ({ url: "https://example.test/pr/1" }) }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /--pr requires --commit/);
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "ready_to_ship");
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
