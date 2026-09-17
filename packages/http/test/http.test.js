import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  completionsUrl,
  HttpAdapter,
  HttpAdapterError,
  httpAdapterNotReadyReason,
  isHttpAdapterReady,
  isRunCommandAllowed,
  toolsForJob,
} from "../dist/index.js";

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

test("run_command allowlist refuses git/ssh/curl and allows node/pnpm", () => {
  assert.equal(isRunCommandAllowed(["git", "commit"]), false);
  assert.equal(isRunCommandAllowed(["ssh"]), false);
  assert.equal(isRunCommandAllowed(["curl", "https://example.com"]), false);
  assert.equal(isRunCommandAllowed(["cmd", "/c", "dir"]), false);
  assert.equal(isRunCommandAllowed(["powershell", "-c", "Get-Process"]), false);
  assert.equal(isRunCommandAllowed(["node", "-e", "1"]), true);
  assert.equal(isRunCommandAllowed(["pnpm", "test"]), true);
});

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
  const { server, baseUrl } = await startMock(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      await jsonBody(req);
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
      assert.notEqual(deniedResult.exitCode, 0);
      assert.match(await readFile(deniedResult.stderrPath, "utf8"), /allowLoopback/);

      const allowed = new HttpAdapter({
        baseUrl,
        model: "local",
        apiKeyEnv: "LEGION_HTTP_TEST_KEY",
        allowLoopback: true,
      });
      assert.equal((await allowed.detect()).ok, true);
      const handle = await allowed.spawn(job);
      assert.equal(handle.pid, null);
      const result = await handle.wait();
      assert.equal(result.exitCode, 0, await readFile(result.stderrPath, "utf8"));
      assert.equal(result.aborted, false);
      assert.match(await readFile(result.stdoutPath, "utf8"), /HTTP 200 POST \/chat\/completions/);
      assert.doesNotMatch(await readFile(result.stdoutPath, "utf8"), /sk-test|Authorization/i);
      assert.doesNotMatch(await readFile(result.stderrPath, "utf8"), /sk-test|Authorization/i);
    });
  } finally {
    if (previous === undefined) delete process.env.LEGION_HTTP_TEST_KEY;
    else process.env.LEGION_HTTP_TEST_KEY = previous;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("mock 302 to 169.254.169.254 is refused (no redirects)", async () => {
  let secondHop = 0;
  const { server, baseUrl } = await startMock((req, res) => {
    if (req.url === "/latest") {
      secondHop += 1;
      res.writeHead(200);
      res.end("metadata");
      return;
    }
    res.writeHead(302, { Location: "http://169.254.169.254/latest" });
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
      assert.notEqual(result.exitCode, 0);
      assert.match(await readFile(result.stderrPath, "utf8"), /refused redirect HTTP 302/);
      assert.equal(secondHop, 0);
    });
  } finally {
    delete process.env.LEGION_HTTP_TEST_KEY;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
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
      assert.equal(result.exitCode, 0, await readFile(result.stderrPath, "utf8"));
      assert.equal(result.aborted, false);
      assert.equal(
        writes.some((row) => row.posix === ".env"),
        false,
      );
      assert.equal(
        writes.some((row) => row.posix === ".legion-cli/tasks/TSK-0001.md"),
        true,
      );
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
      assert.notEqual(result.exitCode, 0);
      assert.equal(posts, 32);
      assert.match(await readFile(result.stderrPath, "utf8"), /32 tool rounds/);
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
      const waited = handle.wait();
      await handle.abort();
      const result = await waited;
      assert.equal(result.aborted, true);
      assert.equal(result.timedOut, false);
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
