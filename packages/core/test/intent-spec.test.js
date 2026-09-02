import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  INTENT_Q,
  LegionEngine,
  LegionRefuseError,
  WIREFRAME_PALETTE,
  palettePresent,
  splitMustNotAndOutOfScope,
} from "../dist/index.js";
import { initProject, withEngine, writeUnspawnableGrok } from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

async function fillThroughRound2(engine) {
  await engine.beginIntent();
  await engine.intentTurn([
    "Teammates who keep missing who's in the office.",
    "They ping five chat apps every morning.",
  ]);
  return engine.intentTurn([
    "People can tap in or out on their phone in under five seconds.",
    "No payroll, no badges, no calendar sync in v0.",
  ]);
}

async function fillFullIntent(engine) {
  await fillThroughRound2(engine);
  await engine.intentTurn(["existing auth"]);
  await engine.intentTurn([
    "Open the board, tap In, see yourself listed, tap Out, see yourself leave.",
    "Empty board, network error, changed mind.",
  ]);
  await engine.intentTurn(["board", "phone"]);
  await engine.intentTurn(["none", "none"]);
  await engine.confirmIntent({ id: "tester" });
}

test("question bank maps answers onto IntentAnswersFile SPEC fields", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    const after = await fillThroughRound2(engine);
    assert.equal(after.phase, "intent_draft");
    assert.equal(after.nextQuestions[0], INTENT_Q.clarifyMustNotChange);
    const file = await store.readIntentAnswers();
    assert.equal(file.schemaVersion, "legion-cli-intent-answers/v1");
    assert.equal(file.mapped.personas[0], "Teammates who keep missing who's in the office.");
    assert.equal(file.mapped.problem, "They ping five chat apps every morning.");
    assert.deepEqual(file.mapped.mustBeTrue, [
      "People can tap in or out on their phone in under five seconds",
    ]);
    assert.deepEqual(file.mapped.outOfScope, ["payroll", "badges", "calendar sync in v0"]);
    assert.equal(file.rounds.length, 2);
    assert.equal(file.rounds[0].questions.length, 2);
  });
});

test("scope split on not build vs clarifying half-round", () => {
  const split = splitMustNotAndOutOfScope("Keep auth. We will not build payroll.");
  assert.deepEqual(split.mustNotChange, ["Keep auth"]);
  assert.ok(split.outOfScope.some((item) => /payroll/i.test(item)));
  assert.equal(split.needsClarify, false);
  const unsplit = splitMustNotAndOutOfScope("No payroll, no badges");
  assert.equal(unsplit.needsClarify, true);
  assert.deepEqual(unsplit.outOfScope, ["payroll", "badges"]);
});

test("intent confirm is required; --done after round 2 is enough to confirm", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    await fillThroughRound2(engine);
    await assert.rejects(
      () => engine.confirmIntent({ id: "tester" }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.nextHint, /confirm/);
        return true;
      },
    );
    await engine.confirmIntent({ id: "tester" }, { done: true });
    assert.equal((await engine.getState()).phase, "intent_ready");
  });
});

test("two questions at a time and max eight rounds then confirm", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    let state = await engine.beginIntent();
    assert.equal(state.nextQuestions.length, 2);
    let turns = 0;
    while (state.nextQuestions.length > 0 && turns < 10) {
      assert.ok(state.nextQuestions.length <= 2);
      const answers = state.nextQuestions.map((_, i) => `answer-${turns}-${i}`);
      state = await engine.intentTurn(answers);
      turns += 1;
    }
    assert.ok(turns <= 8);
    assert.equal(state.readyToConfirm, true);
    await engine.confirmIntent({ id: "tester" });
    assert.equal((await engine.getState()).phase, "intent_ready");
  });
});

test("templates produce a valid Spec without a spawn", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await fillFullIntent(engine);
    const proposed = await engine.startDiscuss();
    assert.ok(proposed.length >= 2);
    assert.ok(proposed.every((item) => item.status === "proposed"));
    await engine.discuss(proposed.map((item) => ({ id: item.id, status: "accepted" })));
    const spec = await engine.draftSpec();
    assert.equal(spec.status, "draft");
    assert.equal(spec.schemaVersion, "legion-cli-spec/v1");
    assert.ok(spec.mustBeTrue.length > 0);
    assert.ok(spec.acceptance.some((ac) => ac.priority === "P0"));
    assert.equal(spec.wireframesIndex, "wireframes/INDEX.html");
    const index = await readFile(join(store.paths.specsDir, spec.id, "wireframes", "INDEX.html"), "utf8");
    assert.equal(palettePresent(index), true);
    assert.match(index, new RegExp(WIREFRAME_PALETTE.background));
    assert.match(index, new RegExp(WIREFRAME_PALETTE.ink));
    assert.match(index, new RegExp(WIREFRAME_PALETTE.accent));
    assert.match(index, new RegExp(WIREFRAME_PALETTE.muted));
    const prd = await readFile(join(store.paths.specsDir, spec.id, "prd.md"), "utf8");
    assert.match(prd, /Problem/);
    assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
    await engine.approveSpec(spec.id, { id: "human" });
    assert.equal((await engine.getState()).phase, "spec_frozen");
    assert.equal((await store.readSpec(spec.id)).data.status, "frozen");
  });
});

test("--skip-wireframes is pre-approve only and leaves wireframesIndex empty", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await fillFullIntent(engine);
    const proposed = await engine.startDiscuss();
    await engine.discuss(proposed.map((item) => ({ id: item.id, status: "accepted" })));
    const spec = await engine.draftSpec({ skipWireframes: true });
    assert.equal(spec.wireframesIndex ?? null, null);
    assert.equal(existsSync(join(store.paths.specsDir, spec.id, "wireframes", "INDEX.html")), false);
    await engine.approveSpec(spec.id, { id: "human" });
    await assert.rejects(
      () => engine.draftSpec({ skipWireframes: true }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.nextHint, /pre-approve/);
        return true;
      },
    );
  });
});

test("mustBeTrue splits on newlines not commas", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    await engine.beginIntent();
    await engine.intentTurn([
      "Teammates who keep missing who's in the office.",
      "They ping five chat apps every morning.",
    ]);
    const after = await engine.intentTurn([
      "People can tap in or out on their phone in under five seconds, even offline.",
      "No payroll",
    ]);
    assert.deepEqual(after.mapped.mustBeTrue, [
      "People can tap in or out on their phone in under five seconds, even offline",
    ]);
  });
});

test("round 5 brand and blockers are asked after screens", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await fillThroughRound2(engine);
    await engine.intentTurn(["existing auth"]);
    await engine.intentTurn([
      "Open the board, tap In, see yourself listed, tap Out, see yourself leave.",
      "Empty board, network error, changed mind.",
    ]);
    const afterScreens = await engine.intentTurn(["board", "phone"]);
    assert.deepEqual(afterScreens.nextQuestions, [INTENT_Q.brand, INTENT_Q.blockers]);
    assert.equal(afterScreens.readyToConfirm, false);
    await engine.intentTurn([".legion-cli/design/tokens.css", "need office wifi"]);
    const context = await store.readContext();
    assert.match(context.data.standingInstructions, /tokens\.css/);
    const names = await readdir(store.paths.assumptionsDir);
    const blocking = [];
    for (const name of names.filter((file) => file.endsWith(".md"))) {
      const doc = await store.readAssumption(name.replace(/\.md$/i, ""));
      if (doc.data.blocking) blocking.push(doc.data.statement);
    }
    assert.ok(blocking.some((line) => /wifi/i.test(line)));
    const ready = await engine.getIntentState();
    assert.equal(ready.readyToConfirm, true);
    assert.equal(ready.nextQuestions.length, 0);
  });
});

test("duplicate screen names get unique wireframe slugs", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await fillThroughRound2(engine);
    await engine.intentTurn(["existing auth"]);
    await engine.intentTurn(["Open the board.", "empty"]);
    await engine.intentTurn(["board, board", "phone"]);
    await engine.intentTurn(["none", "none"]);
    await engine.confirmIntent({ id: "tester" });
    const proposed = await engine.startDiscuss();
    await engine.discuss(proposed.map((item) => ({ id: item.id, status: "accepted" })));
    const spec = await engine.draftSpec();
    const dir = join(store.paths.specsDir, spec.id, "wireframes");
    const index = await readFile(join(dir, "INDEX.html"), "utf8");
    assert.match(index, /href="board\.html"/);
    assert.match(index, /href="board-2\.html"/);
    assert.equal(existsSync(join(dir, "board.html")), true);
    assert.equal(existsSync(join(dir, "board-2.html")), true);
  });
});

test("optional spec spawn cannot freeze the spec", async () => {
  const previous = process.env.LEGION_CLI_ADAPTER;
  try {
    await withEngine(async ({ engine, dir }) => {
      await initProject(engine);
      await fillFullIntent(engine);
      const proposed = await engine.startDiscuss();
      await engine.discuss(proposed.map((item) => ({ id: item.id, status: "accepted" })));
      process.env.LEGION_CLI_ADAPTER = "fake";
      const frozenMd = [
        "---",
        "schemaVersion: legion-cli-spec/v1",
        "id: spec-checkin",
        "title: Checkin",
        "status: frozen",
        "mustBeTrue:",
        "  - tap in",
        "mustNotChange: []",
        "outOfScope: []",
        "acceptance:",
        "  - id: AC-P0-01",
        "    statement: tap in",
        "    kind: behavior",
        "    priority: P0",
        "personas:",
        "  - teammates",
        "happyPath: tap",
        "frozenAt: 2026-09-01T00:00:00.000Z",
        "frozenBy: agent",
        "---",
        "",
        "Spawn froze this.",
        "",
      ].join("\n");
      const spawning = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [{ path: ".legion-cli/specs/spec-checkin/SPEC.md", content: frozenMd }],
      });
      const spec = await spawning.draftSpec();
      assert.equal(spec.status, "draft");
      assert.equal(spec.frozenAt ?? null, null);
      assert.equal(spec.frozenBy ?? null, null);
      await spawning.approveSpec(spec.id, { id: "human" });
      assert.equal((await spawning.getState()).phase, "spec_frozen");
      assert.equal((await spawning.store.readSpec(spec.id)).data.status, "frozen");
    });
  } finally {
    if (previous === undefined) delete process.env.LEGION_CLI_ADAPTER;
    else process.env.LEGION_CLI_ADAPTER = previous;
  }
});

test("discuss skips spawn when the routed extra is not spawnable", async () => {
  await withEngine(
    async ({ engine, store, dir }) => {
      await initProject(engine);
      await fillFullIntent(engine);
      await writeUnspawnableGrok(store, { routes: { discuss: "grok" } });
      const previous = process.env.LEGION_CLI_ADAPTER;
      process.env.LEGION_CLI_ADAPTER = "fake";
      try {
        const proposed = await engine.startDiscuss();
        assert.ok(proposed.length > 0);
        assert.equal((await engine.getState()).phase, "discussing");
        const runsDir = join(dir, ".legion-cli", "cache", "runs");
        const runs = existsSync(runsDir) ? await readdir(runsDir) : [];
        assert.equal(
          runs.some((name) => name.startsWith("discuss-")),
          false,
        );
      } finally {
        if (previous === undefined) delete process.env.LEGION_CLI_ADAPTER;
        else process.env.LEGION_CLI_ADAPTER = previous;
      }
    },
    { skillsDir },
  );
});

test("optional discuss spawn cannot auto-accept decisions", async () => {
  const previous = process.env.LEGION_CLI_ADAPTER;
  try {
    await withEngine(async ({ engine, dir }) => {
      await initProject(engine);
      await fillFullIntent(engine);
      process.env.LEGION_CLI_ADAPTER = "fake";
      const accepted = [
        "---",
        "schemaVersion: legion-cli-discuss/v1",
        "decisions:",
        "  - id: D-001",
        "    statement: Ship as a native app.",
        "    status: accepted",
        "  - id: D-002",
        "    statement: Skip billing forever.",
        "    status: accepted",
        "---",
        "",
        "Spawn accepted these.",
        "",
      ].join("\n");
      const spawning = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [{ path: ".legion-cli/discuss/DISCUSS.md", content: accepted }],
      });
      const proposed = await spawning.startDiscuss();
      assert.ok(proposed.length >= 2);
      assert.ok(proposed.every((item) => item.status === "proposed"));
      assert.ok(proposed.some((item) => item.id === "D-001"));
    });
  } finally {
    if (previous === undefined) delete process.env.LEGION_CLI_ADAPTER;
    else process.env.LEGION_CLI_ADAPTER = previous;
  }
});

test("optional spawn extras vs SkillContract are reverted", async () => {
  const previous = process.env.LEGION_CLI_ADAPTER;
  try {
    await withEngine(async ({ engine, dir }) => {
      await initProject(engine);
      await fillFullIntent(engine);
      const proposed = await engine.startDiscuss();
      await engine.discuss(proposed.map((item) => ({ id: item.id, status: "accepted" })));
      await mkdir(join(dir, "src"), { recursive: true });
      process.env.LEGION_CLI_ADAPTER = "fake";
      const spawning = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [{ path: "src/secret.ts", content: "nope\n" }],
      });
      await assert.rejects(
        () => spawning.draftSpec(),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /SkillContract/);
          return true;
        },
      );
      assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
      const spec = await engine.store.readSpec("spec-checkin");
      assert.equal(spec.data.status, "draft");
    });
  } finally {
    if (previous === undefined) delete process.env.LEGION_CLI_ADAPTER;
    else process.env.LEGION_CLI_ADAPTER = previous;
  }
});

test("SkillContract revert runs in finally when wait() throws", async () => {
  const previous = process.env.LEGION_CLI_ADAPTER;
  try {
    await withEngine(async ({ engine, dir }) => {
      await initProject(engine);
      await fillFullIntent(engine);
      const proposed = await engine.startDiscuss();
      await engine.discuss(proposed.map((item) => ({ id: item.id, status: "accepted" })));
      await mkdir(join(dir, "src"), { recursive: true });
      process.env.LEGION_CLI_ADAPTER = "fake";
      const spawning = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [{ path: "src/secret.ts", content: "nope\n" }],
        fakeThrowAfterWrite: true,
      });
      await assert.rejects(() => spawning.draftSpec());
      assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
    });
  } finally {
    if (previous === undefined) delete process.env.LEGION_CLI_ADAPTER;
    else process.env.LEGION_CLI_ADAPTER = previous;
  }
});
