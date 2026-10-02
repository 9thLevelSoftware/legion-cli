import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { LegionEngine } from "../dist/index.js";
import { initGitRepo, makeTask, quoteArg, withEngine, withFakeAdapter, withReviewNotes } from "./helpers.js";

test("complete governed lifecycle binds AC-linked QA to the executed source before ship", async () => {
  await withFakeAdapter(() => withEngine(async ({ dir, engine, store }) => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "result.txt"), "pending\n");
    await writeFile(join(dir, "acceptance.cjs"), [
      'const assert = require("node:assert/strict");',
      'const fs = require("node:fs");',
      'assert.equal(fs.readFileSync("src/result.txt", "utf8"), "approved\\n");',
      'console.log(JSON.stringify({tests:[]}));',
    ].join("\n"));
    initGitRepo(dir);
    await engine.init({ name: "Lifecycle fixture", adapter: "fake", allowCopyJail: true });
    await engine.beginIntent();
    await engine.intentTurn(["Operators validating generated results", "They reconcile output manually"]);
    await engine.intentTurn(["The result equals approved", "Do not change acceptance.cjs; no integrations in v0"]);
    // Respond to the engine's actual question bank rather than forging phase state.
    const answers = new Map([
      ["What must we not change?", "acceptance.cjs"],
      ["Walk through the happy path in 3–5 steps.", "Run, inspect the result, accept"],
      ["What failures, security concerns, or integration risks must be handled?", "Reject a result that does not equal approved; no network access or external integrations"],
      ["What interfaces or touchpoints must exist in v0? (use `none` for a service or library)", "src/result.txt and the acceptance command"],
      ["What runtime or deployment environment matters, if any? (for example CLI, service, browser, mobile, Python, Rust; or `none`)", "The local Node.js CLI workspace"],
      ["Any existing constraints or design inputs we must follow? (path, link, or `none`)", "none"],
      ["Which unknowns or external integrations could block building?", "none"],
    ]);
    for (let round = 0; round < 8; round++) {
      const intent = await engine.getIntentState();
      if (intent.readyToConfirm) break;
      assert.ok(intent.nextQuestions.length > 0);
      await engine.intentTurn(intent.nextQuestions.map((question) => {
        assert.ok(answers.has(question), `unexpected intent question: ${question}`);
        return answers.get(question);
      }));
    }
    await engine.confirmIntent({ id: "fixture-operator" });
    const proposals = await engine.startDiscuss();
    await engine.discuss(proposals.map(({ id }) => ({ id, status: "accepted" })));
    const spec = await engine.draftSpec({ skipWireframes: true });
    const p0Acceptance = spec.acceptance.filter(({ priority }) => priority === "P0");
    assert.ok(p0Acceptance.length > 0, "drafted spec must retain at least one P0 acceptance criterion");
    assert.equal(spec.wireframesIndex, null, "this non-UI fixture must not require browser visual evidence");
    await writeFile(join(dir, "acceptance.cjs"), [
      'const assert = require("node:assert/strict");',
      'const fs = require("node:fs");',
      'assert.equal(fs.readFileSync("src/result.txt", "utf8"), "approved\\n");',
      `console.log(JSON.stringify({tests:${JSON.stringify(spec.acceptance.map(({ id, priority, statement }) => ({
        title: `@ac(${id}) @${priority.toLowerCase()} ${statement}`,
        ok: true,
      })))} }));`,
    ].join("\n"));
    await engine.approveSpec(spec.id, { id: "fixture-operator" });
    const command = `${quoteArg(process.execPath)} acceptance.cjs`;
    const config = await store.readConfig();
    await store.writeConfig({ ...config, qa: { ...config.qa, unitCommand: command } });
    await store.writeTask(makeTask({
      specId: spec.id, status: "todo", title: "Write the approved result",
      contract: { filesAllowed: ["src/result.txt"], expectedArtifacts: ["src/result.txt"], filesForbidden: ["acceptance.cjs", ".git/**"], verificationCommands: [command] },
    }), "Produce the approved result.\n");
    assert.notEqual(await engine.plan(spec.id), "FAIL");
    const executor = new LegionEngine(dir, undefined, { fakeArtifacts: [{ path: "src/result.txt", content: "approved\n" }] });
    const execution = await executor.execute("auto", { untilBlocked: true });
    assert.equal(execution.status, "done");
    assert.equal(await readFile(join(dir, "src", "result.txt"), "utf8"), "approved\n");
    const reviewer = new LegionEngine(dir, undefined, withReviewNotes());
    assert.equal((await reviewer.review()).verdict, "PASS");
    const score = await engine.qa();
    assert.equal(score.schemaVersion, "legion-cli-qa/v2");
    assert.equal(score.pass, true);
    assert.deepEqual(score.criteria.map(({ id, outcome }) => ({ id, outcome })), spec.acceptance.map(({ id }) => ({ id, outcome: "passed" })));
    assert.equal(score.buckets.visual.regressions, 0);
    const receipt = await engine.ship({ commit: false });
    assert.equal(receipt.phase, "shipped");
    assert.equal((await engine.getState()).phase, "shipped");
  }));
});
