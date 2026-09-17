import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_TOOLS, closeMcpHttp, handleMcpHttp } from "../dist/index.js";
import { copyFixtureProject, withStore, withTempDir } from "./helpers.js";

async function withMcpHttp(dir, fn) {
  const server = createServer((req, res) => {
    void handleMcpHttp({ req, res, projectRoot: dir }).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      res.end("Internal Server Error\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(base);
  } finally {
    await closeMcpHttp(dir);
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function withClient(base, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  const client = new Client({ name: "legion-cli-mcp-http-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("GET /mcp Accept text/event-stream is 200 event-stream not 405", async () => {
  await withTempDir(async (dir) => {
    await withMcpHttp(dir, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        headers: { Accept: "text/event-stream" },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.notEqual(res.status, 405);
      await res.text();
    });
  });
});

test("POST tools/list returns eight names; legion_cli_status JSON has next", async () => {
  await withStore(async ({ dir }) => {
    await withMcpHttp(dir, async (base) => {
      await withClient(base, async (client) => {
        const listed = await client.listTools();
        const names = listed.tools.map((tool) => tool.name).sort();
        assert.deepEqual(names, [...MCP_TOOLS].sort());
        assert.equal(names.length, 8);
        for (const tool of listed.tools) {
          assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
        }
        const status = await client.callTool({ name: "legion_cli_status", arguments: {} });
        const text = status.content?.map((item) => item.text).join("\n") ?? "";
        const json = JSON.parse(text);
        assert.equal(Boolean(status.isError), false, text);
        assert.ok(json.next);
        assert.ok(json.next.run);
      });
    });
  });
});

test("/mcp without token succeeds on loopback GET and POST", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    await withMcpHttp(dir, async (base) => {
      const get = await fetch(`${base}/mcp`, { headers: { Accept: "text/event-stream" } });
      assert.equal(get.status, 200);
      assert.notEqual(get.status, 403);
      await get.text();

      const init = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "loopback", version: "0" },
          },
        }),
      });
      assert.equal(init.status, 200, await init.clone().text());
      assert.notEqual(init.status, 403);
      const session = init.headers.get("mcp-session-id");
      assert.ok(session);
      const listed = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Session-Id": session,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      assert.equal(listed.status, 200, await listed.clone().text());
      assert.notEqual(listed.status, 403);
    });
  });
});
