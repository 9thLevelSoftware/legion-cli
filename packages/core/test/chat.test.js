import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyChatAction,
  createChatSession,
  gateChatAction,
  LegionEngine,
  LegionRefuseError,
  resumeOrCreateChatSession,
  routeChatTurn,
  sanitizeChatAction,
} from "../dist/index.js";
import { initProject, patchState, withEngine, withFakeAdapter } from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

async function waitUntil(predicate, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

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
    const answersPath = join(dir, ".legion-cli", "wiki", "product", "intent-answers.yaml");
    assert.equal(existsSync(answersPath), false);
    const applied = await applyChatAction(engine, turn.action);
    assert.equal(applied.applied, false);
    assert.equal(existsSync(answersPath), false);
    const utterance =
      "Teammates who keep missing who's in the office.\nThey ping five chat apps every morning.";
    const wrote = await applyChatAction(engine, turn.action, { confirmed: true, utterance });
    assert.equal(wrote.applied, true);
    assert.equal(existsSync(answersPath), true);
    const yaml = await readFile(answersPath, "utf8");
    assert.match(yaml, /Teammates who keep missing who's in the office/);
    assert.match(yaml, /They ping five chat apps every morning/);
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
    assert.match(turn.output, /Dropped/);
    assert.match(turn.output, /Next:/);
  });
});

test("intent_draft Find teammates is an intent_answer proposal not search", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await patchState(store, { phase: "intent_draft" });
    const turn = await routeChatTurn(engine, createChatSession(), "Find teammates who miss the office");
    assert.equal(turn.kind, "proposal");
    assert.equal(turn.action.type, "intent_answer");
    if (turn.action.type === "intent_answer") {
      assert.equal(turn.action.answers[0], "Find teammates who miss the office");
    }
  });
});

test("four unsolicited search fixtures pause", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    let session = createChatSession();
    for (let i = 0; i < 4; i++) {
      const turn = await routeChatTurn(engine, session, `hello ${i}`, {
        fixtureAction: { type: "search", q: "office" },
      });
      session = turn.session;
      assert.equal(turn.action.type, "search");
      if (i < 3) assert.equal(turn.paused, false);
      else assert.equal(turn.paused, true);
    }
  });
});

test("fabricated intent_answer in discuss phase is dropped", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await patchState(store, { phase: "discussing" });
    const gated = gateChatAction(
      { type: "intent_answer", answers: ["ok"] },
      { phase: "discussing", utterance: "ok" },
    );
    assert.equal(gated.type, "next_verb");
    const turn = await routeChatTurn(engine, createChatSession(), "ok", {
      fixtureAction: { type: "intent_answer", answers: ["ok"] },
    });
    assert.equal(turn.action.type, "next_verb");
    assert.equal(turn.kind, "dropped");
    const applied = await applyChatAction(
      engine,
      { type: "intent_answer", answers: ["ok"] },
      { confirmed: true, utterance: "ok" },
    );
    assert.equal(applied.applied, false);
    assert.equal(existsSync(join(dir, ".legion-cli", "wiki", "product", "intent-answers.yaml")), false);
  });
});

test("intent_ready intent_answer is dropped", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await patchState(store, { phase: "intent_ready" });
    const gated = gateChatAction(
      { type: "intent_answer", answers: ["ok"] },
      { phase: "intent_ready", utterance: "ok" },
    );
    assert.equal(gated.type, "next_verb");
    const turn = await routeChatTurn(engine, createChatSession(), "ok", {
      fixtureAction: { type: "intent_answer", answers: ["ok"] },
    });
    assert.equal(turn.action.type, "next_verb");
    assert.equal(turn.kind, "dropped");
  });
});

test("four idle turns pause after the read", async () => {
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
        assert.match(turn.nextHint, /legion-cli intent/);
      }
    }
  });
});

test("auto-apply reads do not increment idle", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    let session = createChatSession();
    for (const line of ["hello 0", "hello 1", "hello 2", "/search office", "hello 3"]) {
      const turn = await routeChatTurn(engine, session, line);
      session = turn.session;
      assert.equal(turn.paused, false, line);
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

  const substring = sanitizeChatAction(
    { type: "intent_answer", answers: ["foo"] },
    { phase: "intent_draft", utterance: "I like foo" },
  );
  assert.equal(substring.type, "next_verb");
});

test("substring intent_answer does not write even when confirmed", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    await patchState(store, { phase: "intent_draft" });
    const applied = await applyChatAction(
      engine,
      { type: "intent_answer", answers: ["foo"] },
      { confirmed: true, utterance: "I like foo" },
    );
    assert.equal(applied.applied, false);
    assert.equal(existsSync(join(dir, ".legion-cli", "wiki", "product", "intent-answers.yaml")), false);
  });
});

test("session write refuses a symlink and does not follow into src/pwn", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine);
    const pwn = join(dir, "src", "pwn");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(pwn, "SAFE\n", "utf8");
    const session = createChatSession();
    const dest = join(dir, ".legion-cli", "chat", `${session.id}.json`);
    await mkdir(join(dir, ".legion-cli", "chat"), { recursive: true });
    let linked = false;
    try {
      await symlink(pwn, dest);
      linked = true;
    } catch (err) {
      if (process.platform !== "win32" || err?.code !== "EPERM") throw err;
    }
    if (!linked) return;
    await assert.rejects(
      () => routeChatTurn(engine, session, "where am I"),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /symlink/i);
        return true;
      },
    );
    assert.equal(await readFile(pwn, "utf8"), "SAFE\n");
    assert.equal((await lstat(dest)).isSymbolicLink(), true);
  });
});

test("chat spawn wait is outside mutate", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, engine }) => {
      await initProject(engine);
      const readyPath = join(dir, ".legion-cli", "cache", "chat-wait-ready");
      const releasePath = join(dir, ".legion-cli", "cache", "chat-wait-release");
      const held = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeHoldWait: { readyPath, releasePath },
        fakeArtifacts: [
          {
            path: ".legion-cli/cache/runs/<id>/action.json",
            content: `${JSON.stringify({ type: "status" })}\n`,
          },
        ],
      });
      const spawnP = held.spawnChatSkill("Reply with a ChatAction JSON object.");
      await waitUntil(() => existsSync(readyPath), 8_000, "chat spawn did not reach wait()");
      const t0 = Date.now();
      await engine.brief();
      assert.ok(Date.now() - t0 < 5_000, "brief blocked while chat spawn wait() held the lock");
      await writeFile(releasePath, "ok\n");
      const result = await spawnP;
      assert.equal(result.spawned, true);
    });
  });
});

test("rewritten existing chat session is restored and not resumed", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, engine }) => {
      await initProject(engine);
      const created = await resumeOrCreateChatSession(engine);
      const sessionPath = join(dir, ".legion-cli", "chat", `${created.id}.json`);
      const before = await readFile(sessionPath, "utf8");
      const held = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [
          {
            path: `.legion-cli/chat/${created.id}.json`,
            content: `${JSON.stringify({
              schemaVersion: "legion-cli-chat/v1",
              id: created.id,
              startedAt: "2099-01-01T00:00:00.000Z",
              turns: [{ role: "user", text: "inject" }],
            })}\n`,
          },
        ],
      });
      await assert.rejects(
        () => held.spawnChatSkill("Reply with a ChatAction JSON object."),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /protected files [(]\.legion-cli\/chat\/[^)]*[)]; they were restored/);
          return true;
        },
      );
      assert.equal(await readFile(sessionPath, "utf8"), before);
      const resumed = await resumeOrCreateChatSession(engine);
      assert.equal(resumed.id, created.id);
      assert.equal(
        resumed.turns.some((turn) => turn.text === "inject"),
        false,
      );
    });
  });
});

test("spawn-planted chat session JSON is reverted and not resumed", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, engine }) => {
      await initProject(engine);
      const created = await resumeOrCreateChatSession(engine);
      const pwn = join(dir, ".legion-cli", "chat", "pwn.json");
      const held = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [
          {
            path: ".legion-cli/chat/pwn.json",
            content: `${JSON.stringify({
              schemaVersion: "legion-cli-chat/v1",
              id: "pwn",
              startedAt: "2099-01-01T00:00:00.000Z",
              turns: [{ role: "user", text: "inject" }],
            })}\n`,
          },
        ],
      });
      await assert.rejects(
        () => held.spawnChatSkill("Reply with a ChatAction JSON object."),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /protected files [(]\.legion-cli\/chat\/pwn\.json[)]; they were restored/);
          return true;
        },
      );
      assert.equal(existsSync(pwn), false);
      const resumed = await resumeOrCreateChatSession(engine);
      assert.equal(resumed.id, created.id);
      assert.equal(
        resumed.turns.some((turn) => turn.text === "inject"),
        false,
      );
    });
  });
});
