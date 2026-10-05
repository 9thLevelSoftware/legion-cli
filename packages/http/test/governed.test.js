import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpAdapter, LegionMcpClientPool, stableHash } from "../dist/index.js";
import { AssuranceIdSchema } from "@9thlevelsoftware/legion-cli-schema";
import { governedActionId } from "../dist/governed.js";

test("controller action IDs stay within the assurance ID alphabet", () => {
  const generated = governedActionId("00000000-0000-0000-0000-000000000000");
  assert.equal(generated, "act-00000000-0000-0000-0000-000000000000");
  assert.equal(AssuranceIdSchema.safeParse(generated).success, true);
});
const hash = "a".repeat(64);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identities = (endpoint) => ({ promptFingerprint: hash, configurationFingerprint: hash, contractFingerprint: hash, sourceFingerprint: hash, jailFingerprint: hash, hostFingerprint: hash, approvalId: "approval-1", policyFingerprint: hash, provider: { endpoint, model: "fixture", profile: "profile" } });
const program = { operations: [{ kind: "finish", id: "finish" }] };

async function serverWith(response) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(Buffer.concat(chunks));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return { server, requests, baseUrl };
}
async function startMcpFixture(options = {}) {
  const responseBodies = [];
  let listCalls = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      let body;
      let status = 200;
      if (request.method === "initialize") {
        body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } }));
      } else if (request.method === "tools/list") {
        const inputSchema = options.inputSchemas?.[listCalls] ?? options.inputSchema ?? { type: "object" };
        listCalls += 1;
        body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "status", inputSchema, annotations: { readOnlyHint: true } }] } }));
      } else if (request.method === "tools/call") {
        status = options.status ?? 200;
        body = options.body ?? Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "fixture-result" }] } }));
        responseBodies.push(body);
        const send = () => {
          res.writeHead(status, { "content-type": "application/json", "content-length": body.byteLength });
          res.end(body);
        };
        if (options.delayMs) setTimeout(send, options.delayMs);
        else send();
        return;
      } else {
        body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));
      }
      res.writeHead(status, { "content-type": "application/json", "content-length": body.byteLength });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return {
    url,
    responseBodies,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
async function toolFingerprint(pool) {
  const tools = (await pool.listAllTools()).filter((tool) => tool.readOnly && tool.name === "remote:status");
  return stableHash(tools.sort((a, b) => a.name.localeCompare(b.name)).map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema, readOnly: tool.readOnly })));
}


function createHost() {
  const bootstrap = {
    phase: "bootstrap", bootstrapAuthorityDigest: hash, candidateProgram: null, revision: 0,
    identities: {}, providerCalls: [], usage: { planner: { requests: 0, inputTokens: null, outputTokens: null, costUsd: null, tokenLowerBound: 0, tokenAccounting: "complete", costAccounting: "complete" }, quarantined: { requests: 0, inputTokens: null, outputTokens: null, costUsd: null, tokenLowerBound: 0, tokenAccounting: "complete", costAccounting: "complete" } },
    status: "running", blocker: null,
  };
  let checkpoint = bootstrap;
  let revision = 0;
  let intent;
  let completion;
  return {
    get intent() { return intent; },
    get completion() { return completion; },
    async open(context, resume) { assert.equal(context.runId, "run/../unsafe"); return { revision, checkpoint }; },
    async saveProgress(expectedRevision, next) { assert.equal(expectedRevision, revision); checkpoint = next; revision++; return { revision, checkpoint }; },
    async prepareEffect(expectedRevision, nextIntent) { assert.equal(expectedRevision, revision); intent = nextIntent; revision++; return { kind: "ready", permit: { actionId: nextIntent.actionId, pendingRevision: revision, requestDigest: nextIntent.requestDigest }, state: { revision, checkpoint } }; },
    async completeEffect(permit, nextCompletion) { completion = nextCompletion; revision++; checkpoint = { ...checkpoint, revision, candidateProgram: nextCompletion.candidateProgram, providerCalls: [{ actionId: permit.actionId, sequence: 1, state: "completed" }], usage: { planner: { requests: 1, inputTokens: 2, outputTokens: 3, costUsd: null, tokenLowerBound: 5, tokenAccounting: "complete", costAccounting: "incomplete" }, quarantined: bootstrap.usage.quarantined } }; return { revision, checkpoint }; },
    async markUncertain(permit, code) { completion = { outcome: { kind: "failure", code } }; return { revision, checkpoint }; },
    async freezeProgram(expectedRevision) { assert.equal(expectedRevision, revision); revision++; checkpoint = { phase: "program", runId: "run/../unsafe", bootstrapAuthorityDigest: hash, programAuthorityDigest: hash, programKind: "governed", programFingerprint: hash, identities: {}, program, candidateProgram: program, revision, providerCalls: checkpoint.providerCalls, usage: checkpoint.usage, cursor: 0, values: [], effects: [], status: "running", blocker: null, recordedAt: "2026-10-03T12:00:00.000Z" }; return { revision, checkpoint }; },
    async readSource() { throw new Error("unexpected read"); },
    async dispatchWrite() { throw new Error("unexpected write"); },
    async dispatchMcp() { throw new Error("unexpected MCP call"); },
  };
}

async function runGoverned(response, options = {}) {
  const fixture = await serverWith(response);
  const root = await mkdtemp(join(tmpdir(), "governed-http-"));
  try {
    const host = createHost();
    const context = { runId: "run/../unsafe", taskId: "task-1", identities: identities(fixture.baseUrl), manifestDigest: hash, plannerInput: { approvedMetadata: { title: "approved" }, label: { origins: ["control"], integrity: "approved", confidentiality: "workspace" }, taskContract: { description: "fixed" } }, policy: {} };
    const job = { runId: context.runId, skillId: "execute", cwd: root, timeoutMs: 5000, env: { TOKEN: "fixture-secret" }, checkpointRoot: root, assuranceContext: context, effectHost: host };
    Object.defineProperty(job, "promptPath", { get() { throw new Error("governed path read legacy prompt"); } });
    Object.defineProperty(job, "pointerPrompt", { get() { throw new Error("governed path read pointer prompt"); } });
    if (options.incomplete) delete job.effectHost;
    const adapter = new HttpAdapter({ baseUrl: fixture.baseUrl, model: "fixture", apiKeyEnv: "TOKEN", allowLoopback: true });
    const result = await (await adapter.spawn(job)).wait();
    return { fixture, host, result, root, runId: context.runId };
  } finally {
    fixture.server.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("governed branch skips legacy prompt and sends exactly the admitted request bytes", async () => {
  const { fixture, host, result, root, runId } = await runGoverned({ choices: [{ message: { role: "assistant", content: JSON.stringify(program) }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  assert.equal(result.exitCode, 0);
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.requests[0], Buffer.from(host.intent.requestBody));
  assert.equal(digest(fixture.requests[0]), host.intent.bodyDigest);
  assert.equal(result.stdoutPath, "");
  assert.equal(result.stderrPath, "");
  assert.equal(result.checkpointPath, join(root, ".legion-cli", "audit", "http-governed", digest(`legion-cli-governed-run-path/v1\0${runId}`), "http-governed-checkpoint.json"));
  assert.equal(result.checkpointPath.includes("unsafe"), false);
});

test("incomplete governed context refuses before any provider dispatch", async () => {
  const { fixture, result } = await runGoverned({ choices: [{ message: { role: "assistant", content: JSON.stringify(program) }, finish_reason: "stop" }] }, { incomplete: true });
  assert.equal(result.exitCode, 1);
  assert.equal(fixture.requests.length, 0);
});

test("quarantined planner tool calls are rejected after charging the provider attempt", async () => {
  const { fixture, host, result } = await runGoverned({ choices: [{ message: { role: "assistant", content: "ignored", tool_calls: [{ id: "forbidden", type: "function", function: { name: "run_command", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
  assert.equal(result.exitCode, 1);
  assert.equal(fixture.requests.length, 1);
  assert.equal(host.completion.outcome.kind, "failure");
  assert.equal(host.completion.providerUsage.requestCharge, 1);
  assert.equal(host.completion.providerUsage.tokenAccounting, "incomplete");
});

test("governed MCP capture hashes the completed streamable HTTP response bytes", async () => {
  const fixture = await startMcpFixture();
  const pool = new LegionMcpClientPool({ remote: { transport: "streamable-http", url: fixture.url, allowLoopback: true } }, { governedHttpToolAllowlist: ["remote:status"] });
  try {
    const legacy = await pool.callTool("remote:status", {});
    assert.equal(legacy.content[0].text, "fixture-result");
    const captured = await pool.callGovernedHttpToolCaptured("remote:status", {}, await toolFingerprint(pool));
    const responseBody = fixture.responseBodies.at(-1);
    assert.ok(captured);
    assert.equal(captured.result.content[0].text, "fixture-result");
    assert.equal(captured.responseBytes, responseBody.byteLength);
    assert.equal(captured.responseDigest, digest(responseBody));
  } finally {
    await pool.closeAll();
    await fixture.close();
  }
});

test("governed MCP capture refuses non-200 and oversized wire responses", async () => {
  const non200 = await startMcpFixture({ status: 503 });
  const non200Pool = new LegionMcpClientPool({ remote: { transport: "streamable-http", url: non200.url, allowLoopback: true } }, { governedHttpToolAllowlist: ["remote:status"] });
  try {
    assert.equal(await non200Pool.callGovernedHttpToolCaptured("remote:status", {}, await toolFingerprint(non200Pool)), null);
  } finally {
    await non200Pool.closeAll();
    await non200.close();
  }

  const oversized = await startMcpFixture({ body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "x".repeat(1_048_577) }] } })) });
  const oversizedPool = new LegionMcpClientPool({ remote: { transport: "streamable-http", url: oversized.url, allowLoopback: true } }, { governedHttpToolAllowlist: ["remote:status"] });
  try {
    assert.equal(await oversizedPool.callGovernedHttpToolCaptured("remote:status", {}, await toolFingerprint(oversizedPool)), null);
  } finally {
    await oversizedPool.closeAll();
    await oversized.close();
  }
});

test("concurrent governed MCP capture refuses an ambiguous second call", async () => {
  const fixture = await startMcpFixture({ delayMs: 100 });
  const pool = new LegionMcpClientPool({ remote: { transport: "streamable-http", url: fixture.url, allowLoopback: true } }, { governedHttpToolAllowlist: ["remote:status"] });
  try {
    const expected = await toolFingerprint(pool);
    const firstPromise = pool.callGovernedHttpToolCaptured("remote:status", {}, expected);
    const second = await pool.callGovernedHttpToolCaptured("remote:status", {}, expected);
    assert.equal(second, null);
    const first = await firstPromise;
    assert.ok(first);
    assert.equal(first.responseDigest, digest(fixture.responseBodies[0]));
  } finally {
    await pool.closeAll();
    await fixture.close();
  }
});

test("governed MCP capture refuses a changed allowlisted schema before dispatch", async () => {
  const fixture = await startMcpFixture({ inputSchemas: [{ type: "object" }, { type: "string" }] });
  const pool = new LegionMcpClientPool({ remote: { transport: "streamable-http", url: fixture.url, allowLoopback: true } }, { governedHttpToolAllowlist: ["remote:status"] });
  try {
    const expected = await toolFingerprint(pool);
    assert.equal(await pool.callGovernedHttpToolCaptured("remote:status", {}, expected), null);
    assert.equal(fixture.responseBodies.length, 0);
  } finally {
    await pool.closeAll();
    await fixture.close();
  }
});
test("governed planner rejects lone-surrogate output after charging the response", async () => {
  const invalidContent = String.fromCharCode(0xd800);
  const { host, result } = await runGoverned({ choices: [{ message: { role: "assistant", content: invalidContent }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  assert.equal(result.exitCode, 1);
  assert.equal(host.completion.outcome.kind, "failure");
  assert.equal(host.completion.outcome.code, "invalid-output");
  assert.equal(host.completion.providerUsage.requestCharge, 1);
  assert.equal(host.completion.candidateProgram, null);
  assert.equal(host.completion.producedValue, null);
});
test("invalid governed output completes with parsed usage and the exact raw response receipt", async () => {
  const content = "private-invalid-governed-program";
  const response = { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } };
  const rawResponse = Buffer.from(JSON.stringify(response));
  const { host, result } = await runGoverned(response);
  assert.equal(result.exitCode, 1);
  assert.equal(host.completion.outcome.kind, "failure");
  assert.equal(host.completion.outcome.code, "invalid-program");
  assert.deepEqual(host.completion.providerUsage, {
    requestCharge: 1, inputTokens: 7, outputTokens: 4, totalTokens: 11, tokenLowerBound: 11,
    costUsd: null, tokenAccounting: "complete", costAccounting: "incomplete",
  });
  assert.equal(host.completion.responseDigest, digest(rawResponse));
  assert.equal(host.completion.responseBytes, rawResponse.byteLength);
  assert.equal(host.completion.responseBody, undefined);
  assert.equal(JSON.stringify(host.completion).includes(content), false);
});
