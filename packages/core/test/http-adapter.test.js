import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  initProject,
  makeTask,
  seedFrozenSpec,
  withEngine,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

function taskMarkdown(task) {
  return [
    "---",
    "schemaVersion: legion-cli-task/v1",
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `type: ${task.type}`,
    `priority: ${task.priority}`,
    `specId: ${task.specId}`,
    "blockedBy: []",
    "blocks: []",
    "contract:",
    "  filesAllowed:",
    ...task.contract.filesAllowed.map((path) => `    - ${path}`),
    "  filesForbidden:",
    "    - .git/**",
    "  expectedArtifacts:",
    ...task.contract.expectedArtifacts.map((path) => `    - ${path}`),
    "  verificationCommands:",
    ...task.contract.verificationCommands.map((cmd) => `    - ${cmd}`),
    "assignee: agent",
    'notes: ""',
    "---",
    "",
    `${task.title}.`,
    "",
  ].join("\n");
}

function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}/v1` });
    });
  });
}

function closeMock(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
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

test("plan with adapter.default http writes two TSK files in jail then copy-out", async () => {
  const tsk1 = makeTask({
    id: "TSK-0001",
    title: "in/out button",
    status: "ready",
    contract: {
      filesAllowed: ["src/main.ts"],
      expectedArtifacts: ["src/main.ts"],
      verificationCommands: ["pnpm test"],
    },
  });
  const tsk2 = makeTask({
    id: "TSK-0002",
    title: "settings screen",
    status: "ready",
    contract: {
      filesAllowed: ["src/settings.ts"],
      expectedArtifacts: ["src/settings.ts"],
      verificationCommands: ["pnpm test"],
    },
  });
  const { server, baseUrl } = await startMock(async (req, res) => {
    const body = await jsonBody(req);
    const tools = (body.messages ?? []).filter((msg) => msg.role === "tool").length;
    if (tools === 0) {
      sendJson(res, 200, {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: ".legion-cli/tasks/TSK-0001.md",
                      contents: taskMarkdown(tsk1),
                    }),
                  },
                },
                {
                  id: "c2",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: ".legion-cli/tasks/TSK-0002.md",
                      contents: taskMarkdown(tsk2),
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
      return;
    }
    sendJson(res, 200, {
      choices: [{ message: { role: "assistant", content: "planned two tasks" } }],
    });
  });
  const previous = process.env.LEGION_HTTP_TEST_KEY;
  process.env.LEGION_HTTP_TEST_KEY = "sk-test";
  try {
    await withEngine(
      async ({ engine, store, dir }) => {
        await engine.init({
          name: "Checkin",
          adapter: "http",
          http: {
            baseUrl,
            model: "local",
            apiKeyEnv: "LEGION_HTTP_TEST_KEY",
            allowLoopback: true,
          },
        });
        const config = await engine.store.readConfig();
        await engine.store.writeConfig({
          ...config,
          sandbox: { ...config.sandbox, allowCopyJail: true },
        });
        await seedFrozenSpec(store, { wireframesIndex: "wireframes/INDEX.html" });
        const readiness = await engine.plan("spec-checkin");
        assert.equal(existsSync(join(dir, ".legion-cli", "tasks", "TSK-0001.md")), true, "TSK-0001 copy-out");
        assert.equal(existsSync(join(dir, ".legion-cli", "tasks", "TSK-0002.md")), true, "TSK-0002 copy-out");
        assert.notEqual(readiness, "FAIL");
        const runsDir = join(dir, ".legion-cli", "cache", "runs");
        const names = (await readdir(runsDir)).filter((name) => name.startsWith("plan-"));
        assert.ok(names.length > 0);
        const resume = JSON.parse(await readFile(join(runsDir, names[names.length - 1], "resume.json"), "utf8"));
        assert.equal(resume.pid, null);
        assert.equal(resume.adapterId, "http");
        assert.match(resume.argvSummary, /POST \/chat\/completions model=local/);
        assert.doesNotMatch(resume.argvSummary, /sk-test|Authorization/i);
        const stdout = await readFile(join(runsDir, names[names.length - 1], "stdout.log"), "utf8");
        assert.match(stdout, /HTTP 200 POST \/chat\/completions/);
        assert.doesNotMatch(stdout, /sk-test|Authorization/i);
      },
      { skillsDir },
    );
  } finally {
    if (previous === undefined) delete process.env.LEGION_HTTP_TEST_KEY;
    else process.env.LEGION_HTTP_TEST_KEY = previous;
    await closeMock(server);
  }
});

test("http write_file to .env does not land on the operator tree", async () => {
  const { server, baseUrl } = await startMock(async (req, res) => {
    const body = await jsonBody(req);
    const tools = (body.messages ?? []).filter((msg) => msg.role === "tool").length;
    if (tools === 0) {
      sendJson(res, 200, {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: ".env", contents: "SECRET=1\n" }),
                  },
                },
              ],
            },
          },
        ],
      });
      return;
    }
    sendJson(res, 200, { choices: [{ message: { role: "assistant", content: "done" } }] });
  });
  const previous = process.env.LEGION_HTTP_TEST_KEY;
  process.env.LEGION_HTTP_TEST_KEY = "sk-test";
  try {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine, {
          adapter: "http",
          http: {
            baseUrl,
            model: "local",
            apiKeyEnv: "LEGION_HTTP_TEST_KEY",
            allowLoopback: true,
          },
        });
        await seedFrozenSpec(store);
        await engine.plan("spec-checkin");
        assert.equal(existsSync(join(dir, ".env")), false);
        assert.equal(existsSync(join(dir, ".ENV")), false);
      },
      { skillsDir },
    );
  } finally {
    if (previous === undefined) delete process.env.LEGION_HTTP_TEST_KEY;
    else process.env.LEGION_HTTP_TEST_KEY = previous;
    await closeMock(server);
  }
});
