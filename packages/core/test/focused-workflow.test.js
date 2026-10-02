import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PlanApprovalReceiptSchema,
  SpecApprovalReceiptSchema,
  WorkflowEvidenceReceiptSchema,
} from "@9thlevelsoftware/legion-cli-schema";
import { LegionEngine, LegionRefuseError } from "../dist/index.js";
import { prepareDiscovery, recordDiscoverySelection } from "../dist/discovery.js";
import {
  WORKFLOW_APPROVAL_PATH,
  WORKFLOW_EVIDENCE_PATH,
  WORKFLOW_REVIEW_RECEIPT_PATH,
  WORKFLOW_SPEC_APPROVAL_PATH,
  acquireWorkflowClaim,
  releaseWorkflowClaim,
  workflowFingerprint,
} from "../dist/workflow.js";
import {
  initProject,
  makeQaScore,
  makeSpec,
  makeTask,
  passingVerificationCommand,
  patchState,
  quoteArg,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  writeQaFile,
  writeSpec,
  writeTask,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
const explicitPassReview = {
  path: ".legion-cli/qa/review.md",
  content: "# Independent review\n\nVerdict: PASS\n",
};

async function initFocused(engine, opts = {}) {
  await initProject(engine, { workflowProfile: "focused", ...opts });
}

async function writePlan(dir, body = "# Approved implementation plan\n\nImplement the active slice.\n") {
  await writeFile(join(dir, ".legion-cli", "plans", "spec-checkin.md"), body, "utf8");
}

async function seedFocusedPlan(store, dir, opts = {}) {
  const seeded = await seedPlanReady(store, {
    phase: opts.phase ?? "plan_ready",
    task: {
      status: opts.taskStatus ?? "ready",
      contract: {
        filesAllowed: ["src/main.ts"],
        expectedArtifacts: ["src/main.ts"],
        verificationCommands: [passingVerificationCommand()],
        ...(opts.contract ?? {}),
      },
      ...(opts.task ?? {}),
    },
    extraTasks: opts.extraTasks,
    spec: opts.spec,
    lastReview: opts.lastReview,
    lastQaId: opts.lastQaId,
  });
  await writePlan(dir, opts.planBody);
  return seeded;
}

async function readWorkflowYaml(store, path, schema) {
  return store.readYaml(path, schema);
}

test("focused low-level execute and ship both require the approved workflow", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initFocused(engine);
      await seedFocusedPlan(store, dir);

      await assert.rejects(
        () => engine.execute("auto"),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /plan approval is required before execute/);
          assert.match(err.nextHint, /plan approve/);
          return true;
        },
      );
      await assert.rejects(
        () => engine.ship(),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /focused ship requires completed execution/);
          assert.match(err.nextHint, /execute/);
          return true;
        },
      );
      assert.equal((await store.readTask("TSK-0001")).data.status, "ready");
      assert.equal((await engine.getState()).phase, "plan_ready");
    }, { skillsDir });
  });
});

test("spec approval atomically binds the frozen spec and approval message", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initFocused(engine);
      const draft = makeSpec({ status: "draft" });
      await writeSpec(store, draft, "# Office check-in\n\nDraft contract.\n");
      const project = await store.readProject();
      await store.writeProject({ ...project.data, activeSpecId: draft.id }, project.body);
      await patchState(store, { phase: "spec_draft", activeSpecId: draft.id });
      assert.equal((await engine.prepareSpecChallenge(draft.id)).status, "complete");

      await engine.approveSpec(draft.id, { id: "product-owner" }, { message: "Approved for implementation." });
      const frozen = await store.readSpec(draft.id);
      const receipt = await readWorkflowYaml(store, WORKFLOW_SPEC_APPROVAL_PATH, SpecApprovalReceiptSchema);
      assert.equal(frozen.data.status, "frozen");
      assert.match(frozen.body, /## Approval note\n\nApproved for implementation\./);
      assert.equal(receipt.specId, draft.id);
      assert.equal(receipt.approvedBy, "product-owner");
      assert.equal(receipt.approvedAt, frozen.data.frozenAt);
      assert.equal(receipt.specFingerprint, workflowFingerprint({ data: frozen.data, body: frozen.body }));
      assert.equal((await engine.getState()).phase, "spec_frozen");

      await writeTask(store, makeTask());
      await patchState(store, { phase: "plan_ready", lastReadiness: "PASS" });
      await writePlan(dir);
      await engine.approvePlan({ id: "product-owner" });
      await store.writeSpec(frozen.data, `${frozen.body}\nChanged after approval.\n`);
      assert.equal((await engine.getWorkflowStatus()).planApproval, "stale");
      await assert.rejects(() => engine.approvePlan({ id: "product-owner" }), /frozen spec changed after approval/);
    }, {
      skillsDir,
      fakeArtifacts: [{
        path: ".legion-cli/cache/runs/<id>/analysis.json",
        content: '{"schemaVersion":"legion-cli-spec-challenge-analysis/v1","concerns":[]}\n',
      }],
    });
  });
});

test("contract and planned-check changes create explicit reapproval epochs", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initFocused(engine);
    const { task } = await seedFocusedPlan(store, dir, { phase: "executing", taskStatus: "done" });
    const retainedCheck = passingVerificationCommand();
    const first = await engine.approvePlan({ id: "owner" }, { verificationCommands: [retainedCheck] });
    assert.equal((await engine.getWorkflowStatus()).planApproval, "valid");

    await writeTask(store, {
      ...task,
      status: "done",
      contract: { ...task.contract, maxFilesTouched: task.contract.maxFilesTouched + 1 },
    });
    assert.equal((await engine.getWorkflowStatus()).planApproval, "stale");
    await assert.rejects(() => engine.execute("auto"), /plan approval is stale/);

    const second = await engine.approvePlan({ id: "owner" });
    assert.notEqual(second.approvalId, first.approvalId);
    assert.notEqual(second.taskFingerprint, first.taskFingerprint);
    assert.deepEqual(second.verificationCommands, [retainedCheck]);
    const newCheck = `${quoteArg(process.execPath)} -e process.exitCode=0`;
    const third = await engine.approvePlan({ id: "owner" }, { verificationCommands: [newCheck] });
    assert.notEqual(third.approvalId, second.approvalId);
    assert.deepEqual(third.verificationCommands, [retainedCheck, newCheck]);
    assert.equal((await engine.getWorkflowStatus()).planApproval, "valid");
  });
});

test("focused approval is project-neutral and adds no implicit QA command", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initFocused(engine);
    await seedFocusedPlan(store, dir, { phase: "executing", taskStatus: "done" });
    const approval = await engine.approvePlan({ id: "owner" });
    const config = await store.readConfig();
    const persisted = await readWorkflowYaml(store, WORKFLOW_APPROVAL_PATH, PlanApprovalReceiptSchema);

    assert.deepEqual(approval.verificationCommands, []);
    assert.equal(persisted.approvalId, approval.approvalId);
    assert.deepEqual(config.workflow, { profile: "focused", verificationCommands: [] });
    assert.equal(config.qa.mode, "full", "legacy QA configuration is not promoted into focused checks");
    assert.equal(approval.verificationCommands.some((command) => /pnpm|playwright|qa/i.test(command)), false);
  });
});

test("failed legacy plan approval does not persist focused adoption", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, {
      phase: "plan_ready",
      task: {
        status: "ready",
        contract: {
          filesAllowed: ["src/main.ts"],
          expectedArtifacts: ["src/main.ts"],
          verificationCommands: [passingVerificationCommand()],
        },
      },
    });
    assert.equal((await store.readConfig()).workflow, undefined);

    await assert.rejects(() => engine.approvePlan({ id: "owner" }), /requires a non-empty .*plans\/spec-checkin\.md/);
    assert.equal((await store.readConfig()).workflow, undefined);
    assert.equal(await store.pathExists(WORKFLOW_APPROVAL_PATH), false);
  });
});

test("a legacy ready_to_ship project can adopt the focused workflow and finish", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      const legacyQa = makeQaScore({ id: "qa-legacy" });
      await writeQaFile(store, legacyQa);
      await seedFocusedPlan(store, dir, {
        phase: "ready_to_ship",
        taskStatus: "done",
        lastReview: "PASS",
        lastQaId: legacyQa.id,
      });
      assert.equal((await store.readConfig()).workflow, undefined);

      const check = passingVerificationCommand();
      const approval = await engine.approvePlan({ id: "owner" }, { verificationCommands: [check] });
      assert.equal((await store.readConfig()).workflow.profile, "focused");
      assert.equal((await engine.getWorkflowStatus()).planApproval, "valid");

      const executed = await engine.executeWorkflow();
      assert.equal(executed.status, "blocked");
      assert.match(executed.blocker, /acceptance evidence pending: AC-01/);
      const evidence = await readWorkflowYaml(store, WORKFLOW_EVIDENCE_PATH, WorkflowEvidenceReceiptSchema);
      assert.equal(evidence.status, "complete");
      assert.equal(evidence.approvalId, approval.approvalId);
      assert.deepEqual(evidence.integration.map((entry) => entry.ok), [true]);
      assert.equal(evidence.review.verdict, "PASS");

      await engine.recordAcceptance([{ id: "AC-01", status: "passed" }], { id: "product-owner" });
      assert.equal((await engine.getWorkflowStatus()).stage, "ship");
      const shipped = await engine.ship({ actor: "product-owner" });
      assert.equal(shipped.phase, "shipped");
    }, { skillsDir, fakeArtifacts: [explicitPassReview] });
  });
});

test("planned checks, fresh review, manual acceptance, and human ship form one evidence chain", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initFocused(engine);
      await seedFocusedPlan(store, dir, { phase: "executing", taskStatus: "done" });
      const check = passingVerificationCommand();
      const approval = await engine.approvePlan({ id: "owner" }, { verificationCommands: [check] });

      const executed = await engine.executeWorkflow();
      assert.equal(executed.status, "blocked", "manual acceptance remains pending after automated evidence completes");
      assert.match(executed.blocker, /acceptance evidence pending: AC-01/);
      const evidence = await readWorkflowYaml(store, WORKFLOW_EVIDENCE_PATH, WorkflowEvidenceReceiptSchema);
      assert.equal(evidence.status, "complete");
      assert.equal(evidence.approvalId, approval.approvalId);
      assert.deepEqual(evidence.integration.map(({ command, ok }) => ({ command, ok })), [{ command: check, ok: true }]);
      assert.equal(evidence.review.verdict, "PASS");
      assert.equal(evidence.review.evidencePath, WORKFLOW_REVIEW_RECEIPT_PATH);
      assert.match(await readFile(join(dir, WORKFLOW_REVIEW_RECEIPT_PATH), "utf8"), /Verdict: PASS/);
      await assert.rejects(() => engine.ship(), /acceptance evidence pending/);

      const acceptance = await engine.recordAcceptance([{ id: "AC-01", status: "passed" }], { id: "product-owner" });
      assert.equal(acceptance.approvalId, approval.approvalId);
      assert.equal((await engine.getWorkflowStatus()).stage, "ship");
      const shipped = await engine.ship({ actor: "product-owner" });
      assert.equal(shipped.phase, "shipped");
      assert.equal((await engine.getState()).phase, "shipped");
    }, { skillsDir, fakeArtifacts: [explicitPassReview] });
  });
});

test("--step persists progress and a later engine resumes at verification and review", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initFocused(engine);
      await seedFocusedPlan(store, dir);
      await engine.approvePlan({ id: "owner" });

      const stepped = await engine.executeWorkflow({ step: true });
      assert.equal(stepped.status, "step_complete");
      assert.deepEqual(stepped.completedTaskIds, ["TSK-0001"]);
      assert.equal((await engine.getWorkflowStatus()).execution, "running");

      const resumed = new LegionEngine(dir, undefined, { skillsDir, fakeArtifacts: [explicitPassReview] });
      const completed = await resumed.executeWorkflow();
      assert.equal(completed.status, "blocked");
      assert.match(completed.blocker, /acceptance evidence pending/);
      const evidence = await readWorkflowYaml(store, WORKFLOW_EVIDENCE_PATH, WorkflowEvidenceReceiptSchema);
      assert.equal(evidence.status, "complete");
      assert.deepEqual(evidence.completedTaskIds, ["TSK-0001"]);
      assert.equal(evidence.review.verdict, "PASS");
    }, { skillsDir });
  });
});

test("failed planned checks stay blocked until retry and retry reruns only the failed command", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initFocused(engine);
      await seedFocusedPlan(store, dir, { phase: "executing", taskStatus: "done" });
      const passCount = ".legion-cli/cache/focused-pass-count";
      const failCount = ".legion-cli/cache/focused-fail-count";
      const retryMarker = ".legion-cli/cache/focused-retry-ok";
      const passScript = `require('node:fs').appendFileSync('${passCount}','x'),process.exit(0)`;
      const failScript = `require('node:fs').appendFileSync('${failCount}','x'),process.exit(require('node:fs').existsSync('${retryMarker}')?0:1)`;
      const pass = `${quoteArg(process.execPath)} -e ${JSON.stringify(passScript)}`;
      const failThenPass = `${quoteArg(process.execPath)} -e ${JSON.stringify(failScript)}`;
      await engine.approvePlan({ id: "owner" }, { verificationCommands: [pass, failThenPass] });

      const first = await engine.executeWorkflow();
      assert.equal(first.status, "blocked");
      assert.match(first.blocker, /verification command failed/);
      assert.equal(await readFile(join(dir, passCount), "utf8"), "x");
      assert.equal(await readFile(join(dir, failCount), "utf8"), "x");

      const unchanged = await engine.executeWorkflow();
      assert.equal(unchanged.status, "blocked");
      assert.equal(await readFile(join(dir, passCount), "utf8"), "x");
      assert.equal(await readFile(join(dir, failCount), "utf8"), "x");
      const blockedStatus = await engine.getWorkflowStatus();
      assert.equal(blockedStatus.execution, "blocked");
      assert.equal(blockedStatus.blocker, unchanged.blocker);
      assert.equal(blockedStatus.next, "legion-cli execute --retry");

      await writeFile(join(dir, retryMarker), "retry\n", "utf8");
      const retried = await engine.executeWorkflow({ retry: true });
      assert.equal(retried.status, "blocked");
      assert.match(retried.blocker, /acceptance evidence pending/);
      assert.equal(await readFile(join(dir, passCount), "utf8"), "x", "the prior passing command is reused");
      assert.equal(await readFile(join(dir, failCount), "utf8"), "xx", "only the failed command is rerun");
      const evidence = await readWorkflowYaml(store, WORKFLOW_EVIDENCE_PATH, WorkflowEvidenceReceiptSchema);
      assert.equal(evidence.status, "complete");
      assert.deepEqual(evidence.integration.map((entry) => entry.ok), [true, true]);
    }, { skillsDir, fakeArtifacts: [explicitPassReview] });
  });
});

for (const [label, fakeArtifacts] of [
  ["missing", []],
  ["ambiguous", [{ path: ".legion-cli/qa/review.md", content: "Verdict: PASS\nVerdict: FAIL\n" }]],
]) {
  test(`${label} explicit reviewer evidence blocks focused completion`, async () => {
    await withFakeAdapter(async () => {
      await withEngine(async ({ engine, store, dir }) => {
        await initFocused(engine);
        await seedFocusedPlan(store, dir, { phase: "executing", taskStatus: "done" });
        await engine.approvePlan({ id: "owner" });

        const result = await engine.executeWorkflow();
        assert.equal(result.status, "blocked");
        assert.match(result.blocker, /fresh explicit Verdict: PASS/);
        assert.equal(result.next, "legion-cli review");
        const evidence = await readWorkflowYaml(store, WORKFLOW_EVIDENCE_PATH, WorkflowEvidenceReceiptSchema);
        assert.equal(evidence.status, "blocked");
        assert.equal(evidence.review, null);
      }, { skillsDir, fakeArtifacts });
    });
  });
}

test("focused status maps draft, frozen, planning, shipped, and abandoned to one next command", async () => {
  await withEngine(async ({ engine, store }) => {
    await initFocused(engine);
    const draft = makeSpec({ status: "draft" });
    await writeSpec(store, draft);
    const project = await store.readProject();
    await store.writeProject({ ...project.data, activeSpecId: draft.id }, project.body);

    await patchState(store, { phase: "spec_draft", activeSpecId: draft.id });
    assert.deepEqual(
      { stage: (await engine.getWorkflowStatus()).stage, next: (await engine.getWorkflowStatus()).next },
      { stage: "spec", next: "legion-cli spec" },
    );
    await writeSpec(store, makeSpec({ status: "frozen", frozenAt: "2026-10-02T12:00:00.000Z", frozenBy: "owner" }));
    await patchState(store, { phase: "spec_frozen" });
    assert.deepEqual(
      { stage: (await engine.getWorkflowStatus()).stage, next: (await engine.getWorkflowStatus()).next },
      { stage: "plan", next: "legion-cli plan" },
    );
    await patchState(store, { phase: "planning" });
    assert.deepEqual(
      { stage: (await engine.getWorkflowStatus()).stage, next: (await engine.getWorkflowStatus()).next },
      { stage: "plan", next: "legion-cli plan" },
    );
    await patchState(store, { phase: "shipped" });
    assert.deepEqual(
      { stage: (await engine.getWorkflowStatus()).stage, next: (await engine.getWorkflowStatus()).next },
      { stage: "spec", next: "legion-cli spec new" },
    );
    await patchState(store, { phase: "abandoned" });
    assert.deepEqual(
      { stage: (await engine.getWorkflowStatus()).stage, next: (await engine.getWorkflowStatus()).next },
      { stage: "spec", next: "legion-cli spec new" },
    );
  });
});

test("audit plans require a bounded discovery selection", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initFocused(engine, { mode: "brownfield", brownfieldGoal: "audit" });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "service.ts"), "export const answer = 42;\n", "utf8");
    await prepareDiscovery(engine);
    await seedFocusedPlan(store, dir);

    await assert.rejects(() => engine.approvePlan({ id: "owner" }), /select a bounded audit remediation increment/);
    await recordDiscoverySelection(engine, { goal: "Verify the answer service", affectedArea: "src/service.ts" });
    const approval = await engine.approvePlan({ id: "owner" });
    assert.equal(approval.specId, "spec-checkin");
    assert.equal((await engine.getWorkflowStatus()).planApproval, "valid");
  });
});

test("a live workflow claim excludes a second pipeline", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initFocused(engine);
    await seedFocusedPlan(store, dir, { phase: "executing", taskStatus: "done" });
    await engine.approvePlan({ id: "owner" });
    const claim = await acquireWorkflowClaim(store);
    try {
      await assert.rejects(
        () => engine.executeWorkflow(),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /another focused workflow is running/);
          assert.match(err.nextHint, /status/);
          return true;
        },
      );
    } finally {
      await releaseWorkflowClaim(store, claim.token);
    }
    assert.equal(await store.pathExists(".legion-cli/workflow/run-claim.yaml"), false);
  });
});

test("a planned check that mutates product inputs is blocked and cannot certify the new state", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initFocused(engine);
    await seedFocusedPlan(store, dir, { phase: "executing", taskStatus: "done" });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const value = 1;\n", "utf8");
    const script = "require('node:fs').writeFileSync('src/main.ts','export const value = 2;'+String.fromCharCode(10))";
    const mutatingCheck = `${quoteArg(process.execPath)} -e ${JSON.stringify(script)}`;
    await engine.approvePlan({ id: "owner" }, { verificationCommands: [mutatingCheck] });

    const result = await engine.executeWorkflow();
    assert.equal(result.status, "blocked");
    assert.match(result.blocker, /verification changed product inputs while running/);
    assert.equal(await readFile(join(dir, "src", "main.ts"), "utf8"), "export const value = 2;\n");
    assert.equal((await engine.getWorkflowStatus()).execution, "stale");
  });
});
