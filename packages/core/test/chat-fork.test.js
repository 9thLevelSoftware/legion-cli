import assert from "node:assert/strict";
import test from "node:test";
import { forkChatSession } from "../dist/index.js";

test("forkChatSession truncates turns at specified turnId and generates a new branchId", () => {
  const session = {
    schemaVersion: "legion-cli-chat/v1",
    id: "chat-0001",
    startedAt: new Date().toISOString(),
    turns: [
      { id: "turn-1", role: "user", text: "Turn 1" },
      { id: "turn-2", role: "assistant", text: "Response 1" },
      { id: "turn-3", role: "user", text: "Turn 2" },
      { id: "turn-4", role: "assistant", text: "Response 2" },
    ],
  };

  const forked = forkChatSession(session, "turn-2");
  assert.notEqual(forked.id, session.id);
  assert.ok(forked.startedAt > session.startedAt);
  assert.match(forked.id, /^chat-[0-9a-z]+-[0-9a-f]{8}$/);
  assert.ok(forked.activeBranchId && forked.activeBranchId.startsWith("branch-"));
  assert.equal(forked.parentSessionId, session.id);
  assert.equal(forked.forkedFromTurnId, "turn-2");
  assert.equal(forked.turns.length, 2);
  assert.equal(forked.turns[0].id, "turn-1");
  assert.equal(forked.turns[1].id, "turn-2");
});

test("forkChatSession supports pre-id legacy sessions by positional index", () => {
  const session = {
    schemaVersion: "legion-cli-chat/v1",
    id: "chat-legacy",
    startedAt: new Date().toISOString(),
    turns: [
      { role: "user", text: "Turn 1" },
      { role: "assistant", text: "Response 1" },
      { role: "user", text: "Turn 2" },
    ],
  };

  const forked = forkChatSession(session, "1");
  assert.equal(forked.turns.length, 2);
  assert.equal(forked.turns[0].id, "legacy-0");
  assert.equal(forked.turns[1].id, "legacy-1");
  assert.equal(forked.parentSessionId, "chat-legacy");

  const byBackfill = forkChatSession(session, "legacy-0");
  assert.equal(byBackfill.turns.length, 1);
  assert.equal(byBackfill.turns[0].text, "Turn 1");
});

test("two forks from the same parent do not share startedAt", () => {
  const session = {
    schemaVersion: "legion-cli-chat/v1",
    id: "chat-0001",
    startedAt: new Date().toISOString(),
    turns: [{ id: "turn-1", role: "user", text: "Turn 1" }],
  };
  const a = forkChatSession(session, "turn-1");
  const b = forkChatSession(session, "turn-1");
  assert.notEqual(a.startedAt, b.startedAt);
  assert.ok(a.startedAt > session.startedAt);
  assert.ok(b.startedAt > session.startedAt);
});
