import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { normalize, readGolden, runCli, sanitizeDoctor, withTempDir } from "./helpers.js";

function quoteArg(value) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function unitCommand(payload) {
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`;
  return `${quoteArg(process.execPath)} -e ${quoteArg(script)}`;
}

function passingVerify() {
  return `${quoteArg(process.execPath)} -e process.exit(0)`;
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

test("bare legion-cli is uninitialized status (golden)", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    await assertTranscript(result.stdout, "status-uninitialized.stdout.txt");
    assert.equal(normalize(result.stderr), "");
  });
});

test("init --name --adapter fake writes templates (golden)", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(result.status, 0, result.stderr);
    await assertTranscript(result.stdout, "init.stdout.txt");

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
    await assertTranscript(result.stdout, "status-initialized.stdout.txt");
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
    ]);
    assert.equal(result.status, 0, result.stderr);
    await assertTranscript(result.stdout, "init-brownfield.stdout.txt");
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
    await assertTranscript(result.stderr, "init-missing-adapter.stderr.txt");
  });
});

test("doctor after init with fake adapter (golden)", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const expected = await readGolden("doctor.stdout.txt");
    assert.equal(sanitizeDoctor(result.stdout), expected);
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
    assert.equal(body.next.run, "legion-cli intent");
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

test("doctor fails when fake adapter is not spawnable", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "" },
    });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stdout), /Doctor failed/);
    assert.match(normalize(result.stdout), /adapter spawnable/);
  });
});

test("doctor stderr does not contain DEP0190", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.doesNotMatch(normalize(result.stderr), /DEP0190/);
  });
});

test("doctor PATH listing names legion-cli and legion", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    const out = normalize(result.stdout);
    assert.match(out, /^PATH$/m);
    assert.match(out, /^  legion-cli$/m);
    assert.match(out, /^  legion$/m);
  });
});

test("doctor --metrics reads local audit and honors DO_NOT_TRACK", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
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
    assert.match(out, /plan\s+1/);
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
    assert.equal(body.metrics.refusesByType.plan, 1);
    assert.equal(body.metrics.timeouts, 0);
  });
});

test("doctor --metrics falls back to QA score files", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
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

    const discuss = runCli(["discuss", "--project", dir, "--yes"]);
    assert.equal(discuss.status, 0, `${discuss.stdout}\n${discuss.stderr}`);

    const spec = runCli(["spec", "--project", dir]);
    assert.equal(spec.status, 0, `${spec.stdout}\n${spec.stderr}`);

    const approve = runCli(["spec", "approve", "--project", dir]);
    assert.equal(approve.status, 0, approve.stderr);

    const engine = createLegionEngine(dir);
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

    const plan = runCli(["plan", "--project", dir], fake);
    assert.equal(plan.status, 0, `${plan.stdout}\n${plan.stderr}`);

    const execute = runCli(["execute", "--until-blocked", "--project", dir], fake);
    assert.equal(execute.status, 0, `${execute.stdout}\n${execute.stderr}`);

    const review = runCli(["review", "--project", dir], fake);
    assert.equal(review.status, 0, `${review.stdout}\n${review.stderr}`);

    const specDoc = await engine.store.readSpec("spec-checkin");
    await engine.store.writeSpec(
      {
        ...specDoc.data,
        wireframesIndex: null,
        acceptance: [
          {
            id: "AC-01",
            statement: "API returns 200 for health",
            kind: "test",
            priority: "P0",
          },
        ],
      },
      specDoc.body,
    );
    const config = await engine.store.readConfig();
    await engine.store.writeConfig({
      ...config,
      qa: {
        ...config.qa,
        unitCommand: unitCommand({
          tests: [
            { title: "p0 @p0", status: "passed" },
            ...Array.from({ length: 9 }, () => ({ title: "p1 @p1", status: "passed" })),
            { title: "p1 fail @p1", status: "failed" },
            ...Array.from({ length: 4 }, () => ({ title: "p2 @p2", status: "passed" })),
            { title: "p2 fail @p2", status: "failed" },
          ],
        }),
      },
    });

    const qa = runCli(["qa", "--project", dir]);
    assert.equal(qa.status, 0, `${qa.stdout}\n${qa.stderr}`);

    const combined = [
      normalize(intent.stdout),
      normalize(approve.stdout),
      normalize(plan.stdout),
      normalize(execute.stdout),
      normalize(review.stdout),
      normalize(qa.stdout),
    ].join("\n");
    const expected = await readGolden("session-checkin.key-lines.txt");
    for (const line of expected.trim().split("\n")) {
      assert.match(combined, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
