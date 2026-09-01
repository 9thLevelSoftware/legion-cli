import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LegionRefuseError } from "../dist/index.js";
import {
  initProject,
  makeTask,
  seedFrozenSpec,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  writeTask,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

function taskMarkdown(task) {
  return [
    "---",
    "schemaVersion: legion-cli-task/v1",
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `type: ${task.type}`,
    `priority: ${task.priority}`,
    `specId: ${task.specId}`,
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
    ...task.contract.verificationCommands.map((cmd) => `    - ${cmd}`),
    "assignee: agent",
    'notes: ""',
    "---",
    "",
    `${task.title}.`,
    "",
  ].join("\n");
}

test("plan refuses without a spawnable adapter", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedFrozenSpec(store);
    await writeTask(store, makeTask());
    await assert.rejects(
      () => engine.plan("spec-checkin"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /spawnable adapter/);
        assert.match(err.nextHint, /doctor/);
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "spec_frozen");
  });
});

test("empty verificationCommands is plan FAIL", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedFrozenSpec(store);
      await writeTask(store, makeTask({ contract: { verificationCommands: [] } }));
      const readiness = await engine.plan("spec-checkin");
      assert.equal(readiness, "FAIL");
      assert.equal((await engine.getState()).phase, "plan_failed");
      assert.ok(engine.getLastPlanReport().fails.some((line) => /verificationCommands/.test(line)));
    });
  });
});

test("overlapping filesAllowed is plan FAIL", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
      await writeTask(store, makeTask());
      await writeTask(
        store,
        makeTask({
          id: "TSK-0002",
          contract: { filesAllowed: ["src/main.ts"], expectedArtifacts: ["src/main.ts"] },
        }),
      );
      const readiness = await engine.plan("spec-checkin");
      assert.equal(readiness, "FAIL");
      assert.equal((await engine.getState()).phase, "plan_failed");
      assert.ok(engine.getLastPlanReport().fails.some((line) => /overlapping filesAllowed/.test(line)));
    });
  });
});

test("plan spawn that writes src/main.ts is reverted and plan FAILs", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedFrozenSpec(store);
        await mkdir(join(dir, "src"), { recursive: true });
        const readiness = await engine.plan("spec-checkin");
        assert.equal(readiness, "FAIL");
        assert.equal((await engine.getState()).phase, "plan_failed");
        assert.equal(existsSync(join(dir, "src", "main.ts")), false);
        assert.ok(
          engine.getLastPlanReport().fails.some((line) => /SkillContract/.test(line) && /src\/main\.ts/.test(line)),
        );
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: "src/main.ts", content: "export const leaked = true;\n" }],
      },
    );
  });
});

test("extra work becomes a linked ticket, not an expansion", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
        const parent = makeTask();
        await writeTask(store, parent);
        const readiness = await engine.plan("spec-checkin");
        assert.equal(readiness, "CONCERNS");
        const slice = await engine.listSliceTasks();
        const child = slice.find((task) => task.parentId === "TSK-0001");
        assert.ok(child, "expected linked ticket");
        assert.equal(child.id, "TSK-0002");
        assert.deepEqual(child.blockedBy, ["TSK-0001"]);
        const afterParent = slice.find((task) => task.id === "TSK-0001");
        assert.deepEqual(afterParent.contract.filesAllowed, ["src/main.ts"]);
        assert.ok(afterParent.blocks.includes("TSK-0002"));
      },
      {
        skillsDir,
        fakeArtifacts: [
          {
            path: ".legion-cli/cache/runs/<id>/extra.json",
            content: JSON.stringify({
              title: "also do settings",
              parentId: "TSK-0001",
              filesAllowed: ["src/settings.ts"],
              verificationCommands: ["pnpm test"],
            }),
          },
        ],
      },
    );
  });
});

test("fileTicket parks extra work and expandCurrentTask still refuses", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", currentTaskId: "TSK-0001", lastReview: "PASS" });
    const ticket = await engine.fileTicket({
      title: "also do settings",
      parentId: "TSK-0001",
    });
    assert.equal(ticket.parentId, "TSK-0001");
    assert.equal(ticket.status, "todo");
    const parent = (await store.readTask("TSK-0001")).data;
    assert.deepEqual(parent.contract.filesAllowed, ["src/main.ts"]);
    assert.ok(parent.blocks.includes(ticket.id));
    assert.equal((await engine.getState()).lastReview, "FAIL");
    await assert.rejects(
      () => engine.expandCurrentTask("also do settings in-place"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.nextHint, /ticket create --parent/);
        return true;
      },
    );
  });
});

test("amendTask updates FileContract and deps require --allow-deps", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, {
      extraTasks: [
        makeTask({
          id: "TSK-0002",
          status: "todo",
          contract: { filesAllowed: ["src/board.ts"], expectedArtifacts: ["src/board.ts"] },
        }),
      ],
    });
    const current = (await store.readTask("TSK-0001")).data.contract;
    await assert.rejects(
      () => engine.amendTask("TSK-0001", current, { blockedBy: ["TSK-0002"] }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /--allow-deps/);
        return true;
      },
    );
    await engine.amendTask(
      "TSK-0001",
      {
        filesAllowed: ["src/in-out.ts"],
        filesForbidden: [".git/**"],
        expectedArtifacts: ["src/in-out.ts"],
        verificationCommands: ["pnpm test"],
      },
      { allowDeps: true, blockedBy: ["TSK-0002"] },
    );
    const amended = (await store.readTask("TSK-0001")).data;
    assert.deepEqual(amended.contract.filesAllowed, ["src/in-out.ts"]);
    assert.deepEqual(amended.blockedBy, ["TSK-0002"]);
    await assert.rejects(
      () =>
        engine.amendTask("TSK-0002", {
          filesAllowed: ["src/in-out.ts"],
          filesForbidden: [".git/**"],
          expectedArtifacts: ["src/in-out.ts"],
          verificationCommands: ["pnpm test"],
        }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /overlapping filesAllowed/);
        return true;
      },
    );
  });
});

test("nextTasks returns unblocked P0 then oldest", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, {
      extraTasks: [
        makeTask({
          id: "TSK-0002",
          priority: "P0",
          status: "todo",
          blockedBy: ["TSK-0001"],
          contract: { filesAllowed: ["src/board.ts"], expectedArtifacts: ["src/board.ts"] },
        }),
        makeTask({
          id: "TSK-0003",
          priority: "P1",
          status: "ready",
          contract: { filesAllowed: ["src/empty.ts"], expectedArtifacts: ["src/empty.ts"] },
        }),
      ],
    });
    const ready = await engine.nextTasks();
    assert.deepEqual(
      ready.map((task) => task.id),
      ["TSK-0001", "TSK-0003"],
    );
  });
});

test("plan spawn can emit a P0 task via fake fixture", async () => {
  await withFakeAdapter(async () => {
    const p0 = makeTask();
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
        const readiness = await engine.plan("spec-checkin");
        assert.equal(readiness, "CONCERNS");
        const slice = await engine.listSliceTasks();
        assert.equal(slice[0].id, "TSK-0001");
        assert.equal(slice[0].priority, "P0");
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: ".legion-cli/tasks/TSK-0001.md", content: taskMarkdown(p0) }],
      },
    );
  });
});
