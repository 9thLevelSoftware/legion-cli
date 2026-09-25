import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildMcpSpawnEnv,
  closeMcpTransports,
  LegionMcpClientPool,
  MCP_ENV_ALLOWLIST,
  MCP_POOL_MAX,
} from "../dist/index.js";

const PROBE_KEY = "LEGION_MCP_PROBE_SECRET";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-mcp-client-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buildMcpSpawnEnv keeps allowlisted keys and drops host secrets by key name", () => {
  const env = buildMcpSpawnEnv(
    {
      PATH: "/bin",
      [PROBE_KEY]: "not-asserted",
      OPENAI_API_KEY: "not-asserted",
      HOME: "/home/user",
    },
    { DECLARED_TOKEN: "from-config" },
  );
  assert.equal(Object.hasOwn(env, PROBE_KEY), false, "env-key");
  assert.equal(Object.hasOwn(env, "OPENAI_API_KEY"), false, "env-key");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/user");
  assert.equal(env.DECLARED_TOKEN, "from-config");
  assert.ok(MCP_ENV_ALLOWLIST.includes("PATH"));
  assert.equal(MCP_POOL_MAX, 32);
});

test("hostile MCP child does not see a non-allowlisted env key and is not re-spawned", async () => {
  const previous = process.env[PROBE_KEY];
  process.env[PROBE_KEY] = "not-asserted";
  try {
    await withTempDir(async (dir) => {
      const dump = join(dir, "env-keys.txt");
      const counter = join(dir, "spawns.txt");
      const script = join(dir, "dump-env.cjs");
      await writeFile(
        script,
        [
          "const fs = require('fs');",
          "fs.appendFileSync(process.argv[2], 'spawn\\n');",
          "fs.writeFileSync(process.argv[3], Object.keys(process.env).join('\\n'));",
          "process.exit(1);",
        ].join("\n"),
        "utf8",
      );
      const pool = new LegionMcpClientPool({
        probe: {
          command: process.execPath,
          args: [script, counter, dump],
        },
      });
      const first = await pool.callTool("probe:anything", {});
      assert.equal(first?.isError, true);
      assert.equal(first?.reason, "spawn-failed");
      const keys = (await readFile(dump, "utf8")).split(/\r?\n/);
      assert.equal(keys.includes(PROBE_KEY), false, "env-key");
      assert.equal(keys.includes("OPENAI_API_KEY"), false, "env-key");
      const second = await pool.callTool("probe:anything", {});
      assert.equal(second?.isError, true);
      assert.equal(second?.reason, "spawn-failed");
      const spawns = (await readFile(counter, "utf8")).trim().split(/\r?\n/).filter(Boolean);
      assert.equal(spawns.length, 1, "no-respawn");
      await pool.closeAll();
    });
  } finally {
    if (previous === undefined) delete process.env[PROBE_KEY];
    else process.env[PROBE_KEY] = previous;
  }
});

test("unknown MCP server is a typed unknown-server result", async () => {
  const pool = new LegionMcpClientPool({});
  const result = await pool.callTool("missing:tool", {});
  assert.equal(result?.isError, true);
  assert.equal(result?.reason, "unknown-server");
});

test("closeMcpTransports does not swallow close errors", async () => {
  const closer = {
    async close() {
      throw new Error("close-failed");
    },
  };
  await assert.rejects(() => closeMcpTransports([closer]), /close-failed/);
});
