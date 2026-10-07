import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { detectSandbox } from "@9thlevelsoftware/legion-cli-sandbox";
import { WORKFLOW_STAGE_FIELDS } from "@9thlevelsoftware/legion-cli-schema";
import { allowCopyJail, allowCopyJailIn, normalize, readGolden, runCli, withTempDir } from "./helpers.js";

function quoteArg(value) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function passingVerify() {
  return `${quoteArg(process.execPath)} -e process.exit(0)`;
}

async function patchAdapter(dir, patch) {
  const engine = createLegionEngine(dir);
  const config = await engine.store.readConfig();
  await engine.store.writeConfig({
    ...config,
    adapter: {
      ...config.adapter,
      ...patch,
    },
  });
  return engine;
}

function makeReadyTask(overrides = {}) {
  const { contract, ...rest } = overrides;
  return {
    schemaVersion: "legion-cli-task/v1",
    id: "TSK-0001",
    title: "scaffold",
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

async function assertTranscript(actual, name) {
  const expected = await readGolden(name);
  assert.equal(normalize(actual), expected);
}

function normalizeProjectScope(text, project) {
  return normalize(text).replaceAll(`--project '${project.replaceAll("'", "''")}'`, "--project <project>");
}

async function assertScopedTranscript(actual, name, project) {
  const expected = await readGolden(name);
  assert.equal(normalizeProjectScope(actual, project), expected);
}

async function seedExecutingSlice(dir, tasks) {
  const engine = createLegionEngine(dir);
  await engine.init({ name: "Checkin", adapter: "fake" });
  await engine.store.writeSpec({
    schemaVersion: "legion-cli-spec/v1", id: "spec-checkin", title: "Checkin", status: "frozen",
    mustBeTrue: ["works"], mustNotChange: [], outOfScope: [],
    acceptance: [{ id: "AC-01", statement: "works", kind: "behavior", priority: "P0" }],
    personas: ["user"], happyPath: "use it", frozenAt: "2026-10-02T00:00:00.000Z", frozenBy: "tester",
  }, "Spec body.\n");
  for (const task of tasks) {
    await engine.store.writeTask(makeReadyTask(task), `${task.title ?? task.id ?? "task"}.\n`);
  }
  const state = await engine.store.readState();
  const currentTaskId = tasks.find((task) => task.status === "in_progress")?.id ?? null;
  await engine.store.writeState(
    {
      ...state.data,
      phase: "executing",
      activeSpecId: "spec-checkin",
      currentTaskId,
      lastReadiness: "PASS",
    },
    state.body,
  );
  return engine;
}

test("bare legion-cli is uninitialized status (golden)", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    await assertScopedTranscript(result.stdout, "status-uninitialized.stdout.txt", dir);
    assert.equal(normalize(result.stderr), "");
  });
});

test("init --name --adapter fake writes templates (golden)", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /adapter readiness: ready/);
    assert.match(result.stdout, /sandbox readiness: (?:ready|needs attention)/);
    if (result.stdout.includes("sandbox readiness: needs attention")) {
      assert.match(result.stdout, /Remediation: none; install a supported hardened sandbox, then run legion-cli doctor/);
    }
    await assertScopedTranscript(
      result.stdout
        .replace(/^sandbox readiness: .+\n/m, "sandbox readiness: <sandbox preflight>\n")
        .replace(/^Remediation: .+\n/m, ""),
      "init.stdout.txt",
      dir,
    );

    const project = await readFile(join(dir, ".legion-cli", "PROJECT.md"), "utf8");
    assert.match(project, /name: Checkin/);
    assert.match(project, /mode: greenfield/);
    const config = await readFile(join(dir, ".legion-cli", "config.yaml"), "utf8");
    assert.match(config, /default: fake/);
    const state = await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8");
    assert.match(state, /phase: initialized/);
  });
});

test("status after init (golden)", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const result = runCli(["status", "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    await assertScopedTranscript(result.stdout, "status-initialized.stdout.txt", dir);
  });
});

test("status --blockers with none (golden)", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["status", "--project", dir, "--blockers"]);
    assert.equal(result.status, 0, result.stderr);
    await assertTranscript(result.stdout, "status-blockers-none.stdout.txt");
  });
});

test("init --mode brownfield writes templates (golden)", async () => {
  await withTempDir(async (dir) => {
    const result = runCli([
      "init",
      "--project",
      dir,
      "--name",
      "Checkin",
      "--adapter",
      "fake",
      "--mode",
      "brownfield",
      "--brownfield-goal",
      "audit",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /adapter readiness: ready/);
    assert.match(result.stdout, /sandbox readiness: (?:ready|needs attention)/);
    await assertScopedTranscript(
      result.stdout
        .replace(/^sandbox readiness: .+\n/m, "sandbox readiness: <sandbox preflight>\n")
        .replace(/^Remediation: .+\n/m, ""),
      "init-brownfield.stdout.txt",
      dir,
    );
    const project = await readFile(join(dir, ".legion-cli", "PROJECT.md"), "utf8");
    assert.match(project, /mode: brownfield/);
  });
});

test("unknown verb is not parsed as status args (golden)", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["xyzzy", "--project", dir]);
    assert.equal(result.status, 1);
    await assertTranscript(result.stderr, "unknown-xyzzy.stderr.txt");
    assert.doesNotMatch(normalize(result.stderr), /too many arguments/);
  });
});

test("bare legion-cli --blockers still runs status", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["--project", dir, "--blockers"]);
    assert.equal(result.status, 0, result.stderr);
    await assertTranscript(result.stdout, "status-blockers-none.stdout.txt");
  });
});

test("init requires adapter when non-interactive (golden)", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["init", "--project", dir, "--name", "Checkin"]);
    assert.equal(result.status, 1);
    await assertScopedTranscript(result.stderr, "init-missing-adapter.stderr.txt", dir);
  });
});

test("doctor on the untouched init config follows detectSandbox (ok when hardened, advisory otherwise)", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const config = await createLegionEngine(dir).store.readConfig();
    assert.equal(config.sandbox.backend, "auto");
    assert.equal(config.sandbox.requireHardened, true);
    assert.equal(config.sandbox.allowCopyJail, false);
    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    const out = normalize(result.stdout);
    const detected = detectSandbox();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(out, /Doctor passed/);
    if (detected.hardened) {
      assert.match(out, new RegExp(`^ok    sandbox \\(${detected.backend}, hardened=true\\)$`, "m"));
    } else {
      assert.match(out, /^warn  sandbox \(/m);
      assert.match(out, /sandbox config cannot satisfy requireHardened|sandbox is not hardened/);
    }
  });
});

test("doctor reports sandbox:false as advisory on every OS when copy is forced without the opt-in", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const engine = createLegionEngine(dir);
    const config = await engine.store.readConfig();
    await engine.store.writeConfig({
      ...config,
      sandbox: { ...config.sandbox, backend: "copy", requireHardened: true, allowCopyJail: false },
    });
    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /^warn  sandbox \(hardened sandbox required/m);
    assert.match(out, /sandbox config cannot satisfy requireHardened \(copy\)/);
    assert.match(out, /Doctor passed/);
    const json = runCli(["doctor", "--project", dir, "--json"], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    const sandbox = report.checks.find((check) => check.label === "sandbox");
    assert.equal(sandbox.ok, true);
    assert.equal(sandbox.advisory, true);

    await allowCopyJail(engine.store);
    const optedIn = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(optedIn.status, 0, `${optedIn.stdout}\n${optedIn.stderr}`);
    assert.match(normalize(optedIn.stdout), /^ok    sandbox \(/m);
  });
});

test("status --json after init", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["status", "--project", dir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.phase, "initialized");
    assert.equal(body.name, "Checkin");
    assert.equal(body.mode, "greenfield");
    assert.match(body.next.run, /^legion-cli spec --project /);
  });
});

test("status exits 2 on blocked tasks and lists them", async () => {
  await withTempDir(async (dir) => {
    const engine = createLegionEngine(dir);
    await engine.init({ name: "Checkin", adapter: "fake" });
    await engine.store.writeTask(
      {
        schemaVersion: "legion-cli-task/v1",
        id: "TSK-0002",
        title: "in/out button",
        status: "blocked",
        type: "feature",
        priority: "P0",
        specId: "spec-checkin",
        blockedBy: ["TSK-0001"],
        blocks: [],
        contract: {
          filesAllowed: ["src/main.ts"],
          filesForbidden: [".git/**"],
          expectedArtifacts: ["src/main.ts"],
          verificationCommands: ["pnpm test"],
          maxFilesTouched: 20,
        },
        assignee: "agent",
        notes: "",
      },
      "Implement the in/out button.\n",
    );
    const state = await engine.store.readState();
    await engine.store.writeState(
      {
        ...state.data,
        phase: "executing",
        activeSpecId: "spec-checkin",
        currentTaskId: "TSK-0002",
        lastReadiness: "PASS",
      },
      state.body,
    );

    const result = runCli(["status", "--project", dir, "--blockers"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(normalize(result.stdout), /TSK-0002 blocked/);
  });
});

test("status exits 1 on FAIL readiness", async () => {
  await withTempDir(async (dir) => {
    const engine = createLegionEngine(dir);
    await engine.init({ name: "Checkin", adapter: "fake" });
    const state = await engine.store.readState();
    await engine.store.writeState(
      { ...state.data, phase: "plan_failed", lastReadiness: "FAIL", activeSpecId: "spec-checkin" },
      state.body,
    );
    const result = runCli(["status", "--project", dir]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(normalize(result.stdout), /Readiness: FAIL/);
    assert.match(normalize(result.stdout), /legion-cli plan/);
  });
});

test("status does not promote compaction or the dashboard", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingSlice(dir, [
      { status: "done" },
      {
        id: "TSK-0002",
        title: "board",
        status: "todo",
        contract: {
          filesAllowed: ["src/board.ts"],
          expectedArtifacts: ["src/board.ts"],
          verificationCommands: [passingVerify()],
        },
      },
    ]);
    const result = runCli(["status", "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    const out = normalize(result.stdout);
    assert.match(out, /Run:  legion-cli plan approve/);
    assert.doesNotMatch(out, /context compact|Viewer:/);
    const json = runCli(["status", "--json", "--project", dir]);
    assert.match(JSON.parse(json.stdout).next.run, /^legion-cli plan approve --project /);
  });
});

test("status omits compact hint when a done task has an in_progress sibling", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingSlice(dir, [
      { status: "done" },
      {
        id: "TSK-0002",
        title: "board",
        status: "in_progress",
        contract: {
          filesAllowed: ["src/board.ts"],
          expectedArtifacts: ["src/board.ts"],
          verificationCommands: [passingVerify()],
        },
      },
    ]);
    const result = runCli(["status", "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    const out = normalize(result.stdout);
    assert.match(out, /Run:  legion-cli plan approve/);
    assert.doesNotMatch(out, /Hint: legion-cli context compact/);
  });
});

test("status omits compact hint when slice tasks are compacted rather than done", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingSlice(dir, [{ status: "compacted" }]);
    const result = runCli(["status", "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    const out = normalize(result.stdout);
    assert.doesNotMatch(out, /Hint: legion-cli context compact/);
    assert.doesNotMatch(out, /Viewer:/);
  });
});

test("doctor fails when fake adapter is not spawnable", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "" },
    });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stdout), /Doctor failed/);
    assert.match(normalize(result.stdout), /^FAIL  adapter spawnable/m);
  });
});

test("doctor stderr does not contain DEP0190", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.doesNotMatch(normalize(result.stderr), /DEP0190/);
  });
});

test("doctor PATH listing names legion-cli and legion", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    const out = normalize(result.stdout);
    assert.match(out, /^PATH$/m);
    assert.match(out, /^  legion-cli$/m);
    assert.match(out, /^  legion$/m);
  });
});

test("doctor --json includes routed default", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    const result = runCli(["doctor", "--json", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.adapter.default, "fake");
    assert.equal(body.adapter.spawnable, true);
    assert.deepEqual(body.adapter.routes, {});
    assert.deepEqual(body.adapter.named, {});
    assert.deepEqual(body.adapter.routed, [
      { id: "fake", via: "default", skill: null, required: true, spawnable: true },
    ]);
  });
});

for (const skill of ["plan", "execute", "review"]) {
  test(`doctor fails closed when routes.${skill} grok args omit {{pointer}} even if grok is on PATH`, async () => {
    await withTempDir(async (dir) => {
      runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
      await allowCopyJailIn(dir);
      await patchAdapter(dir, {
        routes: { [skill]: "grok" },
        grok: { binary: process.execPath, args: ["--model", "grok-4"] },
      });
      const result = runCli(["doctor", "--project", dir], {
        env: { LEGION_CLI_ADAPTER: "fake" },
      });
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      const out = normalize(result.stdout);
      assert.match(out, new RegExp(`FAIL  adapter.routes.${skill} spawnable \\(grok is not spawnable\\)`));
      assert.match(out, new RegExp(`^  ${skill.padEnd(13)}grok  not spawnable$`, "m"));
      assert.match(out, /grok args are set \(trust warning\): --model <redacted>/);
      assert.match(out, /^  grok         on PATH \(/m);
      assert.match(out, /Doctor failed/);

      const json = runCli(["doctor", "--json", "--project", dir], {
        env: { LEGION_CLI_ADAPTER: "fake" },
      });
      assert.equal(json.status, 1, json.stderr);
      const body = JSON.parse(json.stdout);
      assert.equal(body.ok, false);
      assert.equal(body.adapter.spawnable, true);
      assert.equal(body.adapter.routes[skill], "grok");
      assert.deepEqual(
        body.adapter.routed.find((entry) => entry.skill === skill),
        {
          id: "grok",
          via: `routes.${skill}`,
          skill,
          required: true,
          spawnable: false,
        },
      );
    });
  });
}

test("doctor passes with trust warning when required-route extra args include {{pointer}}", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    await patchAdapter(dir, {
      routes: { plan: "grok" },
      grok: { binary: process.execPath, args: ["--model", "grok-4", "{{pointer}}"] },
    });
    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /grok args are set \(trust warning\): --model <redacted> \{\{pointer\}\}/);
    assert.match(out, /^  plan         grok  spawnable$/m);
    assert.doesNotMatch(out, /FAIL  adapter.routes/);
    assert.match(out, /Doctor passed/);

    const json = runCli(["doctor", "--json", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.ok, true);
    assert.deepEqual(
      body.adapter.routed.find((entry) => entry.skill === "plan"),
      {
        id: "grok",
        via: "routes.plan",
        skill: "plan",
        required: true,
        spawnable: true,
      },
    );
  });
});

test("doctor warns but passes when optional-skill route is unspawnable", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    await patchAdapter(dir, {
      routes: { interview: "grok" },
      grok: { binary: process.execPath, args: ["--model", "grok-4"] },
    });
    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /adapter.routes.interview \(grok\) is not spawnable \(optional skill\)/);
    assert.match(out, /Doctor passed/);
    assert.doesNotMatch(out, /FAIL  adapter.routes/);
  });
});

test("doctor warns but passes when named adapter target is unspawnable", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    await patchAdapter(dir, {
      named: { ui: "grok" },
      grok: { binary: process.execPath, args: ["--model", "grok-4"] },
    });
    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /adapter.named.ui \(grok\) is not spawnable/);
    assert.match(out, /Doctor passed/);
  });
});

test("doctor warns on unspawnable Task.adapter in the active spec slice only", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    const engine = await patchAdapter(dir, {
      grok: { binary: process.execPath, args: ["--model", "grok-4"] },
    });
    const state = await engine.store.readState();
    await engine.store.writeState({ ...state.data, activeSpecId: "spec-checkin" }, state.body);
    await engine.store.writeTask(makeReadyTask({ adapter: "grok" }), "Scaffold the check-in app.\n");
    await engine.store.writeTask(
      makeReadyTask({ id: "TSK-0099", specId: "spec-other", adapter: "grok" }),
      "Outside the active spec.\n",
    );
    await mkdir(join(dir, ".legion-cli", "tasks"), { recursive: true });
    await writeFile(join(dir, ".legion-cli", "tasks", "TSK-bad.md"), "not a task\n", "utf8");

    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /TSK-0001 adapter \(grok\) is not spawnable/);
    assert.doesNotMatch(out, /TSK-0099/);
    assert.doesNotMatch(out, /TSK-bad/);
    assert.match(out, /Doctor passed/);
  });
});

test("doctor fails closed when adapter.default is missing", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["doctor", "--project", dir]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /FAIL  adapter.default \(adapter.default is missing\)/);
    assert.match(out, /^Routes$/m);
    assert.match(out, /Doctor failed/);
  });
});

test("doctor --metrics reads local audit and honors DO_NOT_TRACK", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    const execute = runCli(["execute", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(execute.status, 1, execute.stderr);
    const none = runCli(["doctor", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.doesNotMatch(normalize(none.stdout), /Local metrics/);

    const result = runCli(["doctor", "--metrics", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake", DO_NOT_TRACK: "1" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /Local metrics \(on disk only; never phones home\)/);
    assert.match(out, /DO_NOT_TRACK=1 honored/);
    assert.match(out, /Refuses by type/);
    assert.match(out, /none/);
    assert.match(out, /QA pass rate/);
    assert.match(out, /Mean execute duration/);
    assert.match(out, /Timeouts/);
    assert.match(out, /Doctor passed/);

    const json = runCli(["doctor", "--metrics", "--json", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake", DO_NOT_TRACK: "1" },
    });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.metrics.telemetry, "off");
    assert.equal(body.metrics.source, ".legion-cli/audit/events.jsonl");
    assert.equal(body.metrics.qaSource, null);
    assert.equal(body.metrics.refusesByType.plan ?? 0, 0);
    assert.equal(body.metrics.timeouts, 0);
  });
});

test("doctor --metrics falls back to QA score files", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    const scoresDir = join(dir, ".legion-cli", "qa", "scores");
    await mkdir(scoresDir, { recursive: true });
    await writeFile(
      join(scoresDir, "qa-1.json"),
      `${JSON.stringify({
        schemaVersion: "legion-cli-qa/v1",
        id: "qa-1",
        specId: "spec-checkin",
        mode: "full",
        buckets: {
          p0: { points: 40, max: 40, failed: 0 },
          p1: { points: 27, max: 30, passRate: 0.9 },
          p2: { points: 12, max: 15, passRate: 0.8 },
          visual: { points: 15, max: 15, regressions: 0 },
        },
        total: 94,
        pass: true,
        evidencePaths: [".legion-cli/qa/scores/qa-1.json"],
        createdAt: "2026-09-01T12:00:00Z",
      })}\n`,
      "utf8",
    );
    const result = runCli(["doctor", "--metrics", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /QA pass rate\s+1\/1 \(100%\)/);
    assert.match(out, /QA source\s+\.legion-cli\/qa\/scores/);
    const json = runCli(["doctor", "--metrics", "--json", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    const body = JSON.parse(json.stdout);
    assert.equal(body.metrics.source, ".legion-cli/audit/events.jsonl");
    assert.equal(body.metrics.qaSource, ".legion-cli/qa/scores");
    assert.equal(body.metrics.qa.runs, 1);
    assert.equal(body.metrics.qa.passes, 1);
    assert.equal(body.metrics.qa.passRate, 1);
  });
});

test("help doctor lists --metrics", () => {
  const result = runCli(["help", "doctor"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(normalize(result.stdout), /--metrics/);
});

test("Checkin session key lines match the design-doc walkthrough (golden)", async () => {
  await withTempDir(async (dir) => {
    const fake = { env: { LEGION_CLI_ADAPTER: "fake" } };
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    assert.equal(init.status, 0, init.stderr);

    const intent = runCli(["intent", "--project", dir, "--done"], {
      input: [
        "Teammates who keep missing who's in the office.",
        "They ping five chat apps every morning.",
        "People can tap in or out on their phone in under five seconds.",
        "Do not change auth. We will not build payroll, badges, or calendar sync.",
        "Y",
      ].join("\n") + "\n",
    });
    assert.equal(intent.status, 0, `${intent.stdout}\n${intent.stderr}`);

    const discuss = runCli(["discuss", "--project", dir], { input: "Y\nY\nY\n" });
    assert.equal(discuss.status, 0, `${discuss.stdout}\n${discuss.stderr}`);

    const spec = runCli(["spec", "--project", dir]);
    assert.equal(spec.status, 0, `${spec.stdout}\n${spec.stderr}`);
    const challenge = runCli(["spec", "--project", dir, "--manual-review"], {
      input: [
        "A check-in is recorded in under five seconds and confirmed to the teammate.",
        "When unavailable, preserve the attempted check-in and show a clear retry message.",
        "Do not change authentication or add payroll, badge, or calendar scope.",
        "I acknowledge",
      ].join("\n") + "\n",
    });
    assert.equal(challenge.status, 0, `${challenge.stdout}\n${challenge.stderr}`);

    const approve = runCli(["spec", "approve", "--project", dir]);
    assert.equal(approve.status, 0, approve.stderr);

    const engine = createLegionEngine(dir);
    await allowCopyJail(engine.store);
    await mkdir(join(dir, ".legion-cli", "specs", "spec-checkin"), { recursive: true });
    await writeFile(join(dir, ".legion-cli", "specs", "spec-checkin", "stories.yaml"), "stories: []\n", "utf8");
    await engine.store.writeTask(makeReadyTask(), "Scaffold the check-in app.\n");
    await engine.store.writeTask(
      makeReadyTask({
        id: "TSK-0002",
        title: "in/out button",
        contract: {
          filesAllowed: ["src/button.ts"],
          expectedArtifacts: ["src/button.ts"],
          verificationCommands: [passingVerify()],
        },
      }),
      "Implement the in/out button.\n",
    );

    const preparation = (await engine.readWorkflowPreparation()).record;
    const tasks = await engine.listSliceTasks();
    const frozenSpec = (await engine.store.readSpec("spec-checkin")).data;
    const designFields = {
      decision: "Keep the existing check-in interaction and task-owned scaffold/button components",
      interfaces: "Scaffold owns src/main.ts; button task owns src/button.ts; no shared ownership",
      failureCompatibility: "Preserve authentication, confirm recorded check-in, and expose retry when unavailable",
      verification: "Run the approved task checks and independently review the check-in interaction",
      installation: "Deliver the local source change; production deployment is outside this fixture scope",
      recovery: "Revert the bounded local change if the recorded interaction fails review",
      externalChecks: "No provider rollout is approved by this local transcript fixture",
      operator: "The project maintainer reviews and accepts the local delivery",
    };
    const designOutputs = preparation.assessment.stageDecisions
      .filter((item) => item.decision === "required" && !["context", "requirements"].includes(item.stage))
      .map((item) => {
        const fields = Object.fromEntries(WORKFLOW_STAGE_FIELDS[item.stage].map((key) => [key, designFields[key]]));
        const content = `# ${item.stage}\n\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n`;
        const path = `.legion-cli/plans/spec-checkin/${item.stage}.md`;
        return { path, content, artifact: { stage: item.stage, path, digest: createHash("sha256").update(content).digest("hex"), inputs: preparation.specArtifacts.map((artifact) => ({ path: artifact.path, digest: artifact.digest })), fields } };
      });
    const plannedPreparation = { ...preparation, planArtifacts: designOutputs.map((item) => item.artifact),
      acceptanceMappings: frozenSpec.acceptance.map((criterion) => ({ criterionId: criterion.id, taskIds: tasks.map((task) => task.id), methods: tasks.map((task) => ({ id: `${criterion.id}-${task.id}`, kind: "task_check", taskId: task.id, command: task.contract.verificationCommands[0], expectedObservation: `The approved task check completes for ${task.title}; independent review still assesses ${criterion.statement}` })) })) };
    const planArtifacts = [...designOutputs.map(({ path, content }) => ({ path, content })),
      { path: ".legion-cli/plans/spec-checkin.md", content: "# Checkin plan\n\nImplement the approved tasks.\n" },
      { path: ".legion-cli/cache/runs/<id>/preparation.json", content: JSON.stringify(plannedPreparation) }];
    const plan = runCli(["plan", "--project", dir], { env: { ...fake.env, LEGION_CLI_FAKE_ARTIFACTS: JSON.stringify(planArtifacts) } });
    assert.equal(plan.status, 0, `${plan.stdout}\n${plan.stderr}`);

    await writeFile(join(dir, ".legion-cli", "plans", "spec-checkin.md"), "# Checkin plan\n\nImplement the approved tasks.\n", "utf8");

    const planApprove = runCli(["plan", "approve", "--project", dir], fake);
    assert.equal(planApprove.status, 0, `${planApprove.stdout}\n${planApprove.stderr}`);

    const execute = runCli(["execute", "--until-blocked", "--project", dir], fake);
    assert.equal(execute.status, 1, `${execute.stdout}\n${execute.stderr}`);
    assert.match(normalize(execute.stdout), /review failed: agent wrote no notes/);

    const combined = [
      normalize(intent.stdout),
      normalize(approve.stdout),
      normalize(plan.stdout),
      normalize(planApprove.stdout),
      normalize(execute.stdout),
    ].join("\n");
    const expected = await readGolden("session-checkin.key-lines.txt");
    for (const line of expected.trim().split("\n")) {
      assert.match(combined, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
