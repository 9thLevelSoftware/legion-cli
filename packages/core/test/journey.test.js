import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LegionEngine, LegionRefuseError } from "../dist/index.js";
import { specHasUi } from "@9thlevelsoftware/legion-cli-qa";
import {
  commitAll,
  git,
  gitHead,
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

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

/** init -> intent -> discuss -> spec approve -> plan, all through the engine's own verbs. */
async function driveToPlanReady(engine, store, dir) {
  await engine.beginIntent();
  await engine.intentTurn([
    "Teammates who keep missing who's in the office.",
    "They ping five chat apps every morning.",
  ]);
  await engine.intentTurn([
    "People can tap in or out on their phone in under five seconds.",
    "No payroll, no badges, no calendar sync in v0.",
  ]);
  await engine.intentTurn(["existing auth"]);
  await engine.intentTurn([
    "Open the board, tap In, see yourself listed, tap Out, see yourself leave.",
    "Empty board, network error, changed mind.",
  ]);
  await engine.intentTurn(["board", "phone"]);
  await engine.intentTurn(["none", "none"]);
  await engine.confirmIntent({ id: "tester" });
  assert.equal((await engine.getState()).phase, "intent_ready");

  const proposed = await engine.startDiscuss();
  await engine.discuss(proposed.map((item) => ({ id: item.id, status: "accepted" })));
  assert.equal((await engine.getState()).phase, "discussing");
  const spec = await engine.draftSpec({ skipWireframes: true });
  await engine.approveSpec(spec.id, { id: "tester" }, { message: "looks right" });
  assert.equal((await engine.getState()).phase, "spec_frozen");

  // The planner agent's output: one task that the fake execute adapter can complete.
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
  assert.equal((await engine.getState()).phase, "plan_ready");
  return spec;
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

for (const setup of ["committed-before-ship", "first-committed-by-ship", "older-baseline"]) {
  test(`journey: init to ship, then undo keeps phase, task and receipt in agreement (${setup})`, async () => {
    await withFakeAdapter(async () => {
      await withEngine(async ({ dir, engine, store }) => {
        await initProject(engine);
        await driveToPlanReady(engine, store, dir);
        initGitRepo(dir);
        if (setup === "first-committed-by-ship") {
          git(dir, ["rm", "-r", "--cached", "-q", ".legion-cli"]);
          git(dir, ["commit", "-m", "stop tracking legion state"]);
        }

        const exec = await engine.execute("auto");
        assert.equal(exec.status, "done");
        assert.equal((await engine.getState()).phase, "executing");
        assert.equal((await store.readTask("TSK-0001")).data.status, "done");

        const review = await new LegionEngine(dir, undefined, withReviewNotes({ skillsDir })).review();
        assert.equal(review.verdict, "PASS");
        await engine.qa({ score: await passingQaForActiveSpec(engine, store) });
        assert.equal((await engine.getState()).phase, "ready_to_ship");

        if (setup === "committed-before-ship") commitAll(dir, "legion state before ship");
        const before = gitHead(dir);
        const receipt = await engine.ship({ commit: true });
        assert.equal(receipt.committed, true);
        assert.equal((await engine.getState()).phase, "shipped");
        assert.notEqual(gitHead(dir), before);

        if (setup === "first-committed-by-ship") {
          // The ship commit is the first to contain .legion-cli/: reverting it deletes STATE.md.
          const shipHead = gitHead(dir);
          await assert.rejects(
            () => engine.undoLastTask(),
            (err) => err instanceof LegionRefuseError && /would remove \.legion-cli\/STATE\.md/.test(err.message),
          );
          assert.equal(gitHead(dir), shipHead, "refused undo leaves HEAD on the ship commit");
          assert.equal(existsSync(join(dir, ".git", "REVERT_HEAD")), false);
          assert.equal((await engine.getState()).phase, "shipped");
          assert.equal((await store.readTask("TSK-0001")).data.status, "done");
          return;
        }

        const undone = await engine.undoLastTask();
        assert.equal(undone.taskId, "TSK-0001");
        const state = await engine.getState();
        assert.equal(state.lastReview, null);
        assert.equal(state.lastQaId, null);
        if (setup === "older-baseline") {
          // .legion-cli was last committed at plan_ready: the revert restores that snapshot, and the
          // phase and task agree with it (the stale done task doc is not written back over it).
          assert.equal(state.phase, "plan_ready");
          assert.equal((await store.readTask("TSK-0001")).data.status, "ready");
        } else {
          assert.equal(state.phase, "executing");
          assert.equal((await store.readTask("TSK-0001")).data.status, "todo");
        }
        assert.equal(existsSync(join(dir, ".git", "REVERT_HEAD")), false);
        // The revert deletes the receipt; undo puts it back, marked reverted.
        const kept = await readFile(join(store.paths.auditDir, "ship-spec-checkin.md"), "utf8");
        assert.match(kept, /committed: true/);
        assert.match(kept, /- reverted: true/);
        // Shipping again is refused until the work is redone.
        await assert.rejects(() => engine.ship(), (err) => err instanceof LegionRefuseError);
      });
    });
  });
}

test("journey: a failing reviewer blocks qa and ship", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, engine, store }) => {
      await initProject(engine);
      const spec = await driveToPlanReady(engine, store, dir);
      initGitRepo(dir);
      await engine.execute("auto");
      const review = await new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [
          {
            path: ".legion-cli/cache/runs/<id>/extra.json",
            content: JSON.stringify({
              title: "fix walkthrough finding",
              parentId: "TSK-0001",
              type: "fix",
              filesAllowed: ["src/fix.ts"],
              expectedArtifacts: ["src/fix.ts"],
              verificationCommands: ["pnpm test"],
            }),
          },
        ],
      }).review();
      assert.equal(review.verdict, "FAIL");
      assert.equal((await engine.getState()).lastReview, "FAIL");
      await assert.rejects(
        () => engine.qa({ score: makeQaScore({ specId: spec.id }) }),
        (err) => err instanceof LegionRefuseError,
      );
      await assert.rejects(() => engine.ship(), (err) => err instanceof LegionRefuseError);
      assert.notEqual((await engine.getState()).phase, "shipped");
      assert.equal((await engine.getState()).phase, "executing");
      const fix = await store.readTask("TSK-0002");
      assert.equal(fix.data.title, "fix walkthrough finding");
      assert.equal(fix.data.status === "done", false);
    });
  });
});

async function shippedProject(engine, store, dir, opts) {
  await initProject(engine);
  await driveToPlanReady(engine, store, dir);
  initGitRepo(dir);
  await engine.execute("auto");
  await new LegionEngine(dir, undefined, withReviewNotes({ skillsDir })).review();
  await engine.qa({ score: await passingQaForActiveSpec(engine, store) });
  return engine.ship(opts);
}

for (const variant of ["ship without --commit", "a later commit on top of the ship commit"]) {
  test(`journey: undo after ${variant} rewinds the phase and marks the receipt reverted`, async () => {
    await withFakeAdapter(async () => {
      await withEngine(async ({ dir, engine, store }) => {
        const shipHere = variant.startsWith("ship without");
        await shippedProject(engine, store, dir, shipHere ? {} : { commit: true });
        if (!shipHere) git(dir, ["commit", "--allow-empty", "-m", "later work"]);
        assert.equal((await engine.getState()).phase, "shipped");

        const undone = await engine.undoLastTask();
        assert.equal(undone.commitSha, null, "no ship commit at HEAD, so nothing is reverted in git");
        const state = await engine.getState();
        assert.equal(state.phase, "executing");
        assert.equal(state.lastReview, null);
        assert.equal(state.lastQaId, null);
        assert.equal((await store.readTask("TSK-0001")).data.status, "todo");
        const receipt = await readFile(join(store.paths.auditDir, "ship-spec-checkin.md"), "utf8");
        assert.match(receipt, /- reverted: true/);
        assert.equal((receipt.match(/- reverted: true/g) ?? []).length, 1);
      });
    });
  });
}

test("no package outside core writes lifecycle documents through the engine's store", async () => {
  const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  // Every lifecycle writer of the store, by dot, bracket or destructuring access. wiki legitimately
  // writes wiki pages and YAML through its own store handle, so it is checked for lifecycle writers only.
  const lifecycle = "write(?:State|Spec|Task|Project|Config|Context|Discuss|IntentAnswers|Decision|Assumption|Packet)\\w*";
  const anyWriter = "(?:write|delete|append)[A-Z]\\w*";
  const patterns = (writer) => [
    new RegExp(`\\bstore\\s*(?:\\?\\.|\\.)\\s*${writer}\\b`),
    new RegExp(`\\bstore\\s*\\[\\s*["'\`]${writer}`),
    new RegExp(`\\{[^}]*\\b${writer}\\b[^}]*\\}\\s*=\\s*[\\w.]*store\\b`),
  ];
  const offenders = [];
  let visited = 0;
  for (const pkg of await readdir(packagesDir)) {
    if (pkg === "core" || pkg === "persist") continue;
    const srcDir = join(packagesDir, pkg, "src");
    if (!existsSync(srcDir)) continue;
    const forbidden = patterns(pkg === "wiki" ? lifecycle : anyWriter);
    for (const name of await readdir(srcDir, { recursive: true })) {
      if (!/\.(ts|mts|js|mjs)$/.test(String(name))) continue;
      visited += 1;
      const text = await readFile(join(srcDir, String(name)), "utf8");
      if (forbidden.some((re) => re.test(text))) offenders.push(`${pkg}/src/${name}`);
    }
  }
  assert.ok(visited > 50, `the scan visited ${visited} files; the layout changed`);
  assert.deepEqual(offenders, []);
});
