import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  completionsUrl,
  dispatchToolCall,
  HttpAdapter,
  HttpAdapterError,
  httpAdapterNotReadyReason,
  isHttpAdapterReady,
  isRunCommandAllowed,
  RUN_COMMAND_DENIED_BINS,
  toolsForJob,
} from "../dist/index.js";
import { capToolResult, MAX_TOOL_RESULT_CHARS, MAX_TOOL_ROUNDS } from "../dist/tools.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}/v1` });
    });
  });
}

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) });
  res.end(raw);
}

function assistant(content, toolCalls) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content ?? null,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
  };
}

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-http-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("completionsUrl strips a trailing slash then appends /chat/completions", () => {
  assert.equal(completionsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
  assert.equal(completionsUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions");
  assert.equal(completionsUrl("https://api.x.ai/v1"), "https://api.x.ai/v1/chat/completions");
  assert.equal(completionsUrl("https://api.x.ai/v1/"), "https://api.x.ai/v1/chat/completions");
});

test("detect refuses missing config, empty env, and loopback without allowLoopback", () => {
  assert.equal(isHttpAdapterReady(undefined), false);
  assert.match(httpAdapterNotReadyReason(undefined) ?? "", /not configured/);
  const httpsCfg = {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4",
    apiKeyEnv: "OPENAI_API_KEY",
    allowLoopback: false,
  };
  const previous = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    assert.equal(isHttpAdapterReady(httpsCfg), false);
    assert.match(httpAdapterNotReadyReason(httpsCfg) ?? "", /OPENAI_API_KEY/);
    process.env.OPENAI_API_KEY = "sk-test";
    assert.equal(isHttpAdapterReady(httpsCfg), true);
    assert.equal(
      isHttpAdapterReady({
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local",
        apiKeyEnv: "OPENAI_API_KEY",
        allowLoopback: false,
      }),
      false,
    );
    assert.equal(
      isHttpAdapterReady({
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local",
        apiKeyEnv: "OPENAI_API_KEY",
        allowLoopback: true,
      }),
      true,
    );
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("run_command argument policy allows node/pnpm and refuses node -e", () => {
  assert.equal(isRunCommandAllowed(["node", "test.js"]), true);
  assert.equal(isRunCommandAllowed(["pnpm", "test"]), true);
  assert.equal(isRunCommandAllowed(["node", "-e", "1"]), false);
  assert.equal(isRunCommandAllowed(["node", "--eval", "1"]), false);
  assert.equal(isRunCommandAllowed(["node", "-p", "1"]), false);
});

for (const bin of RUN_COMMAND_DENIED_BINS) {
  test(`run_command refuses denied command ${bin}`, () => {
    assert.equal(isRunCommandAllowed([bin]), false);
    assert.equal(isRunCommandAllowed([`${bin}.exe`]), false);
  });
}

test("run_command is absent from the tool list unless the host is hardened", () => {
  const copyHost = {
    jailRoot: "/tmp/jail",
    readFile: async () => "",
    writeFile: async () => undefined,
    listDir: async () => [],
  };
  assert.deepEqual(
    toolsForJob("execute", copyHost).map((tool) => tool.function.name),
    ["read_file", "write_file", "list_dir"],
  );
  const hardened = {
    ...copyHost,
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  assert.deepEqual(
    toolsForJob("execute", hardened).map((tool) => tool.function.name),
    ["read_file", "write_file", "list_dir", "run_command"],
  );
  assert.deepEqual(toolsForJob("chat", hardened), []);
  assert.deepEqual(toolsForJob("execute", undefined), []);
});

test("mock loopback refuses without allowLoopback and succeeds with it", async () => {
  const seen = [];
  const { server, baseUrl } = await startMock(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = await jsonBody(req);
      seen.push({
        authorization: req.headers.authorization,
        apiKey: req.headers["x-api-key"],
        model: body.model,
        tools: (body.tools ?? []).map((tool) => tool.function?.name),
      });
      sendJson(res, 200, assistant("ok"));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const previous = process.env.LEGION_HTTP_TEST_KEY;
  process.env.LEGION_HTTP_TEST_KEY = "sk-test";
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "hello\n", "utf8");
      const job = {
        runId: "run-1",
        skillId: "plan",
        promptPath,
        pointerPrompt: "pointer",
        cwd: dir,
        timeoutMs: 10_000,
        env: { LEGION_HTTP_TEST_KEY: "sk-test" },
      };
      const denied = new HttpAdapter({
        baseUrl,
        model: "local",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: false,
      });
      assert.equal((await denied.detect()).ok, false);
      const deniedResult = await (await denied.spawn(job)).wait();
      assert.equal(deniedResult.exitCode, 1);
      assert.equal(seen.length, 0);

      const allowed = new HttpAdapter({
        baseUrl,
        model: "local",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: true,
      });
      assert.equal((await allowed.detect()).ok, true);
      const allowedHandle = await allowed.spawn(job);
      const allowedResult = await allowedHandle.wait();
      assert.equal(allowedHandle.pid, null);
      assert.equal(allowedResult.exitCode, 0);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].model, "local");
      assert.equal(seen[0].apiKey, undefined);
      assert.match(seen[0].authorization, /^Bearer /);
    });
  } finally {
    if (previous === undefined) delete process.env.LEGION_HTTP_TEST_KEY;
    else process.env.LEGION_HTTP_TEST_KEY = previous;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("mock 302 to same-origin /latest is not followed", async () => {
  let secondHop = 0;
  const { server, port, baseUrl } = await startMock((req, res) => {
    if (req.url === "/latest") {
      secondHop += 1;
      res.writeHead(200);
      res.end("metadata");
      return;
    }
    res.writeHead(302, { Location: `http://127.0.0.1:${port}/latest` });
    res.end();
  });
  process.env.LEGION_HTTP_TEST_KEY = "sk-test";
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "hello\n", "utf8");
      const adapter = new HttpAdapter({
        baseUrl,
        model: "local",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: true,
      });
      const result = await (
        await adapter.spawn({
          runId: "run-302",
          skillId: "plan",
          promptPath,
          pointerPrompt: "pointer",
          cwd: dir,
          timeoutMs: 10_000,
          env: { LEGION_HTTP_TEST_KEY: "sk-test" },
        })
      ).wait();
      assert.equal(result.exitCode, 1);
      const stderr = await readFile(result.stderrPath, "utf8");
      assert.match(stderr, /refused redirect/);
      assert.equal(secondHop, 0);
    });
  } finally {
    delete process.env.LEGION_HTTP_TEST_KEY;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tool results longer than the cap are truncated before the next POST", () => {
  const huge = "x".repeat(MAX_TOOL_RESULT_CHARS + 50);
  const capped = capToolResult(huge);
  assert.equal(capped.length <= MAX_TOOL_RESULT_CHARS + 20, true);
  assert.match(capped, /truncated/);
});

test("write_file to .env is an error; allowed path writes through the host", async () => {
  const { server, baseUrl } = await startMock(async (req, res) => {
    const body = await jsonBody(req);
    const round = (body.messages ?? []).filter((msg) => msg.role === "tool").length;
    if (round === 0) {
      sendJson(
        res,
        200,
        assistant(null, [
          toolCall("c1", "write_file", { path: ".env", contents: "SECRET=1\n" }),
          toolCall("c2", "write_file", { path: ".legion-cli/tasks/TSK-0001.md", contents: "task\n" }),
        ]),
      );
      return;
    }
    sendJson(res, 200, assistant("done"));
  });
  process.env.LEGION_HTTP_TEST_KEY = "sk-test";
  try {
    await withTemp(async (dir) => {
      const jail = join(dir, "jail");
      await mkdir(join(jail, ".legion-cli", "tasks"), { recursive: true });
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "plan\n", "utf8");
      const writes = [];
      const host = {
        jailRoot: jail,
        async readFile() {
          return "";
        },
        async writeFile(posix, contents) {
          if (posix === ".env" || posix.endsWith("/.env") || /(^|\/)\.env(\.|$)/.test(posix)) {
            throw new Error("implicit forbidden: .env");
          }
          if (posix === ".legion-cli/STATE.md" || posix === ".legion-cli/tasks" || posix.startsWith(".legion-cli/tasks/")) {
            throw new Error(`engine-SoT refused: ${posix}`);
          }
          writes.push({ posix, contents });
        },
        async listDir() {
          return [];
        },
      };
      const adapter = new HttpAdapter({
        baseUrl,
        model: "local",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: true,
      });
      const result = await (
        await adapter.spawn({
          runId: "run-tools",
          skillId: "plan",
          promptPath,
          pointerPrompt: "pointer",
          cwd: dir,
          timeoutMs: 10_000,
          env: { LEGION_HTTP_TEST_KEY: "sk-test" },
          httpHost: host,
        })
      ).wait();
      assert.equal(result.exitCode, 0);
      assert.equal(writes.length, 0);
    });
  } finally {
    delete process.env.LEGION_HTTP_TEST_KEY;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("unknown tool name does not retry-storm past max rounds", async () => {
  let posts = 0;
  const { server, baseUrl } = await startMock(async (req, res) => {
    posts += 1;
    await jsonBody(req);
    sendJson(res, 200, assistant(null, [toolCall("c1", "pwned", { path: "x" })]));
  });
  process.env.LEGION_HTTP_TEST_KEY = "sk-test";
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "hello\n", "utf8");
      const adapter = new HttpAdapter({
        baseUrl,
        model: "local",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: true,
      });
      const result = await (
        await adapter.spawn({
          runId: "run-unknown",
          skillId: "execute",
          promptPath,
          pointerPrompt: "pointer",
          cwd: dir,
          timeoutMs: 20_000,
          env: { LEGION_HTTP_TEST_KEY: "sk-test" },
          httpHost: {
            jailRoot: dir,
            readFile: async () => "",
            writeFile: async () => undefined,
            listDir: async () => [],
          },
        })
      ).wait();
      assert.equal(result.exitCode, 1);
      assert.equal(posts, MAX_TOOL_ROUNDS);
    });
  } finally {
    delete process.env.LEGION_HTTP_TEST_KEY;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("abort() resolves wait with aborted true and pid stays null", async () => {
  const { server, baseUrl } = await startMock((_req, _res) => {
    // hang until the client aborts
  });
  process.env.LEGION_HTTP_TEST_KEY = "sk-test";
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "hello\n", "utf8");
      const adapter = new HttpAdapter({
        baseUrl,
        model: "local",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: true,
      });
      const handle = await adapter.spawn({
        runId: "run-abort",
        skillId: "plan",
        promptPath,
        pointerPrompt: "pointer",
        cwd: dir,
        timeoutMs: 20_000,
        env: { LEGION_HTTP_TEST_KEY: "sk-test" },
      });
      assert.equal(handle.pid, null);
      const waiting = handle.wait();
      await handle.abort();
      const result = await waiting;
      assert.equal(result.aborted, true);
      assert.equal(result.exitCode, null);
    });
  } finally {
    delete process.env.LEGION_HTTP_TEST_KEY;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HttpAdapterError name is stable", () => {
  const err = new HttpAdapterError("nope");
  assert.equal(err.name, "HttpAdapterError");
});

function copyHost() {
  return {
    jailRoot: "/tmp/jail",
    readFile: async () => "",
    writeFile: async () => undefined,
    listDir: async () => [],
  };
}

test("dispatchToolCall refuses each denied run_command argv", async () => {
  let ran = 0;
  const host = {
    ...copyHost(),
    runCommand: async () => {
      ran += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  for (const bin of RUN_COMMAND_DENIED_BINS) {
    const out = await dispatchToolCall(
      { id: "c1", type: "function", function: { name: "run_command", arguments: JSON.stringify({ argv: [bin] }) } },
      host,
      "execute",
    );
    assert.match(out, /not allowlisted/, bin);
  }
  assert.equal(ran, 0);
});

test("dispatchToolCall refuses node -e past the argument policy", async () => {
  let ran = 0;
  const host = {
    ...copyHost(),
    runCommand: async () => {
      ran += 1;
      return { exitCode: 0, stdout: "pwned", stderr: "" };
    },
  };
  const out = await dispatchToolCall(
    {
      id: "c1",
      type: "function",
      function: { name: "run_command", arguments: JSON.stringify({ argv: ["node", "-e", "process.exit(0)"] }) },
    },
    host,
    "execute",
  );
  assert.match(out, /not allowlisted/);
  assert.equal(ran, 0);
});

test("copy-jail host does not offer run_command through the tool router", async () => {
  const host = copyHost();
  assert.equal(host.runCommand, undefined);
  const out = await dispatchToolCall(
    {
      id: "c1",
      type: "function",
      function: { name: "run_command", arguments: JSON.stringify({ argv: ["node", "test.js"] }) },
    },
    host,
    "execute",
  );
  assert.match(out, /unknown tool run_command/);
});

test("tool router is the only path from adapter to host tools", async () => {
  const src = await readFile(join(pkgRoot, "src", "adapter.ts"), "utf8");
  assert.match(src, /await dispatchToolCall\(call, job\.httpHost, job\.skillId\)/);
  const runFn = src.slice(src.indexOf("async #run"));
  assert.doesNotMatch(runFn, /httpHost\.writeFile/);
  assert.doesNotMatch(runFn, /httpHost\.runCommand/);
  assert.doesNotMatch(runFn, /host\.writeFile/);
  assert.doesNotMatch(runFn, /host\.runCommand/);
});

test("adapter tool round-trip writes an allowed path through dispatchToolCall", async () => {
  const toolResults = [];
  const { server, baseUrl } = await startMock(async (req, res) => {
    const body = await jsonBody(req);
    const round = (body.messages ?? []).filter((msg) => msg.role === "tool").length;
    if (round === 0) {
      sendJson(res, 200, assistant(null, [toolCall("c1", "write_file", { path: "src/ok.ts", contents: "ok\n" })]));
      return;
    }
    for (const msg of body.messages ?? []) {
      if (msg.role === "tool") toolResults.push(msg.content);
    }
    sendJson(res, 200, assistant("wrote src/ok.ts"));
  });
  process.env.LEGION_HTTP_TEST_KEY = "sk-test";
  try {
    await withTemp(async (dir) => {
      const writes = [];
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "write ok\n", "utf8");
      const host = {
        jailRoot: dir,
        readFile: async () => "",
        async writeFile(posix, contents) {
          writes.push({ posix, contents });
        },
        listDir: async () => [],
      };
      const adapter = new HttpAdapter({
        baseUrl,
        model: "local",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: true,
      });
      const result = await (
        await adapter.spawn({
          runId: "run-roundtrip",
          skillId: "execute",
          promptPath,
          pointerPrompt: "pointer",
          cwd: dir,
          timeoutMs: 10_000,
          env: { LEGION_HTTP_TEST_KEY: "sk-test" },
          httpHost: host,
        })
      ).wait();
      assert.equal(result.exitCode, 0);
      assert.deepEqual(writes, [{ posix: "src/ok.ts", contents: "ok\n" }]);
      assert.deepEqual(toolResults, ["ok"]);
      const summary = await readFile(result.summaryPath, "utf8");
      assert.match(summary, /wrote src\/ok\.ts/);
    });
  } finally {
    delete process.env.LEGION_HTTP_TEST_KEY;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
