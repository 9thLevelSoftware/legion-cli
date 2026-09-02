import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { readAuditEvents, summarizeAuditMetrics } from "@9thlevelsoftware/legion-cli-persist";
import { HEAD_MOVED_WARNING, LegionRefuseError, revertExtras } from "../dist/index.js";
import { snapshotGitPolicy } from "../dist/revert.js";
import {
  git,
  gitHead,
  initGitRepo,
  initProject,
  makeTask,
  passingVerificationCommand,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  writeUnspawnableGrok,
} from "./helpers.js";

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
        assert.ok(result.tasks[0].extrasReverted.includes("src/secret.ts"));
        assert.ok(result.tasks[0].extrasReverted.includes("src/leaked.ts"));
        assert.notEqual(gitHead(dir), pre);
        assert.equal(git(dir, ["log", "-1", "--format=%s"]), "fake adapter commit");
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
        assert.ok(result.tasks[0].extrasReverted.includes("src/secret.ts"));
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
        assert.notEqual(head, pre);
        const resume = await readResume(dir, result.tasks[0].runId);
        assert.equal(resume.preSpawnRef, pre);
        assert.equal(head, git(dir, ["rev-parse", "HEAD"]));
        assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
        const log = git(dir, ["log", "-1", "--format=%s"]);
        assert.equal(log, "fake adapter commit");
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
        assert.equal(existsSync(join(dir, ".git", "hooks", "pre-commit")), true);
        const hook = (await readFile(join(dir, ".git", "hooks", "pre-commit"), "utf8")).replaceAll("\r\n", "\n");
        assert.match(hook, /pwned/);
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
        assert.notEqual(gitHead(dir), pre);
        assert.ok(result.warnings.includes(HEAD_MOVED_WARNING));
        assert.equal(result.tasks[0].verificationPass, true);
        assert.equal(result.tasks[0].headMoved, true);
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
