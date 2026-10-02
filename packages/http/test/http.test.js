import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertCompatibleCheckpoint,
  checkpointPath,
  completionsUrl,
  dispatchToolCall,
  HttpAdapter,
  HttpAdapterError,
  httpAdapterNotReadyReason,
  isHttpAdapterReady,
  isRunCommandAllowed,
  RUN_COMMAND_DENIED_BINS,
  parseAssistantResponse,
  readHttpCheckpoint,
  recoverPendingToolOutcome,
  restoreCompletedToolMessages,
  toolCallSignature,
  sha256Text,
  stableHash,
  writeHttpCheckpoint,
  toolsForJob,
} from "../dist/index.js";
import { capToolResult, MAX_TOOL_RESULT_CHARS } from "../dist/tools.js";

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

test("run_command argument policy refuses clustered eval flags", () => {
  assert.equal(isRunCommandAllowed(["node", "-pe", "1"]), false);
  assert.equal(isRunCommandAllowed(["node", "-ep", "1"]), false);
  assert.equal(isRunCommandAllowed(["python", "-ic", "print(1)"]), false);
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
      assert.equal(posts, 1, "invalid provider tool names fail before another request");
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

test("governed external tools are default-denied and only explicitly advertised calls dispatch", async () => {
  let called;
  const baseHost = {
    jailRoot: "/tmp/jail",
    async readFile() { return ""; },
    async writeFile() {},
    async listDir() { return []; },
  };
  assert.equal(toolsForJob("execute", baseHost).some((tool) => tool.function.name.startsWith("mcp_")), false);
  const externalHost = {
    ...baseHost,
    externalTools: [{
      callName: "mcp_fixture_read",
      namespacedName: "fixture:read",
      description: "Fixture read",
      inputSchema: { type: "object", properties: { key: { type: "string" } } },
    }],
    async callExternalTool(name, args) {
      called = { name, args };
      return "external-result";
    },
  };
  assert.equal(
    toolsForJob("execute", externalHost).some((tool) => tool.function.name === "mcp_fixture_read"),
    true,
  );
  assert.equal(
    await dispatchToolCall(toolCall("external", "mcp_fixture_read", { key: "value" }), externalHost, "execute"),
    "external-result",
  );
  assert.deepEqual(called, { name: "mcp_fixture_read", args: { key: "value" } });
});

test("external MCP arguments are schema-validated before checkpointing or dispatch", async () => {
  let posts = 0;
  let calls = 0;
  const { server, baseUrl } = await startMock(async (req, res) => {
    await jsonBody(req);
    posts += 1;
    sendJson(res, 200, assistant(null, [toolCall(`invalid-${posts}`, "mcp_fixture_read", posts === 1 ? {} : { key: 42 })]));
  });
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "validate external args\n", "utf8");
      const adapter = new HttpAdapter({ baseUrl, model: "fixture-model", apiKeyEnv: "KEY", allowLoopback: true });
      const host = {
        jailRoot: dir,
        async readFile() { return ""; },
        async writeFile() {},
        async listDir() { return []; },
        externalTools: [{
          callName: "mcp_fixture_read",
          namespacedName: "fixture:read",
          inputSchema: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
            additionalProperties: false,
          },
        }],
        async callExternalTool() { calls += 1; return "unexpected"; },
      };
      for (const runId of ["invalid-missing", "invalid-type"]) {
        const result = await (await adapter.spawn({
          runId,
          skillId: "execute",
          promptPath,
          pointerPrompt: "pointer",
          cwd: dir,
          checkpointRoot: dir,
          timeoutMs: 10_000,
          env: { KEY: "secret" },
          httpHost: host,
        })).wait();
        assert.equal(result.exitCode, 1);
        assert.match(await readFile(result.stderrPath, "utf8"), /invalid tool arguments for mcp_fixture_read/);
        assert.deepEqual((await readHttpCheckpoint(result.checkpointPath)).toolOutcomes, []);
      }
      assert.equal(calls, 0);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("assistant response validation rejects malformed, provider-error, duplicate, and incomplete responses", () => {
  const bad = [
    {},
    { error: { message: "quota exhausted" } },
    { choices: [{ finish_reason: "stop", message: { role: "assistant", content: null } }] },
    {
      choices: [{ finish_reason: "mystery", message: { role: "assistant", content: "looks complete" } }],
    },
    {
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            toolCall("same", "read_file", { path: "a" }),
            toolCall("same", "read_file", { path: "b" }),
          ],
        },
      }],
    },
    {
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "[]" } }],
        },
      }],
    },
  ];
  for (const value of bad) {
    assert.throws(() => parseAssistantResponse(value), HttpAdapterError);
  }
});

test("checkpoint reader rejects malformed resumable state", async () => {
  await withTemp(async (dir) => {
    const path = join(dir, "checkpoint.json");
    const base = {
      version: 1,
      runId: "run-1",
      identities: {
        promptHash: "p",
        configHash: "c",
        contractHash: "k",
        sourceIdentity: "s",
        jailIdentity: "j",
      },
      conversation: [],
      round: 0,
      toolOutcomes: [],
      usage: { requests: 0, toolCalls: 0, model: "fixture" },
      completion: { status: "running" },
      updatedAt: new Date().toISOString(),
    };
    const malformed = [
      { ...base, runId: "" },
      { ...base, round: -1 },
      { ...base, usage: { ...base.usage, requests: -1 } },
      { ...base, completion: { status: "surprise" } },
      { ...base, toolOutcomes: [{ id: "x", signature: "bad", name: "read_file", arguments: "{}", status: "maybe" }] },
    ];
    for (const value of malformed) {
      await writeFile(path, JSON.stringify(value), "utf8");
      await assert.rejects(() => readHttpCheckpoint(path), /checkpoint is malformed/);
    }
  });
});

test("resume restores a persisted completed tool result into conversation without replay", () => {
  const call = toolCall("done-1", "read_file", { path: "src/a.ts" });
  const checkpoint = {
    conversation: [
      { role: "user", content: "read it" },
      { role: "assistant", content: null, tool_calls: [call] },
    ],
    toolOutcomes: [{
      id: call.id,
      signature: toolCallSignature(call),
      name: call.function.name,
      arguments: call.function.arguments,
      status: "completed",
      result: "contents",
    }],
  };
  const changed = restoreCompletedToolMessages(checkpoint);
  assert.equal(changed, true);
  assert.deepEqual(checkpoint.conversation.at(-1), {
    role: "tool",
    tool_call_id: "done-1",
    content: "contents",
  });
  assert.equal(restoreCompletedToolMessages(checkpoint), false, "idempotent and never replays");
});

test("assistant response validation accepts multiple unique valid calls and usage", () => {
  const parsed = parseAssistantResponse({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          toolCall("r1", "read_file", { path: "src/a.ts" }),
          toolCall("r2", "list_dir", { path: "src" }),
        ],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  });
  assert.equal(parsed.toolCalls.length, 2);
  assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
});

test("assistant response validation requires tool_calls finish reason and consistent integer usage", () => {
  const call = { id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } };
  for (const finish_reason of [undefined, "", "stop"]) {
    assert.throws(
      () => parseAssistantResponse({ choices: [{ finish_reason, message: { role: "assistant", content: null, tool_calls: [call] } }] }),
      /require finish_reason=tool_calls/,
    );
  }
  assert.throws(
    () => parseAssistantResponse({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: "bad", total_tokens: 1 } }),
    /usage\.prompt_tokens/,
  );
  assert.throws(
    () => parseAssistantResponse({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 9 } }),
    /inconsistent/,
  );
});

test("checkpoint compatibility binds prompt, config, contract, source, and jail", () => {
  const checkpoint = {
    version: 1,
    runId: "run-1",
    identities: {
      promptHash: "p",
      configHash: "c",
      contractHash: "k",
      sourceIdentity: "s",
      jailIdentity: "j",
    },
  };
  assert.doesNotThrow(() => assertCompatibleCheckpoint(checkpoint, checkpoint.identities));
  for (const key of Object.keys(checkpoint.identities)) {
    assert.throws(
      () => assertCompatibleCheckpoint(checkpoint, { ...checkpoint.identities, [key]: `${key}-changed` }),
      /checkpoint .* mismatch/,
    );
  }
});

test("pending write recovery reconciles expected content and blocks uncertain commands", async () => {
  let writes = 0;
  const host = {
    ...copyHost(),
    readFile: async () => "already written\n",
    writeFile: async () => { writes += 1; },
  };
  const write = {
    id: "w1",
    name: "write_file",
    arguments: JSON.stringify({ path: "src/a.ts", contents: "already written\n" }),
    status: "pending",
  };
  write.signature = toolCallSignature({
    id: write.id,
    type: "function",
    function: { name: write.name, arguments: write.arguments },
  });
  const reconciled = await recoverPendingToolOutcome(write, host, "execute");
  assert.equal(reconciled.status, "completed");
  assert.equal(reconciled.result, "ok (reconciled)");
  assert.equal(writes, 0);

  await assert.rejects(
    () => {
      const command = { ...write, id: "x1", name: "run_command", arguments: '{"argv":["node","x.js"]}' };
      command.signature = toolCallSignature({
        id: command.id,
        type: "function",
        function: { name: command.name, arguments: command.arguments },
      });
      return recoverPendingToolOutcome(command, host, "execute");
    },
    /outcome is uncertain/,
  );
});

test("completed checkpoint resumes without replay and excludes the API key", async () => {
  let posts = 0;
  const { server, baseUrl } = await startMock(async (req, res) => {
    posts += 1;
    await jsonBody(req);
    sendJson(res, 200, {
      ...assistant("complete"),
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  });
  process.env.LEGION_HTTP_TEST_KEY = "checkpoint-secret";
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "checkpoint me\n", "utf8");
      const adapter = new HttpAdapter({
        baseUrl,
        model: "fixture-model",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: true,
      });
      const identities = {
        sourceIdentity: "source-abc",
        contractIdentity: "contract-abc",
        jailIdentity: "jail-abc",
      };
      const job = {
        runId: "run-checkpoint",
        skillId: "plan",
        promptPath,
        pointerPrompt: "pointer",
        cwd: dir,
        timeoutMs: 10_000,
        env: { LEGION_HTTP_TEST_KEY: "checkpoint-secret" },
        ...identities,
      };
      const first = await (await adapter.spawn(job)).wait();
      assert.equal(first.exitCode, 0);
      assert.deepEqual(first.usage, {
        requests: 1,
        toolCalls: 0,
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        model: "fixture-model",
        estimatedCostUsd: undefined,
        costEstimated: false,
      });
      const checkpointRaw = await readFile(first.checkpointPath, "utf8");
      assert.equal(checkpointRaw.includes("checkpoint-secret"), false);

      const resumed = await (await adapter.spawn({ ...job, resume: true })).wait();
      assert.equal(resumed.exitCode, 0);
      assert.equal(posts, 1, "completed provider request was not replayed");
      assert.equal(await readFile(resumed.summaryPath, "utf8"), "complete\n");
    });
  } finally {
    delete process.env.LEGION_HTTP_TEST_KEY;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("resume blocks an uncertain provider request before or after an uncheckpointed response", async (t) => {
  for (const boundary of ["post-before-response", "response-before-assistant-checkpoint"]) {
    await t.test(boundary, async () => {
      await withTemp(async (dir) => {
        const prompt = "uncertain request\n";
        const promptPath = join(dir, "prompt.md");
        await writeFile(promptPath, prompt, "utf8");
        const config = { baseUrl: "https://example.test/v1", model: "fixture-model", apiKeyEnv: "LEGION_HTTP_TEST_KEY" };
        const runId = `run-${boundary}`;
        const sourceIdentity = "source-uncertain";
        const contractIdentity = "contract-uncertain";
        const jailIdentity = "jail-uncertain";
        const body = { model: config.model, messages: [{ role: "user", content: prompt }] };
        await writeHttpCheckpoint(checkpointPath(dir, runId), {
          version: 1,
          runId,
          identities: {
            promptHash: sha256Text(prompt),
            configHash: stableHash({ ...config, allowLoopback: undefined, headers: {} }),
            contractHash: contractIdentity,
            sourceIdentity,
            jailIdentity,
          },
          conversation: body.messages,
          round: 0,
          request: { status: "dispatching", round: 1, requestHash: stableHash(body) },
          toolOutcomes: [],
          usage: { requests: 0, toolCalls: 0, model: config.model },
          completion: { status: "running" },
          updatedAt: new Date().toISOString(),
        });
        const result = await (await new HttpAdapter(config).spawn({
          runId,
          skillId: "execute",
          promptPath,
          pointerPrompt: "pointer",
          cwd: dir,
          checkpointRoot: dir,
          timeoutMs: 10_000,
          env: { LEGION_HTTP_TEST_KEY: "fixture-secret" },
          resume: true,
          sourceIdentity,
          contractIdentity,
          jailIdentity,
        })).wait();
        assert.equal(result.exitCode, 1);
        assert.match(await readFile(result.stderrPath, "utf8"), /outcome is uncertain/);
      });
    });
  }
});

test("reported token threshold checkpoints usage and refuses tool dispatch or provider replay at the exact cap", async () => {
  let posts = 0;
  let toolReads = 0;
  const { server, baseUrl } = await startMock(async (req, res) => {
    posts += 1;
    const body = await jsonBody(req);
    assert.equal(body.max_tokens, 16);
    sendJson(res, 200, {
      ...assistant(null, [toolCall("at-cap", "read_file", { path: "README.md" })]),
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  });
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "cap request\n", "utf8");
      const config = { baseUrl, model: "fixture-model", apiKeyEnv: "LEGION_HTTP_TEST_KEY", allowLoopback: true };
      const identities = { sourceIdentity: "source-cap", contractIdentity: "contract-cap", jailIdentity: "jail-cap" };
      const job = {
        runId: "run-exact-cap",
        skillId: "execute",
        promptPath,
        pointerPrompt: "pointer",
        cwd: dir,
        checkpointRoot: dir,
        timeoutMs: 10_000,
        env: { LEGION_HTTP_TEST_KEY: "fixture-secret" },
        ...identities,
        outputLimit: 16,
        maxReportedTokens: 5,
        httpHost: {
          jailRoot: dir,
          async readFile() { toolReads += 1; return "should not run"; },
          async writeFile() {},
          async listDir() { return []; },
        },
      };
      const adapter = new HttpAdapter(config);
      const first = await (await adapter.spawn(job)).wait();
      assert.equal(first.exitCode, 1);
      assert.equal(toolReads, 0);
      const saved = await readHttpCheckpoint(first.checkpointPath);
      assert.equal(saved.round, 1);
      assert.equal(saved.request, undefined);
      assert.equal(saved.usage.totalTokens, 5);

      const resumed = await (await adapter.spawn({ ...job, resume: true })).wait();
      assert.equal(resumed.exitCode, 1);
      assert.equal(posts, 1);
      assert.equal(toolReads, 0);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a terminal response at the exact reported-token cap succeeds while an over-cap response fails", async () => {
  let responseTokens = 5;
  const { server, baseUrl } = await startMock(async (req, res) => {
    await jsonBody(req);
    sendJson(res, 200, {
      ...assistant("complete at the boundary"),
      usage: { prompt_tokens: responseTokens - 1, completion_tokens: 1, total_tokens: responseTokens },
    });
  });
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "terminal cap\n", "utf8");
      const adapter = new HttpAdapter({
        baseUrl,
        model: "fixture-model",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: true,
      });
      const baseJob = {
        skillId: "execute",
        promptPath,
        pointerPrompt: "pointer",
        cwd: dir,
        checkpointRoot: dir,
        timeoutMs: 10_000,
        env: { LEGION_HTTP_TEST_KEY: "fixture-secret" },
        maxReportedTokens: 5,
      };
      const exact = await (await adapter.spawn({ ...baseJob, runId: "run-terminal-exact" })).wait();
      assert.equal(exact.exitCode, 0);
      assert.equal(exact.usage.totalTokens, 5);

      responseTokens = 6;
      const over = await (await adapter.spawn({ ...baseJob, runId: "run-terminal-over" })).wait();
      assert.equal(over.exitCode, 1);
      assert.match(await readFile(over.stderrPath, "utf8"), /reported token limit 5/);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("split token usage derives total tokens before enforcing the reported-token cap", () => {
  const parsed = parseAssistantResponse({
    ...assistant("done"),
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  });
  assert.deepEqual(parsed.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
});

test("cost thresholds fail closed for total-only usage or incomplete operator pricing", async () => {
  let posts = 0;
  const { server, baseUrl } = await startMock(async (req, res) => {
    await jsonBody(req);
    posts += 1;
    sendJson(res, 200, posts === 1
      ? { ...assistant("total only"), usage: { total_tokens: 5 } }
      : { ...assistant("split"), usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  });
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "cost cap\n", "utf8");
      const adapter = new HttpAdapter({ baseUrl, model: "fixture-model", apiKeyEnv: "KEY", allowLoopback: true });
      const baseJob = {
        skillId: "execute",
        promptPath,
        pointerPrompt: "pointer",
        cwd: dir,
        checkpointRoot: dir,
        timeoutMs: 10_000,
        env: { KEY: "secret" },
        maxEstimatedCostUsd: 1,
      };
      const totalOnly = await (await adapter.spawn({
        ...baseJob,
        runId: "cost-total-only",
        pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1, requestUsd: 0 },
      })).wait();
      assert.equal(totalOnly.exitCode, 1);
      assert.equal(totalOnly.usage.estimatedCostUsd, undefined);
      assert.equal(totalOnly.usage.costEstimated, false);
      assert.match(await readFile(totalOnly.stderrPath, "utf8"), /cannot enforce estimated cost limit/);

      const incompletePricing = await (await adapter.spawn({
        ...baseJob,
        runId: "cost-incomplete-pricing",
        pricing: { inputPerMillionUsd: 1, requestUsd: 0 },
      })).wait();
      assert.equal(incompletePricing.exitCode, 1);
      assert.equal(incompletePricing.usage.estimatedCostUsd, undefined);
      assert.equal(incompletePricing.usage.costEstimated, false);
      assert.match(await readFile(incompletePricing.stderrPath, "utf8"), /cannot enforce estimated cost limit/);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a later complete usage round cannot make an earlier unpriced round cost-complete", async () => {
  let posts = 0;
  const { server, baseUrl } = await startMock(async (req, res) => {
    await jsonBody(req);
    posts += 1;
    sendJson(res, 200, posts === 1
      ? {
          ...assistant(null, [toolCall("mixed-read", "read_file", { path: "README.md" })]),
          usage: { total_tokens: 5 },
        }
      : {
          ...assistant("mixed usage complete"),
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
  });
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "mixed cost usage\n", "utf8");
      const result = await (await new HttpAdapter({
        baseUrl,
        model: "fixture-model",
        apiKeyEnv: "KEY",
        allowLoopback: true,
      }).spawn({
        runId: "mixed-cost-usage",
        skillId: "execute",
        promptPath,
        pointerPrompt: "pointer",
        cwd: dir,
        checkpointRoot: dir,
        timeoutMs: 10_000,
        env: { KEY: "secret" },
        pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1, requestUsd: 0 },
        httpHost: {
          jailRoot: dir,
          async readFile() { return "contents"; },
          async writeFile() {},
          async listDir() { return []; },
        },
      })).wait();
      assert.equal(result.exitCode, 0);
      assert.equal(result.usage.totalTokens, 10);
      assert.equal(result.usage.estimatedCostUsd, undefined);
      assert.equal(result.usage.costEstimated, false);
      const saved = await readHttpCheckpoint(result.checkpointPath);
      assert.equal(saved.usageAccounting.costIncomplete, true);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("prompt-only usage counts as a lower bound and fails closed before tool continuation", async () => {
  let reads = 0;
  const { server, baseUrl } = await startMock(async (req, res) => {
    await jsonBody(req);
    sendJson(res, 200, {
      ...assistant(null, [toolCall("partial-read", "read_file", { path: "README.md" })]),
      usage: { prompt_tokens: 3 },
    });
  });
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "partial usage\n", "utf8");
      const result = await (await new HttpAdapter({
        baseUrl,
        model: "fixture-model",
        apiKeyEnv: "KEY",
        allowLoopback: true,
      }).spawn({
        runId: "partial-token-usage",
        skillId: "execute",
        promptPath,
        pointerPrompt: "pointer",
        cwd: dir,
        checkpointRoot: dir,
        timeoutMs: 10_000,
        env: { KEY: "secret" },
        maxReportedTokens: 5,
        httpHost: {
          jailRoot: dir,
          async readFile() { reads += 1; return "unexpected"; },
          async writeFile() {},
          async listDir() { return []; },
        },
      })).wait();
      assert.equal(result.exitCode, 1);
      assert.equal(result.usage.totalTokens, undefined);
      assert.equal(reads, 0);
      assert.match(await readFile(result.stderrPath, "utf8"), /cannot enforce reported token limit/);
      assert.equal((await readHttpCheckpoint(result.checkpointPath)).usageAccounting.tokenLowerBound, 3);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a provider cannot reuse a tool call id in a later round even with the same signature", async () => {
  let posts = 0;
  let reads = 0;
  const repeated = toolCall("reused-id", "read_file", { path: "README.md" });
  const { server, baseUrl } = await startMock(async (req, res) => {
    posts += 1;
    await jsonBody(req);
    sendJson(res, 200, assistant(null, [repeated]));
  });
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "duplicate id\n", "utf8");
      const result = await (await new HttpAdapter({
        baseUrl,
        model: "fixture-model",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: true,
      }).spawn({
        runId: "run-duplicate-cross-round",
        skillId: "execute",
        promptPath,
        pointerPrompt: "pointer",
        cwd: dir,
        checkpointRoot: dir,
        timeoutMs: 10_000,
        env: { LEGION_HTTP_TEST_KEY: "fixture-secret" },
        httpHost: {
          jailRoot: dir,
          async readFile() { reads += 1; return "content"; },
          async writeFile() {},
          async listDir() { return []; },
        },
      })).wait();
      assert.equal(result.exitCode, 1);
      assert.equal(posts, 2);
      assert.equal(reads, 1);
      assert.match(await readFile(result.stderrPath, "utf8"), /duplicate tool call id reused-id/);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an uncertain external MCP tool call is never replayed during recovery", async () => {
  let calls = 0;
  const call = toolCall("external-1", "mcp_fixture_read", { key: "value" });
  const host = {
    jailRoot: "/tmp/jail",
    async readFile() { return ""; },
    async writeFile() {},
    async listDir() { return []; },
    externalTools: [{
      callName: "mcp_fixture_read",
      namespacedName: "fixture:read",
      inputSchema: { type: "object" },
    }],
    async callExternalTool() { calls += 1; return "result"; },
  };
  await assert.rejects(
    recoverPendingToolOutcome({
      id: call.id,
      signature: toolCallSignature(call),
      name: call.function.name,
      arguments: call.function.arguments,
      status: "pending",
    }, host, "execute"),
    /outcome is uncertain/,
  );
  assert.equal(calls, 0);
});

test("aborting an in-flight external tool keeps its checkpoint pending and resume does not replay it", async () => {
  let posts = 0;
  const { server, baseUrl } = await startMock(async (req, res) => {
    posts += 1;
    await jsonBody(req);
    sendJson(res, 200, assistant(null, [toolCall("external-abort", "mcp_fixture_read", { key: "value" })]));
  });
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "cancel external tool\n", "utf8");
      let calls = 0;
      let seenSignal;
      let markStarted;
      const started = new Promise((resolve) => { markStarted = resolve; });
      const host = {
        jailRoot: dir,
        async readFile() { return ""; },
        async writeFile() {},
        async listDir() { return []; },
        externalTools: [{
          callName: "mcp_fixture_read",
          namespacedName: "fixture:read",
          inputSchema: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
            additionalProperties: false,
          },
        }],
        async callExternalTool(_name, _args, signal) {
          calls += 1;
          seenSignal = signal;
          markStarted();
          return new Promise((resolve, reject) => {
            const onAbort = () => reject(signal.reason ?? new Error("aborted"));
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
        },
      };
      const adapter = new HttpAdapter({ baseUrl, model: "fixture-model", apiKeyEnv: "KEY", allowLoopback: true });
      const job = {
        runId: "run-abort-external",
        skillId: "execute",
        promptPath,
        pointerPrompt: "pointer",
        cwd: dir,
        checkpointRoot: dir,
        timeoutMs: 10_000,
        env: { KEY: "fixture-secret" },
        sourceIdentity: "source-abort",
        contractIdentity: "contract-abort",
        externalConfigIdentity: "external-abort",
        jailIdentity: "jail-abort",
        httpHost: host,
      };
      const handle = await adapter.spawn(job);
      const resultPromise = handle.wait();
      await started;
      await handle.abort();
      const interrupted = await resultPromise;
      assert.equal(interrupted.aborted, true);
      assert.equal(interrupted.recovery, "manual");
      assert.equal(seenSignal?.aborted, true);
      assert.equal(calls, 1);
      const pending = await readHttpCheckpoint(interrupted.checkpointPath);
      assert.deepEqual(pending.toolOutcomes.map((outcome) => outcome.status), ["pending"]);

      const resumed = await (await adapter.spawn({ ...job, resume: true })).wait();
      assert.equal(resumed.exitCode, 1);
      assert.equal(resumed.recovery, "manual");
      assert.equal(calls, 1, "uncertain external outcome is not replayed");
      assert.equal(posts, 1, "resume fails before another provider request");
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("resume repairs a multi-call crash in call order and retries only the safe unread call", async () => {
  let posts = 0;
  const { server, baseUrl } = await startMock(async (req, res) => {
    posts += 1;
    const body = await jsonBody(req);
    const toolMessages = body.messages.filter((message) => message.role === "tool");
    assert.deepEqual(toolMessages.map((message) => message.tool_call_id), ["cached", "missing"]);
    assert.deepEqual(toolMessages.map((message) => message.content), ["cached result", "fresh result"]);
    sendJson(res, 200, assistant("resumed complete"));
  });
  process.env.LEGION_HTTP_TEST_KEY = "resume-secret";
  try {
    await withTemp(async (dir) => {
      const prompt = "resume two calls\n";
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, prompt, "utf8");
      const config = {
        baseUrl,
        model: "fixture-model",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: true,
      };
      const first = toolCall("cached", "read_file", { path: "src/cached.ts" });
      const second = toolCall("missing", "read_file", { path: "src/missing.ts" });
      const sourceIdentity = "source-two";
      const contractIdentity = "contract-two";
      const jailIdentity = "jail-two";
      const runId = "run-two-call-crash";
      await writeHttpCheckpoint(checkpointPath(dir, runId), {
        version: 1,
        runId,
        identities: {
          promptHash: sha256Text(prompt),
          configHash: stableHash({ ...config, headers: {} }),
          contractHash: contractIdentity,
          sourceIdentity,
          jailIdentity,
        },
        conversation: [
          { role: "user", content: prompt },
          { role: "assistant", content: null, tool_calls: [first, second] },
        ],
        round: 1,
        toolOutcomes: [{
          id: first.id,
          signature: toolCallSignature(first),
          name: first.function.name,
          arguments: first.function.arguments,
          status: "completed",
          result: "cached result",
        }],
        usage: { requests: 1, toolCalls: 1, model: config.model },
        completion: { status: "running" },
        updatedAt: new Date().toISOString(),
      });
      const reads = [];
      const result = await (await new HttpAdapter(config).spawn({
        runId,
        skillId: "execute",
        promptPath,
        pointerPrompt: "pointer",
        cwd: dir,
        checkpointRoot: dir,
        timeoutMs: 10_000,
        env: { LEGION_HTTP_TEST_KEY: "resume-secret" },
        resume: true,
        sourceIdentity,
        contractIdentity,
        jailIdentity,
        httpHost: {
          jailRoot: dir,
          async readFile(path) {
            reads.push(path);
            return "fresh result";
          },
          async writeFile() {},
          async listDir() { return []; },
        },
      })).wait();
      assert.equal(result.exitCode, 0);
      assert.deepEqual(reads, ["src/missing.ts"]);
      assert.equal(posts, 1);
    });
  } finally {
    delete process.env.LEGION_HTTP_TEST_KEY;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
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

test("dispatchToolCall refuses clustered node -pe / python -ic", async () => {
  let ran = 0;
  const host = {
    ...copyHost(),
    runCommand: async () => {
      ran += 1;
      return { exitCode: 0, stdout: "pwned", stderr: "" };
    },
  };
  const pe = await dispatchToolCall(
    {
      id: "c1",
      type: "function",
      function: { name: "run_command", arguments: JSON.stringify({ argv: ["node", "-pe", "1"] }) },
    },
    host,
    "execute",
  );
  assert.match(pe, /not allowlisted/);
  const ic = await dispatchToolCall(
    {
      id: "c2",
      type: "function",
      function: { name: "run_command", arguments: JSON.stringify({ argv: ["python", "-ic", "print(1)"] }) },
    },
    host,
    "execute",
  );
  assert.match(ic, /not allowlisted/);
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
test("an empty final reply after a tool round remains an incomplete terminal response", async () => {
  const { server, baseUrl } = await startMock(async (req, res) => {
    const body = await jsonBody(req);
    const round = (body.messages ?? []).filter((msg) => msg.role === "tool").length;
    if (round === 0) {
      sendJson(res, 200, assistant(null, [toolCall("c1", "write_file", { path: "src/ok.ts", contents: "ok\n" })]));
      return;
    }
    sendJson(res, 200, assistant(""));
  });
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
      const adapter = new HttpAdapter({ baseUrl, model: "local", apiKeyEnv: "LEGION_HTTP_TEST_KEY", allowLoopback: true });
      const result = await (
        await adapter.spawn({
          runId: "run-empty-final",
          skillId: "review",
          promptPath,
          pointerPrompt: "pointer",
          cwd: dir,
          timeoutMs: 10_000,
          env: { LEGION_HTTP_TEST_KEY: "sk-test" },
          httpHost: host,
        })
      ).wait();
      assert.equal(result.exitCode, 1);
      assert.deepEqual(writes, [{ posix: "src/ok.ts", contents: "ok\n" }]);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const [label, body] of [
  ["a 200 with an error body and no choices", { error: { message: "quota exceeded" } }],
  ["a 200 with an empty choices array", { choices: [] }],
  ["a 200 whose message has neither content nor tool calls", assistant("")],
]) {
  test(`${label} is a failed run (exit 1), not an empty success`, async () => {
    const { server, baseUrl } = await startMock(async (req, res) => {
      await jsonBody(req);
      sendJson(res, 200, body);
    });
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
            runId: "run-empty",
            skillId: "plan",
            promptPath,
            pointerPrompt: "pointer",
            cwd: dir,
            timeoutMs: 10_000,
            env: { LEGION_HTTP_TEST_KEY: "sk-test" },
          })
        ).wait();
        assert.equal(result.exitCode, 1);
        assert.equal(result.summaryPath, undefined);
      });
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test("an abort during a tool-call batch stops the remaining calls", async () => {
  const { server, baseUrl } = await startMock(async (req, res) => {
    await jsonBody(req);
    sendJson(
      res,
      200,
      assistant(null, [
        toolCall("c1", "write_file", { path: "src/a.ts", contents: "a\n" }),
        toolCall("c2", "write_file", { path: "src/b.ts", contents: "b\n" }),
      ]),
    );
  });
  process.env.LEGION_HTTP_TEST_KEY = "sk-test";
  try {
    await withTemp(async (dir) => {
      const promptPath = join(dir, "prompt.md");
      await writeFile(promptPath, "write two\n", "utf8");
      const writes = [];
      let handle;
      const host = {
        jailRoot: dir,
        readFile: async () => "",
        async writeFile(posix) {
          writes.push(posix);
          void handle.abort();
        },
        listDir: async () => [],
      };
      const adapter = new HttpAdapter({
        baseUrl,
        model: "local",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: true,
      });
      handle = await adapter.spawn({
        runId: "run-abort-batch",
        skillId: "execute",
        promptPath,
        pointerPrompt: "pointer",
        cwd: dir,
        timeoutMs: 10_000,
        env: { LEGION_HTTP_TEST_KEY: "sk-test" },
        httpHost: host,
      });
      const result = await handle.wait();
      assert.deepEqual(writes, ["src/a.ts"]);
      assert.equal(result.aborted, true);
    });
  } finally {
    delete process.env.LEGION_HTTP_TEST_KEY;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
