import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readAuditEvents } from "@9thlevelsoftware/legion-cli-persist";
import { LegionEngine, LegionRefuseError } from "../dist/index.js";
import {
  initProject,
  makeTask,
  passingVerificationCommand,
  readLatestRunPrompt,
  seedFrozenSpec,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  withReviewNotes,
  writeTask,
  writeUnspawnableGrok,
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

test("the review prompt names the concrete run-cache notes path, never a literal <id>", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await seedDone(engine, store);
        await engine.review();
        const prompt = await readLatestRunPrompt(dir, "review");
        assert.match(prompt, /\.legion-cli\/cache\/runs\/review-[a-z0-9-]+\/review\.md/);
        assert.doesNotMatch(prompt, /<id>/);
      },
      withReviewNotes({ skillsDir }),
    );
  });
});

test("a notes path that is a directory, or is over 1 MiB, is refused and never copied to qa/", async () => {
  await withFakeAdapter(async () => {
    for (const [label, options, expected] of [
      [
        "directory",
        null,
        /not a regular file/,
      ],
      [
        "oversized",
        {
          skillsDir,
          fakeArtifacts: [{ path: ".legion-cli/cache/runs/<id>/review.md", content: "x".repeat(1024 * 1024 + 1) }],
        },
        /larger than 1048576 bytes/,
      ],
    ]) {
      await withEngine(async ({ engine, store, dir }) => {
        await seedDone(engine, store);
        let opts = options;
        if (label === "directory") {
          opts = {
            skillsDir,
            fakeOnWait: async () => {
              const runsDir = join(dir, ".legion-cli", "cache", "runs");
              const name = (await readdir(runsDir)).find((entry) => entry.startsWith("review-"));
              await mkdir(join(runsDir, name, "review.md"), { recursive: true });
            },
          };
        }
        const reviewer = new LegionEngine(dir, undefined, opts);
        await assert.rejects(
          () => reviewer.review(),
          (err) => {
            assert.equal(err instanceof LegionRefuseError, true);
            assert.match(err.message, expected);
            return true;
          },
        );
        assert.equal((await engine.getState()).lastReview ?? null, null);
        assert.equal(existsSync(reviewNotesPath(dir)), false, label);
      });
    }
  });
});

test("a symlinked notes file is refused, not followed", async (t) => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await seedDone(engine, store);
      const secret = join(dir, "secret.txt");
      await writeFile(secret, "do not copy me", "utf8");
      let linked = true;
      const reviewer = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeOnWait: async () => {
          const runsDir = join(dir, ".legion-cli", "cache", "runs");
          const name = (await readdir(runsDir)).find((entry) => entry.startsWith("review-"));
          try {
            await symlink(secret, join(runsDir, name, "review.md"));
          } catch {
            linked = false;
          }
        },
      });
      await assert.rejects(() => reviewer.review(), /wrote no notes|not a regular file/);
      if (!linked) {
        t.skip("symlinks not permitted here");
        return;
      }
      assert.equal(existsSync(reviewNotesPath(dir)), false);
    });
  });
});

test("a reviewer that exits 1 after filing a task is a FAIL with an exit warning", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await seedDone(engine, store);
        const review = await engine.review();
        assert.equal(review.verdict, "FAIL");
        assert.ok(review.warnings.some((line) => /agent exited with code 1/.test(line)), review.warnings.join("\n"));
        assert.equal((await engine.getState()).lastReview, "FAIL");
      },
      {
        skillsDir,
        fakeExitCode: 1,
        fakeArtifacts: [
          {
            path: ".legion-cli/cache/runs/<id>/extra.json",
            content: JSON.stringify({
              title: "fix finding",
              parentId: "TSK-0001",
              type: "fix",
              filesAllowed: ["src/fix.ts"],
              expectedArtifacts: ["src/fix.ts"],
              verificationCommands: ["pnpm test"],
            }),
          },
        ],
      },
    );
  });
});

test("plan records a non-zero agent exit as a concern and an audit event", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedFrozenSpec(store);
        await writeTask(store, makeTask());
        await engine.plan("spec-checkin");
        const concerns = engine.getLastPlanReport()?.concerns ?? [];
        assert.ok(concerns.some((line) => /plan agent exited with code 3/.test(line)), concerns.join("\n"));
        const events = (await readAuditEvents(dir)).filter((event) => event.type === "plan");
        assert.equal(events.length, 1);
        assert.equal(events[0].data.agentExitCode, 3);
      },
      { skillsDir, fakeExitCode: 3 },
    );
  });
});

test("verify warns and audits a non-zero agent exit, and says when it was skipped", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await seedDone(engine, store);
        const result = await engine.verify();
        assert.ok(result.warnings.some((line) => /verify agent exited with code 2/.test(line)), result.warnings.join("\n"));
        const events = (await readAuditEvents(dir)).filter((event) => event.type === "verify");
        assert.equal(events[0].data.agentExitCode, 2);
      },
      { skillsDir, fakeExitCode: 2 },
    );
    await withEngine(
      async ({ engine, store }) => {
        await seedDone(engine, store);
        await writeUnspawnableGrok(store, { routes: { verify: "grok" } });
        const result = await engine.verify();
        assert.equal(result.spawned, false);
        assert.deepEqual(result.warnings.length, 1);
        assert.match(result.warnings[0], /^verify skipped: no agent ran \(grok, via route\)/);
      },
      { skillsDir },
    );
  });
});
