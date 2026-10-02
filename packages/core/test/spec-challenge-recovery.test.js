import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { LegionRefuseError, specChallengeReceiptPath } from "../dist/index.js";
import {
  initProject,
  makeSpec,
  patchState,
  seedFrozenSpec,
  withEngine,
  withFakeAdapter,
  writeSpec,
} from "./helpers.js";

const analysis = (concerns) => ({
  path: ".legion-cli/cache/runs/<id>/analysis.json",
  content: `${JSON.stringify({ schemaVersion: "legion-cli-spec-challenge-analysis/v1", concerns })}\n`,
});

async function seedFocusedDraft(engine, store, dir) {
  await initProject(engine, { workflowProfile: "focused" });
  const spec = makeSpec();
  await writeSpec(store, spec, "# Office check-in\n\nDraft contract.\n");
  const project = await store.readProject();
  await store.writeProject({ ...project.data, activeSpecId: spec.id }, project.body);
  await patchState(store, { phase: "spec_draft", activeSpecId: spec.id });
  await writeFile(join(dir, "README.md"), "Offline behavior needs a human decision.\n", "utf8");
  return spec;
}

test("manual review cannot bypass a successful challenge with unresolved concerns", async () => {
  await withFakeAdapter(async () => {
    const concerns = [
      { question: "What is success?", why: "A measurable outcome is needed.", evidence: [{ kind: "assumption", claim: "Success is incomplete." }] },
      { question: "How does failure work?", why: "Failure handling is needed.", evidence: [{ kind: "assumption", claim: "Failure behavior is incomplete." }] },
      { question: "What remains compatible?", why: "Scope needs a constraint.", evidence: [{ kind: "assumption", claim: "Compatibility is incomplete." }] },
    ];
    await withEngine(async ({ engine, store, dir }) => {
      const spec = await seedFocusedDraft(engine, store, dir);
      const prepared = await engine.prepareSpecChallenge(spec.id);
      assert.equal(prepared.status, "awaiting_resolutions");
      assert.equal(prepared.pendingConcerns.length, 3);
      await assert.rejects(
        () => engine.finalizeSpecChallenge(spec.id, { manualReview: {
          measurableSuccess: "A check-in persists and confirms in under five seconds.",
          failureHandling: "An unavailable service preserves input and provides a retry message.",
          compatibilityAndScope: "Authentication remains compatible and payroll stays outside scope.",
          acknowledgement: "I acknowledge",
        } }),
        (error) => error instanceof LegionRefuseError && /cannot bypass/i.test(error.message),
      );
      const again = await engine.prepareSpecChallenge(spec.id);
      assert.equal(again.receipt.generation.runId, prepared.receipt.generation.runId);
      assert.equal(again.pendingConcerns.length, 3, "pending analysis is resumed without a new adapter call");
      await engine.recordSpecChallengeResolution(
        spec.id, "C-01", { disposition: "answered", response: "Persist a confirmation within five seconds." }, { id: "owner" },
      );
      await engine.recordSpecChallengeResolution(
        spec.id, "C-02", { disposition: "dismissed", response: "This failure mode is outside the bounded check-in contract." }, { id: "owner" },
      );
      const resolved = await engine.recordSpecChallengeResolution(
        spec.id, "C-03", { disposition: "risk_accepted", response: "The owner accepts this compatibility risk for the increment." }, { id: "owner" },
      );
      assert.deepEqual(resolved.receipt.concerns.map((concern) => concern.resolution?.disposition), [
        "answered", "dismissed", "risk_accepted",
      ]);
    }, { skillsDir: join(process.cwd(), "skills"), fakeArtifacts: [analysis(concerns)] });
  });
});

test("unproven interrupted analysis becomes manual-required without starting another run", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      const spec = await seedFocusedDraft(engine, store, dir);
      const complete = await engine.prepareSpecChallenge(spec.id);
      await store.writeYaml(specChallengeReceiptPath(spec.id), {
        ...complete.receipt,
        status: "analysis_running",
        finalDraftFingerprint: null,
        concerns: [],
        generation: { status: "running", runId: "spec-challenge-dead-run" },
      });
      const recovered = await engine.prepareSpecChallenge(spec.id);
      assert.equal(recovered.status, "manual_required");
      assert.match(recovered.automationError, /interrupted/i);
      assert.equal(recovered.receipt.generation.runId, "spec-challenge-dead-run");
    }, { skillsDir: join(process.cwd(), "skills"), fakeArtifacts: [analysis([])] });
  });
});

test("legacy and frozen specs remain challenge-compatible without retrospective work", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      const draft = makeSpec();
      await writeSpec(store, draft);
      const project = await store.readProject();
      await store.writeProject({ ...project.data, activeSpecId: draft.id }, project.body);
      await patchState(store, { phase: "spec_draft", activeSpecId: draft.id });
      assert.equal((await engine.readSpecChallenge(draft.id)).status, "complete");
      assert.equal((await engine.prepareSpecChallenge(draft.id)).receipt, null);
      await engine.approveSpec(draft.id, { id: "owner" });
    }, { skillsDir: join(process.cwd(), "skills") });

    await withEngine(async ({ engine, store }) => {
      await initProject(engine, { workflowProfile: "focused" });
      const frozen = await seedFrozenSpec(store);
      const challenge = await engine.readSpecChallenge(frozen.id);
      assert.equal(challenge.status, "complete");
      assert.equal(challenge.receipt, null);
      assert.equal((await engine.prepareSpecChallenge(frozen.id)).status, "complete");
    }, { skillsDir: join(process.cwd(), "skills") });
  });
});

test("focused brownfield challenge uses its configured adapter route", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, store, dir }) => {
      const spec = await seedFocusedDraft(engine, store, dir);
      const project = await store.readProject();
      await store.writeProject({ ...project.data, mode: "brownfield" }, project.body);
      const config = await store.readConfig();
      await store.writeConfig({
        ...config,
        adapter: {
          ...config.adapter,
          default: "generic",
          generic: { binary: "intentionally-unselected-generic", args: ["{{pointer}}"] },
          routes: { ...config.adapter.routes, "spec-challenge": "fake" },
        },
      });
      const result = await engine.prepareSpecChallenge(spec.id);
      assert.equal(result.status, "complete");
      assert.equal(result.receipt.generation.status, "complete");
    }, { skillsDir: join(process.cwd(), "skills"), fakeArtifacts: [analysis([])] });
  });
});
