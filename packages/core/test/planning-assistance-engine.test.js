import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatMarkdownDocument } from "@9thlevelsoftware/legion-cli-persist";
import { initProject, withEngine, withFakeAdapter } from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../skills");
const brief = "Operators need a rollback CLI. Preserve the existing API, verify health, and roll back failed deployments. UI redesign is excluded.\n";

function sourceProposal(overrides = {}) {
  return {
    mapped: {
      personas: ["deployment operators"], problem: "Failed deployments need a safe rollback.",
      mustBeTrue: ["Rollback preserves API compatibility"], mustNotChange: ["existing API"],
      outOfScope: ["UI redesign"], happyPath: "Deploy, verify health, then roll back on failure.", screens: ["CLI"],
    },
    inferredSuggestions: ["Consider a dry-run preview"], missingSlots: [], conflictingSlots: [],
    failureLines: ["An unhealthy deployment is rolled back"], blockingLines: [], ...overrides,
  };
}

function setProposal(artifacts, filename, value) {
  artifacts.splice(0, artifacts.length, {
    path: `.legion-cli/cache/runs/<id>/${filename}`, content: JSON.stringify(value),
  });
}

function planningDecision(id, prerequisiteIds = []) {
  return {
    id, name: "Compatibility choice", question: `Which interface should ${id} preserve?`,
    kind: "design", blocking: true, prerequisiteIds,
    evidence: [{ kind: "assumption", statement: "Existing consumers may depend on the current API" }],
    options: [{ id: "preserve", label: "Preserve API", consequence: "Existing consumers continue to work" }],
    resolution: {
      disposition: "answered", response: "The model selected preservation", selectedOptionId: "preserve",
      resolvedAt: "2026-10-07T12:00:00.000Z",
    },
  };
}

test("a complete local brief stays unconfirmed until human confirmation, without synthetic interview rounds", async () => {
  const fakeArtifacts = [];
  await withFakeAdapter(() => withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeFile(join(dir, "brief.md"), brief);
    setProposal(fakeArtifacts, "intent-source-proposal.json", sourceProposal());
    const proposed = await engine.proposeIntentFromSource("brief.md");
    const draft = await engine.getIntentState();
    assert.equal(draft.phase, "intent_draft");
    assert.equal(draft.readyToConfirm, true);
    assert.deepEqual(draft.answers.rounds, []);
    assert.deepEqual(draft.mapped, proposed.mapped);
    assert.equal(proposed.source.digest, createHash("sha256").update(brief).digest("hex"));
    assert.equal(proposed.source.provenance, "local-file");
    assert.ok(!draft.mapped.mustBeTrue.includes(proposed.inferredSuggestions[0]));
    assert.equal(await store.pathExists(".legion-cli/wiki/product/intent.md"), false);

    // Confirmation's ordinary polish spawn has no output and cannot invent a transcript.
    fakeArtifacts.splice(0);
    await engine.confirmIntentFromSource({ id: "human-reviewer" });
    assert.equal((await engine.getState()).phase, "intent_ready");
    const confirmed = await store.readIntentAnswers();
    assert.deepEqual(confirmed.rounds, []);
    assert.deepEqual(confirmed.mapped, proposed.mapped);
    assert.match(await readFile(join(dir, ".legion-cli/wiki/product/intent.md"), "utf8"), /Failed deployments need a safe rollback/);
    assert.match(await readFile(join(dir, ".legion-cli/specs/spec-checkin/prd.md"), "utf8"), /Rollback preserves API compatibility/);
  }, { skillsDir, fakeArtifacts }));
});

test("changed source refuses stale confirmation, shows a diff, and retires only its imported assumptions", async () => {
  const fakeArtifacts = [];
  await withFakeAdapter(() => withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeFile(join(dir, "brief.txt"), brief);
    setProposal(fakeArtifacts, "intent-source-proposal.json", sourceProposal());
    const first = await engine.proposeIntentFromSource("brief.txt");
    const imported = (await engine.assumeList())[0];
    await engine.assumeAnswer(imported.id, "confirmed");
    const human = {
      ...imported, id: "ASM-0900", statement: "Human operator requires a recovery drill", status: "confirmed",
      createdIn: "intent", evidence: "Human confirmed in the interview",
    };
    await store.writeAssumption(human, "Human-authored recovery requirement.\n");
    const humanRecord = await store.readAssumption(human.id);
    const humanDiscussion = { schemaVersion: "legion-cli-discuss/v1", decisions: [
      { id: "D-HUMAN", statement: "Keep the existing API", status: "accepted" },
    ] };
    await store.writeDiscuss(humanDiscussion, "Human accepted this before reimport.\n");
    const discussionBefore = await store.readDiscuss();

    await writeFile(join(dir, "brief.txt"), `${brief}New requirement: show an actionable timeout message.\n`);
    await assert.rejects(engine.confirmIntentFromSource(), /imported brief changed/);
    assert.equal((await engine.getState()).phase, "intent_draft");
    assert.equal((await store.readAssumption(imported.id)).data.status, "confirmed");
    const next = sourceProposal({
      mapped: { ...first.mapped, mustBeTrue: [...first.mapped.mustBeTrue, "Timeout messages identify the recovery command"] },
      failureLines: ["A health timeout shows the recovery command"], blockingLines: ["Operator chooses the health timeout"],
    });
    setProposal(fakeArtifacts, "intent-source-proposal.json", next);
    const changed = await engine.proposeIntentFromSource("brief.txt");
    assert.equal(changed.changed, true);
    assert.notEqual(changed.source.digest, first.source.digest);
    assert.ok(changed.diff.some((line) => line.startsWith("mustBeTrue:")));
    assert.ok(changed.diff.some((line) => line.startsWith("failure handling:")));
    assert.ok(changed.diff.some((line) => line.startsWith("blockers:")));
    const retired = (await store.readAssumption(imported.id)).data;
    assert.equal(retired.status, "rejected");
    assert.match(retired.evidence, new RegExp(changed.source.digest));
    assert.deepEqual(await store.readAssumption(human.id), humanRecord);
    assert.deepEqual(await store.readDiscuss(), discussionBefore);
    const newImported = (await engine.assumeList()).filter((item) => item.createdIn === `intent-source:${changed.source.digest}`);
    assert.equal(newImported.length, 2);
    assert.ok(newImported.every((item) => item.status === "open"));
    assert.deepEqual((await store.readIntentAnswers()).rounds, []);

    // Identical reimport returns the saved proposal without duplicate side effects or another adapter output.
    fakeArtifacts.splice(0);
    const identical = await engine.proposeIntentFromSource("brief.txt");
    assert.equal(identical.changed, false);
    assert.deepEqual(identical.diff, []);
    assert.equal((await engine.assumeList()).length, 4);
  }, { skillsDir, fakeArtifacts }));
});

test("explicit exploration can depend on a prior human resolution and ordinary discussion preserves the planning graph", async () => {
  const fakeArtifacts = [];
  await withFakeAdapter(() => withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await writeFile(join(dir, "brief.md"), brief);
    setProposal(fakeArtifacts, "intent-source-proposal.json", sourceProposal());
    await engine.proposeIntentFromSource("brief.md");
    fakeArtifacts.splice(0);
    await engine.confirmIntentFromSource();

    setProposal(fakeArtifacts, "planning-decisions.json", { decisions: [planningDecision("D-FIRST")] });
    const first = await engine.explorePlanning();
    assert.equal(first.round, 1);
    assert.equal(first.decisions.length, 1);
    assert.equal(first.decisions[0].resolution, undefined);
    assert.equal((await store.readDiscuss()).data.decisions[0].status, "proposed");
    const humanResolution = await engine.resolvePlanningDecision("D-FIRST", {
      disposition: "answered", response: "Preserve the documented API for existing clients", selectedOptionId: "preserve",
    }, { id: "human-reviewer" });

    setProposal(fakeArtifacts, "planning-decisions.json", { decisions: [planningDecision("D-NEXT", ["D-FIRST"])] });
    const paused = await engine.explorePlanning();
    assert.equal(paused.round, 1);
    assert.deepEqual(paused.decisions, []);
    assert.equal((await store.readDiscuss()).data.decisions.length, 1);
    const second = await engine.explorePlanning({ continueRound: true });
    assert.equal(second.round, 2);
    assert.deepEqual(second.decisions.map((item) => item.id), ["D-NEXT"]);
    assert.deepEqual(second.decisions[0].prerequisiteIds, ["D-FIRST"]);
    assert.equal(second.decisions[0].resolution, undefined);
    assert.deepEqual((await store.readDiscuss()).data.decisions.find((item) => item.id === "D-FIRST").planning, humanResolution);
    const before = (await store.readDiscuss()).data.decisions;

    // A normal adapter omits the accepted node and attempts to replace the pending node with its own answer.
    fakeArtifacts.splice(0, fakeArtifacts.length, {
      path: ".legion-cli/discuss/DISCUSS.md",
      content: formatMarkdownDocument({ schemaVersion: "legion-cli-discuss/v1", decisions: [
        { id: "D-NEXT", statement: "Model replaced the question", status: "accepted", planning: planningDecision("D-NEXT") },
        { id: "D-ORDINARY", statement: "Record the release window", status: "accepted" },
      ] }, "Adapter proposal.\n"),
    });
    const proposed = await engine.startDiscuss();
    assert.ok(proposed.some((item) => item.id === "D-ORDINARY" && item.status === "proposed"));
    for (const saved of before) assert.deepEqual((await store.readDiscuss()).data.decisions.find((item) => item.id === saved.id), saved);
    await engine.discuss([{ id: "D-ORDINARY", status: "accepted" }]);
    for (const saved of before) assert.deepEqual((await store.readDiscuss()).data.decisions.find((item) => item.id === saved.id), saved);
    assert.equal((await engine.getAssistance()).cursor.round, 2);
  }, { skillsDir, fakeArtifacts }));
});
