import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { bin, normalize, runCli, withTempDir } from "./helpers.js";

function runCliAsync(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const KEY_ENV = "LEGION_HTTP_E2E_KEY";
const KEY_VALUE = "sk-legion-http-e2e-not-for-disk";

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
    id: "chatcmpl-e2e",
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

async function seedFrozen(dir) {
  const engine = createLegionEngine(dir);
  await engine.store.writeSpec(
    {
      schemaVersion: "legion-cli-spec/v1",
      id: "spec-checkin",
      title: "Office check-in",
      status: "frozen",
      mustBeTrue: ["People can tap in or out on their phone in under five seconds"],
      mustNotChange: [],
      outOfScope: ["payroll"],
      acceptance: [
        {
          id: "AC-01",
          statement: "Tap in or out on a phone completes in under five seconds",
          kind: "behavior",
          priority: "P0",
        },
      ],
      personas: ["teammates"],
      happyPath: "Open the board, tap In.",
      frozenAt: "2026-09-01T12:00:00.000Z",
      frozenBy: "tester",
      wireframesIndex: null,
    },
    "Spec body.\n",
  );
  const project = await engine.store.readProject();
  await engine.store.writeProject({ ...project.data, activeSpecId: "spec-checkin" }, project.body);
  const state = await engine.store.readState();
  await engine.store.writeState({ ...state.data, phase: "spec_frozen", activeSpecId: "spec-checkin" }, state.body);
  await engine.store.writeTask(
    {
      schemaVersion: "legion-cli-task/v1",
      id: "TSK-0001",
      title: "in/out button",
      status: "ready",
      type: "feature",
      priority: "P0",
      specId: "spec-checkin",
      blockedBy: [],
      blocks: [],
      assignee: "agent",
      notes: "",
      contract: {
        filesAllowed: ["src/main.ts"],
        filesForbidden: [".git/**"],
        expectedArtifacts: ["src/main.ts"],
        verificationCommands: ["pnpm test"],
        maxFilesTouched: 20,
      },
    },
    "Implement the in/out button.\n",
  );
  return engine;
}

test("init --adapter http writes config and plan completes a governed HTTP tool round-trip", async () => {
  const posts = [];
  const { server, baseUrl } = await startMock(async (req, res) => {
    const body = await jsonBody(req);
    const toolMessages = (body.messages ?? []).filter((msg) => msg.role === "tool");
    posts.push({
      tools: (body.tools ?? []).map((tool) => tool.function?.name),
      toolResults: toolMessages.map((msg) => msg.content),
      authorization: req.headers.authorization,
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
    await withTempDir(async (dir) => {
      const init = runCli(
        [
          "init",
          "--project",
          dir,
          "--name",
          "Checkin",
          "--adapter",
          "http",
          "--http-base-url",
          baseUrl,
          "--http-model",
          "local-e2e",
          "--http-api-key-env",
          KEY_ENV,
          "--http-allow-loopback",
        ],
        { env: { [KEY_ENV]: KEY_VALUE } },
      );
      assert.equal(init.status, 0, init.stderr);
      const engine = createLegionEngine(dir);
      const config = await engine.store.readConfig();
      assert.equal(config.adapter.default, "http");
      assert.equal(config.adapter.http?.apiKeyEnv, KEY_ENV);
      assert.equal(config.adapter.http?.model, "local-e2e");
      assert.equal(config.adapter.http?.allowLoopback, true);
      assert.equal(config.sandbox.allowCopyJail, true);
      assert.equal(config.sandbox.requireHardened, true);
      assert.equal(Object.hasOwn(config.adapter.http ?? {}, "apiKey"), false);
      const yaml = await readFile(join(dir, ".legion-cli", "config.yaml"), "utf8");
      assert.match(yaml, new RegExp(`apiKeyEnv:\\s*${KEY_ENV}`));
      assert.match(yaml, /allowCopyJail:\s*true/);
      assert.equal(yaml.includes(KEY_VALUE), false, `config.yaml must not contain the value of ${KEY_ENV}`);
      assert.doesNotMatch(yaml, /^\s*apiKey:/m);

      await seedFrozen(dir);
      // spawnSync would freeze this process's mock HTTP server; plan must be async.
      const plan = await runCliAsync(["plan", "--project", dir], { env: { [KEY_ENV]: KEY_VALUE } });
      const combined = `${normalize(plan.stdout)}\n${normalize(plan.stderr)}`;
      assert.doesNotMatch(combined, /spawnable adapter/);
      assert.doesNotMatch(combined, /not selectable yet/);
      assert.ok(posts.length >= 2, `expected a completions POST plus a tool follow-up; posts=${posts.length} status=${plan.status} ${combined}`);
      assert.ok(posts[0].tools.includes("write_file"));
      assert.ok(posts.some((post) => post.toolResults.includes("ok")), "expected a tool round-trip result");
      const planFile = await readFile(join(dir, ".legion-cli", "plans", "spec-checkin.md"), "utf8");
      assert.match(planFile, /plan from http/);
      assert.equal(yaml.includes(KEY_VALUE), false, `config.yaml must not contain the value of ${KEY_ENV}`);
    });
  } finally {
    if (previous === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = previous;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
