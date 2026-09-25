import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { seedFrozenSpec, withEngine, writeTask, makeTask } from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
const KEY_ENV = "LEGION_HTTP_CORE_E2E_KEY";
const KEY_VALUE = "sk-legion-http-core-e2e-not-for-disk";

function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}/v1` });
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
    id: "chatcmpl-core-e2e",
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

test("plan with adapter.default http completes a governed HTTP tool round-trip", async () => {
  const posts = [];
  const { server, baseUrl } = await startMock(async (req, res) => {
    const body = await jsonBody(req);
    const toolMessages = (body.messages ?? []).filter((msg) => msg.role === "tool");
    posts.push({
      tools: (body.tools ?? []).map((tool) => tool.function?.name),
      toolResults: toolMessages.map((msg) => msg.content),
    });
    if (toolMessages.length === 0) {
      sendJson(res, 200, assistant(null, [
        {
          id: "c1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: ".legion-cli/plans/spec-checkin.md", contents: "plan from http\n" }),
          },
        },
      ]));
      return;
    }
    sendJson(res, 200, assistant("planned"));
  });
  const previous = process.env[KEY_ENV];
  process.env[KEY_ENV] = KEY_VALUE;
  try {
    await withEngine(
      async ({ engine, store, dir }) => {
        await engine.init({
          name: "Checkin",
          adapter: "http",
          http: {
            baseUrl,
            model: "local",
            apiKeyEnv: KEY_ENV,
            allowLoopback: true,
          },
        });
        const config = await store.readConfig();
        assert.equal(config.sandbox.allowCopyJail, true);
        assert.equal(config.adapter.http?.apiKeyEnv, KEY_ENV);
        assert.equal(Object.hasOwn(config.adapter.http ?? {}, "apiKey"), false);
        const yaml = await readFile(join(dir, ".legion-cli", "config.yaml"), "utf8");
        assert.equal(yaml.includes(KEY_VALUE), false, `config.yaml must not contain the value of ${KEY_ENV}`);
        await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
        await writeTask(store, makeTask());
        const readiness = await engine.plan("spec-checkin");
        assert.ok(readiness === "PASS" || readiness === "CONCERNS" || readiness === "FAIL");
        assert.ok(posts.length >= 2, "expected a completions POST plus a tool follow-up");
        assert.ok(posts[0].tools.includes("write_file"));
        assert.ok(posts.some((post) => post.toolResults.includes("ok")), "expected a tool round-trip result");
        const planFile = await readFile(join(dir, ".legion-cli", "plans", "spec-checkin.md"), "utf8");
        assert.match(planFile, /plan from http/);
      },
      { skillsDir },
    );
  } finally {
    if (previous === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = previous;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
