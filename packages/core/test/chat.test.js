import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  applyChatAction,
  createChatSession,
  routeChatTurn,
  sanitizeChatAction,
} from "../dist/index.js";
import { initProject, patchState, withEngine } from "./helpers.js";

test("where am I routes to status without spawning", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    const turn = await routeChatTurn(engine, createChatSession(), "where am I");
    assert.equal(turn.action.type, "status");
    assert.equal(turn.kind, "read");
    assert.equal(turn.spawned, false);
  });
});

test("intent_draft two answers propose and do not write intent-answers.yaml", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await patchState(store, { phase: "intent_draft" });
    const turn = await routeChatTurn(
      engine,
      createChatSession(),
      "Teammates who keep missing who's in the office.\nThey ping five chat apps every morning.",
    );
    assert.equal(turn.kind, "proposal");
    assert.equal(turn.action.type, "intent_answer");
    if (turn.action.type === "intent_answer") {
      assert.equal(turn.action.answers.length, 2);
    }
    assert.match(turn.proposal ?? "", /Proposed:/);
    assert.equal(existsSync(join(dir, ".legion-cli", "wiki", "product", "intent-answers.yaml")), false);
    const applied = await applyChatAction(engine, turn.action);
    assert.equal(applied.applied, false);
    assert.equal(existsSync(join(dir, ".legion-cli", "wiki", "product", "intent-answers.yaml")), false);
  });
});

test("discuss_decide fixture does not write DISCUSS.md without confirm", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await patchState(store, { phase: "discussing" });
    await store.writeDiscuss(
      {
        schemaVersion: "legion-cli-discuss/v1",
        decisions: [{ id: "D-001", statement: "Ship as mobile web.", status: "proposed" }],
      },
      "Proposed decisions.\n",
    );
    const before = await readFile(join(dir, ".legion-cli", "discuss", "DISCUSS.md"), "utf8");
    const turn = await routeChatTurn(engine, createChatSession(), "ok", {
      fixtureAction: { type: "discuss_decide", id: "D-001", status: "accepted" },
    });
    assert.equal(turn.kind, "proposal");
    assert.equal(turn.action.type, "discuss_decide");
    const applied = await applyChatAction(engine, turn.action);
    assert.equal(applied.applied, false);
    const after = await readFile(join(dir, ".legion-cli", "discuss", "DISCUSS.md"), "utf8");
    assert.equal(after, before);
    assert.doesNotMatch(after, /status: accepted/);
  });
});

test("ship fixture is dropped and Next is printed", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    const turn = await routeChatTurn(engine, createChatSession(), "ship it", {
      fixtureAction: { type: "ship" },
    });
    assert.equal(turn.kind, "dropped");
    assert.equal(turn.action.type, "next_verb");
    assert.match(turn.output, /Next:/);
  });
});

test("four idle turns pause", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    let session = createChatSession();
    for (let i = 0; i < 4; i++) {
      const turn = await routeChatTurn(engine, session, `hello ${i}`);
      session = turn.session;
      assert.equal(turn.action.type, "next_verb");
      assert.equal(turn.spawned, false);
      if (i < 3) assert.equal(turn.paused, false);
      else {
        assert.equal(turn.paused, true);
        assert.match(turn.output, /Chat paused/);
        assert.match(turn.output, /Next: legion-cli intent/);
      }
    }
  });
});

test("extra keys are stripped and fabricated intent_answer is dropped", () => {
  const status = sanitizeChatAction(
    { type: "status", extra: true },
    { phase: "initialized", utterance: "where am I" },
  );
  assert.equal(status.type, "status");
  assert.equal("extra" in status, false);

  const fabricated = sanitizeChatAction(
    { type: "intent_answer", answers: ["not in the utterance"] },
    { phase: "intent_draft", utterance: "hello there" },
  );
  assert.equal(fabricated.type, "next_verb");

  const wrongPhase = sanitizeChatAction(
    { type: "intent_answer", answers: ["hello there"] },
    { phase: "initialized", utterance: "hello there" },
  );
  assert.equal(wrongPhase.type, "next_verb");
});
