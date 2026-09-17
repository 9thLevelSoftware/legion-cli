import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { installLocalDir } from "@9thlevelsoftware/legion-cli-design-system";
import { readAuditEvents, summarizeAuditMetrics } from "@9thlevelsoftware/legion-cli-persist";
import {
  argvSummarySafe,
  HEAD_MOVED_WARNING,
  HINT,
  LegionEngine,
  LegionRefuseError,
  optionalSkillSpawn,
  regressionTestPath,
  revertExtras,
} from "../dist/index.js";
import { snapshotGitPolicy } from "../dist/revert.js";
import {
  git,
  gitHead,
  initGitRepo,
  initProject,
  makeTask,
  passingVerificationCommand,
  readLatestRunPrompt,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  writeTask,
  writeUnspawnableGrok,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
const l3FooFixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "references", "foo.md");
const designFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "design-systems",
  "_fixture-neutral",
);
const L3_FOO_BODY_TOKEN = "UNIQUE_L3_FOO_BODY_TOKEN";

test("argvSummarySafe keeps flag names and redacts attached values", () => {
  assert.equal(
    argvSummarySafe(["exec", "--model", "grok-4", "{{pointer}}"]),
    "<redacted> --model <redacted> {{pointer}}",
  );
  assert.equal(argvSummarySafe(["--api-key=secret", "-pSECRET", "--header=Authorization:x"]), "--api-key=<redacted> <redacted> --header=<redacted>");
  assert.equal(argvSummarySafe(["-p", "--output-format", "json"]), "-p --output-format <redacted>");
  assert.equal(argvSummarySafe(['{"apiKey":"secret","prompt":"{{pointer}}"}']), "{{pointer}}");
});

async function seedExecute(store, opts = {}) {
  const verify = opts.verify ?? [passingVerificationCommand()];
  return seedPlanReady(store, {
    task: {
      contract: {
        filesAllowed: opts.filesAllowed ?? ["src/main.ts"],
        expectedArtifacts: opts.expectedArtifacts ?? ["src/main.ts"],
        verificationCommands: verify,
        ...(opts.contract ?? {}),
      },
      ...(opts.task ?? {}),
    },
    extraTasks: opts.extraTasks,
    phase: opts.phase,
    lastReview: opts.lastReview,
  });
}

async function readResume(dir, runId) {
  return JSON.parse(await readFile(join(dir, ".legion-cli", "cache", "runs", runId, "resume.json"), "utf8"));
}

test("execute writes local duration audit events", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedExecute(store);
      initGitRepo(dir);
      const result = await engine.execute("auto");
      assert.equal(result.status, "done");
      const jsonl = await readFile(join(dir, ".legion-cli", "audit", "events.jsonl"), "utf8");
      assert.match(jsonl, /"type":"execute"/);
      assert.match(jsonl, /"durationMs":/);
      assert.match(jsonl, /"adapterId":"fake"/);
      assert.match(jsonl, /"resolutionSource":"default"/);
      assert.equal(result.tasks[0].adapterId, "fake");
      assert.equal(result.tasks[0].resolutionSource, "default");
    });
  });
});

test("execute spawn timeout blocks the task and counts one timeout", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        initGitRepo(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
        const events = await readAuditEvents(dir);
        const executes = events.filter((event) => event.type === "execute");
        const timeouts = events.filter((event) => event.type === "timeout");
        assert.equal(executes.length, 1);
        assert.equal(executes[0].data.timedOut, true);
        assert.equal(executes[0].data.adapterId, "fake");
        assert.equal(timeouts.length, 1);
        assert.equal(timeouts[0].data.adapterId, "fake");
        assert.equal(summarizeAuditMetrics(events).timeouts, 1);
      },
      { fakeTimedOut: true },
    );
  });
});

test("execute refuses without a spawnable adapter", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedExecute(store);
    await assert.rejects(
      () => engine.execute("auto"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /execute needs a spawnable adapter \(fake, via default\)/);
        assert.match(err.nextHint, /doctor/);
        return true;
      },
    );
    assert.equal((await store.readTask("TSK-0001")).data.status, "ready");
  });
});

test("execute task.adapter=grok refuses when grok is not spawnable even if default fake is", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedExecute(store, { task: { adapter: "grok" } });
      await writeUnspawnableGrok(store);
      await assert.rejects(
        () => engine.execute("auto"),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /execute needs a spawnable adapter \(grok, via task\)/);
          assert.match(err.nextHint, /doctor/);
          return true;
        },
      );
    });
  });
});

test("execute opts.adapter records resolutionSource cli", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedExecute(store, { task: { adapter: "grok" } });
      await writeUnspawnableGrok(store);
      initGitRepo(dir);
      const result = await engine.execute("auto", { adapter: "fake" });
      assert.equal(result.status, "done");
      assert.equal(result.tasks[0].adapterId, "fake");
      assert.equal(result.tasks[0].resolutionSource, "cli");
    });
  });
});

test("untracked extra is reverted and fails the contract", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        initGitRepo(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal(result.phase, "executing");
        assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
        assert.ok(result.tasks[0].extrasReverted.includes("src/secret.ts"));
        assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
        const ticket = (await store.readTask("TSK-0002")).data;
        assert.match(ticket.notes, /scope/);
        assert.equal(ticket.parentId, "TSK-0001");
      },
      {
        fakeArtifacts: [{ path: "src/secret.ts", content: "export const secret = true;\n" }],
      },
    );
  });
});

test("tracked extra is restored from preSpawnRef", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src", "secret.ts"), "export const original = true;\n", "utf8");
        initGitRepo(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        const restored = (await readFile(join(dir, "src", "secret.ts"), "utf8")).replaceAll("\r\n", "\n");
        assert.equal(restored, "export const original = true;\n");
        assert.ok(result.tasks[0].extrasReverted.includes("src/secret.ts"));
        assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
      },
      {
        fakeArtifacts: [{ path: "src/secret.ts", content: "export const leaked = true;\n" }],
      },
    );
  });
});

test("committed git mv of a tracked extra restores the source and removes the dest", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src", "secret.ts"), "export const original = true;\n", "utf8");
        initGitRepo(dir);
        const pre = gitHead(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        const restored = (await readFile(join(dir, "src", "secret.ts"), "utf8")).replaceAll("\r\n", "\n");
        assert.equal(restored, "export const original = true;\n");
        assert.equal(existsSync(join(dir, "src", "leaked.ts")), false);
        assert.equal(gitHead(dir), pre);
        assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
      },
      {
        fakeArtifacts: [{ path: "src/secret.ts", gitMv: "src/leaked.ts" }],
      },
    );
  });
});

test("committed git mv of a tracked extra onto filesAllowed is still a deletion extra", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src", "secret.ts"), "export const original = true;\n", "utf8");
        initGitRepo(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.notEqual(result.status, "done");
        const restored = (await readFile(join(dir, "src", "secret.ts"), "utf8")).replaceAll("\r\n", "\n");
        assert.equal(restored, "export const original = true;\n");
        assert.equal(
          result.tasks[0].extrasReverted.includes("src/main.ts"),
          false,
          "allowed dest is not an extra",
        );
        assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
      },
      {
        fakeArtifacts: [{ path: "src/secret.ts", gitMv: "src/main.ts" }],
      },
    );
  });
});

test("committed extra vs preSpawnRef is removed without reset --hard", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        initGitRepo(dir);
        const pre = gitHead(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
        assert.ok(result.tasks[0].extrasReverted.includes("src/secret.ts"));
        const head = gitHead(dir);
        assert.equal(head, pre, "jail git commit cannot move operator HEAD");
        const resume = await readResume(dir, result.tasks[0].runId);
        assert.equal(resume.preSpawnRef, pre);
        assert.equal(head, git(dir, ["rev-parse", "HEAD"]));
        assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
      },
      {
        fakeArtifacts: [{ path: "src/secret.ts", content: "export const secret = true;\n", gitAdd: true }],
      },
    );
  });
});

test(".git hooks incident blocks and does not rm .git", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        initGitRepo(dir);
        const headBefore = gitHead(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal(result.tasks[0].incident, true);
        assert.equal(existsSync(join(dir, ".git")), true);
        assert.equal(existsSync(join(dir, ".git", "HEAD")), true);
        assert.equal(existsSync(join(dir, ".git", "config")), true);
        const hookPath = join(dir, ".git", "hooks", "pre-commit");
        if (existsSync(hookPath)) {
          const hook = (await readFile(hookPath, "utf8")).replaceAll("\r\n", "\n");
          assert.doesNotMatch(hook, /pwned/);
        }
        assert.equal(gitHead(dir), headBefore);
        assert.equal(git(dir, ["rev-parse", "--is-inside-work-tree"]), "true");
        assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
        assert.equal(result.phase, "executing");
      },
      {
        fakeArtifacts: [{ path: ".git/hooks/pre-commit", content: "#!/bin/sh\necho pwned\n" }],
      },
    );
  });
});

test(".git/config change is an incident and does not delete .git", async () => {
  await withEngine(async ({ dir }) => {
    await writeFile(join(dir, "README.md"), "seed\n", "utf8");
    initGitRepo(dir);
    const gitPolicy = await snapshotGitPolicy(dir);
    const pre = gitHead(dir);
    const configPath = join(dir, ".git", "config");
    const before = await readFile(configPath, "utf8");
    await writeFile(configPath, `${before}\n[alias]\n\tpwn = status\n`, "utf8");
    const result = await revertExtras({
      projectRoot: dir,
      preSpawnRef: pre,
      allowedRoots: ["src/main.ts"],
      gitPolicy,
    });
    assert.equal(result.incident, true);
    assert.equal(existsSync(join(dir, ".git")), true);
    assert.equal(existsSync(join(dir, ".git", "HEAD")), true);
    assert.equal(existsSync(configPath), true);
    assert.match(await readFile(configPath, "utf8"), /pwn = status/);
    assert.equal(git(dir, ["rev-parse", "--is-inside-work-tree"]), "true");
  });
});

test("in-contract commit still runs verificationCommands and can mark done", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        initGitRepo(dir);
        const pre = gitHead(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "done");
        assert.equal(result.phase, "executing");
        assert.equal((await store.readTask("TSK-0001")).data.status, "done");
        assert.equal(existsSync(join(dir, "src", "main.ts")), true);
        assert.equal(gitHead(dir), pre, "jail GIT_DIR cannot move operator HEAD");
        assert.equal(result.warnings.includes(HEAD_MOVED_WARNING), false);
        assert.equal(result.tasks[0].verificationPass, true);
        assert.equal(result.tasks[0].headMoved, false);
        assert.equal(result.tasks[0].incident, false, "HEAD movement alone is not a .git incident");
        const resume = await readResume(dir, result.tasks[0].runId);
        assert.equal(resume.skillId, "execute");
        assert.equal(resume.taskId, "TSK-0001");
        assert.equal(resume.preSpawnRef, pre);
        assert.equal(resume.adapterId, "fake");
        assert.equal(resume.binary, "(in-process)");
        assert.equal(resume.resolutionSource, "default");
        assert.equal(resume.argvSummary, "");
      },
      {
        fakeArtifacts: [{ path: "src/main.ts", content: "export const ok = true;\n", gitAdd: true }],
      },
    );
  });
});

test("HEAD movement is a warning not a fail, and execute does not auto-commit", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        initGitRepo(dir);
        const pre = gitHead(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "done");
        assert.equal(gitHead(dir), pre);
        assert.equal(result.warnings.includes(HEAD_MOVED_WARNING), false);
        assert.equal(existsSync(join(dir, "src", "main.ts")), true);
        assert.equal((await store.readTask("TSK-0001")).data.status, "done");
      },
      {
        fakeArtifacts: [{ path: "src/main.ts", content: "export const ok = true;\n" }],
      },
    );
  });
});

test("execute --until-blocked loops until no ready task remains", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        const verify = [passingVerificationCommand()];
        await seedExecute(store, {
          verify,
          extraTasks: [
            makeTask({
              id: "TSK-0002",
              status: "todo",
              blockedBy: ["TSK-0001"],
              contract: {
                filesAllowed: ["src/board.ts"],
                expectedArtifacts: ["src/board.ts"],
                verificationCommands: verify,
              },
            }),
          ],
        });
        const result = await engine.execute("auto", { untilBlocked: true });
        assert.equal(result.status, "done");
        assert.equal(result.phase, "executing");
        assert.deepEqual(
          result.tasks.map((item) => item.taskId),
          ["TSK-0001", "TSK-0002"],
        );
        assert.equal((await store.readTask("TSK-0001")).data.status, "done");
        assert.equal((await store.readTask("TSK-0002")).data.status, "done");
      },
    );
  });
});

test("until-blocked stops when a task is blocked by extras", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        const verify = [passingVerificationCommand()];
        await seedExecute(store, {
          verify,
          extraTasks: [
            makeTask({
              id: "TSK-0002",
              contract: {
                filesAllowed: ["src/board.ts"],
                expectedArtifacts: ["src/board.ts"],
                verificationCommands: verify,
              },
            }),
          ],
        });
        initGitRepo(dir);
        const result = await engine.execute("auto", { untilBlocked: true });
        assert.equal(result.status, "blocked");
        assert.equal(result.tasks.length, 1);
        assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
        assert.equal((await store.readTask("TSK-0002")).data.status, "ready");
      },
      {
        fakeArtifacts: [{ path: "src/secret.ts", content: "export const leaked = true;\n" }],
      },
    );
  });
});

function assertPromptOrder(prompt, opts = {}) {
  assert.ok(prompt.startsWith("## SessionBrief\n"), prompt.slice(0, 120));
  const sessionIdx = prompt.indexOf("## SessionBrief");
  const activeIdx = prompt.indexOf("## Active skill");
  const skillContractIdx = prompt.indexOf("## SkillContract");
  const fileContractIdx = prompt.indexOf("## FileContract");
  const usageIdx = prompt.search(/^## (usage|USAGE\.md)\b/m);
  const designIdx = prompt.search(/^## DESIGN\.md\b/m);
  const skillIdx = prompt.search(/^## skill\b/m);
  assert.equal(sessionIdx, 0);
  assert.ok(activeIdx > sessionIdx);
  assert.ok(skillContractIdx > activeIdx);
  if (opts.expectFileContract) {
    assert.ok(fileContractIdx > skillContractIdx, "FileContract must follow SkillContract");
    if (usageIdx !== -1) assert.ok(fileContractIdx < usageIdx);
    if (designIdx !== -1) assert.ok(fileContractIdx < designIdx);
    if (skillIdx !== -1) assert.ok(fileContractIdx < skillIdx);
    assert.equal(prompt.split("## FileContract").length - 1, 1, "exactly one FileContract heading");
  } else {
    assert.equal(fileContractIdx, -1);
  }
}

test("execute prompt.md starts with SessionBrief and FileContract after SkillContract", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedExecute(store);
      initGitRepo(dir);
      const result = await engine.execute("auto");
      assert.equal(result.status, "done");
      const prompt = await readFile(
        join(dir, ".legion-cli", "cache", "runs", result.tasks[0].runId, "prompt.md"),
        "utf8",
      );
      assertPromptOrder(prompt, { expectFileContract: true });
      assert.ok(prompt.startsWith("## SessionBrief\nProject:"));
      assert.match(prompt, /Skills:/);
      assert.match(prompt, /execute \(active\)/);
      assert.match(prompt, /## Active skill\nskillId: execute/);
      assert.match(prompt, /Level 3 files \(read only if the skill body names them\):\n- \(none\)/);
      assert.match(prompt, /Task: TSK-0001 in\/out button/);
      assert.match(prompt, /maxFilesTouched: 20/);
      const skillIdx = prompt.indexOf("## skill");
      if (skillIdx !== -1) {
        assert.equal(prompt.slice(skillIdx).includes("## FileContract"), false);
      }
    });
  });
});

test("execute prompt.md starts with SessionBrief when a design-system package is active", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedExecute(store);
      await installLocalDir({ projectRoot: dir, source: designFixture });
      initGitRepo(dir);
      const result = await engine.execute("auto");
      assert.equal(result.status, "done");
      const prompt = await readFile(
        join(dir, ".legion-cli", "cache", "runs", result.tasks[0].runId, "prompt.md"),
        "utf8",
      );
      assertPromptOrder(prompt, { expectFileContract: true });
      assert.ok(prompt.startsWith("## SessionBrief\nProject:"));
      assert.match(prompt, /^## USAGE\.md$/m);
      assert.match(prompt, /^## DESIGN\.md$/m);
      assert.match(prompt, /^## skill$/m);
      assert.ok(prompt.indexOf("## FileContract") < prompt.indexOf("## USAGE.md"));
      assert.ok(prompt.indexOf("## FileContract") < prompt.indexOf("## skill"));
      assert.equal(prompt.slice(prompt.indexOf("## USAGE.md")).includes("## FileContract"), false);
    });
  });
});

test("execute prompt.md lists Level 3 paths and does not inline references/foo.md", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedExecute(store);
      const overlay = join(dir, "skills-l3");
      await cp(skillsDir, overlay, { recursive: true });
      await mkdir(join(overlay, "execute", "references"), { recursive: true });
      const fixtureBody = await readFile(l3FooFixture, "utf8");
      await writeFile(join(overlay, "execute", "references", "foo.md"), fixtureBody, "utf8");
      const gated = new LegionEngine(dir, undefined, { skillsDir: overlay });
      initGitRepo(dir);
      const result = await gated.execute("auto");
      assert.equal(result.status, "done");
      const runId = result.tasks[0].runId;
      const prompt = await readFile(join(dir, ".legion-cli", "cache", "runs", runId, "prompt.md"), "utf8");
      assert.match(prompt, /## Active skill\nskillId: execute/);
      assert.match(prompt, /Level 3 files \(read only if the skill body names them\):\n- references\/foo\.md/);
      assert.doesNotMatch(prompt, new RegExp(L3_FOO_BODY_TOKEN));
      assert.equal(prompt.includes(fixtureBody.trim()), false);
      assert.equal(
        await readFile(join(dir, ".legion-cli", "cache", "skills", runId, "references", "foo.md"), "utf8"),
        fixtureBody,
      );
    });
  });
});

test("optionalSkillSpawn lists Level 3 paths and does not inline references/foo.md", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      const overlay = join(dir, "skills-l3");
      await cp(skillsDir, overlay, { recursive: true });
      await mkdir(join(overlay, "execute", "references"), { recursive: true });
      const fixtureBody = await readFile(l3FooFixture, "utf8");
      await writeFile(join(overlay, "execute", "references", "foo.md"), fixtureBody, "utf8");
      const config = await store.readConfig();
      const spawned = await optionalSkillSpawn({
        projectRoot: dir,
        config,
        skillId: "execute",
        promptBody: "Task: TSK-0001 narrative only",
        fileContract: makeTask().contract,
        skillsDir: overlay,
        required: true,
      });
      assert.equal(spawned.spawned, true);
      const prompt = await readLatestRunPrompt(dir, "execute");
      assert.match(prompt, /Level 3 files \(read only if the skill body names them\):\n- references\/foo\.md/);
      assert.doesNotMatch(prompt, new RegExp(L3_FOO_BODY_TOKEN));
      assert.equal(prompt.includes(fixtureBody.trim()), false);
      const staged = join(dir, ".legion-cli", "cache", "skills", spawned.runId, "references", "foo.md");
      assert.equal(await readFile(staged, "utf8"), fixtureBody);
    });
  });
});

test("optionalSkillSpawn omits SessionBrief body without store and still renders FileContract", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      const config = await store.readConfig();
      const spawned = await optionalSkillSpawn({
        projectRoot: dir,
        config,
        skillId: "execute",
        promptBody: "Task: TSK-0001 narrative only",
        fileContract: makeTask().contract,
        skillsDir,
        required: true,
      });
      assert.equal(spawned.spawned, true);
      const prompt = await readLatestRunPrompt(dir, "execute");
      assert.ok(prompt.startsWith("## SessionBrief\n(no store; test-only spawn)"));
      assert.match(prompt, /## FileContract/);
      assert.match(prompt, /Task: TSK-0001 narrative only/);
      assert.match(prompt, /filesAllowed:\n- src\/main\.ts/);
      assert.match(prompt, /maxFilesTouched: 20/);
      assert.ok(prompt.indexOf("## FileContract") > prompt.indexOf("## SkillContract"));
    });
  });
});

test("until-blocked SessionBrief FileContract matches the spawned task, not the previous one", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      const verify = [passingVerificationCommand()];
      await seedExecute(store, {
        verify,
        extraTasks: [
          makeTask({
            id: "TSK-0002",
            title: "board view",
            status: "todo",
            blockedBy: ["TSK-0001"],
            contract: {
              filesAllowed: ["src/board.ts"],
              expectedArtifacts: ["src/board.ts"],
              verificationCommands: verify,
            },
          }),
        ],
      });
      const result = await engine.execute("auto", { untilBlocked: true });
      assert.equal(result.status, "done");
      assert.deepEqual(
        result.tasks.map((item) => item.taskId),
        ["TSK-0001", "TSK-0002"],
      );
      const first = await readFile(
        join(dir, ".legion-cli", "cache", "runs", result.tasks[0].runId, "prompt.md"),
        "utf8",
      );
      const second = await readFile(
        join(dir, ".legion-cli", "cache", "runs", result.tasks[1].runId, "prompt.md"),
        "utf8",
      );
      const firstBrief = first.slice(0, first.indexOf("## Active skill"));
      const secondBrief = second.slice(0, second.indexOf("## Active skill"));
      assert.match(firstBrief, /Phase: executing/);
      assert.match(firstBrief, /Current task: TSK-0001 in\/out button/);
      assert.match(firstBrief, /filesAllowed: src\/main\.ts/);
      assert.doesNotMatch(firstBrief, /src\/board\.ts/);
      assert.match(secondBrief, /Phase: executing/);
      assert.match(secondBrief, /Current task: TSK-0002 board view/);
      assert.match(secondBrief, /filesAllowed: src\/board\.ts/);
      assert.doesNotMatch(secondBrief, /src\/main\.ts/);
      assert.match(second, /## FileContract\nfilesAllowed:\n- src\/board\.ts/);
      assert.match(second, /maxFilesTouched: 20/);
    });
  });
});

test("execute [id] of a graph-ready todo succeeds", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedExecute(store, { task: { status: "todo" } });
      initGitRepo(dir);
      const result = await engine.execute("TSK-0001");
      assert.equal(result.status, "done");
      assert.equal((await store.readTask("TSK-0001")).data.status, "done");
    });
  });
});

test("execute [id] other-spec ready refuses", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedExecute(store);
    await writeTask(
      store,
      makeTask({
        id: "TSK-9999",
        specId: "spec-other",
        status: "ready",
        contract: { filesAllowed: ["src/other.ts"], expectedArtifacts: ["src/other.ts"] },
      }),
    );
    await assert.rejects(
      () => engine.execute("TSK-9999"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /not in the active spec slice/);
        assert.match(err.nextHint, /status --blockers/);
        return true;
      },
    );
    assert.equal((await store.readTask("TSK-9999")).data.status, "ready");
    assert.equal((await store.readTask("TSK-0001")).data.status, "ready");
  });
});

test("execute [id] with blockedBy refuses even if status is ready", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedExecute(store, {
      task: { status: "ready", blockedBy: ["TSK-0002"] },
      extraTasks: [
        makeTask({
          id: "TSK-0002",
          status: "todo",
          contract: { filesAllowed: ["src/board.ts"], expectedArtifacts: ["src/board.ts"] },
        }),
      ],
    });
    await assert.rejects(
      () => engine.execute("TSK-0001"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /is not ready/);
        return true;
      },
    );
  });
});

test("execute [id] with a sibling in_progress refuses even if status is ready", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedExecute(store, {
      extraTasks: [
        makeTask({
          id: "TSK-0002",
          status: "in_progress",
          contract: { filesAllowed: ["src/board.ts"], expectedArtifacts: ["src/board.ts"] },
        }),
      ],
    });
    await assert.rejects(
      () => engine.execute("TSK-0001"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /is not ready/);
        return true;
      },
    );
  });
});

test("execute [id] with an open blocking assumption refuses even if status is ready", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedExecute(store);
    await store.writeAssumption(
      {
        schemaVersion: "legion-cli-assumption/v1",
        id: "ASM-0001",
        statement: "Need office wifi",
        status: "open",
        blocking: true,
        escalatesTo: "user",
        createdIn: "intent",
      },
      "Need office wifi\n",
    );
    await assert.rejects(
      () => engine.execute("TSK-0001"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /is not ready/);
        return true;
      },
    );
  });
});

test("extra.json glob files a notes ticket and blocks instead of stuck in_progress", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        initGitRepo(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
        assert.notEqual((await store.readTask("TSK-0001")).data.status, "in_progress");
        const ticket = (await store.readTask("TSK-0002")).data;
        assert.equal(ticket.title, "also glob");
        assert.deepEqual(ticket.contract.filesAllowed, ["notes/TSK-0002.md"]);
        assert.equal(ticket.parentId, "TSK-0001");
        assert.equal(result.tasks[0].ticketId, "TSK-0002");
      },
      {
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

test("ticket create overlapping filesAllowed refuses with ticket Next", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedExecute(store);
    await assert.rejects(
      () =>
        engine.fileTicket({
          title: "also main",
          contract: { filesAllowed: ["src/main.ts"] },
        }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /overlapping filesAllowed/);
        assert.equal(err.nextHint, HINT.ticket("TSK-x"));
        return true;
      },
    );
  });
});

test("extra.json overlapping filesAllowed is coerced and blocks the parent", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        initGitRepo(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
        const ticket = (await store.readTask("TSK-0002")).data;
        assert.deepEqual(ticket.contract.filesAllowed, ["notes/TSK-0002.md"]);
        assert.equal(result.tasks[0].ticketId, "TSK-0002");
      },
      {
        fakeArtifacts: [
          {
            path: ".legion-cli/cache/runs/<id>/extra.json",
            content: JSON.stringify({
              title: "also main",
              parentId: "TSK-0001",
              filesAllowed: ["src/main.ts"],
            }),
          },
        ],
      },
    );
  });
});

test("fix overlapping src/main.ts refuses before lastReview or regression tests", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedExecute(store, { phase: "executing", lastReview: "PASS" });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.js"), "export const ok = false;\n", "utf8");
    const testPath = regressionTestPath("crash on tap");
    await assert.rejects(
      () => engine.fix("crash on tap"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /overlapping filesAllowed/);
        assert.equal(err.nextHint, HINT.fix);
        return true;
      },
    );
    assert.equal((await engine.getState()).lastReview, "PASS");
    assert.equal(existsSync(join(dir, ...testPath.split("/"))), false);
  });
});

test("gitignore extras revert only new ignored paths, not pre-existing secret/keep", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        await mkdir(join(dir, "secret"), { recursive: true });
        await writeFile(join(dir, "secret", "keep"), "keep-me\n", "utf8");
        const gitignore = await readFile(join(dir, ".gitignore"), "utf8").catch(() => "");
        await writeFile(join(dir, ".gitignore"), `${gitignore.endsWith("\n") ? gitignore : `${gitignore}\n`}secret/\n`, "utf8");
        initGitRepo(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal(existsSync(join(dir, "secret", "x")), false);
        assert.ok(result.tasks[0].extrasReverted.includes("secret/x"));
        assert.equal(result.tasks[0].extrasReverted.includes("secret/keep"), false);
        assert.equal(existsSync(join(dir, "secret", "keep")), true);
        const keep = (await readFile(join(dir, "secret", "keep"), "utf8")).replaceAll("\r\n", "\n");
        assert.equal(keep, "keep-me\n");
      },
      {
        fakeArtifacts: [{ path: "secret/x", content: "leaked\n" }],
      },
    );
  });
});

test("gitignore extras under dist/ revert new files, not pre-existing dist/keep", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seedExecute(store);
        await mkdir(join(dir, "dist"), { recursive: true });
        await writeFile(join(dir, "dist", "keep"), "keep-me\n", "utf8");
        const gitignore = await readFile(join(dir, ".gitignore"), "utf8").catch(() => "");
        await writeFile(
          join(dir, ".gitignore"),
          `${gitignore.endsWith("\n") ? gitignore : `${gitignore}\n`}dist/\n`,
          "utf8",
        );
        initGitRepo(dir);
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal(existsSync(join(dir, "dist", "x")), false);
        assert.ok(result.tasks[0].extrasReverted.includes("dist/x"));
        assert.equal(result.tasks[0].extrasReverted.includes("dist/keep"), false);
        assert.equal(existsSync(join(dir, "dist", "keep")), true);
      },
      {
        fakeArtifacts: [{ path: "dist/x", content: "leaked\n" }],
      },
    );
  });
});

test("requireHardened copy jail without allowNoSandbox refuses before in_progress", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedExecute(store);
      const config = await store.readConfig();
      await store.writeConfig({
        ...config,
        sandbox: { requireHardened: true, allowCopyJail: false, backend: "copy", skills: ["execute"] },
      });
      await assert.rejects(
        () => engine.execute("auto"),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /hardened sandbox required/);
          assert.match(err.nextHint, /--allow-no-sandbox/);
          return true;
        },
      );
      assert.equal((await store.readTask("TSK-0001")).data.status, "ready");
    });
  });
});

test("allowNoSandbox and allowCopyJail and requireHardened false all admit copy jail", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await seedExecute(store);
      initGitRepo(dir);
      const config = await store.readConfig();
      await store.writeConfig({
        ...config,
        sandbox: { requireHardened: true, allowCopyJail: false, backend: "copy", skills: ["execute"] },
      });
      const viaFlag = await engine.execute("auto", { allowNoSandbox: true });
      assert.equal(viaFlag.status, "done");

      await store.writeTask(
        makeTask({
          id: "TSK-0002",
          status: "ready",
          contract: {
            filesAllowed: ["src/board.ts"],
            expectedArtifacts: ["src/board.ts"],
            verificationCommands: [passingVerificationCommand()],
          },
        }),
        "board\n",
      );
      await store.writeConfig({
        ...(await store.readConfig()),
        sandbox: { requireHardened: true, allowCopyJail: true, backend: "copy", skills: ["execute"] },
      });
      const viaCopy = await engine.execute("TSK-0002");
      assert.equal(viaCopy.status, "done");

      await store.writeTask(
        makeTask({
          id: "TSK-0003",
          status: "ready",
          contract: {
            filesAllowed: ["src/third.ts"],
            expectedArtifacts: ["src/third.ts"],
            verificationCommands: [passingVerificationCommand()],
          },
        }),
        "third\n",
      );
      await store.writeConfig({
        ...(await store.readConfig()),
        sandbox: { requireHardened: false, allowCopyJail: false, backend: "copy", skills: ["execute"] },
      });
      const viaOff = await engine.execute("TSK-0003");
      assert.equal(viaOff.status, "done");
    });
  });
});

test("execute jail cwd exists during spawn and extra writes are dropped", async () => {
  await withFakeAdapter(async () => {
    let jailSeen = false;
    let projectDir;
    await withEngine(
      async ({ engine, store, dir }) => {
        projectDir = dir;
        await initProject(engine);
        await seedExecute(store);
        initGitRepo(dir);
        const specBefore = await readFile(join(dir, ".legion-cli", "specs", "spec-checkin", "SPEC.md"), "utf8");
        const result = await engine.execute("auto");
        assert.equal(result.status, "blocked");
        assert.equal(jailSeen, true);
        assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
        assert.ok(result.tasks[0].extrasReverted.includes("src/secret.ts"));
        assert.ok(result.tasks[0].extrasReverted.includes(".legion-cli/specs/spec-checkin/SPEC.md"));
        assert.equal(
          await readFile(join(dir, ".legion-cli", "specs", "spec-checkin", "SPEC.md"), "utf8"),
          specBefore,
        );
        const events = await readAuditEvents(dir);
        assert.ok(events.some((event) => event.type === "sandbox_start" || event.type === "sandbox_degraded"));
        assert.ok(events.some((event) => event.type === "sandbox_copyout"));
      },
      {
        fakeArtifacts: [
          { path: "src/secret.ts", content: "steal\n" },
          { path: ".legion-cli/specs/spec-checkin/SPEC.md", content: "pwned\n" },
        ],
        fakeOnWait: async () => {
          const names = await readdir(join(projectDir, ".legion-cli", "sandbox"));
          jailSeen = names.some((name) => name.startsWith("execute-"));
        },
      },
    );
  });
});

test("execute stays jailed when sandbox.skills omits execute", async () => {
  await withFakeAdapter(async () => {
    let jailSeen = false;
    let projectDir;
    await withEngine(
      async ({ engine, store, dir }) => {
        projectDir = dir;
        await initProject(engine);
        await seedExecute(store);
        initGitRepo(dir);
        const config = await store.readConfig();
        await store.writeConfig({
          ...config,
          sandbox: { ...config.sandbox, skills: ["plan"], allowCopyJail: true },
        });
        const result = await engine.execute("auto");
        assert.equal(result.status, "done");
        assert.equal(jailSeen, true);
      },
      {
        fakeOnWait: async () => {
          const names = await readdir(join(projectDir, ".legion-cli", "sandbox"));
          jailSeen = names.some((name) => name.startsWith("execute-"));
        },
      },
    );
  });
});

test("sandboxed plan copy-out includes SkillContract plans", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      const config = await store.readConfig();
      await store.writeConfig({
        ...config,
        sandbox: { ...config.sandbox, skills: ["plan"], allowCopyJail: true },
      });
      const spawned = await optionalSkillSpawn({
        projectRoot: dir,
        config: await store.readConfig(),
        skillId: "plan",
        specId: "spec-checkin",
        promptBody: "Write the plan.",
        skillsDir,
        required: true,
        fakeArtifacts: [{ path: ".legion-cli/plans/spec-checkin.md", content: "plan body\n" }],
      });
      assert.equal(spawned.spawned, true);
      assert.equal(await readFile(join(dir, ".legion-cli", "plans", "spec-checkin.md"), "utf8"), "plan body\n");
      assert.equal(spawned.revert?.extrasReverted.includes(".legion-cli/plans/spec-checkin.md"), false);
    });
  });
});
