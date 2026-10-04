import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import { detectSandbox } from "@9thlevelsoftware/legion-cli-sandbox";
import { initGitRepo, initProject, makeTask, passingVerificationCommand, seedPlanReady, withEngine, withFakeAdapter } from "./helpers.js";

const KEY_ENV = "GOVERNED_TEST_KEY";

async function withProvider(program, fn) {
  const previousKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = "governed-test-key-not-a-secret";
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify(program) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`);
  } finally {
    if (previousKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = previousKey;
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

function skipWithoutHardenedVerification(t) {
  const detected = detectSandbox();
  if (detected.hardened && ["bwrap", "seatbelt", "docker"].includes(detected.backend)) return false;
  t.skip(`requires a hardened verification backend (detected ${process.platform}/${detected.backend})`);
  return true;
}

async function writePlanDocument(dir) {
  const plans = join(dir, ".legion-cli", "plans");
  await mkdir(plans, { recursive: true });
  await writeFile(join(plans, "spec-checkin.md"), "# Approved plan\n\nImplement the reviewed task contracts.\n");
}
async function withMcpServer(inputSchema, fn) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body) {
        res.writeHead(202);
        res.end();
        return;
      }
      const request = JSON.parse(body);
      if (request.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      let result = {};
      if (request.method === "initialize") {
        result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
      } else if (request.method === "tools/list") {
        result = { tools: [{ name: "record", inputSchema, annotations: { readOnlyHint: true } }] };
      } else if (request.method === "tools/call") {
        calls.push(request.params.arguments);
        result = { content: [{ type: "text", text: "recorded" }] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/mcp`, calls);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}


test("engine approveAction binds exact pending action, consumes once, and stales on provider-header change", async (t) => {
  if (skipWithoutHardenedVerification(t)) return;
  const program = {
    operations: [
      { kind: "read", id: "read-one", path: "src/main.ts" },
      { kind: "write", id: "write-one", path: "src/result.txt", value: "read-one", expectedTargetDigest: null },
      { kind: "finish", id: "finish" },
    ],
  };
  await withProvider(program, async (baseUrl) => withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/main.ts"), "approved source\n");
    await seedPlanReady(store, {
      task: {
        adapter: "http",
        contract: {
          filesAllowed: ["src/result.txt"],
          filesForbidden: [".git/**"],
          expectedArtifacts: ["src/result.txt"],
          verificationCommands: [passingVerificationCommand()],
          maxFilesTouched: 1,
        },
      },
    });
    await writePlanDocument(dir);
    const legacySkill = join(dir, ".legion-cli", "skills", "execute");
    await mkdir(legacySkill, { recursive: true });
    await writeFile(join(legacySkill, "SKILL.md"), "not valid frontmatter; LEGACY_SKILL_SECRET\n");
    initGitRepo(dir);
    const config = await store.readConfig();
    await store.writeConfig({
      ...config,
      adapter: {
        ...config.adapter,
        default: "http",
        http: { baseUrl, model: "fixture", apiKeyEnv: "GOVERNED_TEST_KEY", allowLoopback: true },
      },
    });
    const draft = join(dir, "assurance-draft.yaml");
    await writeFile(draft, stringify({
      schemaVersion: "legion-cli-assurance-plan/v1",
      specId: "spec-checkin",
      acceptanceIds: ["AC-01"],
      taskIds: ["TSK-0001"],
      security: {
        mode: "information-flow",
        sources: [{ id: "main", path: "src/main.ts", classification: "workspace" }],
        sinks: [{ id: "planner", origin: baseUrl, classifications: ["workspace"] }],
        transformations: [],
        tasks: [{ taskId: "TSK-0001", readPaths: ["src/main.ts"], transformationIds: [] }],
        externalCalls: [],
      },
      knowledge: [{
        id: "checkin-task",
        statement: "Implement the approved check-in acceptance criterion.",
        source: { path: "src/main.ts" },
        acceptanceIds: ["AC-01"],
        taskIds: ["TSK-0001"],
        dependsOn: [],
        checkIds: [],
      }],
      validators: [],
      delivery: { artifacts: [] },
    }));
    await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const result = await engine.execute("TSK-0001");
    assert.equal(result.status, "blocked");
    const pending = await engine.getPendingGovernedActions();
    assert.equal(pending.length, 1, JSON.stringify({ result, pending }));
    assert.equal(pending[0].actionKind, "write");
    assert.equal(pending[0].target, "src/result.txt");
    assert.equal(existsSync(join(dir, ".legion-cli", "cache", "skills", pending[0].runId)), false);
    assert.equal(existsSync(join(dir, ".legion-cli", "cache", "runs", pending[0].runId, "prompt.md")), false);
    assert.equal(pending[0].confidentiality, "workspace");
    assert.equal(pending[0].integrity, "untrusted");
    assert.doesNotMatch(JSON.stringify(pending), /private-header-value|GOVERNED_TEST_KEY/);
    const request = {
      runId: pending[0].runId,
      actionId: pending[0].actionId,
      valueDigest: pending[0].valueDigest,
      sinkId: pending[0].sinkId,
      operatorId: "operator",
      reason: "Approve the exact reviewed write",
    };

    const originalConfig = await store.readConfig();
    await store.writeConfig({
      ...originalConfig,
      adapter: {
        ...originalConfig.adapter,
        http: { ...originalConfig.adapter.http, headers: { "x-private-header": "private-header-value" } },
      },
    });
    assert.deepEqual(await engine.getPendingGovernedActions(), []);
    await assert.rejects(() => engine.approveAction(request));
    await store.writeConfig(originalConfig);
    assert.equal((await engine.getPendingGovernedActions()).length, 1);

    await assert.rejects(
      () => engine.approveAction({ ...request, valueDigest: "0".repeat(64) }),
      /stale-authority/,
    );
    const approval = await engine.approveAction(request);
    assert.equal(approval.state, "approved");
    assert.equal(approval.actionId, request.actionId);
    await assert.rejects(() => engine.approveAction(request), /stale-authority/);
  }));
});
test("approved governed MCP dispatch sends schema-shaped nested array arguments to the loopback tool", async (t) => {
  if (skipWithoutHardenedVerification(t)) return;
  const inputSchema = {
    type: "object",
    properties: {
      account: { type: "string" },
      filter: {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, levels: { type: "array", items: { type: "number" } } },
            },
          },
        },
      },
    },
  };
  const pointers = [
    "/filter/groups/0/name",
    "/filter/groups/0/levels/0",
    "/filter/groups/1/name",
  ];
  const program = {
    operations: [
      { kind: "read", id: "read-name", path: "src/name.json" },
      { kind: "read", id: "read-number", path: "src/number.json" },
      {
        kind: "external-call",
        id: "mcp-call",
        grantId: "local-record",
        authority: { account: "fixed-account" },
        data: [
          { pointer: pointers[0], value: "read-name" },
          { pointer: pointers[1], value: "read-number" },
          { pointer: pointers[2], value: "read-name" },
        ],
      },
      { kind: "finish", id: "finish" },
    ],
  };
  await withMcpServer(inputSchema, (mcpUrl, mcpCalls) =>
    withProvider(program, (baseUrl) =>
      withEngine(async ({ engine, store, dir }) => {
        await initProject(engine);
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src/name.json"), JSON.stringify("alpha"));
        await writeFile(join(dir, "src/number.json"), "5");
        await writeFile(join(dir, "src/result.json"), "{}\n");
        await seedPlanReady(store, {
          task: {
            adapter: "http",
            contract: {
              filesAllowed: ["src/result.json"],
              filesForbidden: [".git/**"],
              expectedArtifacts: ["src/result.json"],
              verificationCommands: [passingVerificationCommand()],
              maxFilesTouched: 1,
            },
          },
        });
        await writePlanDocument(dir);
        initGitRepo(dir);
        const config = await store.readConfig();
        await store.writeConfig({
          ...config,
          adapter: {
            ...config.adapter,
            default: "http",
            http: { baseUrl, model: "fixture", apiKeyEnv: "GOVERNED_TEST_KEY", allowLoopback: true },
          },
          mcpServers: {
            fixture: { transport: "streamable-http", url: mcpUrl, allowLoopback: true },
          },
          mcpHttpToolAllowlist: ["fixture:record"],
        });
        const draft = join(dir, "assurance-draft.yaml");
        await writeFile(draft, stringify({
          schemaVersion: "legion-cli-assurance-plan/v1",
          specId: "spec-checkin",
          acceptanceIds: ["AC-01"],
          taskIds: ["TSK-0001"],
          security: {
            mode: "information-flow",
            sources: [
              { id: "name", path: "src/name.json", classification: "workspace" },
              { id: "number", path: "src/number.json", classification: "workspace" },
            ],
            sinks: [
              { id: "planner", origin: baseUrl, classifications: ["workspace"] },
              { id: "mcp-sink", origin: "https://fixture.example/mcp", classifications: ["workspace"] },
            ],
            transformations: [],
            tasks: [{
              taskId: "TSK-0001",
              readPaths: ["src/name.json", "src/number.json"],
              transformationIds: [],
            }],
            externalCalls: [{
              id: "local-record",
              taskIds: ["TSK-0001"],
              tool: "fixture:record",
              sinkId: "mcp-sink",
              authority: { account: "fixed-account" },
              dataPointers: pointers,
              effect: "http-mcp",
            }],
          },
          knowledge: [{
            id: "checkin-task",
            statement: "Record the approved nested MCP payload.",
            source: { path: "src/name.json" },
            acceptanceIds: ["AC-01"],
            taskIds: ["TSK-0001"],
            dependsOn: [],
            checkIds: [],
          }],
          validators: [],
          delivery: { artifacts: [] },
        }));
        await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
        const blocked = await engine.execute("TSK-0001");
        assert.equal(blocked.status, "blocked");
        assert.equal(mcpCalls.length, 0);
        const pending = await engine.getPendingGovernedActions();
        assert.equal(pending.length, 1);
        assert.equal(pending[0].actionKind, "http-mcp");
        await engine.approveAction({
          runId: pending[0].runId,
          actionId: pending[0].actionId,
          valueDigest: pending[0].valueDigest,
          sinkId: pending[0].sinkId,
          operatorId: "operator",
          reason: "Approve the exact governed MCP call",
        });
        const resumed = await engine.execute("auto", { resume: pending[0].runId });
        assert.equal(resumed.status, "done", resumed.tasks[0].reason);
        assert.deepEqual(mcpCalls, [{
          account: "fixed-account",
          filter: {
            groups: [
              { name: "alpha", levels: [5] },
              { name: "alpha" },
            ],
          },
        }]);
      }),
    ),
  );
});
test("parallel governed execution carries the approved context to each task", async (t) => {
  if (skipWithoutHardenedVerification(t)) return;
  await withProvider({ operations: [{ kind: "finish", id: "finish" }] }, (baseUrl) =>
    withEngine(async ({ engine, store, dir }) => {
      await initProject(engine);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/source.txt"), "approved source\n");
      await writeFile(join(dir, "src/one.txt"), "one\n");
      await writeFile(join(dir, "src/two.txt"), "two\n");
      await seedPlanReady(store, {
        task: {
          adapter: "http",
          contract: {
            filesAllowed: ["src/one.txt"],
            filesForbidden: [".git/**"],
            expectedArtifacts: ["src/one.txt"],
            verificationCommands: [passingVerificationCommand()],
            maxFilesTouched: 1,
          },
        },
        extraTasks: [makeTask({
          id: "TSK-0002",
          title: "Second governed task",
          priority: "P1",
          specId: "spec-checkin",
          status: "ready",
          adapter: "http",
          contract: {
            filesAllowed: ["src/two.txt"],
            filesForbidden: [".git/**"],
            expectedArtifacts: ["src/two.txt"],
            verificationCommands: [passingVerificationCommand()],
            maxFilesTouched: 1,
          },
        })],
      });
      await writePlanDocument(dir);
      initGitRepo(dir);
      const config = await store.readConfig();
      await store.writeConfig({
        ...config,
        adapter: {
          ...config.adapter,
          default: "http",
          http: { baseUrl, model: "fixture", apiKeyEnv: "GOVERNED_TEST_KEY", allowLoopback: true },
        },
      });
      const draft = join(dir, "assurance-draft.yaml");
      await writeFile(draft, stringify({
        schemaVersion: "legion-cli-assurance-plan/v1",
        specId: "spec-checkin",
        acceptanceIds: ["AC-01"],
        taskIds: ["TSK-0001", "TSK-0002"],
        security: {
          mode: "information-flow",
          sources: [{ id: "source", path: "src/source.txt", classification: "workspace" }],
          sinks: [{ id: "planner", origin: baseUrl, classifications: ["workspace"] }],
          transformations: [],
          tasks: [
            { taskId: "TSK-0001", readPaths: ["src/source.txt"], transformationIds: [] },
            { taskId: "TSK-0002", readPaths: ["src/source.txt"], transformationIds: [] },
          ],
          externalCalls: [],
        },
        knowledge: [
          {
            id: "first-task",
            statement: "Complete the first approved task.",
            source: { path: "src/source.txt" },
            acceptanceIds: ["AC-01"],
            taskIds: ["TSK-0001"],
            dependsOn: [],
            checkIds: [],
          },
          {
            id: "second-task",
            statement: "Complete the second approved task.",
            source: { path: "src/source.txt" },
            acceptanceIds: ["AC-01"],
            taskIds: ["TSK-0002"],
            dependsOn: [],
            checkIds: [],
          },
        ],
        validators: [],
        delivery: { artifacts: [] },
      }));
      await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
      const result = await engine.execute("auto", { untilBlocked: true, jobs: 2 });
      assert.equal(result.status, "done", result.blocker);
      assert.deepEqual(result.tasks.map((task) => task.status), ["done", "done"]);
      assert.equal(result.tasks.length, 2);
      await withFakeAdapter(() =>
        assert.rejects(
          () => engine.review({ adapter: "fake" }),
          /information-flow review requires the governed HTTP controller/,
        ),
      );
    }),
  );
});
