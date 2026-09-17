import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  MCP_HTTP_MAX_BODY_BYTES,
  MCP_HTTP_RATE_PER_SEC,
  MCP_TOOLS,
  closeMcpHttp,
  handleMcpHttp,
} from "../dist/index.js";
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
    await closeMcpHttp();
    server.closeAllConnections?.();
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

test("unknown Mcp-Session-Id is 404; missing DELETE session is 400; POST body is consumed", async () => {
  await withTempDir(async (dir) => {
    await withMcpHttp(dir, async (base) => {
      const get = await fetch(`${base}/mcp`, {
        headers: { Accept: "text/event-stream", "MCP-Session-Id": "missing-session" },
      });
      assert.equal(get.status, 404);
      const delUnknown = await fetch(`${base}/mcp`, {
        method: "DELETE",
        headers: { "MCP-Session-Id": "missing-session" },
      });
      assert.equal(delUnknown.status, 404);
      const delMissing = await fetch(`${base}/mcp`, { method: "DELETE" });
      assert.equal(delMissing.status, 400);

      const url = new URL(`${base}/mcp`);
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const postUnknown = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: "/mcp",
            method: "POST",
            agent,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "MCP-Session-Id": "missing-session",
            },
          },
          (res) => {
            assert.notEqual((res.headers.connection ?? "").toLowerCase(), "close");
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
      });
      assert.equal(postUnknown, 404);
      const init = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: "/mcp",
            method: "POST",
            agent,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            assert.equal(req.reusedSocket, true);
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "reuse", version: "0" },
            },
          }),
        );
      });
      agent.destroy();
      assert.equal(init, 200);
    });
  });
});

test("MCP POST oversized body (real stream) is 413", async () => {
  await withTempDir(async (dir) => {
    await withMcpHttp(dir, async (base) => {
      const url = new URL(`${base}/mcp`);
      const huge = await new Promise((resolve, reject) => {
        let status;
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "Transfer-Encoding": "chunked",
            },
          },
          (res) => {
            status = res.statusCode;
            res.resume();
            res.on("end", () => resolve(status));
          },
        );
        req.on("error", (err) => {
          if (status === 413) {
            resolve(413);
            return;
          }
          reject(err);
        });
        req.write(Buffer.alloc(MCP_HTTP_MAX_BODY_BYTES + 1, 0x78));
        req.end();
      });
      assert.equal(huge, 413);
    });
  });
});

test("30 MCP calls/sec per connection then 429", async () => {
  await withTempDir(async (dir) => {
    await withMcpHttp(dir, async (base) => {
      const url = new URL(`${base}/mcp`);
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const statuses = [];
      for (let i = 0; i < MCP_HTTP_RATE_PER_SEC + 5; i++) {
        statuses.push(
          await new Promise((resolve, reject) => {
            const req = http.request(
              {
                hostname: url.hostname,
                port: url.port,
                path: "/mcp",
                method: "POST",
                agent,
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json, text/event-stream",
                  "Content-Length": 2,
                },
              },
              (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode));
              },
            );
            req.on("error", reject);
            req.end("{}");
          }),
        );
      }
      agent.destroy();
      assert.ok(statuses.includes(429), `expected 429 in ${statuses.join(",")}`);
    });
  });
});

test("closeMcpHttp ends an open GET SSE so server.close does not hang", async () => {
  await withTempDir(async (dir) => {
    const server = createServer((req, res) => {
      void handleMcpHttp({ req, res, projectRoot: dir });
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
          clientInfo: { name: "hang", version: "0" },
        },
      }),
    });
    assert.equal(init.status, 200, await init.clone().text());
    const session = init.headers.get("mcp-session-id");
    assert.ok(session);
    const sse = fetch(`${base}/mcp`, {
      headers: {
        Accept: "text/event-stream",
        "MCP-Session-Id": session,
        "MCP-Protocol-Version": "2025-03-26",
      },
    });
    const streamed = await sse;
    assert.equal(streamed.status, 200);
    const closed = closeMcpHttp().then(
      () =>
        new Promise((resolve, reject) => {
          server.closeAllConnections?.();
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    );
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("close hung with GET SSE open")), 2000);
      }),
    ]);
  });
});
