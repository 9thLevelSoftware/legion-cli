import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { normalize, readGolden, runCli, sanitizeDoctor, withTempDir } from "./helpers.js";

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

test("init --mode brownfield refuses (golden)", async () => {
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
    assert.equal(result.status, 1);
    await assertTranscript(result.stderr, "init-brownfield.stderr.txt");
  });
});

test("unknown verb is not parsed as status args (golden)", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["intent", "--project", dir]);
    assert.equal(result.status, 1);
    await assertTranscript(result.stderr, "unknown-intent.stderr.txt");
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
