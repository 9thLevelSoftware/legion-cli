import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { findSkillsDir, LegionEngine, LegionRefuseError, specChallengeReceiptPath } from "../dist/index.js";
import { finishStartedSpawn, startSkillSpawn, waitStartedSpawn } from "../dist/spawn.js";
import { workflowFingerprint } from "../dist/workflow.js";
import { SpecChallengeReceiptSchema } from "@9thlevelsoftware/legion-cli-schema";
import {
  initProject,
  makeSpec,
  patchState,
  withEngine,
  withFakeAdapter,
  writeSpec,
} from "./helpers.js";

const skillsDir = findSkillsDir();

const analysis = (concerns) => ({
  path: ".legion-cli/cache/runs/<id>/analysis.json",
  content: `${JSON.stringify({ schemaVersion: "legion-cli-spec-challenge-analysis/v1", concerns })}\n`,
});

const synthesis = (changes) => ({
  path: ".legion-cli/cache/runs/<id>/synthesis.json",
  content: `${JSON.stringify({ schemaVersion: "legion-cli-spec-challenge-synthesis/v1", changes })}\n`,
});

async function seedFocusedDraft(engine, store, dir) {
  await initProject(engine, { workflowProfile: "focused" });
  const spec = makeSpec();
  await writeSpec(store, spec, "# Office check-in\n\nDraft contract.\n");
  const project = await store.readProject();
  await store.writeProject({ ...project.data, activeSpecId: spec.id }, project.body);
  await patchState(store, { phase: "spec_draft", activeSpecId: spec.id });
  await writeFile(join(dir, "README.md"), "The check-in API returns unavailable when offline.\n", "utf8");
  return spec;
}

async function challengeRunNames(dir) {
  return (await readdir(join(dir, ".legion-cli", "cache", "runs")))
    .filter((name) => name.startsWith("spec-challenge-"))
    .sort();
}

async function waitForPath(path) {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > 10_000) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startHeldMapSpawn(dir, store) {
  const readyPath = join(dir, ".legion-cli", "cache", "fake-wait", `map-ready-${Date.now()}`);
  const releasePath = join(dir, ".legion-cli", "cache", "fake-wait", `map-release-${Date.now()}`);
  const started = await startSkillSpawn({
    projectRoot: dir,
    config: await store.readConfig(),
    skillId: "map",
    promptBody: "Hold an unrelated map operation for concurrency testing.",
    skillsDir,
    store,
    required: true,
    holdWait: { readyPath, releasePath, timeoutMs: 15_000 },
  });
  assert.equal(started.spawned, true);
  const waited = waitStartedSpawn(started);
  await waitForPath(readyPath);
  return {
    async finish() {
      await writeFile(releasePath, "go\n", "utf8");
      const result = await waited;
      assert.equal(result.error, undefined);
      await finishStartedSpawn(started);
    },
  };
}

test("zero-concern analysis completes once and permits focused approval", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      const spec = await seedFocusedDraft(engine, store, dir);
      const first = await engine.prepareSpecChallenge(spec.id);
      assert.equal(first.status, "complete");
      assert.deepEqual(first.pendingConcerns, []);
      const before = (await readdir(join(dir, ".legion-cli", "cache", "runs"))).filter((name) => name.startsWith("spec-challenge-"));
      const second = await engine.prepareSpecChallenge(spec.id);
      const after = (await readdir(join(dir, ".legion-cli", "cache", "runs"))).filter((name) => name.startsWith("spec-challenge-"));
      assert.equal(second.status, "complete");
      assert.deepEqual(after, before, "a completed unchanged analysis is not repeated");
      await engine.approveSpec(spec.id, { id: "owner" });
      assert.equal((await store.readSpec(spec.id)).data.status, "frozen");
    }, { skillsDir, fakeArtifacts: [analysis([])] });
  });
});

test("concerns require immediate human resolutions and synthesis applies only grounded additions", async () => {
  await withFakeAdapter(async () => {
    const concerns = [
      {
        question: "What happens when the check-in API is unavailable?",
        why: "Failure behavior is unspecified.",
        evidence: [{
          kind: "repository",
          path: "README.md",
          line: 1,
          quote: "a quote that is not on line one",
          claim: "The API already handles offline mode.",
        }],
      },
      {
        question: "Which compatibility constraint must remain?",
        why: "The boundary needs an explicit owner decision.",
        evidence: [{ kind: "assumption", claim: "Compatibility requirements may be incomplete." }],
      },
    ];
    const changes = [
      {
        section: "failureCases",
        statement: "Preserve the pending action and show a retry message.",
        rationale: "C-01 records preservation and retry behavior.",
        concernIds: ["C-01"],
      },
      {
        section: "mustNotChange",
        statement: "Keep the existing auth contract compatible.",
        rationale: "C-02 confirms auth compatibility.",
        concernIds: ["C-02"],
      },
    ];
    await withEngine(async ({ engine, store, dir }) => {
      const spec = await seedFocusedDraft(engine, store, dir);
      const prepared = await engine.prepareSpecChallenge(spec.id);
      assert.equal(prepared.status, "awaiting_resolutions");
      assert.equal(prepared.pendingConcerns.length, 2);
      assert.equal(prepared.receipt.concerns[0].evidence[0].kind, "assumption", "unsupported quotes are never trusted");
      await assert.rejects(() => engine.approveSpec(spec.id, { id: "owner" }), /challenge.*unresolved/i);

      const first = await engine.recordSpecChallengeResolution(
        spec.id,
        "C-01",
        { disposition: "answered", response: "Preserve the pending action and show a retry message." },
        { id: "owner" },
      );
      assert.deepEqual(first.pendingConcerns.map((item) => item.id), ["C-02"]);
      const second = await engine.recordSpecChallengeResolution(
        spec.id,
        "C-02",
        { disposition: "risk_accepted", response: "Keep the existing auth contract compatible." },
        { id: "owner" },
      );
      assert.equal(second.pendingConcerns.length, 0);

      const finalized = await engine.finalizeSpecChallenge(spec.id);
      assert.equal(finalized.status, "complete");
      assert.match(finalized.draftDiff, /failureCases/);
      assert.match(finalized.draftDiff, /mustNotChange/);
      const draft = await store.readSpec(spec.id);
      assert.ok(draft.data.failureCases.includes(changes[0].statement));
      assert.ok(draft.data.mustNotChange.includes(changes[1].statement));
      assert.match(await readFile(join(dir, finalized.receipt.thinkingPath), "utf8"), /risk_accepted/);
    }, { skillsDir, fakeArtifacts: [analysis(concerns), synthesis(changes)] });
  });
});

test("invalid analysis and failed synthesis require explicit substantive manual review", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      const spec = await seedFocusedDraft(engine, store, dir);
      const failed = await engine.prepareSpecChallenge(spec.id);
      assert.equal(failed.status, "manual_required");
      assert.match(failed.automationError, /three concerns|invalid/i);
      await assert.rejects(
        () => engine.finalizeSpecChallenge(spec.id, { manualReview: {
          measurableSuccess: "too short",
          failureHandling: "too short",
          compatibilityAndScope: "too short",
          acknowledgement: "yes",
        } }),
        /manual review/i,
      );
      const completed = await engine.finalizeSpecChallenge(spec.id, { actor: { id: "owner" }, manualReview: {
        measurableSuccess: "A phone check-in completes within five seconds.",
        failureHandling: "An unavailable service preserves input and shows a retry action.",
        compatibilityAndScope: "Keep authentication compatible and payroll remains outside scope.",
        acknowledgement: "I acknowledge",
      } });
      assert.equal(completed.status, "complete");
      assert.ok((await store.readSpec(spec.id)).data.failureCases.some((item) => /unavailable service/i.test(item)));
    }, {
      skillsDir,
      fakeArtifacts: [analysis([1, 2, 3, 4].map((i) => ({
        question: `Question ${i}?`,
        why: "It matters.",
        evidence: [{ kind: "assumption", claim: "Unknown." }],
      })))],
    });
  });
});

test("synthesis failure preserves a dismissed resolution and resumes partial manual answers", async () => {
  await withFakeAdapter(async () => {
    const concerns = [{
      question: "Should this concern change the draft?",
      why: "The user must decide whether it is relevant.",
      evidence: [{ kind: "assumption", claim: "Relevance is unknown." }],
    }];
    await withEngine(async ({ engine, store, dir }) => {
      const spec = await seedFocusedDraft(engine, store, dir);
      assert.equal((await engine.prepareSpecChallenge(spec.id)).status, "awaiting_resolutions");
      await engine.recordSpecChallengeResolution(
        spec.id,
        "C-01",
        { disposition: "dismissed", response: "This concern is outside the approved check-in scope." },
        { id: "owner" },
      );
      const failed = await engine.finalizeSpecChallenge(spec.id);
      assert.equal(failed.status, "manual_required");
      assert.equal(failed.receipt.concerns[0].resolution.disposition, "dismissed");

      const partial = await engine.recordSpecChallengeManualAnswer(
        spec.id,
        "measurableSuccess",
        "A phone check-in completes within five seconds.",
        { id: "owner" },
      );
      assert.equal(partial.status, "manual_required");
      assert.equal(partial.receipt.manualReview.measurableSuccess, "A phone check-in completes within five seconds.");
      assert.equal(partial.receipt.manualReview.failureHandling, undefined);
      await engine.recordSpecChallengeManualAnswer(
        spec.id,
        "failureHandling",
        "An unavailable service preserves input and shows a retry action.",
        { id: "owner" },
      );
      await engine.recordSpecChallengeManualAnswer(
        spec.id,
        "compatibilityAndScope",
        "Keep authentication compatible and payroll remains outside scope.",
        { id: "owner" },
      );
      await engine.recordSpecChallengeManualAnswer(
        spec.id,
        "acknowledgement",
        "I acknowledge",
        { id: "owner" },
      );
      const completed = await engine.finalizeSpecChallenge(spec.id, { actor: { id: "owner" } });
      assert.equal(completed.status, "complete");
      assert.equal(completed.receipt.concerns[0].resolution.disposition, "dismissed");
      assert.match(await readFile(join(dir, completed.receipt.thinkingPath), "utf8"), /I acknowledge/);
      assert.ok((await store.readSpec(spec.id)).body.includes("## Challenge clarifications"));
    }, { skillsDir, fakeArtifacts: [analysis(concerns)] });
  });
});

test("external draft edits stale completion and explicit prepare starts one new bounded round", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      const spec = await seedFocusedDraft(engine, store, dir);
      assert.equal((await engine.prepareSpecChallenge(spec.id)).status, "complete");
      const doc = await store.readSpec(spec.id);
      await store.writeSpec(doc.data, `${doc.body}\nExternal edit.\n`);
      assert.equal((await engine.readSpecChallenge(spec.id)).status, "stale");
      await assert.rejects(
        () => engine.approveSpec(spec.id, { id: "owner" }),
        (err) => err instanceof LegionRefuseError && /stale/.test(err.message),
      );
      const refreshed = await engine.prepareSpecChallenge(spec.id);
      assert.equal(refreshed.status, "complete");
      assert.equal(refreshed.receipt.round, 2);
      await writeFile(join(dir, "README.md"), "Repository context changed after review.\n", "utf8");
      assert.equal((await engine.readSpecChallenge(spec.id)).status, "stale");
      const sourceRefreshed = await engine.prepareSpecChallenge(spec.id);
      assert.equal(sourceRefreshed.receipt.round, 3);
      const discuss = await store.readDiscuss();
      await store.writeDiscuss(discuss.data, `${discuss.body}\nInterview decision context changed.\n`);
      assert.equal((await engine.readSpecChallenge(spec.id)).status, "stale");
    }, { skillsDir, fakeArtifacts: [analysis([])] });
  });
});

test("successful analysis and synthesis checkpoints recover without repeating adapter calls", async () => {
  await withFakeAdapter(async () => {
    const response = "Preserve the pending action and show a retry message.";
    const concerns = [{
      question: "What happens when the API is unavailable?",
      why: "Failure behavior is unspecified.",
      evidence: [{ kind: "assumption", claim: "No failure behavior is captured." }],
    }];
    const changes = [{
      section: "failureCases",
      statement: response,
      rationale: "Records the human response.",
      concernIds: ["C-01"],
    }];
    await withEngine(async ({ engine, store, dir }) => {
      const spec = await seedFocusedDraft(engine, store, dir);
      const original = await store.readSpec(spec.id);
      const analyzed = await engine.prepareSpecChallenge(spec.id);
      const analysisRunId = analyzed.receipt.generation.runId;
      const runCountAfterAnalysis = (await readdir(join(dir, ".legion-cli", "cache", "runs"))).length;
      await store.writeYaml(specChallengeReceiptPath(spec.id), {
        ...analyzed.receipt,
        status: "analysis_running",
        finalDraftFingerprint: null,
        generation: { ...analyzed.receipt.generation, status: "complete", runId: analysisRunId },
        synthesis: { status: "pending", runId: null },
      });
      const recoveredAnalysis = await engine.prepareSpecChallenge(spec.id);
      assert.equal(recoveredAnalysis.status, "awaiting_resolutions");
      assert.equal((await readdir(join(dir, ".legion-cli", "cache", "runs"))).length, runCountAfterAnalysis);

      await engine.recordSpecChallengeResolution(
        spec.id,
        "C-01",
        { disposition: "answered", response },
        { id: "owner" },
      );
      const synthesized = await engine.finalizeSpecChallenge(spec.id);
      const synthesisRunId = synthesized.receipt.synthesis.runId;
      const runCountAfterSynthesis = (await readdir(join(dir, ".legion-cli", "cache", "runs"))).length;
      await store.writeSpec(original.data, original.body);
      const checkpoint = SpecChallengeReceiptSchema.parse({
        ...synthesized.receipt,
        status: "synthesis_running",
        finalDraftFingerprint: null,
        changes: [],
        draftDiff: null,
        synthesis: { ...synthesized.receipt.synthesis, status: "complete", runId: synthesisRunId },
      });
      await store.writeYaml(specChallengeReceiptPath(spec.id), checkpoint);
      const recoveredSynthesis = await engine.finalizeSpecChallenge(spec.id);
      assert.equal(recoveredSynthesis.status, "complete");
      assert.equal((await readdir(join(dir, ".legion-cli", "cache", "runs"))).length, runCountAfterSynthesis);
      assert.ok((await store.readSpec(spec.id)).data.failureCases.includes(response));
    }, { skillsDir, fakeArtifacts: [analysis(concerns), synthesis(changes)] });
  });
});

test("receipt reads reject mismatched identities and noncanonical thinking paths", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      const spec = await seedFocusedDraft(engine, store, dir);
      const completed = await engine.prepareSpecChallenge(spec.id);
      const path = specChallengeReceiptPath(spec.id);

      await store.writeYaml(path, { ...completed.receipt, specId: "other-spec" });
      await assert.rejects(() => engine.readSpecChallenge(spec.id), /receipt id mismatch/);

      await store.writeYaml(path, { ...completed.receipt, thinkingPath: ".legion-cli/workflow/untrusted.md" });
      await assert.rejects(() => engine.readSpecChallenge(spec.id), /thinking path mismatch/);
    }, { skillsDir, fakeArtifacts: [analysis([])] });
  });
});

test("tampered application checkpoints cannot remove existing requirements during recovery", async () => {
  await withFakeAdapter(async () => {
    const response = "Preserve the pending action and show a retry message.";
    const concerns = [{
      question: "What happens when the API is unavailable?",
      why: "Failure behavior is unspecified.",
      evidence: [{ kind: "assumption", claim: "No failure behavior is captured." }],
    }];
    const changes = [{
      section: "failureCases",
      statement: response,
      rationale: "Records the human response.",
      concernIds: ["C-01"],
    }];
    await withEngine(async ({ engine, store, dir }) => {
      const spec = await seedFocusedDraft(engine, store, dir);
      await engine.prepareSpecChallenge(spec.id);
      await engine.recordSpecChallengeResolution(
        spec.id,
        "C-01",
        { disposition: "answered", response },
        { id: "owner" },
      );
      const completed = await engine.finalizeSpecChallenge(spec.id);
      const application = completed.receipt.application;
      assert.ok(application);

      await store.writeSpec(application.baseSpec, application.baseBody);
      const tamperedSpec = { ...application.spec, mustBeTrue: [] };
      const tampered = SpecChallengeReceiptSchema.parse({
        ...completed.receipt,
        status: "synthesis_running",
        finalDraftFingerprint: null,
        synthesis: { ...completed.receipt.synthesis, status: "complete" },
        application: {
          ...application,
          spec: tamperedSpec,
          expectedDraftFingerprint: workflowFingerprint({ data: tamperedSpec, body: application.body }),
        },
      });
      await store.writeYaml(specChallengeReceiptPath(spec.id), tampered);

      await assert.rejects(() => engine.finalizeSpecChallenge(spec.id), /invalid spec challenge application checkpoint/);
      assert.deepEqual((await store.readSpec(spec.id)).data.mustBeTrue, application.baseSpec.mustBeTrue);
    }, { skillsDir, fakeArtifacts: [analysis(concerns), synthesis(changes)] });
  });
});

test("analysis output checkpoint recovers without copied jail output or another adapter call", async () => {
  await withFakeAdapter(async () => {
    const concerns = [{
      question: "What happens when the API is unavailable?",
      why: "Failure behavior is unspecified.",
      evidence: [{ kind: "assumption", claim: "No failure behavior is captured." }],
    }];
    await withEngine(async ({ engine: bootstrap, store, dir }) => {
      const spec = await seedFocusedDraft(bootstrap, store, dir);
      const crashing = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [analysis(concerns)],
        fakeAfterChallengeOutputCheckpoint: async () => {
          throw new Error("fault after analysis output checkpoint");
        },
      });
      await assert.rejects(
        () => crashing.prepareSpecChallenge(spec.id),
        /fault after analysis output checkpoint/,
      );
      const checkpoint = await crashing.readSpecChallenge(spec.id);
      assert.equal(checkpoint.status, "analysis_running");
      assert.equal(checkpoint.receipt.generation.status, "complete");
      assert.equal(checkpoint.receipt.concerns.length, 1);
      const runId = checkpoint.receipt.generation.runId;
      assert.ok(runId);
      await assert.rejects(
        () => readFile(join(dir, ".legion-cli", "cache", "runs", runId, "analysis.json"), "utf8"),
        (error) => error?.code === "ENOENT",
      );
      const beforeRuns = await challengeRunNames(dir);

      const restarted = new LegionEngine(dir, undefined, { skillsDir });
      const recovered = await restarted.prepareSpecChallenge(spec.id);
      assert.equal(recovered.status, "awaiting_resolutions");
      assert.equal(recovered.receipt.concerns[0].question, concerns[0].question);
      assert.deepEqual(await challengeRunNames(dir), beforeRuns);
    }, { skillsDir });
  });
});

test("synthesis output checkpoint recovers without copied jail output or another adapter call", async () => {
  await withFakeAdapter(async () => {
    const response = "Preserve the pending action and show a retry message.";
    const concerns = [{
      question: "What happens when the API is unavailable?",
      why: "Failure behavior is unspecified.",
      evidence: [{ kind: "assumption", claim: "No failure behavior is captured." }],
    }];
    const changes = [{
      section: "failureCases",
      statement: response,
      rationale: "Records the human response.",
      concernIds: ["C-01"],
    }];
    await withEngine(async ({ engine: bootstrap, store, dir }) => {
      const spec = await seedFocusedDraft(bootstrap, store, dir);
      const analyzer = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [analysis(concerns)],
      });
      await analyzer.prepareSpecChallenge(spec.id);
      await analyzer.recordSpecChallengeResolution(
        spec.id,
        "C-01",
        { disposition: "answered", response },
        { id: "owner" },
      );
      const crashing = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [synthesis(changes)],
        fakeAfterChallengeOutputCheckpoint: async () => {
          throw new Error("fault after synthesis output checkpoint");
        },
      });
      await assert.rejects(
        () => crashing.finalizeSpecChallenge(spec.id),
        /fault after synthesis output checkpoint/,
      );
      const checkpoint = await crashing.readSpecChallenge(spec.id);
      assert.equal(checkpoint.status, "synthesis_running");
      assert.equal(checkpoint.receipt.synthesis.status, "complete");
      assert.ok(checkpoint.receipt.application);
      const runId = checkpoint.receipt.synthesis.runId;
      assert.ok(runId);
      await assert.rejects(
        () => readFile(join(dir, ".legion-cli", "cache", "runs", runId, "synthesis.json"), "utf8"),
        (error) => error?.code === "ENOENT",
      );
      const beforeRuns = await challengeRunNames(dir);

      const restarted = new LegionEngine(dir, undefined, { skillsDir });
      const recovered = await restarted.finalizeSpecChallenge(spec.id);
      assert.equal(recovered.status, "complete");
      assert.ok((await store.readSpec(spec.id)).data.failureCases.includes(response));
      assert.deepEqual(await challengeRunNames(dir), beforeRuns);
    }, { skillsDir });
  });
});

test("draft-write checkpoint completes idempotently after restart", async () => {
  await withFakeAdapter(async () => {
    const response = "Preserve the pending action and show a retry message.";
    const concerns = [{
      question: "What happens when the API is unavailable?",
      why: "Failure behavior is unspecified.",
      evidence: [{ kind: "assumption", claim: "No failure behavior is captured." }],
    }];
    const changes = [{
      section: "failureCases",
      statement: response,
      rationale: "Records the human response.",
      concernIds: ["C-01"],
    }];
    await withEngine(async ({ engine: bootstrap, store, dir }) => {
      const spec = await seedFocusedDraft(bootstrap, store, dir);
      const analyzer = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [analysis(concerns)],
      });
      await analyzer.prepareSpecChallenge(spec.id);
      await analyzer.recordSpecChallengeResolution(
        spec.id,
        "C-01",
        { disposition: "answered", response },
        { id: "owner" },
      );
      const crashing = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [synthesis(changes)],
        fakeAfterChallengeDraftWrite: async () => {
          throw new Error("fault after challenge draft write");
        },
      });
      await assert.rejects(
        () => crashing.finalizeSpecChallenge(spec.id),
        /fault after challenge draft write/,
      );
      const written = await store.readSpec(spec.id);
      assert.ok(written.data.failureCases.includes(response));
      assert.equal((written.body.match(/legion-cli:spec-challenge:start/g) ?? []).length, 1);
      const checkpoint = await crashing.readSpecChallenge(spec.id);
      assert.equal(checkpoint.status, "synthesis_running");
      assert.ok(checkpoint.receipt.application);
      const beforeRuns = await challengeRunNames(dir);

      const restarted = new LegionEngine(dir, undefined, { skillsDir });
      const recovered = await restarted.finalizeSpecChallenge(spec.id);
      assert.equal(recovered.status, "complete");
      const finalDraft = await store.readSpec(spec.id);
      assert.deepEqual(finalDraft.data.failureCases, written.data.failureCases);
      assert.equal((finalDraft.body.match(/legion-cli:spec-challenge:start/g) ?? []).length, 1);
      assert.deepEqual(await challengeRunNames(dir), beforeRuns);
    }, { skillsDir });
  });
});

test("held unrelated spawns reject every challenge mutation without changing receipt or draft", async () => {
  await withFakeAdapter(async () => {
    const concerns = [{
      question: "What happens when the API is unavailable?",
      why: "Failure behavior is unspecified.",
      evidence: [{ kind: "assumption", claim: "No failure behavior is captured." }],
    }];
    await withEngine(async ({ engine: bootstrap, store, dir }) => {
      const spec = await seedFocusedDraft(bootstrap, store, dir);
      const analyzer = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [analysis(concerns)],
      });
      const prepared = await analyzer.prepareSpecChallenge(spec.id);
      const receiptPath = join(dir, specChallengeReceiptPath(spec.id));
      const draftPath = join(dir, ".legion-cli", "specs", spec.id, "SPEC.md");

      const firstHold = await startHeldMapSpawn(dir, store);
      const receiptBefore = await readFile(receiptPath, "utf8");
      const draftBefore = await readFile(draftPath, "utf8");
      for (const mutate of [
        () => analyzer.recordSpecChallengeResolution(
          spec.id,
          "C-01",
          { disposition: "answered", response: "Preserve the pending action and show a retry message." },
          { id: "owner" },
        ),
        () => analyzer.finalizeSpecChallenge(spec.id),
      ]) {
        await assert.rejects(
          mutate,
          LegionRefuseError,
        );
        assert.equal(await readFile(receiptPath, "utf8"), receiptBefore);
        assert.equal(await readFile(draftPath, "utf8"), draftBefore);
      }
      await firstHold.finish();

      const manualReceipt = SpecChallengeReceiptSchema.parse({
        ...prepared.receipt,
        status: "manual_required",
        synthesis: {
          status: "failed",
          runId: null,
          completedAt: new Date().toISOString(),
          error: "synthesis automation failed",
        },
        automationError: "synthesis automation failed",
      });
      await store.writeYaml(specChallengeReceiptPath(spec.id), manualReceipt);
      const secondHold = await startHeldMapSpawn(dir, store);
      const manualBefore = await readFile(receiptPath, "utf8");
      await assert.rejects(
        () => analyzer.recordSpecChallengeManualAnswer(
          spec.id,
          "measurableSuccess",
          "A phone check-in completes within five seconds.",
          { id: "owner" },
        ),
        LegionRefuseError,
      );
      assert.equal(await readFile(receiptPath, "utf8"), manualBefore);
      assert.equal(await readFile(draftPath, "utf8"), draftBefore);
      await secondHold.finish();
    }, { skillsDir });
  });
});
