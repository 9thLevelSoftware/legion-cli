import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LegionEngine, LegionRefuseError } from "../dist/index.js";
import {
  initProject,
  passingVerificationCommand,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  withReviewNotes,
  writeTask,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
const reviewNotesPath = (dir) => join(dir, ".legion-cli", "qa", "review.md");

async function seedDone(engine, store) {
  await initProject(engine);
  await seedPlanReady(store, { phase: "executing", task: { status: "done" } });
}

test("a reviewer that exits 1 does not yield PASS and records no lastReview", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await seedDone(engine, store);
        await assert.rejects(
          () => engine.review(),
          (err) => {
            assert.equal(err instanceof LegionRefuseError, true);
            assert.match(err.message, /agent exited with code 1/);
            assert.match(err.message, /\.legion-cli\/cache\/runs\/review-[^/]+\/stderr\.log/);
            assert.match(err.message, /re-run legion-cli review/);
            return true;
          },
        );
        const state = await engine.getState();
        assert.equal(state.lastReview ?? null, null);
        assert.equal(state.phase, "executing");
      },
      withReviewNotes({ skillsDir, fakeExitCode: 1 }),
    );
  });
});

test("a reviewer that writes no notes file does not yield PASS", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await seedDone(engine, store);
        await assert.rejects(
          () => engine.review(),
          (err) => {
            assert.equal(err instanceof LegionRefuseError, true);
            assert.match(err.message, /wrote no notes to \.legion-cli\/cache\/runs\/review-[^/]+\/review\.md/);
            return true;
          },
        );
        assert.equal((await engine.getState()).lastReview ?? null, null);
      },
      { skillsDir, fakeOmitSummary: true },
    );
  });
});

test("an empty notes file does not yield PASS", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await seedDone(engine, store);
        await assert.rejects(() => engine.review(), /wrote no notes/);
        assert.equal((await engine.getState()).lastReview ?? null, null);
        assert.equal(existsSync(reviewNotesPath(dir)), false);
      },
      { skillsDir, fakeArtifacts: [{ path: ".legion-cli/cache/runs/<id>/review.md", content: "  \n" }] },
    );
  });
});

test("a reviewer that exits 0 with notes still PASSes", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await seedDone(engine, store);
        const review = await engine.review();
        assert.equal(review.verdict, "PASS");
        assert.equal((await engine.getState()).lastReview, "PASS");
        assert.match(await readFile(reviewNotesPath(dir), "utf8"), /acceptance criteria/);
      },
      withReviewNotes({ skillsDir }),
    );
  });
});

test("a stale review.md from an earlier round cannot satisfy a later review", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await seedDone(engine, store);
        // Round 1: a reviewer that files a fix task -> FAIL, notes on disk.
        const first = new LegionEngine(
          dir,
          undefined,
          withReviewNotes({
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
          }),
        );
        const round1 = await first.review();
        assert.equal(round1.verdict, "FAIL");
        assert.equal(existsSync(reviewNotesPath(dir)), true);
        assert.equal((await engine.getState()).lastReview, "FAIL");

        // The fix task gets done; the terminal slice is reviewed again by an agent that exits 0 and writes nothing.
        await writeTask(store, { ...(await store.readTask("TSK-0002")).data, status: "done" });
        await assert.rejects(
          () => engine.review(),
          (err) => {
            assert.equal(err instanceof LegionRefuseError, true);
            assert.match(err.message, /wrote no notes/);
            return true;
          },
        );
        assert.equal(existsSync(reviewNotesPath(dir)), false, "the stale notes were removed before the spawn");
        const state = await engine.getState();
        assert.notEqual(state.lastReview, "PASS");
        await assert.rejects(
          () => engine.ship({}),
          (err) => {
            assert.equal(err instanceof LegionRefuseError, true);
            assert.match(err.message, /Review must PASS before shipping/);
            return true;
          },
        );
      },
      { skillsDir },
    );
  });
});

test("execute records a non-zero agent exit as a warning, not a refusal", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store, {
          phase: "plan_ready",
          task: { status: "ready", contract: { verificationCommands: [passingVerificationCommand()] } },
        });
        const result = await engine.execute("TSK-0001");
        assert.ok(result.warnings.some((line) => /agent exited with code 3/.test(line)), result.warnings.join("\n"));
      },
      { skillsDir, fakeExitCode: 3 },
    );
  });
});

// Real child process (generic adapter) instead of the in-process fake: the exit code travels through
// spawnAgentProcess, so this is the path a crashed or logged-out agent CLI takes.
for (const [label, script, expected] of [
  ["exits 1", "process.exit(1);", /agent exited with code 1/],
  ["exits 0 without writing notes", "process.exit(0);", /wrote no notes to/],
]) {
  test(`a real agent process that ${label} does not yield PASS`, async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await seedDone(engine, store);
        const scriptPath = join(dir, "agent.js");
        await writeFile(scriptPath, script, "utf8");
        const config = await store.readConfig();
        await store.writeConfig({
          ...config,
          adapter: {
            ...config.adapter,
            default: "generic",
            generic: { binary: process.execPath, args: [scriptPath, "{{pointer}}"] },
          },
        });
        await assert.rejects(
          () => engine.review(),
          (err) => {
            assert.equal(err instanceof LegionRefuseError, true);
            assert.match(err.message, expected);
            return true;
          },
        );
        assert.equal((await engine.getState()).lastReview ?? null, null);
      },
      { skillsDir },
    );
  });
}
