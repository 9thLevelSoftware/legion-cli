import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { allowCopyJail, normalize, runCli, withTempDir, withUnspawnableGrok } from "./helpers.js";

function quoteArg(value) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

test("execute help exposes explicit retry recovery", () => {
  const result = runCli(["execute", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(normalize(result.stdout), /--retry/);
  assert.match(normalize(result.stdout), /retry one failed workflow stage/);
});

function passingVerify() {
  return `${quoteArg(process.execPath)} -e process.exit(0)`;
}

function makeTask(overrides = {}) {
  const { contract, ...rest } = overrides;
  return {
    schemaVersion: "legion-cli-task/v1",
    id: "TSK-0001",
    title: "in/out button",
    status: "ready",
    type: "feature",
    priority: "P0",
    specId: "spec-checkin",
    blockedBy: [],
    blocks: [],
    assignee: "agent",
    notes: "",
    ...rest,
    contract: {
      filesAllowed: ["src/main.ts"],
      filesForbidden: [".git/**"],
      expectedArtifacts: ["src/main.ts"],
      verificationCommands: [passingVerify()],
      maxFilesTouched: 20,
      ...contract,
    },
  };
}

async function seedPlanReady(dir, extra = {}) {
  const engine = createLegionEngine(dir);
  await engine.init({ name: "Checkin", adapter: "fake", ...(extra.focused ? { workflowProfile: "focused" } : {}) });
  await allowCopyJail(engine.store);
  await engine.store.writeSpec(
    {
      schemaVersion: "legion-cli-spec/v1",
      id: "spec-checkin",
      title: "Office check-in",
      status: "frozen",
      mustBeTrue: ["People can tap in or out on their phone in under five seconds"],
      mustNotChange: ["auth"],
      outOfScope: ["payroll"],
      acceptance: [
        {
          id: "AC-01",
          statement: "Tap in or out on a phone completes in under five seconds",
          kind: "behavior",
          priority: "P0",
        },
      ],
      personas: ["teammates"],
      happyPath: "Open the board, tap In.",
      frozenAt: "2026-09-01T12:00:00.000Z",
      frozenBy: "tester",
    },
    "Spec body.\n",
  );
  const project = await engine.store.readProject();
  await engine.store.writeProject({ ...project.data, activeSpecId: "spec-checkin" }, project.body);
  const state = await engine.store.readState();
  await engine.store.writeState(
    { ...state.data, phase: "plan_ready", activeSpecId: "spec-checkin", lastReadiness: "PASS" },
    state.body,
  );
  await engine.store.writeTask(makeTask(extra.task ?? {}), "Implement the in/out button.\n");
  if (extra.extraTasks) {
    for (const task of extra.extraTasks) {
      await engine.store.writeTask(task, `${task.title}.\n`);
    }
  }
  await writeFile(join(dir, ".legion-cli", "plans", "spec-checkin.md"), "# Checkin plan\n\nImplement the approved tasks.\n", "utf8");
  if (extra.approve !== false) await engine.approvePlan();
  return engine;
}

test("execute refuses before plan_ready", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["execute", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /plan approval is required/);
  });
});

test("focused fix persists a configured profile on a proposed amendment without execution", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedPlanReady(dir, { focused: true, task: { status: "done" } });
    const config = await engine.store.readConfig();
    await engine.store.writeConfig({
      ...config,
      adapter: { ...config.adapter, profiles: { careful: { adapter: "fake", modelArgs: [] } } },
    });
    await engine.approvePlan();
    assert.equal((await engine.getWorkflowStatus()).planApproval, "valid");
    const approvalPath = join(dir, ".legion-cli", "workflow", "plan-approval.yaml");
    const beforeApproval = await readFile(approvalPath, "utf8");
    const original = await engine.store.readTask("TSK-0001");
    const beforeTasks = await engine.listSliceTasks();
    const runsDir = join(dir, ".legion-cli", "cache", "runs");
    const beforeRuns = existsSync(runsDir) ? await readdir(runsDir) : [];
    const result = runCli(["fix", "login is denied", "--profile", "careful", "--project", dir]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const proposed = (await engine.listSliceTasks()).filter((task) => !beforeTasks.some((before) => before.id === task.id));
    assert.equal(proposed.length, 1);
    const [task] = proposed;
    assert.equal(task.type, "bug");
    assert.equal(task.profile, "careful");
    assert.match(normalize(result.stdout), new RegExp(task.id));
    assert.deepEqual(await engine.store.readTask("TSK-0001"), original);
    assert.equal(await readFile(approvalPath, "utf8"), beforeApproval);
    assert.notEqual((await engine.getWorkflowStatus()).planApproval, "valid");
    assert.equal((await engine.getState()).currentTaskId, null);
    for (const path of task.contract.filesAllowed) assert.equal(existsSync(join(dir, path)), false);
    assert.deepEqual(existsSync(runsDir) ? await readdir(runsDir) : [], beforeRuns);
  });
});

test("focused fix JSON persists an explicit adapter without executing the proposed task", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedPlanReady(dir, { focused: true, task: { status: "done" } });
    const original = await engine.store.readTask("TSK-0001");
    const result = runCli(["fix", "logout fails", "--adapter", "grok", "--project", dir, "--json"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.status, "proposed");
    assert.match(body.next, /^legion-cli plan approve\b/);
    const proposed = (await engine.listSliceTasks()).find((task) => task.id === body.taskId);
    assert.ok(proposed);
    assert.notEqual(proposed.id, "TSK-0001");
    assert.equal(proposed.adapter, "grok");
    assert.equal(proposed.profile, undefined);
    assert.deepEqual(await engine.store.readTask("TSK-0001"), original);
    assert.notEqual((await engine.getWorkflowStatus()).planApproval, "valid");
    assert.equal((await engine.getState()).currentTaskId, null);
    for (const path of proposed.contract.filesAllowed) assert.equal(existsSync(join(dir, path)), false);
  });
});

test("focused fix rejects an unknown profile without mutating the approved plan", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedPlanReady(dir, { focused: true, task: { status: "done" } });
    const beforeTasks = await engine.listSliceTasks();
    const beforeState = await engine.getState();
    const beforeSpec = await engine.store.readSpec("spec-checkin");
    const planPath = join(dir, ".legion-cli", "plans", "spec-checkin.md");
    const approvalPath = join(dir, ".legion-cli", "workflow", "plan-approval.yaml");
    const beforePlan = await readFile(planPath, "utf8");
    const beforeApproval = await readFile(approvalPath, "utf8");
    const runsDir = join(dir, ".legion-cli", "cache", "runs");
    const beforeRuns = existsSync(runsDir) ? await readdir(runsDir) : [];
    const result = runCli(["fix", "login is denied", "--profile", "unknown", "--project", dir, "--json"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(typeof JSON.parse(result.stdout).error, "string");
    assert.deepEqual(await engine.listSliceTasks(), beforeTasks);
    assert.deepEqual(await engine.getState(), beforeState);
    assert.deepEqual(await engine.store.readSpec("spec-checkin"), beforeSpec);
    assert.equal(await readFile(planPath, "utf8"), beforePlan);
    assert.equal(await readFile(approvalPath, "utf8"), beforeApproval);
    assert.deepEqual(existsSync(runsDir) ? await readdir(runsDir) : [], beforeRuns);
    assert.equal(existsSync(join(dir, "src", "main.ts")), false);
  });
});

test("focused advisory status retains approval gates before recommending guarded execution", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedPlanReady(dir, { focused: true, approve: false });
    const mode = runCli(["control-mode", "advisory", "--project", dir]);
    assert.equal(mode.status, 0, mode.stderr);
    const unapprovedTask = await engine.store.readTask("TSK-0001");
    const unapproved = runCli(["status", "--project", dir, "--json"]);
    assert.equal(unapproved.status, 0, unapproved.stderr);
    assert.match(JSON.parse(unapproved.stdout).next.run, /^legion-cli plan approve\b/);
    assert.deepEqual(await engine.store.readTask("TSK-0001"), unapprovedTask);
    await engine.approvePlan();
    const approvedTask = await engine.store.readTask("TSK-0001");
    const approved = runCli(["status", "--project", dir, "--json"]);
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(JSON.parse(approved.stdout).next.run, /^legion-cli control-mode guarded\b/);
    assert.deepEqual(await engine.store.readTask("TSK-0001"), approvedTask);
    assert.equal(existsSync(join(dir, "src", "main.ts")), false);
  });
});

test("advisory status does not recommend execution for an all-terminal slice awaiting workflow integration", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedPlanReady(dir, { focused: true, task: { status: "done" } });
    const state = await engine.store.readState();
    await engine.store.writeState({ ...state.data, phase: "executing" }, state.body);
    const mode = runCli(["control-mode", "advisory", "--project", dir]);
    assert.equal(mode.status, 0, mode.stderr);
    await engine.approvePlan();
    const result = runCli(["status", "--project", dir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).next.run, /^legion-cli control-mode guarded\b/);
    assert.equal((await engine.getState()).phase, "executing");
    assert.equal((await engine.store.readTask("TSK-0001")).data.status, "done");
  });
});

test("focused status surfaces a corrupt workflow receipt", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir, { focused: true });
    await writeFile(join(dir, ".legion-cli", "workflow", "plan-approval.yaml"), "not: [valid\n", "utf8");
    const result = runCli(["status", "--project", dir]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(normalize(`${result.stdout}\n${result.stderr}`), /yaml|parse|expected|invalid|Flow sequence|must be sufficiently indented/i);
    assert.doesNotMatch(normalize(result.stdout), /Run:.*plan approve/);
  });
});

test("execute one ready task and stay executing", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir);
    const result = runCli(["execute", "--step", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /Completed: TSK-0001/);
    const engine = createLegionEngine(dir);
    assert.equal((await engine.getState()).phase, "executing");
    assert.equal((await engine.store.readTask("TSK-0001")).data.status, "done");
  });
});

test("execute --until-blocked loops remaining ready tasks", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir, {
      extraTasks: [
        makeTask({
          id: "TSK-0002",
          title: "board",
          contract: {
            filesAllowed: ["src/board.ts"],
            expectedArtifacts: ["src/board.ts"],
            verificationCommands: [passingVerify()],
          },
        }),
      ],
    });
    const result = runCli(["execute", "--until-blocked", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /TSK-0001/);
    assert.match(out, /TSK-0002/);
    assert.match(out, /Completed: TSK-0001, TSK-0002/);
    assert.match(out, /review failed: agent wrote no notes/);
    const engine = createLegionEngine(dir);
    assert.equal((await engine.store.readTask("TSK-0001")).data.status, "done");
    assert.equal((await engine.store.readTask("TSK-0002")).data.status, "done");
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("execute --fix is accepted", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir);
    const result = runCli(["execute", "--fix", "--step", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test("help lists execute flags", async () => {
  const result = runCli(["help", "execute"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /until-blocked/);
  assert.match(out, /jobs/);
  assert.match(out, /fix/);
  assert.match(out, /adapter/);
  assert.match(out, /allow-no-sandbox/);
});

test("execute --jobs validates the bounded automatic until-blocked surface", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir);
    for (const args of [
      ["execute", "--jobs", "2"],
      ["execute", "TSK-0001", "--until-blocked", "--jobs", "2"],
      ["execute", "--until-blocked", "--jobs", "5"],
      ["execute", "--step", "--until-blocked", "--jobs", "2"],
    ]) {
      const result = runCli([...args, "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
      assert.equal(result.status, 1, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
      assert.match(normalize(result.stderr), /--jobs/);
    }
  });
});

test("execute --json keeps progress on stderr and emits one parseable document", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir);
    const result = runCli(["execute", "--step", "--json", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.taskId, "TSK-0001");
    assert.match(normalize(result.stderr), /\[TSK-0001\].*(running|verifying)/);
  });
});

test("execute --resume refuses an unknown run without starting ready work", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedPlanReady(dir);
    const result = runCli(["execute", "--resume", "missing-run", "--json", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, false);
    assert.match(body.blocker, /unknown execute resume run missing-run/);
    assert.equal((await engine.store.readTask("TSK-0001")).data.status, "ready");
    assert.equal((await engine.getState()).currentTaskId, null);
    assert.equal(existsSync(join(dir, "src", "main.ts")), false);
  });
});

test("execute --allow-no-sandbox without TTY refuses", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir);
    const result = runCli(["execute", "--allow-no-sandbox", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /requires a TTY/);
    assert.match(normalize(result.stderr), /--allow-no-sandbox/);
  });
});

test("execute --allow-no-sandbox with piped Y still requires a TTY", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir);
    const result = runCli(["execute", "--allow-no-sandbox", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
      input: "Y\n",
    });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /requires a TTY/);
    assert.match(normalize(result.stderr), /--allow-no-sandbox/);
  });
});

test("doctor --metrics counts one execute timeout", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir);
    const previous = process.env.LEGION_CLI_ADAPTER;
    process.env.LEGION_CLI_ADAPTER = "fake";
    try {
      const timed = createLegionEngine(dir, { fakeTimedOut: true });
      const result = await timed.execute("auto");
      assert.equal(result.status, "blocked");
    } finally {
      if (previous === undefined) delete process.env.LEGION_CLI_ADAPTER;
      else process.env.LEGION_CLI_ADAPTER = previous;
    }
    const doctor = runCli(["doctor", "--metrics", "--json", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
    const body = JSON.parse(doctor.stdout);
    assert.equal(body.metrics.timeouts, 1);
  });
});

test("execute other-spec id refuses", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir);
    const engine = createLegionEngine(dir);
    await engine.store.writeTask(
      makeTask({
        id: "TSK-9999",
        specId: "spec-other",
        status: "ready",
        contract: {
          filesAllowed: ["src/other.ts"],
          expectedArtifacts: ["src/other.ts"],
          verificationCommands: [passingVerify()],
        },
      }),
      "Other spec task.\n",
    );
    await engine.approvePlan();
    const result = runCli(["execute", "TSK-9999", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 1);
    assert.match(normalize(`${result.stdout}\n${result.stderr}`), /not in the active spec slice/);
    assert.match(normalize(result.stdout), /Next: legion-cli status --blockers/);
  });
});

test("execute --adapter grok refuses via cli when grok is unspawnable", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedPlanReady(dir);
    await engine.store.writeConfig(withUnspawnableGrok(await engine.store.readConfig()));
    await engine.approvePlan();
    const result = runCli(["execute", "--adapter", "grok", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 1);
    assert.match(normalize(`${result.stdout}\n${result.stderr}`), /spawnable adapter \(grok, via cli\)/);
  });
});

test("execute --until-blocked --adapter applies the override to the loop", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedPlanReady(dir, {
      extraTasks: [
        makeTask({
          id: "TSK-0002",
          title: "board",
          contract: {
            filesAllowed: ["src/board.ts"],
            expectedArtifacts: ["src/board.ts"],
            verificationCommands: [passingVerify()],
          },
        }),
      ],
    });
    await engine.store.writeConfig(withUnspawnableGrok(await engine.store.readConfig()));
    await engine.approvePlan();
    const result = runCli(["execute", "--until-blocked", "--adapter", "grok", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 1);
    assert.match(normalize(`${result.stdout}\n${result.stderr}`), /spawnable adapter \(grok, via cli\)/);
    assert.equal((await engine.store.readTask("TSK-0001")).data.status, "ready");
    assert.equal((await engine.store.readTask("TSK-0002")).data.status, "ready");
  });
});

test("status shows raw currentTaskAdapter when set", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir, { task: { adapter: "grok" } });
    const engine = createLegionEngine(dir);
    const state = await engine.store.readState();
    await engine.store.writeState(
      { ...state.data, phase: "executing", currentTaskId: "TSK-0001" },
      state.body,
    );
    const human = runCli(["status", "--project", dir]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(normalize(human.stdout), /Current task: TSK-0001 \(grok\)/);
    const json = runCli(["status", "--json", "--project", dir]);
    assert.equal(JSON.parse(json.stdout).currentTaskAdapter, "grok");
    const plain = runCli(["status", "--plain", "--project", dir]);
    assert.match(normalize(plain.stdout), /currentTaskAdapter\tgrok/);
  });
});

test("status omits current-task adapter suffix when Task.adapter is unset", async () => {
  await withTempDir(async (dir) => {
    await seedPlanReady(dir);
    const engine = createLegionEngine(dir);
    const state = await engine.store.readState();
    await engine.store.writeState(
      { ...state.data, phase: "executing", currentTaskId: "TSK-0001" },
      state.body,
    );
    const human = runCli(["status", "--project", dir]);
    assert.match(normalize(human.stdout), /Current task: TSK-0001$/m);
    assert.doesNotMatch(normalize(human.stdout), /Current task: TSK-0001 \(/);
    const json = runCli(["status", "--json", "--project", dir]);
    assert.equal(JSON.parse(json.stdout).currentTaskAdapter, null);
    const plain = runCli(["status", "--plain", "--project", dir]);
    assert.doesNotMatch(normalize(plain.stdout), /currentTaskAdapter/);
  });
});
