import assert from "node:assert/strict";
import test from "node:test";
import {
  AdapterConfigError,
  ASSUMED_EXTRA_BINARIES,
  DETECT_ADAPTER_IDS,
  DETECT_ONLY_ADAPTER_IDS,
  EXTRA_ADAPTER_IDS,
  FAKE_ADAPTER_ENV,
  createAdapter,
  detectMatrix,
  isDetectOnly,
  isResolvedAdapterSpawnable,
  isSpawnable,
  resolveAdapter,
  resolveAdapterId,
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

test("extra adapters detect assumed PATH binaries and are no longer detect-only", async () => {
  assert.deepEqual([...DETECT_ONLY_ADAPTER_IDS], []);
  for (const id of EXTRA_ADAPTER_IDS) {
    const adapter = createAdapter(id);
    assert.equal(adapter.id, id);
    assert.equal(adapter.binary, ASSUMED_EXTRA_BINARIES[id]);
    assert.equal(isDetectOnly(id), false);
    const detected = await adapter.detect();
    assert.equal(typeof detected.ok, "boolean");
    assert.equal(await isSpawnable(adapter), detected.ok);
    if (!detected.ok) {
      assert.match(detected.reason ?? "", /is not on PATH/);
    }
  }
});

test("extra adapters with a node shim binary are spawnable", async () => {
  for (const id of EXTRA_ADAPTER_IDS) {
    const adapter = createAdapter(id, {
      [id]: { binary: process.execPath, args: ["{{pointer}}"] },
    });
    const detected = await adapter.detect();
    assert.equal(detected.ok, true, detected.reason);
    assert.equal(await isSpawnable(adapter), true);
  }
});

test("extra adapter args that omit {{pointer}} are not spawnable and spawn throws", async () => {
  for (const id of EXTRA_ADAPTER_IDS) {
    const adapter = createAdapter(id, {
      [id]: { binary: process.execPath, args: ["-p"] },
    });
    const detected = await adapter.detect();
    assert.equal(detected.ok, false);
    assert.match(detected.reason ?? "", /\{\{pointer\}\}/);
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
      (err) => err instanceof AdapterConfigError && /pointer/.test(err.message),
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
  const grok = resolveAdapter({ adapter: { default: "grok" } });
  assert.equal(grok.id, "grok");
  assert.equal(grok.binary, ASSUMED_EXTRA_BINARIES.grok);
  const openai = resolveAdapter({ adapter: { default: "openai" } });
  assert.equal(openai.id, "openai");
  assert.equal(openai.binary, ASSUMED_EXTRA_BINARIES.openai);
  const mimo = resolveAdapter({ adapter: { default: "mimo" } });
  assert.equal(mimo.id, "mimo");
  const minimax = resolveAdapter({ adapter: { default: "minimax" } });
  assert.equal(minimax.id, "minimax");
  assert.equal(minimax.binary, ASSUMED_EXTRA_BINARIES.minimax);
  assert.throws(
    () => resolveAdapter({ adapter: { default: "generic" } }),
    (err) =>
      err instanceof AdapterConfigError && /resolved adapter is generic/.test(err.message),
  );
});

test("resolveAdapter options.id overrides default and still applies per-id knobs", () => {
  const grok = resolveAdapter(
    {
      adapter: {
        default: "claude",
        grok: { binary: process.execPath, args: ["{{pointer}}"] },
      },
    },
    { id: "grok" },
  );
  assert.equal(grok.id, "grok");
  assert.equal(grok.binary, process.execPath);
  const claude = resolveAdapter({ adapter: { default: "grok" } }, { id: "claude" });
  assert.equal(claude.id, "claude");
});

test("resolveAdapter throws when resolved id is generic without binary even if default is not", () => {
  assert.throws(
    () => resolveAdapter({ adapter: { default: "claude" } }, { id: "generic" }),
    (err) =>
      err instanceof AdapterConfigError && /resolved adapter is generic/.test(err.message),
  );
});

test("resolveAdapterId precedence is cli > task > route > default", () => {
  const config = {
    adapter: {
      default: "claude",
      routes: { execute: "codex", plan: "grok", verify: "mimo" },
    },
  };
  assert.deepEqual(
    resolveAdapterId({
      config,
      skillId: "execute",
      taskAdapter: "mimo",
      cliAdapter: "minimax",
    }),
    { id: "minimax", source: "cli" },
  );
  assert.deepEqual(resolveAdapterId({ config, skillId: "execute", taskAdapter: "mimo" }), {
    id: "mimo",
    source: "task",
  });
  assert.deepEqual(resolveAdapterId({ config, skillId: "execute" }), {
    id: "codex",
    source: "route",
  });
  assert.deepEqual(resolveAdapterId({ config, skillId: "review" }), {
    id: "claude",
    source: "default",
  });
});

test("resolveAdapterId ignores Task.adapter unless skill is execute or verify", () => {
  const config = {
    adapter: { default: "claude", routes: { plan: "grok", review: "codex" } },
  };
  for (const skillId of ["plan", "review", "interview", "discuss", "spec", "ingest", "qa"]) {
    const expected =
      skillId === "plan"
        ? { id: "grok", source: "route" }
        : skillId === "review"
          ? { id: "codex", source: "route" }
          : { id: "claude", source: "default" };
    assert.deepEqual(resolveAdapterId({ config, skillId, taskAdapter: "mimo" }), expected);
  }
  assert.deepEqual(resolveAdapterId({ config, skillId: "verify", taskAdapter: "minimax" }), {
    id: "minimax",
    source: "task",
  });
  assert.deepEqual(resolveAdapterId({ config, skillId: "execute", taskAdapter: "mimo" }), {
    id: "mimo",
    source: "task",
  });
});

test("isResolvedAdapterSpawnable is false when grok args omit {{pointer}} even if PATH would pass", async () => {
  const config = {
    adapter: {
      default: "claude",
      grok: { binary: process.execPath, args: ["--model", "grok-4"] },
    },
  };
  assert.equal(await isResolvedAdapterSpawnable(config, "grok"), false);
  assert.equal(
    await isResolvedAdapterSpawnable(
      {
        adapter: {
          default: "claude",
          grok: { binary: process.execPath, args: ["{{pointer}}"] },
        },
      },
      "grok",
    ),
    true,
  );
});

test("isResolvedAdapterSpawnable is false when resolved generic is missing binary", async () => {
  assert.equal(await isResolvedAdapterSpawnable({ adapter: { default: "generic" } }), false);
  assert.equal(await isResolvedAdapterSpawnable({ adapter: { default: "claude" } }, "generic"), false);
});

test("isResolvedAdapterSpawnable uses default when id is omitted", async () => {
  const previous = process.env[FAKE_ADAPTER_ENV];
  try {
    process.env[FAKE_ADAPTER_ENV] = "fake";
    assert.equal(await isResolvedAdapterSpawnable({ adapter: { default: "fake" } }), true);
  } finally {
    restoreEnv(FAKE_ADAPTER_ENV, previous);
  }
});

test("generic without a binary is not spawnable", async () => {
  const adapter = createAdapter("generic");
  const detected = await adapter.detect();
  assert.equal(detected.ok, false);
  assert.match(detected.reason ?? "", /adapter\.generic\.binary is missing/);
});

test("generic args that omit {{pointer}} are not spawnable and spawn throws", async () => {
  const adapter = createAdapter("generic", {
    generic: { binary: process.execPath, args: ["-p"] },
  });
  const detected = await adapter.detect();
  assert.equal(detected.ok, false);
  assert.match(detected.reason ?? "", /\{\{pointer\}\}/);
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
    (err) => err instanceof AdapterConfigError && /pointer/.test(err.message),
  );
});
