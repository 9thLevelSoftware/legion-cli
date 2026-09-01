import assert from "node:assert/strict";
import test from "node:test";
import {
  AdapterConfigError,
  AdapterNotEnabled,
  DETECT_ADAPTER_IDS,
  FAKE_ADAPTER_ENV,
  createAdapter,
  detectMatrix,
  isDetectOnly,
  isSpawnable,
  resolveAdapter,
} from "../dist/index.js";

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

test("detect matrix covers every adapter id", async () => {
  const matrix = await detectMatrix({
    adapter: { default: "fake", generic: { binary: process.execPath, args: ["{{pointer}}"] } },
  });
  assert.deepEqual(Object.keys(matrix).sort(), [...DETECT_ADAPTER_IDS].sort());
  for (const id of DETECT_ADAPTER_IDS) {
    assert.equal(typeof matrix[id].ok, "boolean");
  }
  assert.equal(matrix.generic.ok, true);
});

test("fake detect is ok only when LEGION_CLI_ADAPTER=fake", async () => {
  const previous = process.env[FAKE_ADAPTER_ENV];
  try {
    delete process.env[FAKE_ADAPTER_ENV];
    const adapter = createAdapter("fake");
    assert.equal((await adapter.detect()).ok, false);
    process.env[FAKE_ADAPTER_ENV] = "fake";
    assert.equal((await adapter.detect()).ok, true);
    assert.equal(await isSpawnable(adapter), true);
  } finally {
    restoreEnv(FAKE_ADAPTER_ENV, previous);
  }
});

test("grok and codex are detect-only and spawn throws AdapterNotEnabled", async () => {
  for (const id of ["grok", "codex"]) {
    const adapter = createAdapter(id);
    assert.equal(isDetectOnly(id), true);
    assert.equal(await isSpawnable(adapter), false);
    const detected = await adapter.detect();
    assert.equal(typeof detected.ok, "boolean");
    await assert.rejects(
      () =>
        adapter.spawn({
          runId: "r",
          skillId: "plan",
          promptPath: "p",
          pointerPrompt: "x",
          cwd: process.cwd(),
          timeoutMs: 1000,
          env: {},
        }),
      (err) => err instanceof AdapterNotEnabled && err.id === id && err.name === "AdapterNotEnabled",
    );
  }
});

test("resolveAdapter uses user-set default and has no product fallback", () => {
  const fake = resolveAdapter({ adapter: { default: "fake" } });
  assert.equal(fake.id, "fake");
  const claude = resolveAdapter({ adapter: { default: "claude" } });
  assert.equal(claude.id, "claude");
  const generic = resolveAdapter({
    adapter: { default: "generic", generic: { binary: "node", args: ["{{pointer}}"] } },
  });
  assert.equal(generic.id, "generic");
  assert.equal(generic.binary, "node");
  assert.throws(
    () => resolveAdapter({ adapter: { default: "generic" } }),
    (err) => err instanceof AdapterConfigError,
  );
});

test("generic without a binary is not spawnable", async () => {
  const adapter = createAdapter("generic");
  const detected = await adapter.detect();
  assert.equal(detected.ok, false);
  assert.match(detected.reason ?? "", /adapter\.generic\.binary is missing/);
});
