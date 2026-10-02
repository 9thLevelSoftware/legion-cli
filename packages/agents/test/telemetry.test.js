import assert from "node:assert/strict";
import test from "node:test";

import { exportUsageTelemetry } from "../dist/index.js";

test("usage telemetry only exports metadata to loopback OTLP", async () => {
  let request;
  const result = await exportUsageTelemetry({
    endpoint: "http://127.0.0.1:4318",
    adapter: "http",
    profile: "fast",
    skill: "extension:performance",
    outcome: "complete",
    usage: { requests: 2, toolCalls: 3, totalTokens: 400, estimatedCostUsd: 0.02, costEstimated: true },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response("", { status: 200 });
    },
  });
  assert.deepEqual(result, { sent: true });
  assert.equal(request.url, "http://127.0.0.1:4318/v1/traces");
  const payload = JSON.parse(request.init.body);
  const text = JSON.stringify(payload);
  assert.match(text, /extension:performance/);
  assert.match(text, /estimated_cost_usd/);
  assert.doesNotMatch(text, /"(?:prompt|source|credential|path)"\s*:/i);
});

test("usage telemetry rejects non-loopback collectors and stays disabled without an endpoint", async () => {
  assert.deepEqual(await exportUsageTelemetry({ adapter: "fake", skill: "execute", outcome: "done" }), {
    sent: false,
    reason: "disabled",
  });
  await assert.rejects(
    () => exportUsageTelemetry({ endpoint: "https://collector.example.com", adapter: "http", skill: "execute", outcome: "done" }),
    /loopback/,
  );
});

test("usage telemetry honors DO_NOT_TRACK before collector validation or dispatch", async () => {
  const previous = process.env.DO_NOT_TRACK;
  process.env.DO_NOT_TRACK = "1";
  let called = false;
  try {
    assert.deepEqual(await exportUsageTelemetry({
      endpoint: "https://collector.example.com",
      adapter: "http",
      skill: "execute",
      outcome: "done",
      fetchImpl: async () => { called = true; return new Response("", { status: 200 }); },
    }), { sent: false, reason: "do-not-track" });
    assert.equal(called, false);
  } finally {
    if (previous === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = previous;
  }
});
