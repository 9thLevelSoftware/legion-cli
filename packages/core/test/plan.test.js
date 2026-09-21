import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LegionRefuseError } from "../dist/index.js";
import {
  initProject,
  makeTask,
  readLatestRunPrompt,
  seedFrozenSpec,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  writeTask,
  writeUnspawnableGrok,
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
        assert.match(err.message, /plan needs a spawnable adapter \(fake, via default\)/);
        assert.match(err.nextHint, /doctor/);
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "spec_frozen");
  });
});

test("spawnable default plus unspawnable routes.plan refuses before phase planning", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedFrozenSpec(store);
      await writeUnspawnableGrok(store, { routes: { plan: "grok" } });
      await assert.rejects(
        () => engine.plan("spec-checkin"),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /plan needs a spawnable adapter \(grok, via route\)/);
          assert.match(err.nextHint, /doctor/);
          return true;
        },
      );
      assert.equal((await engine.getState()).phase, "spec_frozen");
    });
  });
});

test("adapter: not-a-cli is an unreadable task and plan FAILs", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedFrozenSpec(store);
      const task = makeTask();
      await writeFile(
        join(store.paths.tasksDir, "TSK-0001.md"),
        taskMarkdown(task).replace("specId: spec-checkin\n", "specId: spec-checkin\nadapter: not-a-cli\n"),
        "utf8",
      );
      const readiness = await engine.plan("spec-checkin");
      assert.equal(readiness, "FAIL");
      assert.equal((await engine.getState()).phase, "plan_failed");
      assert.ok(engine.getLastPlanReport().fails.some((line) => /TSK-0001 is not a valid task/.test(line)));
    });
  });
});

test("parent grok plus extra.json gpt-4 child inherits grok", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
        await writeTask(store, makeTask({ adapter: "grok" }));
        const readiness = await engine.plan("spec-checkin");
        assert.equal(readiness, "CONCERNS");
        const child = (await store.readTask("TSK-0002")).data;
        assert.equal(child.parentId, "TSK-0001");
        assert.equal(child.adapter, "grok");
        assert.equal((await store.readTask("TSK-0001")).data.adapter, "grok");
      },
      {
        skillsDir,
        fakeArtifacts: [
          {
            path: ".legion-cli/cache/runs/<id>/extra.json",
            content: JSON.stringify({
              title: "also do settings",
              parentId: "TSK-0001",
              adapter: "gpt-4",
              filesAllowed: ["src/settings.ts"],
              verificationCommands: ["pnpm test"],
            }),
          },
        ],
      },
    );
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
        // KD-5: `parentId` is provenance, not a dependency edge (F-053).
        assert.deepEqual(child.blockedBy, []);
        const afterParent = slice.find((task) => task.id === "TSK-0001");
        assert.deepEqual(afterParent.contract.filesAllowed, ["src/main.ts"]);
        assert.equal(afterParent.blocks.includes("TSK-0002"), false);
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
    // KD-5: parked work is ready as soon as its own contract is valid — it does not wait on the
    // task it came out of, which may itself end up blocked.
    assert.equal(ticket.status, "ready");
    const parent = (await store.readTask("TSK-0001")).data;
    assert.deepEqual(parent.contract.filesAllowed, ["src/main.ts"]);
    assert.equal(parent.blocks.includes(ticket.id), false);
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
    assert.equal(amended.status, "todo");
    await engine.amendTask("TSK-0001", amended.contract, { adapter: "grok" });
    assert.equal((await store.readTask("TSK-0001")).data.adapter, "grok");
    assert.deepEqual((await store.readTask("TSK-0001")).data.contract.filesAllowed, ["src/in-out.ts"]);
    await engine.amendTask("TSK-0001", (await store.readTask("TSK-0001")).data.contract, { clearAdapter: true });
    assert.equal((await store.readTask("TSK-0001")).data.adapter, undefined);
    const cleared = (await store.readTask("TSK-0001")).data.contract;
    await assert.rejects(
      () => engine.amendTask("TSK-0001", cleared, { adapter: "grok", clearAdapter: true }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /mutually exclusive/);
        return true;
      },
    );
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

test("plan spawn cannot stamp status done", async () => {
  await withFakeAdapter(async () => {
    const p0 = makeTask({ status: "done" });
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
        const readiness = await engine.plan("spec-checkin");
        assert.equal(readiness, "CONCERNS");
        const task = (await store.readTask("TSK-0001")).data;
        assert.equal(task.status, "ready");
        assert.notEqual(task.status, "done");
        assert.equal(existsSync(join(store.paths.tasksDir, "TSK-0001.md")), true);
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: ".legion-cli/tasks/TSK-0001.md", content: taskMarkdown(p0) }],
      },
    );
  });
});

test("extra.json glob is filed as notes ticket, not PersistValidationError", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
        await writeTask(store, makeTask());
        const readiness = await engine.plan("spec-checkin");
        assert.equal(readiness, "CONCERNS");
        const child = (await store.readTask("TSK-0002")).data;
        assert.equal(child.title, "also glob");
        assert.deepEqual(child.contract.filesAllowed, ["notes/TSK-0002.md"]);
        assert.equal((await store.readTask("TSK-0001")).data.status, "ready");
      },
      {
        skillsDir,
        fakeArtifacts: [
          {
            path: ".legion-cli/cache/runs/<id>/extra.json",
            content: JSON.stringify({
              title: "also glob",
              parentId: "TSK-0001",
              filesAllowed: ["src/**"],
            }),
          },
        ],
      },
    );
  });
});

test("extra.json is filed even when SkillContract extras are reverted", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedFrozenSpec(store);
        await writeTask(store, makeTask());
        await mkdir(join(dir, "src"), { recursive: true });
        const readiness = await engine.plan("spec-checkin");
        assert.equal(readiness, "FAIL");
        assert.equal(existsSync(join(dir, "src", "main.ts")), false);
        const child = (await store.readTask("TSK-0002")).data;
        assert.equal(child.parentId, "TSK-0001");
        assert.deepEqual((await store.readTask("TSK-0001")).data.contract.filesAllowed, ["src/main.ts"]);
      },
      {
        skillsDir,
        fakeArtifacts: [
          { path: "src/main.ts", content: "export const leaked = true;\n" },
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

test("extra.json is filed when wait() throws after write", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedFrozenSpec(store);
        await writeTask(store, makeTask());
        await mkdir(join(dir, "src"), { recursive: true });
        const readiness = await engine.plan("spec-checkin");
        assert.equal(readiness, "FAIL");
        assert.equal(existsSync(join(dir, "src", "main.ts")), false);
        const child = (await store.readTask("TSK-0002")).data;
        assert.equal(child.parentId, "TSK-0001");
        assert.deepEqual((await store.readTask("TSK-0001")).data.contract.filesAllowed, ["src/main.ts"]);
      },
      {
        skillsDir,
        fakeThrowAfterWrite: true,
        fakeArtifacts: [
          { path: "src/main.ts", content: "export const leaked = true;\n" },
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

test("unblocked ticket is stored ready so next/execute can pick it", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store);
    const ticket = await engine.fileTicket({ title: "parked extra" });
    assert.equal(ticket.parentId, undefined);
    assert.equal(ticket.status, "ready");
    const ready = await engine.nextTasks();
    assert.ok(ready.some((task) => task.id === ticket.id));
    // KD-5: a child of a live task is not blocked by it — `parentId` records where it came from.
    const child = await engine.fileTicket({ title: "child of live task", parentId: "TSK-0001" });
    assert.equal(child.status, "ready");
    assert.deepEqual(child.blockedBy, []);
    const after = await engine.nextTasks();
    assert.equal(
      after.some((task) => task.id === child.id),
      true,
    );
  });
});

test("filesAllowed intersecting implicit forbidden is plan FAIL", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
      await writeTask(store, makeTask({ contract: { filesAllowed: [".env"], expectedArtifacts: [".env"] } }));
      const envFail = await engine.plan("spec-checkin");
      assert.equal(envFail, "FAIL");
      assert.ok(engine.getLastPlanReport().fails.some((line) => /forbidden path/.test(line)));
    });
  });
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
      await writeTask(
        store,
        makeTask({
          contract: {
            filesAllowed: [".legion-cli/config.yaml"],
            expectedArtifacts: [".legion-cli/config.yaml"],
          },
        }),
      );
      const configFail = await engine.plan("spec-checkin");
      assert.equal(configFail, "FAIL");
      assert.ok(engine.getLastPlanReport().fails.some((line) => /forbidden path/.test(line)));
    });
  });
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
      await writeTask(
        store,
        makeTask({
          contract: {
            filesAllowed: [".legion-cli/STATE.md"],
            expectedArtifacts: [".legion-cli/STATE.md"],
          },
        }),
      );
      const stateFail = await engine.plan("spec-checkin");
      assert.equal(stateFail, "FAIL");
      assert.ok(engine.getLastPlanReport().fails.some((line) => /forbidden path/.test(line)));
    });
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

test("plan prompt.md starts with SessionBrief and has no FileContract heading", async () => {
  await withFakeAdapter(async () => {
    const p0 = makeTask();
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
        const readiness = await engine.plan("spec-checkin");
        assert.equal(readiness, "CONCERNS");
        const prompt = await readLatestRunPrompt(dir, "plan");
        assert.ok(prompt.startsWith("## SessionBrief\nProject:"));
        assert.match(prompt, /## SkillContract/);
        assert.match(prompt, /plan \(active\)/);
        assert.doesNotMatch(prompt, /^## FileContract$/m);
        assert.ok(prompt.indexOf("## SessionBrief") < prompt.indexOf("## SkillContract"));
      },
      {
        skillsDir,
        fakeArtifacts: [{ path: ".legion-cli/tasks/TSK-0001.md", content: taskMarkdown(p0) }],
      },
    );
  });
});
