import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { AssuranceApprovalSchema, PlanApprovalReceiptSchema } from "@9thlevelsoftware/legion-cli-schema";
import { appendGovernanceBegin, readGovernanceEpochs, readGovernanceTrace, governanceTraceDirectory } from "@9thlevelsoftware/legion-cli-persist";
import { stableHash } from "@9thlevelsoftware/legion-cli-http";
import { ASSURANCE_APPROVAL_PATH, ASSURANCE_PLAN_PATH, assuranceManifestDigest } from "../dist/index.js";
import { failingVerificationCommand, initGitRepo, initProject, passingVerificationCommand, seedPlanReady, withEngine, withFakeAdapter } from "./helpers.js";

function manifest() {
  return {
    schemaVersion: "legion-cli-assurance-plan/v1", specId: "spec-checkin",
    acceptanceIds: ["AC-01"], taskIds: ["TSK-0001"],
    security: {
      mode: "adapter-default", sources: [{ id: "main", path: "src/main.ts", classification: "workspace" }],
      sinks: [], transformations: [], tasks: [{ taskId: "TSK-0001", readPaths: ["src/main.ts"], transformationIds: [] }], externalCalls: [],
    },
    knowledge: [], validators: [], delivery: { artifacts: [] },
  };
}

async function fixture(fn, options = {}) {
  await withFakeAdapter(() => withEngine(async ({ engine, store, dir }) => {
    await initProject(engine, { workflowProfile: "focused" });
    await seedPlanReady(store);
    await writeFile(join(dir, ".legion-cli/plans/spec-checkin.md"), "# Reviewed plan\n\nImplement the approved task.\n");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/main.ts"), "export const value = 1;\n");
    const draft = join(dir, "assurance-draft.yaml");
    await writeFile(draft, stringify(manifest()));
    await fn({ engine, store, dir, draft });
  }, options));
}

test("adoption binds a new epoch, preservation keeps its identity, and off restores the legacy plan fingerprint", async () => {
  await fixture(async ({ engine, store, draft }) => {
    const legacy = await engine.approvePlan();
    assert.equal((await engine.getWorkflowStatus()).assurance, undefined);
    const adopted = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    assert.notEqual(adopted.approvalId, legacy.approvalId);
    assert.notEqual(adopted.planFingerprint, legacy.planFingerprint);
    assert.deepEqual(PlanApprovalReceiptSchema.parse(adopted), adopted);
    const sidecar = await store.readYaml(ASSURANCE_APPROVAL_PATH, AssuranceApprovalSchema);
    assert.equal(sidecar.approvalId, adopted.approvalId);
    assert.equal(sidecar.planFingerprint, adopted.planFingerprint);
    assert.equal(sidecar.manifestDigest, assuranceManifestDigest(manifest()));
    assert.equal(sidecar.nativeHost, null);
    assert.notEqual(sidecar.baselineSources[0].sha256, null);
    const status = await engine.getWorkflowStatus();
    assert.equal(status.planApproval, "valid");
    assert.equal(status.assurance.informationFlow, "not-enforced");
    const before = await readFile(join(store.projectRoot, ASSURANCE_PLAN_PATH), "utf8");
    const adoptedConfig = await store.readConfig();
    const adoptedModelDigest = stableHash({
      adapter: adoptedConfig.adapter ?? null,
      profiles: adoptedConfig.adapter.profiles ?? null,
      skillProfiles: adoptedConfig.adapter.skillProfiles ?? null,
    });
    const adoptedTrace = await readGovernanceTrace(store, adopted.approvalId, adoptedModelDigest);
    assert.equal(adoptedTrace.status, "valid");
    assert.deepEqual(adoptedTrace.frames.map(({ boundary, action }) => [boundary, action]), [
      ["begin", "approval-adopt"], ["end", "approval-adopt"],
    ]);
    const reapproved = await engine.approvePlan();
    assert.notEqual(reapproved.approvalId, adopted.approvalId);
    assert.equal(reapproved.planFingerprint, adopted.planFingerprint);
    assert.equal(await readFile(join(store.projectRoot, ASSURANCE_PLAN_PATH), "utf8"), before);
    assert.deepEqual((await readGovernanceTrace(store, adopted.approvalId, adoptedModelDigest)).frames, adoptedTrace.frames);
    assert.equal((await store.readYaml(ASSURANCE_APPROVAL_PATH, AssuranceApprovalSchema)).approvalId, reapproved.approvalId);
    const removed = await engine.approvePlan({ id: "operator" }, { assuranceOff: true });
    assert.notEqual(removed.approvalId, reapproved.approvalId);
    assert.equal(removed.planFingerprint, legacy.planFingerprint);
    assert.equal(await store.pathExists(ASSURANCE_PLAN_PATH), false);
    assert.equal(await store.pathExists(ASSURANCE_APPROVAL_PATH), false);
    assert.equal((await engine.getWorkflowStatus()).assurance, undefined);
  });
});

test("missing markers and manifest tampering invalidate approval until an explicit fresh epoch", async () => {
  await fixture(async ({ engine, store, draft }) => {
    const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    await rm(join(store.projectRoot, ASSURANCE_APPROVAL_PATH));
    assert.equal((await engine.getWorkflowStatus()).planApproval, "stale");
    await assert.rejects(() => engine.executeWorkflow());
    const repaired = await engine.approvePlan();
    assert.notEqual(repaired.approvalId, approved.approvalId);
    assert.equal((await engine.getWorkflowStatus()).planApproval, "valid");
    const changed = manifest();
    changed.security.sources[0].classification = "sealed";
    await writeFile(join(store.projectRoot, ASSURANCE_PLAN_PATH), stringify(changed));
    assert.equal((await engine.getWorkflowStatus()).planApproval, "stale");
    await assert.rejects(() => engine.executeWorkflow());
    await assert.rejects(() => engine.approvePlan());
    await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const sidecar = await store.readYaml(ASSURANCE_APPROVAL_PATH, AssuranceApprovalSchema);
    await store.writeYaml(ASSURANCE_APPROVAL_PATH, { ...sidecar, approvalId: "another-epoch" });
    assert.equal((await engine.getWorkflowStatus()).planApproval, "stale");
    await rm(join(store.projectRoot, ASSURANCE_PLAN_PATH));
    assert.equal((await engine.getWorkflowStatus()).assurance.status, "invalid");
    await assert.rejects(() => engine.approvePlan());
    await engine.approvePlan({ id: "operator" }, { assuranceOff: true });
    assert.equal((await engine.getWorkflowStatus()).planApproval, "valid");
  });
});

test("invalid declarations and protected grants are rejected without changing the current approval", async () => {
  await fixture(async ({ engine, store, draft }) => {
    const initial = await engine.approvePlan();
    const invalid = [
      (v) => { v.acceptanceIds = ["unknown"]; },
      (v) => { v.taskIds = ["unknown"]; },
      (v) => { v.specId = "another-spec"; },
      (v) => { v.security.tasks[0].transformationIds = ["unknown"]; },
      (v) => { v.security.sources[0].path = ".legion-cli/workflow/assurance.yaml"; },
      (v) => { v.security.tasks[0].readPaths = [".legion-cli/audit"]; },
      (v) => { v.security.sources.push({ ...v.security.sources[0], id: "alias" }); },
      (v) => { v.security.sources[0].path = "../escape"; },
      (v) => { v.knowledge = [{ id: "unit", statement: "Reviewed", source: { path: "src/main.ts" }, acceptanceIds: ["AC-01"], taskIds: [], dependsOn: ["unit"], checkIds: [] }]; },
      (v) => { v.knowledge = [{ id: "unit", statement: "Reviewed", source: { path: "src/main.ts" }, acceptanceIds: ["AC-01"], taskIds: [], dependsOn: [], checkIds: ["unknown"] }]; },
      (v) => { v.security.sinks = [{ id: "provider", origin: "file:///private", classifications: ["workspace"] }]; },
      (v) => { v.security.externalCalls = [{ id: "call", taskIds: ["TSK-0001"], tool: "tool", sinkId: "unknown", authority: {}, dataPointers: [], effect: "http-mcp" }]; },
      (v) => { v.security.sinks = [{ id: "provider", origin: "https://example.com/", classifications: ["workspace"] }]; v.security.externalCalls = [{ id: "call", taskIds: ["TSK-0001"], tool: "tool", sinkId: "provider", authority: { recipient: "fixed" }, dataPointers: ["/recipient"], effect: "http-mcp" }]; },
    ];
    for (const mutate of invalid) {
      const value = manifest(); mutate(value);
      await writeFile(draft, stringify(value));
      await assert.rejects(() => engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft }));
      assert.equal((await engine.getWorkflowStatus()).planApproval, "valid");
      const receipt = await store.readYaml(".legion-cli/workflow/plan-approval.yaml", PlanApprovalReceiptSchema);
      assert.equal(receipt.approvalId, initial.approvalId);
    }
    const overlapping = [
      [{ recipient: "fixed" }, "/recipient/inner"],
      [{ recipients: ["fixed"] }, "/recipients/1"],
      [{ scope: { tenant: "fixed" } }, "/scope"],
      [{ scope: { tenant: "fixed" } }, "/scope/tenant"],
    ];
    for (const [authority, pointer] of overlapping) {
      const value = manifest();
      value.security.sinks = [{ id: "provider", origin: "https://example.com/", classifications: ["workspace"] }];
      value.security.externalCalls = [{ id: "call", taskIds: ["TSK-0001"], tool: "tool", sinkId: "provider", authority, dataPointers: [pointer], effect: "http-mcp" }];
      await writeFile(draft, stringify(value));
      await assert.rejects(() => engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft }), /data pointer overlaps fixed authority/, pointer);
      const receipt = await store.readYaml(".legion-cli/workflow/plan-approval.yaml", PlanApprovalReceiptSchema);
      assert.equal(receipt.approvalId, initial.approvalId);
    }
    await assert.rejects(() => engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft, assuranceOff: true }));
    assert.equal(await store.pathExists(ASSURANCE_PLAN_PATH), false);
  });
});

test("bounded strict YAML rejects duplicate keys, nonfinite values, aliases, unknown fields, and oversized drafts", async () => {
  await fixture(async ({ engine, draft }) => {
    await engine.approvePlan();
    const nonfinite = manifest();
    nonfinite.security.sinks = [{ id: "provider", origin: "https://example.com/", classifications: ["workspace"] }];
    nonfinite.security.externalCalls = [{ id: "call", taskIds: ["TSK-0001"], tool: "tool", sinkId: "provider", authority: { limit: Infinity }, dataPointers: [], effect: "http-mcp" }];
    const deep = structuredClone(nonfinite);
    let nested = {};
    for (let i = 0; i < 33; i++) nested = { nested };
    deep.security.externalCalls[0].authority = nested;
    for (const raw of [
      `${stringify(manifest())}\nspecId: spec-checkin\n`,
      `${stringify(manifest())}\nunexpected: true\n`,
      stringify(nonfinite),
      stringify(deep),
      stringify(manifest()).replace("path: src/main.ts", "path: &source src/main.ts").replace("- src/main.ts", "- *source"),
      `#${"x".repeat(1024 * 1024)}\n${stringify(manifest())}`,
    ]) {
      await writeFile(draft, raw);
      await assert.rejects(() => engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft }));
      assert.equal((await engine.getWorkflowStatus()).planApproval, "valid");
    }
  });
});

test("information-flow rejects vendor/task transports and admits HTTP without falling back to the legacy executor", async () => {
  await fixture(async ({ engine, store, draft }) => {
    const value = manifest(); value.security.mode = "information-flow";
    await writeFile(draft, stringify(value));
    await assert.rejects(() => engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft }));
    const config = await store.readConfig();
    await store.writeConfig({ ...config, adapter: { ...config.adapter, default: "http", http: { baseUrl: "http://127.0.0.1:1/v1", model: "fixture", apiKeyEnv: "ASSURANCE_TEST_KEY", allowLoopback: true } } });
    const task = await store.readTask("TSK-0001");
    await store.writeTask({ ...task.data, adapter: "claude" }, task.body);
    await assert.rejects(() => engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft }));
    const { adapter: _adapter, ...httpTask } = task.data;
    await store.writeTask(httpTask, task.body);
    const httpConfig = await store.readConfig();
    await store.writeConfig({ ...httpConfig, mcpServers: { local: { transport: "stdio", command: "node", args: [] } } });
    await assert.rejects(() => engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft }));
    await store.writeConfig(httpConfig);
    await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const status = await engine.getWorkflowStatus();
    assert.equal(status.planApproval, "valid");
    assert.equal(status.assurance.informationFlow, "pending");
    assert.equal(status.execution, "blocked");
    const result = await engine.executeWorkflow();
    assert.doesNotMatch(result.blocker ?? "", /spawnable adapter/);
    assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
  });
});
test("adopted mutations append contiguous redacted governance frames and legacy mutations stay untraced", async () => {
  await fixture(async ({ engine, store, draft }) => {
    const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const task = await store.readTask("TSK-0001");
    await engine.amendTask(task.data.id, task.data.contract);
    const config = await store.readConfig();
    const modelDigest = stableHash({
      adapter: config.adapter ?? null,
      profiles: config.adapter.profiles ?? null,
      skillProfiles: config.adapter.skillProfiles ?? null,
    });
    const trace = await readGovernanceTrace(store, approved.approvalId, modelDigest);
    assert.equal(trace.status, "valid");
    assert.equal(trace.frames.length, 4);
    assert.deepEqual(trace.frames.map(({ boundary, action, sequence }) => [boundary, action, sequence]), [
      ["begin", "approval-adopt", 0], ["end", "approval-adopt", 1],
      ["begin", "amend-inputs", 2], ["end", "amend-inputs", 3],
    ]);
    assert.equal(trace.frames[0].after, null);
    assert.equal(trace.frames[1].outcome, "success");
  });

  await fixture(async ({ engine, store }) => {
    await engine.approvePlan();
    const task = await store.readTask("TSK-0001");
    await engine.amendTask(task.data.id, task.data.contract);
    assert.equal(await store.pathExists(".legion-cli/audit/governance"), false);
  });
});

test("adopted task execution persists lifecycle boundaries and current task projection", async () => {
  await fixture(async ({ engine, store, dir, draft }) => {
    const task = await store.readTask("TSK-0001");
    await store.writeTask({
      ...task.data,
      contract: { ...task.data.contract, verificationCommands: [passingVerificationCommand()] },
    }, task.body);
    initGitRepo(dir);
    const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const result = await engine.execute("TSK-0001");
    assert.equal(result.status, "done");
    const config = await store.readConfig();
    const modelDigest = stableHash({
      adapter: config.adapter ?? null,
      profiles: config.adapter.profiles ?? null,
      skillProfiles: config.adapter.skillProfiles ?? null,
    });
    const trace = await readGovernanceTrace(store, approved.approvalId, modelDigest);
    assert.equal(trace.status, "valid");
    const actions = trace.frames.filter((frame) => frame.boundary === "begin").map((frame) => frame.action);
    for (const action of ["approval-adopt", "task-start", "integration-complete", "task-verify", "task-complete"]) {
      assert.ok(actions.includes(action), `missing ${action} boundary`);
    }
    const final = trace.frames.at(-1).after;
    const projected = final.tasks.find((entry) => entry.id === "TSK-0001");
    assert.deepEqual([projected.status, projected.owner, projected.checks], ["done", null, "passed"]);
    assert.equal(final.approval.freshness, "current");
    assert.deepEqual(final.acceptance, [{ id: "AC-01", status: "not-recorded", freshness: "unknown" }]);
  });
});
test("adopted parallel execution traces each real sandbox application", async () => {
  const applied = [];
  let projectDir;
  let arrivals = 0;
  let releasePopulation;
  const bothArrived = new Promise((resolve) => { releasePopulation = resolve; });
  await fixture(async ({ engine, store, dir, draft }) => {
    projectDir = dir;
    const task = await store.readTask("TSK-0001");
    await store.writeTask({
      ...task.data,
      contract: {
        filesAllowed: ["src/main.ts"],
        expectedArtifacts: ["src/main.ts"],
        filesForbidden: [],
        verificationCommands: [passingVerificationCommand()],
      },
    }, task.body);
    await store.writeTask({
      ...task.data,
      id: "TSK-0002",
      title: "Second governed task",
      status: "ready",
      contract: {
        filesAllowed: ["src/board.ts"],
        expectedArtifacts: ["src/board.ts"],
        filesForbidden: [],
        verificationCommands: [passingVerificationCommand()],
      },
    }, task.body);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/board.ts"), "export const board = 0;\n");
    const plan = manifest();
    plan.taskIds.push("TSK-0002");
    plan.security.tasks.push({ taskId: "TSK-0002", readPaths: ["src/main.ts"], transformationIds: [] });
    await writeFile(draft, stringify(plan));
    const config = await store.readConfig();
    await store.writeConfig({ ...config, execution: { maxWorkers: 2 } });
    initGitRepo(dir);
    const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const result = await engine.execute("auto", { untilBlocked: true, jobs: 2 });
    assert.equal(result.status, "done");
    assert.deepEqual(result.tasks.map((item) => [item.taskId, item.status]), [["TSK-0001", "done"], ["TSK-0002", "done"]]);
    assert.equal(await readFile(join(dir, "src/main.ts"), "utf8"), "export const main = 1;\n");
    assert.equal(await readFile(join(dir, "src/board.ts"), "utf8"), "export const board = 1;\n");
    assert.deepEqual(applied.sort(), ["TSK-0001", "TSK-0002"]);

    const currentConfig = await store.readConfig();
    const modelDigest = stableHash({
      adapter: currentConfig.adapter ?? null,
      profiles: currentConfig.adapter.profiles ?? null,
      skillProfiles: currentConfig.adapter.skillProfiles ?? null,
    });
    const trace = await readGovernanceTrace(store, approved.approvalId, modelDigest);
    assert.equal(trace.status, "valid");
    const integrations = trace.frames.filter((frame) => frame.boundary === "begin" && frame.action === "integration-start");
    assert.equal(integrations.length, 2);
  }, {
    fakeBeforeParallelApply: async (taskId) => { applied.push(taskId); },
    fakeOnWait: async () => {
      arrivals += 1;
      if (arrivals === 2) {
        const roots = join(projectDir, ".legion-cli", "sandbox");
        for (const runId of await readdir(roots)) {
          const root = join(roots, runId);
          const prompt = await readFile(join(root, ".legion-cli", "cache", "runs", runId, "prompt.md"), "utf8");
          const file = prompt.includes("Task: TSK-0002") ? "board.ts" : "main.ts";
          await mkdir(join(root, "src"), { recursive: true });
          await writeFile(join(root, "src", file), `export const ${file === "main.ts" ? "main" : "board"} = 1;\n`);
        }
        releasePopulation();
      } else {
        await bothArrived;
      }
    },
  });
});
test("an adopted parallel batch after a failed task is not an implicit integration retry and leaves no run markers", async () => {
  await fixture(async ({ engine, store, dir, draft }) => {
    const task = await store.readTask("TSK-0001");
    await store.writeTask({
      ...task.data,
      contract: {
        filesAllowed: ["src/main.ts"],
        expectedArtifacts: ["src/main.ts"],
        filesForbidden: [],
        verificationCommands: [failingVerificationCommand()],
      },
    }, task.body);
    await store.writeTask({
      ...task.data,
      id: "TSK-0002",
      title: "Second governed task",
      status: "ready",
      contract: {
        filesAllowed: ["src/board.ts"],
        expectedArtifacts: ["src/board.ts"],
        filesForbidden: [],
        verificationCommands: [passingVerificationCommand()],
      },
    }, task.body);
    await writeFile(join(dir, "src/board.ts"), "export const board = 0;\n");
    const plan = manifest();
    plan.taskIds.push("TSK-0002");
    plan.security.tasks.push({ taskId: "TSK-0002", readPaths: ["src/main.ts"], transformationIds: [] });
    await writeFile(draft, stringify(plan));
    initGitRepo(dir);
    const approved = await engine.approvePlan({ id: "operator" }, {
      assuranceManifestPath: draft,
      verificationCommands: [passingVerificationCommand()],
    });
    const first = await engine.executeWorkflow({ jobs: 2, untilBlocked: true });
    assert.equal(first.status, "blocked");
    assert.deepEqual((await engine.listSliceTasks()).map((item) => [item.id, item.status]), [["TSK-0001", "blocked"], ["TSK-0002", "done"]]);

    await engine.unblockTask("TSK-0001");
    const second = await engine.executeWorkflow({ jobs: 2, untilBlocked: true });
    assert.equal(second.status, "blocked");
    assert.match(second.blocker, /^verification command failed/);

    const config = await store.readConfig();
    const modelDigest = stableHash({
      adapter: config.adapter ?? null,
      profiles: config.adapter.profiles ?? null,
      skillProfiles: config.adapter.skillProfiles ?? null,
    });
    const trace = await readGovernanceTrace(store, approved.approvalId, modelDigest);
    assert.equal(trace.status, "valid");
    const retried = trace.frames.filter((frame) => frame.boundary === "begin" && frame.action === "integration-start");
    assert.ok(retried.length >= 1);
    assert.ok(retried.every((frame) => frame.before.integration !== "failed"), "a task failure is not a failed integration");
    await engine.unblockTask("TSK-0001");
    assert.equal((await engine.listSliceTasks()).find((item) => item.id === "TSK-0001").status, "ready");
  });
});
test("a dead claim holder's reused PID projects as dead, so the takeover is not a duplicate claim", async () => {
  const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  try {
    await fixture(async ({ engine, store, draft }) => {
      const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
      // A killed workflow's claim whose PID now belongs to an unrelated, later-started process.
      await store.writeYaml(".legion-cli/workflow/run-claim.yaml", {
        schemaVersion: "legion-cli-workflow-claim/v1",
        token: randomUUID(),
        pid: foreign.pid,
        processStartedAt: 1,
        claimedAt: "2026-01-01T00:00:00.000Z",
      });
      await engine.executeWorkflow();
      const config = await store.readConfig();
      const modelDigest = stableHash({
        adapter: config.adapter ?? null,
        profiles: config.adapter.profiles ?? null,
        skillProfiles: config.adapter.skillProfiles ?? null,
      });
      const trace = await readGovernanceTrace(store, approved.approvalId, modelDigest);
      assert.equal(trace.status, "valid");
      const takeover = trace.frames.find((frame) => frame.boundary === "begin" && frame.action === "claim-acquire");
      assert.equal(takeover.before.claim.liveness, "dead");
    });
  } finally {
    foreign.kill();
  }
});
test("adopted workflow review, execution, acceptance, and confirmed ship are projected and traced", async () => {
  await fixture(async ({ engine, store, dir, draft }) => {
    const task = await store.readTask("TSK-0001");
    await store.writeTask({
      ...task.data,
      contract: {
        ...task.data.contract,
        verificationCommands: [passingVerificationCommand()],
      },
    }, task.body);
    initGitRepo(dir);
    await store.writeConfig({
      ...(await store.readConfig()),
      workflow: {
        ...((await store.readConfig()).workflow ?? {}),
        verificationCommands: [passingVerificationCommand()],
      },
    });
    const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const executed = await engine.executeWorkflow();
    assert.equal(executed.status, "blocked");
    assert.match(executed.blocker, /acceptance evidence pending/);
    await engine.recordAcceptance([{ id: "AC-01", status: "passed" }], { id: "owner" });
    let preview;
    const receipt = await engine.ship({
      confirm: async (value) => {
        preview = value;
        return true;
      },
    });
    assert.equal(receipt.phase, "shipped");
    assert.ok(preview);
    assert.ok(preview.staged.length > 0);

    const finalConfig = await store.readConfig();
    const modelDigest = stableHash({
      adapter: finalConfig.adapter ?? null,
      profiles: finalConfig.adapter.profiles ?? null,
      skillProfiles: finalConfig.adapter.skillProfiles ?? null,
    });
    const trace = await readGovernanceTrace(store, approved.approvalId, modelDigest);
    assert.equal(trace.status, "valid");
    const begins = trace.frames.filter((frame) => frame.boundary === "begin");
    for (const action of ["claim-acquire", "claim-release", "task-start", "integration-start", "integration-complete", "review-start", "review-complete", "task-verify", "task-complete", "acceptance-record", "ship-prepare", "ship-confirm"]) {
      assert.ok(begins.some((frame) => frame.action === action), `missing ${action} boundary`);
    }
    assert.ok(trace.frames.some((frame) =>
      frame.after?.tasks.some((item) => item.id === "TSK-0001" && item.status === "in_progress" && item.owner !== null &&
        ["running", "unavailable"].includes(item.checks)),
    ));
    const claimed = trace.frames.find((frame) => frame.boundary === "end" && frame.action === "claim-acquire");
    assert.ok(claimed.after.claim.owner);
    assert.equal(claimed.after.claim.liveness, "live");
    const reviewed = trace.frames.find((frame) => frame.boundary === "end" && frame.action === "review-complete");
    assert.equal(reviewed.after.review, "passed");
    assert.deepEqual(reviewed.after.components, []);
    const acceptanceFrame = trace.frames.find((frame) => frame.boundary === "end" && frame.action === "acceptance-record");
    assert.deepEqual(acceptanceFrame.after.acceptance, [{ id: "AC-01", status: "passed", freshness: "current" }]);
    const prepare = trace.frames.find((frame) => frame.boundary === "end" && frame.action === "ship-prepare");
    assert.equal(prepare.after.ship.confirmed, false);
    assert.equal(prepare.after.ship.status, "prepared");
    assert.ok(prepare.after.ship.confirmationId);
    assert.ok(prepare.after.ship.previewFingerprint);
    const completion = trace.frames.find((frame) => frame.boundary === "end" && frame.action === "ship-confirm");
    assert.equal(completion.after.ship.confirmed, true);
    assert.equal(completion.after.ship.status, "complete");
  }, {
    fakeArtifacts: [
      { path: "src/main.ts", content: "export const value = 2;\n" },
      { path: ".legion-cli/cache/runs/<id>/review.md", content: "# Review\n\nVerdict: PASS\n" },
    ],
  });
});
test("failed task execution is recorded by a successful task-block mutation", async () => {
  await fixture(async ({ engine, store, dir, draft }) => {
    const task = await store.readTask("TSK-0001");
    await store.writeTask({
      ...task.data,
      contract: {
        ...task.data.contract,
        verificationCommands: [failingVerificationCommand()],
      },
    }, task.body);
    initGitRepo(dir);
    const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const result = await engine.execute("TSK-0001");
    assert.equal(result.status, "blocked");
    assert.equal((await store.readTask("TSK-0001")).data.status, "blocked");
    const config = await store.readConfig();
    const modelDigest = stableHash({
      adapter: config.adapter ?? null,
      profiles: config.adapter.profiles ?? null,
      skillProfiles: config.adapter.skillProfiles ?? null,
    });
    const trace = await readGovernanceTrace(store, approved.approvalId, modelDigest);
    const failed = trace.frames.find((frame) => frame.boundary === "end" && frame.action === "task-block");
    assert.equal(failed.outcome, "success");
    assert.equal(failed.after.tasks.find((entry) => entry.id === "TSK-0001").status, "blocked");
  });
});

test("open adopted governance head blocks further writes without changing task history", async () => {
  await fixture(async ({ engine, store, draft }) => {
    const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const taskBefore = await store.readTask("TSK-0001");
    const endFrame = join(store.projectRoot, governanceTraceDirectory(approved.approvalId), "1.json");
    await rm(endFrame);
    await assert.rejects(() => engine.amendTask(taskBefore.data.id, taskBefore.data.contract), /invalid, incomplete/);
    const taskAfter = await store.readTask("TSK-0001");
    assert.equal(taskAfter.body, taskBefore.body);
    assert.equal(taskAfter.data.status, taskBefore.data.status);
    assert.equal(await store.pathExists(endFrame), false);
  });
});

test("interrupted governance boundary blocks writes until a fresh approval epoch", async () => {
  await fixture(async ({ engine, store, draft }) => {
    const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const config = await store.readConfig();
    const modelDigest = stableHash({
      adapter: config.adapter ?? null,
      profiles: config.adapter.profiles ?? null,
      skillProfiles: config.adapter.skillProfiles ?? null,
    });
    const prior = await readGovernanceTrace(store, approved.approvalId, modelDigest);
    await store.withLock(() => appendGovernanceBegin(store, {
      approvalId: approved.approvalId,
      modelDigest,
      correlationId: randomUUID(),
      action: "task-start",
      before: prior.frames.at(-1).after,
      recordedAt: new Date().toISOString(),
    }, {
      assertLockOwned: () => {
        if (!store.holdsLock()) throw new Error("Store lock is not held");
      },
    }));
    assert.equal((await readGovernanceTrace(store, approved.approvalId, modelDigest)).status, "incomplete");
    const task = await store.readTask("TSK-0001");
    await assert.rejects(() => engine.amendTask(task.data.id, task.data.contract));
    const nextApproval = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    assert.notEqual(nextApproval.approvalId, approved.approvalId);
    assert.equal((await readGovernanceTrace(store, approved.approvalId, modelDigest)).status, "incomplete");
    assert.equal((await readGovernanceTrace(store, nextApproval.approvalId, modelDigest)).status, "valid");
  });
});

test("refused adopted precondition is recorded without poisoning the epoch", async () => {
  await fixture(async ({ engine, store, draft }) => {
    // Normalize the seeded contract first so a later identical amend keeps the approval current.
    const seeded = await store.readTask("TSK-0001");
    await engine.amendTask(seeded.data.id, seeded.data.contract);
    const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const task = await store.readTask("TSK-0001");
    await assert.rejects(
      () => engine.amendTask(task.data.id, { ...task.data.contract, verificationCommands: [] }),
      /amend requires verificationCommands/,
    );
    const config = await store.readConfig();
    const modelDigest = stableHash({
      adapter: config.adapter ?? null,
      profiles: config.adapter.profiles ?? null,
      skillProfiles: config.adapter.skillProfiles ?? null,
    });
    const trace = await readGovernanceTrace(store, approved.approvalId, modelDigest);
    assert.equal(trace.status, "valid");
    const refused = trace.frames.at(-1);
    assert.deepEqual([refused.boundary, refused.action, refused.outcome], ["end", "amend-inputs", "refused"]);
    assert.deepEqual(refused.after, refused.before);
    await engine.amendTask(task.data.id, task.data.contract);
    const amended = await readGovernanceTrace(store, approved.approvalId, modelDigest);
    assert.equal(amended.status, "valid");
    assert.deepEqual(amended.frames.slice(-2).map(({ boundary, action, outcome }) => [boundary, action, outcome]), [
      ["begin", "amend-inputs", "pending"], ["end", "amend-inputs", "success"],
    ]);
    await assert.rejects(() => engine.ship({ confirm: async () => true }), (error) => {
      assert.doesNotMatch(error.message, /failed operation/);
      assert.match(error.message, /focused ship requires completed execution/);
      return true;
    });
    assert.equal((await engine.inspectGovernance()).current.status, "valid");
  });
});

test("interrupted reapproval epoch refuses writers until a fresh approval opens the next epoch", async () => {
  await fixture(async ({ engine, store, draft }) => {
    const seeded = await store.readTask("TSK-0001");
    await engine.amendTask(seeded.data.id, seeded.data.contract);
    const first = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const sidecarPath = join(store.projectRoot, ASSURANCE_APPROVAL_PATH);
    const firstSidecar = await readFile(sidecarPath);
    const second = await engine.approvePlan();
    const config = await store.readConfig();
    const modelDigest = stableHash({
      adapter: config.adapter ?? null,
      profiles: config.adapter.profiles ?? null,
      skillProfiles: config.adapter.skillProfiles ?? null,
    });
    const firstTrace = await readGovernanceTrace(store, first.approvalId, modelDigest);
    const secondTrace = await readGovernanceTrace(store, second.approvalId, modelDigest);
    assert.equal(firstTrace.status, "valid");
    assert.equal(secondTrace.status, "valid");

    // Journal restore after an interrupted reapproval: the new sidecar is gone and the old bytes are back.
    await rm(sidecarPath);
    await writeFile(sidecarPath, firstSidecar);
    const task = await store.readTask("TSK-0001");
    await assert.rejects(
      () => engine.amendTask(task.data.id, task.data.contract),
      { message: new RegExp(`^governance epoch ${second.approvalId} was interrupted; review and approve the current plan$`) },
    );
    assert.deepEqual((await store.readTask("TSK-0001")).data, task.data);
    const interrupted = await engine.inspectGovernance();
    assert.deepEqual(interrupted.current, { approvalId: first.approvalId, adopted: true, status: "interrupted-epoch" });

    const third = await engine.approvePlan();
    assert.notEqual(third.approvalId, first.approvalId);
    assert.notEqual(third.approvalId, second.approvalId);
    await engine.amendTask(task.data.id, task.data.contract);
    const anchor = await readGovernanceEpochs(store);
    assert.deepEqual(anchor.epochs.map(({ sequence, approvalId, adopted }) => [sequence, approvalId, adopted]), [
      [0, first.approvalId, true], [1, second.approvalId, true], [2, third.approvalId, true],
    ]);
    assert.deepEqual(await readGovernanceTrace(store, first.approvalId, modelDigest), firstTrace);
    assert.deepEqual(await readGovernanceTrace(store, second.approvalId, modelDigest), secondTrace);
    const thirdTrace = await readGovernanceTrace(store, third.approvalId, modelDigest);
    assert.equal(thirdTrace.status, "valid");
    assert.deepEqual(thirdTrace.frames.map(({ boundary, action }) => [boundary, action]), [
      ["begin", "approval-adopt"], ["end", "approval-adopt"], ["begin", "amend-inputs"], ["end", "amend-inputs"],
    ]);
    const inspection = await engine.inspectGovernance();
    assert.deepEqual(inspection.current, { approvalId: third.approvalId, adopted: true, status: "valid" });
    assert.deepEqual(inspection.epochs.map(({ approvalId, status }) => [approvalId, status]), [
      [first.approvalId, "valid"], [second.approvalId, "valid"], [third.approvalId, "valid"],
    ]);
  });
});

test("tampered adopted governance frame blocks mutation without rewriting history", async () => {
  await fixture(async ({ engine, store, draft }) => {
    const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const task = await store.readTask("TSK-0001");
    await engine.amendTask(task.data.id, task.data.contract);
    const framePath = join(store.projectRoot, governanceTraceDirectory(approved.approvalId), "0.json");
    const original = await readFile(framePath, "utf8");
    const tampered = JSON.parse(original);
    tampered.action = "task-start";
    await writeFile(framePath, `${JSON.stringify(tampered)}\n`);
    const tamperedBytes = await readFile(framePath, "utf8");
    await assert.rejects(() => engine.amendTask(task.data.id, task.data.contract));
    assert.equal(await readFile(framePath, "utf8"), tamperedBytes);
  });
});

