import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { MCP_TOOLS } from "@9thlevelsoftware/legion-cli-mcp";

import { bin, normalize, runCli, withTempDir } from "./helpers.js";

const MCP_ACCEPT = "application/json, text/event-stream";

async function mcpRpc(viewer, message, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
  };
  if (sessionId) headers["MCP-Session-Id"] = sessionId;
  const res = await fetch(`${viewer}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, text, json };
}

function startServeCli(args) {
  const child = spawn(process.execPath, [bin, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`serve did not print Viewer url\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15_000);
    const onData = () => {
      const match = /Viewer: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", onData);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (code) {
        clearTimeout(timer);
        reject(new Error(`serve exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
  return { child, url, getStdout: () => stdout, getStderr: () => stderr };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function tokenFromStderr(stderr) {
  const match = /Write token: ([0-9a-f]{64})/.exec(stderr);
  assert.ok(match, `expected write token on stderr\n${stderr}`);
  return match[1];
}

test("serve --no-open --no-mcp-http matches dashboard GET / and optional engine POSTs", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const { child, url, getStderr, getStdout } = startServeCli([
      "serve",
      "--project",
      dir,
      "--no-open",
      "--port",
      "0",
      "--no-mcp-http",
    ]);
    try {
      const viewer = await url;
      const token = tokenFromStderr(getStderr());
      assert.doesNotMatch(getStdout(), new RegExp(token));
      const res = await fetch(viewer);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /source of truth/);
      assert.match(html, /Read-only viewer/);
      assert.match(html, /Checkin/);
      assert.match(html, /Kanban/);
      assert.doesNotMatch(html, /legion-cli-token/);
      assert.equal(html.includes(token), false);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
      assert.equal(res.headers.get("set-cookie"), null);

      const noToken = await fetch(`${viewer}/engine/wikiTrust`, {
        method: "POST",
        headers: { Origin: viewer, "Content-Type": "application/json" },
        body: JSON.stringify({ pageId: "README" }),
      });
      assert.equal(noToken.status, 403);

      const execute = await fetch(`${viewer}/engine/execute`, {
        method: "POST",
        headers: {
          Origin: viewer,
          "Content-Type": "application/json",
          "X-Legion-Cli-Token": token,
        },
        body: JSON.stringify({}),
      });
      assert.equal(execute.status, 404);

      const trust = await fetch(`${viewer}/engine/wikiTrust`, {
        method: "POST",
        headers: {
          Origin: viewer,
          "Content-Type": "application/json",
          "X-Legion-Cli-Token": token,
        },
        body: JSON.stringify({ pageId: "README" }),
      });
      assert.equal(trust.status, 200, await trust.clone().text());
      const body = await trust.json();
      assert.equal(body.ok, true);
      assert.equal(body.trust, "reviewed");

      const mcpGet = await fetch(`${viewer}/mcp`, { headers: { Accept: "text/event-stream" } });
      assert.equal(mcpGet.status, 404);
    } finally {
      await stop(child);
    }
  });
});

test("serve MCP HTTP: GET event-stream, POST tools/list, no-token 200; engine POST still 403", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const { child, url, getStderr, getStdout } = startServeCli(["serve", "--project", dir, "--no-open", "--port", "0"]);
    try {
      const viewer = await url;
      const token = tokenFromStderr(getStderr());
      assert.match(normalize(getStdout()), new RegExp(`MCP HTTP: ${viewer.replaceAll(".", "\\.")}/mcp \\(read-only tools\\)\\.`));

      const htmlRes = await fetch(viewer);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.doesNotMatch(html, /legion-cli-token/);
      assert.equal(html.includes(token), false);

      const getMcp = await fetch(`${viewer}/mcp`, { headers: { Accept: "text/event-stream" } });
      assert.equal(getMcp.status, 200);
      assert.match(getMcp.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.notEqual(getMcp.status, 405);
      assert.notEqual(getMcp.status, 403);
      await getMcp.text();

      const postMcp = await mcpRpc(viewer, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "serve-test", version: "0" },
        },
      });
      assert.equal(postMcp.res.status, 200, postMcp.text);
      assert.notEqual(postMcp.res.status, 403);
      const session = postMcp.res.headers.get("mcp-session-id");
      assert.ok(session);

      const ticket = await fetch(`${viewer}/engine/ticket`, {
        method: "POST",
        headers: { Origin: viewer, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "park extra" }),
      });
      assert.equal(ticket.status, 403);

      const listed = await mcpRpc(
        viewer,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        session,
      );
      assert.equal(listed.res.status, 200, listed.text);
      const names = (listed.json?.result?.tools ?? []).map((tool) => tool.name).sort();
      assert.deepEqual(names, [...MCP_TOOLS].sort());
      assert.equal(names.length, 8);

      const status = await mcpRpc(
        viewer,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "legion_cli_status", arguments: {} },
        },
        session,
      );
      assert.equal(status.res.status, 200, status.text);
      const payload = JSON.parse(status.json?.result?.content?.[0]?.text ?? "{}");
      assert.ok(payload.next);

      const origin = viewer;
      const opt = await fetch(`${viewer}/mcp`, { method: "OPTIONS", headers: { Origin: origin } });
      assert.equal(opt.status, 204);
      assert.match(opt.headers.get("allow") ?? "", /DELETE/);
      assert.match(opt.headers.get("access-control-allow-methods") ?? "", /DELETE/);

      const unknown = await mcpRpc(viewer, { jsonrpc: "2.0", id: 9, method: "tools/list" }, "missing-session");
      assert.equal(unknown.res.status, 404);

      const sse = fetch(`${viewer}/mcp`, {
        headers: {
          Accept: "text/event-stream",
          "MCP-Session-Id": session,
          "MCP-Protocol-Version": "2025-03-26",
        },
      });
      await sse;
    } finally {
      const exited = await Promise.race([
        stop(child).then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 2500)),
      ]);
      assert.equal(exited, true, "serve did not exit after GET SSE");
    }
  });
});

test("serve --expose with MCP HTTP refused", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["serve", "--project", dir, "--no-open", "--port", "0", "--expose"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(normalize(result.stderr), /loopback-only|unauthenticated \/mcp/);
    assert.match(normalize(result.stderr), /Next: legion-cli serve --no-mcp-http --expose/);
  });
});

test("EADDRINUSE Next is legion-cli serve --port <n>", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const { child, url } = startServeCli(["serve", "--project", dir, "--no-open", "--port", "0", "--no-mcp-http"]);
    try {
      const viewer = await url;
      const port = Number(new URL(viewer).port);
      await withTempDir(async (other) => {
        runCli(["init", "--project", other, "--name", "Other", "--adapter", "fake"]);
        const second = runCli(["serve", "--project", other, "--no-open", `--port`, String(port), "--no-mcp-http"]);
        assert.equal(second.status, 1, second.stderr);
        assert.match(normalize(second.stderr), /already in use/);
        assert.match(normalize(second.stderr), new RegExp(`Next: legion-cli serve --port ${port + 1}`));
      });
    } finally {
      await stop(child);
    }
  });
});

test("second serve while pid is live refuses", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const { child, url } = startServeCli(["serve", "--project", dir, "--no-open", "--port", "0", "--no-mcp-http"]);
    try {
      await url;
      const second = runCli(["serve", "--project", dir, "--no-open", "--port", "0", "--no-mcp-http"]);
      assert.equal(second.status, 1, second.stderr);
      assert.match(normalize(second.stderr), /already running/);
      assert.match(normalize(second.stderr), /Next: legion-cli status/);
    } finally {
      await stop(child);
    }
  });
});

test("serve --expose warns and omits token from GET HTML", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const { child, url, getStderr } = startServeCli([
      "serve",
      "--project",
      dir,
      "--no-open",
      "--port",
      "0",
      "--no-mcp-http",
      "--expose",
    ]);
    try {
      const viewer = await url;
      const stderr = normalize(getStderr());
      assert.match(stderr, /0\.0\.0\.0/);
      assert.match(stderr, /not in GET HTML/);
      const token = tokenFromStderr(stderr);
      const res = await fetch(viewer);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.doesNotMatch(html, /legion-cli-token/);
      assert.equal(html.includes(token), false);
    } finally {
      await stop(child);
    }
  });
});

test("status Viewer is a live serve URL only while pid is alive", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const idle = runCli(["status", "--project", dir]);
    assert.equal(idle.status, 0, idle.stderr);
    assert.match(normalize(idle.stdout), /Viewer: legion-cli serve/);
    assert.doesNotMatch(normalize(idle.stdout), /http:\/\/127\.0\.0\.1:7420/);

    const { child, url } = startServeCli(["serve", "--project", dir, "--no-open", "--port", "0", "--no-mcp-http"]);
    try {
      const viewer = await url;
      const live = runCli(["status", "--project", dir]);
      assert.equal(live.status, 0, live.stderr);
      assert.match(normalize(live.stdout), new RegExp(`Viewer: ${viewer.replaceAll(".", "\\.")}  \\(legion-cli serve\\)`));
    } finally {
      await stop(child);
    }

    await mkdir(join(dir, ".legion-cli"), { recursive: true });
    await writeFile(
      join(dir, ".legion-cli", "serve.json"),
      `${JSON.stringify({
        schemaVersion: "legion-cli-serve/v1",
        port: 7420,
        bind: "127.0.0.1",
        mcpPath: "/mcp",
        mcpHttp: true,
        tokenSha256: "a".repeat(64),
        startedAt: new Date().toISOString(),
        pid: 1_000_000_000,
      })}\n`,
    );
    const dead = runCli(["status", "--project", dir]);
    assert.match(normalize(dead.stdout), /Viewer: legion-cli serve/);
    assert.doesNotMatch(normalize(dead.stdout), /http:\/\/127\.0\.0\.1:7420/);
  });
});

test("serve --webmcp serves /webmcp.js with CSP script-src and COOP; no fetch(); no token in HTML", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const configPath = join(dir, ".legion-cli", "config.yaml");
    const before = await readFile(configPath, "utf8");
    const { child, url, getStderr, getStdout } = startServeCli([
      "serve",
      "--project",
      dir,
      "--no-open",
      "--port",
      "0",
      "--no-mcp-http",
      "--webmcp",
    ]);
    try {
      const viewer = await url;
      const token = tokenFromStderr(getStderr());
      assert.match(normalize(getStdout()), /WebMCP: UI-only tools at \/webmcp\.js\./);
      assert.doesNotMatch(getStdout(), new RegExp(token));
      assert.equal(await readFile(configPath, "utf8"), before);

      const board = await fetch(viewer);
      assert.equal(board.status, 200);
      const html = await board.text();
      assert.match(html, /<script src="\/webmcp\.js" defer><\/script>/);
      assert.doesNotMatch(html, /legion-cli-token/);
      assert.equal(html.includes(token), false);
      const csp = board.headers.get("content-security-policy") ?? "";
      assert.match(csp, /script-src 'self'/);
      assert.equal(board.headers.get("cross-origin-opener-policy"), "same-origin");

      const script = await fetch(`${viewer}/webmcp.js`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get("content-type") ?? "", /text\/javascript/);
      assert.match(script.headers.get("content-security-policy") ?? "", /script-src 'self'/);
      assert.equal(script.headers.get("cross-origin-opener-policy"), "same-origin");
      const body = await script.text();
      assert.doesNotMatch(body, /fetch\(/);
      assert.match(body, /filter_board/);
      assert.match(body, /readOnlyHint: true/);
    } finally {
      await stop(child);
    }
  });
});
