import assert from "node:assert/strict";
import test from "node:test";

import {
  applyUsagePricing,
  assertProfileRuntimeSupport,
  resolveAgentProfile,
  usageLimitReason,
} from "../dist/index.js";

const config = {
  adapter: {
    default: "claude",
    routes: { execute: "codex" },
    profiles: {
      fast: {
        adapter: "grok",
        modelArgs: ["--model", "grok-fast"],
        outputLimit: 2000,
        pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 3, requestUsd: 0.01 },
        limits: { maxRequests: 4, maxToolRounds: 8, maxReportedTokens: 5000, maxEstimatedCostUsd: 1 },
      },
      review: { adapter: "codex", modelArgs: ["--model", "review"] },
    },
    skillProfiles: { review: "review" },
  },
};

test("resolveAgentProfile precedence is cli adapter > cli profile > task profile > skill profile > route", () => {
  assert.deepEqual(
    resolveAgentProfile(config, {
      skillId: "execute",
      cliAdapter: "minimax",
      taskProfile: "review",
    }),
    { adapterId: "minimax", source: "cli" },
  );
  assert.deepEqual(resolveAgentProfile(config, { skillId: "execute", cliProfile: "fast", taskProfile: "review" }), {
    adapterId: "grok",
    profile: "fast",
    source: "profile",
    config: config.adapter.profiles.fast,
  });
  assert.deepEqual(resolveAgentProfile(config, { skillId: "execute", taskProfile: "review" }), {
    adapterId: "codex",
    profile: "review",
    source: "task",
    config: config.adapter.profiles.review,
  });
  assert.deepEqual(resolveAgentProfile(config, { skillId: "execute", taskAdapter: "mimo" }), {
    adapterId: "mimo",
    source: "task",
  });
  assert.deepEqual(resolveAgentProfile(config, { skillId: "review" }), {
    adapterId: "codex",
    profile: "review",
    source: "skill-profile",
    config: config.adapter.profiles.review,
  });
  assert.deepEqual(resolveAgentProfile(config, { skillId: "execute" }), {
    adapterId: "codex",
    source: "route",
  });
});

test("resolveAgentProfile rejects unknown profiles and adapter/profile ambiguity", () => {
  assert.throws(
    () => resolveAgentProfile(config, { skillId: "execute", cliAdapter: "codex", cliProfile: "fast" }),
    /mutually exclusive/,
  );
  assert.throws(() => resolveAgentProfile(config, { skillId: "execute", cliProfile: "missing" }), /unknown profile/);
});

test("profile runtime refuses limits an adapter cannot honor", () => {
  assert.throws(
    () => assertProfileRuntimeSupport({ adapterId: "claude", source: "profile", profile: "limited", config: {
      adapter: "claude", modelArgs: [], outputLimit: 100,
    } }),
    /outputLimit is unsupported/,
  );
  assert.throws(
    () => assertProfileRuntimeSupport({ adapterId: "codex", source: "profile", profile: "budget", config: {
      adapter: "codex", modelArgs: [], limits: { maxEstimatedCostUsd: 1 },
    } }),
    /guaranteed spending caps are unsupported/,
  );
  assert.throws(
    () => assertProfileRuntimeSupport({ adapterId: "http", source: "profile", profile: "budget", config: {
      adapter: "http", modelArgs: [], limits: { maxEstimatedCostUsd: 1 },
    } }),
    /operator-supplied profile pricing/,
  );
});

test("usage pricing is explicitly estimated and stop thresholds use reported values", () => {
  const usage = applyUsagePricing(
    { requests: 2, toolCalls: 3, inputTokens: 1000, outputTokens: 500, model: "x" },
    config.adapter.profiles.fast.pricing,
  );
  assert.deepEqual(usage, {
    requests: 2,
    toolCalls: 3,
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    model: "x",
    estimatedCostUsd: 0.0225,
    costEstimated: true,
  });
  assert.equal(usageLimitReason(usage, config.adapter.profiles.fast.limits), null);
  assert.match(
    usageLimitReason({ ...usage, totalTokens: 5001 }, config.adapter.profiles.fast.limits),
    /reported token threshold/,
  );
  assert.match(
    usageLimitReason({ requests: 5 }, config.adapter.profiles.fast.limits),
    /request limit/,
  );
  assert.match(
    usageLimitReason({ requests: 1 }, { maxEstimatedCostUsd: 1 }),
    /cannot enforce.*cost/i,
  );
});

test("usage pricing remains incomplete when usage, rates, or adapter cost evidence is incomplete", () => {
  const pricing = config.adapter.profiles.fast.pricing;

  assert.deepEqual(
    applyUsagePricing({ requests: 1, inputTokens: 1000 }, pricing),
    { requests: 1, inputTokens: 1000 },
  );
  assert.deepEqual(
    applyUsagePricing(
      { requests: 1, inputTokens: 1000, outputTokens: 500 },
      { inputPerMillionUsd: 1, requestUsd: 0.01 },
    ),
    { requests: 1, inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
  );
  assert.deepEqual(
    applyUsagePricing(
      { requests: 1, inputTokens: 1000, outputTokens: 500, costEstimated: false },
      pricing,
    ),
    {
      requests: 1,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      costEstimated: false,
    },
  );
  assert.deepEqual(
    applyUsagePricing(
      {
        requests: 1,
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostUsd: 0.25,
        costEstimated: true,
      },
      pricing,
    ),
    {
      requests: 1,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      estimatedCostUsd: 0.25,
      costEstimated: true,
    },
  );
  assert.match(
    usageLimitReason(
      { requests: 1, estimatedCostUsd: 0.25, costEstimated: false },
      { maxEstimatedCostUsd: 1 },
    ),
    /cannot enforce.*cost/i,
  );
});


test("reported token thresholds enforce partial input and output lower bounds", () => {
  assert.match(
    usageLimitReason({ inputTokens: 101 }, { maxReportedTokens: 100 }),
    /reported token threshold exceeded \(101 > 100\)/,
  );
  assert.match(
    usageLimitReason({ outputTokens: 101 }, { maxReportedTokens: 100 }),
    /reported token threshold exceeded \(101 > 100\)/,
  );
  assert.equal(
    usageLimitReason({ inputTokens: 40 }, { maxReportedTokens: 100 }),
    null,
  );
});
