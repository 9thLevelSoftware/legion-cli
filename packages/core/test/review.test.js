import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isSliceTerminal, LegionEngine, LegionRefuseError } from "../dist/index.js";
import {
  initProject,
  makeQaScore,
  makeTask,
  passingVerificationCommand,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  writeUnspawnableGrok,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

function taskMarkdown(task) {
  const lines = [
    "---",
    "schemaVersion: legion-cli-task/v1",
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `type: ${task.type}`,
    `priority: ${task.priority}`,
    `specId: ${task.specId}`,
  ];
  if (task.parentId) lines.push(`parentId: ${task.parentId}`);
  lines.push(
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
  );
  return lines.join("\n");
}

const fixTask = makeTask({
  id: "TSK-0002",
  title: "fix walkthrough finding",
  type: "fix",
  parentId: "TSK-0001",
  status: "todo",
  contract: { filesAllowed: ["src/fix.ts"], expectedArtifacts: ["src/fix.ts"] },
});

test("review refuses unspawnable routes.review without spawning", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, { phase: "executing", task: { status: "done" } });
      await writeUnspawnableGrok(store, { routes: { review: "grok" } });
      await assert.rejects(
        () => engine.review(),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /review needs a spawnable adapter \(grok, via route\)/);
          assert.match(err.nextHint, /doctor/);
          return true;
        },
      );
      assert.equal((await engine.getState()).phase, "executing");
    });
  });
});

test("review spawn with zero new tasks is PASS and stays executing", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store, { phase: "executing", task: { status: "done" } });
        const review = await engine.review();
        assert.equal(review.verdict, "PASS");
        assert.deepEqual(review.createdTaskIds, []);
        assert.equal((await engine.getState()).phase, "executing");
        assert.equal((await engine.getState()).lastReview, "PASS");
      },
      { skillsDir },
    );
  });
});

test("review spawn that files a task is lastReview FAIL", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store, { phase: "executing", task: { status: "done" } });
        const review = await engine.review();
        assert.equal(review.verdict, "FAIL");
        assert.ok(review.createdTaskIds.includes("TSK-0002"));
        assert.equal((await engine.getState()).lastReview, "FAIL");
        assert.equal((await engine.getState()).phase, "executing");
        await assert.rejects(
          () => engine.qa({ score: makeQaScore() }),
          (err) => {
            assert.equal(err instanceof LegionRefuseError, true);
            assert.match(err.nextHint, /legion-cli (next|execute|review)/);
            return true;
          },
        );
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: ".legion-cli/tasks/TSK-0002.md", content: taskMarkdown(fixTask) }],
      },
    );
  });
});

test("review spawn cannot stamp status done; child must execute before re-review PASS", async () => {
  await withFakeAdapter(async () => {
    const verify = [passingVerificationCommand()];
    const stamped = makeTask({
      id: "TSK-0002",
      title: "fix walkthrough finding",
      type: "fix",
      parentId: "TSK-0001",
      status: "done",
      contract: {
        filesAllowed: ["src/fix.ts"],
        expectedArtifacts: ["src/fix.ts"],
        verificationCommands: verify,
      },
    });
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedPlanReady(store, {
          phase: "executing",
          task: { status: "done", contract: { verificationCommands: verify } },
        });
        const review = await engine.review();
        assert.equal(review.verdict, "FAIL");
        assert.ok(review.createdTaskIds.includes("TSK-0002"));
        assert.equal((await engine.getState()).lastReview, "FAIL");
        const child = (await store.readTask("TSK-0002")).data;
        assert.notEqual(child.status, "done");
        assert.notEqual(child.status, "blocked");
        assert.ok(child.status === "todo" || child.status === "ready");
        const slice = await engine.listSliceTasks();
        assert.equal(isSliceTerminal(slice), false);
        await assert.rejects(
          () => engine.review(),
          (err) => {
            assert.equal(err instanceof LegionRefuseError, true);
            assert.match(err.message, /terminal slice/);
            return true;
          },
        );
        // same tree, no review fixture — execute must not rewrite the child as done
        const runner = new LegionEngine(dir, undefined, { skillsDir });
        const executed = await runner.execute("TSK-0002");
        assert.equal(executed.status, "done");
        assert.equal((await store.readTask("TSK-0002")).data.status, "done");
        const later = await runner.review();
        assert.equal(later.verdict, "PASS");
        assert.deepEqual(later.createdTaskIds, []);
        assert.equal((await runner.getState()).lastReview, "PASS");
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: ".legion-cli/tasks/TSK-0002.md", content: taskMarkdown(stamped) }],
      },
    );
  });
});

test("review extras vs SkillContract FAIL the command", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedPlanReady(store, { phase: "executing", task: { status: "done" } });
        await mkdir(join(dir, "src"), { recursive: true });
        await assert.rejects(
          () => engine.review(),
          (err) => {
            assert.equal(err instanceof LegionRefuseError, true);
            assert.match(err.message, /SkillContract/);
            assert.match(err.nextHint, /legion-cli review/);
            return true;
          },
        );
        assert.equal(existsSync(join(dir, "src", "leaked.ts")), false);
        assert.equal((await engine.getState()).phase, "executing");
        assert.notEqual((await engine.getState()).lastReview, "PASS");
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: "src/leaked.ts", content: "export const leaked = true;\n" }],
      },
    );
  });
});

test("verify refuses before executing", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    await assert.rejects(
      () => engine.verify(),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.nextHint, /legion-cli (next|execute)/);
        return true;
      },
    );
  });
});

test("verify is optional notes and is not a ship gate", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
    const result = await engine.verify();
    assert.equal(result.spawned, false);
    assert.deepEqual(result.createdTaskIds, []);
    assert.equal((await engine.getState()).lastReview, "PASS");
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("verify spawn may file fix tasks and sets lastReview FAIL", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
        const result = await engine.verify("TSK-0001");
        assert.equal(result.spawned, true);
        assert.equal(result.notesPath, ".legion-cli/qa/verify.md");
        assert.ok(result.createdTaskIds.includes("TSK-0002"));
        assert.equal((await store.readTask("TSK-0002")).data.type, "fix");
        assert.equal((await store.readTask("TSK-0002")).data.parentId, "TSK-0001");
        assert.equal((await engine.getState()).lastReview, "FAIL");
        assert.equal((await engine.getState()).phase, "executing");
      },
      {
        skillsDir,
        fakeArtifacts: [
          { path: ".legion-cli/qa/verify.md", content: "Walked the in/out button.\n" },
          {
            path: ".legion-cli/cache/runs/<id>/extra.json",
            content: JSON.stringify({
              title: "fix contrast",
              parentId: "TSK-0001",
              filesAllowed: ["src/fix.ts"],
              verificationCommands: ["pnpm test"],
            }),
          },
        ],
      },
    );
  });
});

test("verify spawn cannot stamp status done or blocked", async () => {
  await withFakeAdapter(async () => {
    const stamped = makeTask({
      id: "TSK-0002",
      title: "fix contrast",
      type: "fix",
      parentId: "TSK-0001",
      status: "blocked",
      contract: { filesAllowed: ["src/fix.ts"], expectedArtifacts: ["src/fix.ts"] },
    });
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
        const result = await engine.verify();
        assert.ok(result.createdTaskIds.includes("TSK-0002"));
        const child = (await store.readTask("TSK-0002")).data;
        assert.notEqual(child.status, "done");
        assert.notEqual(child.status, "blocked");
        assert.ok(child.status === "todo" || child.status === "ready");
        assert.equal((await engine.getState()).lastReview, "FAIL");
        assert.equal(isSliceTerminal(await engine.listSliceTasks()), false);
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: ".legion-cli/tasks/TSK-0002.md", content: taskMarkdown(stamped) }],
      },
    );
  });
});

test("verify extras vs SkillContract FAIL the command", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedPlanReady(store, { phase: "executing", task: { status: "done" } });
        await mkdir(join(dir, "src"), { recursive: true });
        await assert.rejects(
          () => engine.verify(),
          (err) => {
            assert.equal(err instanceof LegionRefuseError, true);
            assert.match(err.message, /SkillContract/);
            assert.match(err.nextHint, /legion-cli verify/);
            return true;
          },
        );
        assert.equal(existsSync(join(dir, "src", "leaked.ts")), false);
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: "src/leaked.ts", content: "export const leaked = true;\n" }],
      },
    );
  });
});
