import assert from "node:assert/strict";
import test from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import {
  ExperimentalAcpAdapter,
  experimentalAcpAvailability,
} from "../dist/index.js";

function fixtureAgent(events) {
  return acp
    .agent({ name: "legion-acp-fixture" })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      events.push(`initialize:${params.protocolVersion}`);
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { close: {} } },
        agentInfo: { name: "fixture-agent", version: "1.0.0" },
      };
    })
    .onRequest(acp.methods.agent.session.new, ({ params }) => {
      events.push(`new:${params.cwd}`);
      return { sessionId: "fixture-session" };
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      events.push(`prompt:${params.sessionId}`);
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "working " },
        },
      });
      const permission = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "edit-1", title: "Edit fixture", kind: "edit" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      events.push(
        permission.outcome.outcome === "selected"
          ? `permission:${permission.outcome.optionId}`
          : "permission:cancelled",
      );
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
        },
      });
      return { stopReason: "end_turn" };
    })
    .onRequest(acp.methods.agent.session.close, ({ params }) => {
      events.push(`close:${params.sessionId}`);
      return {};
    });
}

test("experimental ACP adapter negotiates, streams progress, governs permission, and closes", async () => {
  const events = [];
  const progress = [];
  const adapter = new ExperimentalAcpAdapter({
    target: fixtureAgent(events),
    permissionPolicy: ({ options }) =>
      options.find((option) => option.kind === "allow_once")?.optionId ?? null,
    onProgress: (notification) => progress.push(notification.update.sessionUpdate),
  });

  const result = await adapter.run({ cwd: process.cwd(), prompt: "complete fixture" });

  assert.equal(result.protocolVersion, acp.PROTOCOL_VERSION);
  assert.equal(result.agentInfo?.name, "fixture-agent");
  assert.equal(result.sessionId, "fixture-session");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.text, "working done");
  assert.equal(result.cancelled, false);
  assert.deepEqual(progress, ["agent_message_chunk", "agent_message_chunk"]);
  assert.deepEqual(result.permissions, [
    { toolCallId: "edit-1", outcome: "selected", optionId: "allow-once" },
  ]);
  assert.deepEqual(events, [
    `initialize:${acp.PROTOCOL_VERSION}`,
    `new:${process.cwd()}`,
    "prompt:fixture-session",
    "permission:allow-once",
    "close:fixture-session",
  ]);
});

test("experimental ACP adapter denies permissions by default and refuses persistent allow", async () => {
  const defaultEvents = [];
  const denied = await new ExperimentalAcpAdapter({ target: fixtureAgent(defaultEvents) }).run({
    cwd: process.cwd(),
    prompt: "default deny",
  });
  assert.equal(defaultEvents.includes("permission:cancelled"), true);
  assert.deepEqual(denied.permissions, [{ toolCallId: "edit-1", outcome: "cancelled" }]);

  const persistentEvents = [];
  const persistent = await new ExperimentalAcpAdapter({
    target: fixtureAgent(persistentEvents),
    permissionPolicy: () => "allow-always",
  }).run({ cwd: process.cwd(), prompt: "persistent permission" });
  assert.equal(persistentEvents.includes("permission:cancelled"), true);
  assert.deepEqual(persistent.permissions, [{ toolCallId: "edit-1", outcome: "cancelled" }]);
});

test("experimental ACP adapter forwards cancellation to the active session", async () => {
  const events = [];
  let finishPrompt;
  const agent = acp
    .agent({ name: "cancellable-fixture" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
    }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "cancel-session" }))
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const cancelled = new Promise((resolve) => {
        finishPrompt = resolve;
      });
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "started" },
        },
      });
      await cancelled;
      return { stopReason: "cancelled" };
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      events.push(`cancel:${params.sessionId}`);
      finishPrompt?.();
    });
  const controller = new AbortController();
  const adapter = new ExperimentalAcpAdapter({
    target: agent,
    onProgress: () => controller.abort(),
  });

  const result = await adapter.run({
    cwd: process.cwd(),
    prompt: "cancel fixture",
    signal: controller.signal,
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.stopReason, "cancelled");
  assert.deepEqual(events, ["cancel:cancel-session"]);
});

test("real ACP smoke stays unavailable until an explicit connection target is supplied", () => {
  assert.deepEqual(experimentalAcpAvailability(), {
    available: false,
    experimental: true,
    reason: "ACP is disabled by default; explicitly construct ExperimentalAcpAdapter with a connection target",
  });
});
