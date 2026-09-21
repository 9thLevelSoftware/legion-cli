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
  assert.ok(forked.activeBranchId && forked.activeBranchId.startsWith("branch-"));
  assert.equal(forked.turns.length, 2);
  assert.equal(forked.turns[0].id, "turn-1");
  assert.equal(forked.turns[1].id, "turn-2");
});
