#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AssuranceApprovalSchema } from "../packages/schema/dist/index.js";
import { inspectGovernanceTrace } from "../packages/persist/dist/index.js";
import { stableHash } from "../packages/http/dist/index.js";
import { ASSURANCE_APPROVAL_PATH, LegionRefuseError } from "../packages/core/dist/index.js";
import { git, initGitRepo, quoteArg, withEngine } from "../packages/core/test/helpers.js";
import { decodeItfValue, decodeNondetPicks, parseStepActions, readItfStates, requireContiguousCorpus } from "./lib/itf.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_PATH = join(root, "models", "governance.qnt");
const CHILD_PATH = join(root, "scripts", "governance-replay-child.mjs");
const STATE_COUNT = 41;
const TASK_OUTPUTS = [
  { path: "src/model-replay-a.ts", content: 'export const result = "approved alpha";\n' },
  { path: "src/model-replay-b.ts", content: 'export const result = "approved beta";\n' },
  { path: "src/model-replay-c.ts", content: 'export const result = "approved gamma";\n' },
];
const FAILING_CONTENT = 'export const result = "not-approved";\n';
const BASE_MAX_FILES = 20;
const MAX_AMENDMENTS = 6;
const PROVIDER_KEY_ENV = "LEGION_GOVERNANCE_LOOPBACK_KEY";
const OPERATOR = { id: "governance-replay-operator" };
const INTERRUPT_TIMEOUT_MS = 120_000;
const ADOPTED_STALE_APPROVAL = /^assurance approval does not bind the current plan approval epoch; reapprove the plan$/;
const NONDET_PICKS = ["t", "outcome", "jobs", "verdict", "acceptanceStatus"];
const ACTIONS = new Set([
  "approvePlan",
  "setAdvisory",
  "setGuarded",
  "amendTask",
  "amendTaskOverlapDenied",
  "executeWorkflow",
  "executeRetry",
  "executeFailureUnchanged",
  "setReviewVerdict",
  "unblockTask",
  "undoTask",
  "executeWithoutApproval",
  "executeAdvisoryDenied",
  "recordAcceptance",
  "acceptanceDenied",
  "shipStaleApprovalDenied",
  "shipDeniedNotReady",
  "shipPreviewChangedDenied",
  "shipPrFailureRollback",
  "shipConfirmed",
  "interruptTask",
  "abandon",
  "readStatus",
]);
const SHIP_ACTIONS = new Set([
  "shipStaleApprovalDenied",
  "shipDeniedNotReady",
  "shipPreviewChangedDenied",
  "shipPrFailureRollback",
  "shipConfirmed",
]);
const MODEL_FIELDS = [
  "phase",
  "advisory",
  "approvalId",
  "approvalFresh",
  "taskStatus",
  "taskOutcome",
  "amendmentCount",
  "executionFresh",
  "reviewVerdict",
  "blockedAtReview",
  "acceptance",
  "acceptanceFresh",
  "productEdits",
  "shipped",
  "shippedApprovalId",
];
const BOOLEAN_FIELDS = ["advisory", "approvalFresh", "executionFresh", "blockedAtReview", "acceptanceFresh", "shipped"];
const PHASES = new Set(["plan_ready", "executing", "shipped", "abandoned"]);
const TASK_STATUSES = new Set(["todo", "ready", "in_progress", "done", "blocked"]);
const OUTCOMES = new Set(["pass", "fail"]);
const ACCEPTANCE_VALUES = new Set(["none", "passed", "failed"]);
/** Workflow status hides approval, evidence and acceptance once shipped; these fields are compared before shipping only. */
const UNOBSERVABLE_WHEN_SHIPPED = new Set(["approvalFresh", "executionFresh", "blockedAtReview", "acceptance", "acceptanceFresh"]);

function usage() {
  return [
    "Usage: node scripts/replay-governance-itf.mjs --directory <itf-directory> [--expected-traces <count>] [--jobs <count>] [--shard <index>/<count>]",
    "",
    "Replay Quint --mbt --out-itf traces of models/governance.qnt through public LegionEngine APIs in disposable,",
    "git-initialised, assurance-adopted (adapter-default) three-task projects.",
    "The directory must contain exactly trace0.itf.json through traceN.itf.json; each trace must include all 40 requested transitions.",
    "Every trace in the corpus is decoded and counted for action coverage; --shard i/n replays only traces whose index % n === i.",
    "The loopback provider is a deterministic test stimulus: it writes only task-contracted outputs, the plan body, and the",
    "review notes requested by the review prompt. The review verdict (Verdict: PASS or Verdict: FAIL plus one findings line)",
    "is a provider-stimulus seam selected by the model's setReviewVerdict action, like fakeArtifacts; the engine still decides",
    "the stage outcome from those notes. interruptTask SIGKILLs scripts/governance-replay-child.mjs while the provider holds",
    "task 0's request and then runs engine crash recovery.",
    "After every ship action and at the end of every trace, inspectGovernanceTrace must report a valid trace with no semantic",
    "violations for the current approval; at the end, every approval epoch the trace visited must be valid.",
    "Parallelism is bounded by --jobs (default 8); each trace runs in an isolated project with a local loopback provider.",
  ].join("\n");
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage());
    process.exit(0);
  }
  let directory;
  let expectedTraces = 1000;
  let jobs = 8;
  let shard = { index: 0, count: 1 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--directory" && args[i + 1]) {
      directory = args[++i];
    } else if (arg === "--expected-traces" && args[i + 1]) {
      const count = Number(args[++i]);
      if (!Number.isSafeInteger(count) || count < 1) throw new Error("--expected-traces must be a positive integer");
      expectedTraces = count;
    } else if (arg === "--jobs" && args[i + 1]) {
      const count = Number(args[++i]);
      if (!Number.isSafeInteger(count) || count < 1) throw new Error("--jobs must be a positive integer");
      jobs = count;
    } else if (arg === "--shard" && args[i + 1]) {
      const match = /^(\d+)\/(\d+)$/.exec(args[++i]);
      const index = Number(match?.[1]);
      const count = Number(match?.[2]);
      if (!match || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || index >= count) {
        throw new Error("--shard must be <index>/<count> with 0 <= index < count");
      }
      shard = { index, count };
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}\n${usage()}`);
    }
  }
  if (!directory) throw new Error(`--directory is required\n${usage()}`);
  return { directory: resolve(directory), expectedTraces, jobs, shard };
}

function decodeTaskMap(value, domain, label) {
  if (!(value instanceof Map) || value.size !== TASK_OUTPUTS.length) throw new Error(`${label} must map exactly tasks 0..${TASK_OUTPUTS.length - 1}`);
  for (let task = 0; task < TASK_OUTPUTS.length; task += 1) {
    if (!domain.has(value.get(task))) throw new Error(`${label}[${task}] is out of domain`);
  }
  return value;
}

function decodeModelState(raw, file, index) {
  const label = `${file}: state ${index}`;
  const state = {};
  for (const field of MODEL_FIELDS) state[field] = decodeItfValue(raw[field], `${file}[${index}].${field}`);
  for (const field of BOOLEAN_FIELDS) {
    if (typeof state[field] !== "boolean") throw new Error(`${label} ${field} must be boolean`);
  }
  if (!PHASES.has(state.phase)) throw new Error(`${label} has an invalid phase`);
  for (const field of ["approvalId", "shippedApprovalId"]) {
    if (![0, 1, 2].includes(state[field])) throw new Error(`${label} has an invalid ${field}`);
  }
  if (!Number.isInteger(state.amendmentCount) || state.amendmentCount < 0 || state.amendmentCount > MAX_AMENDMENTS) {
    throw new Error(`${label} has an invalid amendment count`);
  }
  if (!Number.isInteger(state.productEdits) || state.productEdits < 0 || state.productEdits > 2) {
    throw new Error(`${label} has an invalid product-edit count`);
  }
  if (!OUTCOMES.has(state.reviewVerdict)) throw new Error(`${label} has an invalid review verdict`);
  if (!ACCEPTANCE_VALUES.has(state.acceptance)) throw new Error(`${label} has an invalid acceptance value`);
  decodeTaskMap(state.taskStatus, TASK_STATUSES, `${label} taskStatus`);
  decodeTaskMap(state.taskOutcome, OUTCOMES, `${label} taskOutcome`);
  return state;
}

function decodePicks(raw, file, index) {
  const picks = decodeNondetPicks(raw["mbt::nondetPicks"], NONDET_PICKS, `${file}[${index}]`);
  const task = picks.get("t");
  if (task !== undefined && (!Number.isInteger(task) || task < 0 || task >= TASK_OUTPUTS.length)) throw new Error(`${file}[${index}]: task pick out of domain`);
  const jobs = picks.get("jobs");
  if (jobs !== undefined && jobs !== 1 && jobs !== 2) throw new Error(`${file}[${index}]: jobs pick out of domain`);
  return picks;
}

async function readTrace(path, modelActions) {
  const states = await readItfStates(path, {
    fields: [...MODEL_FIELDS, "mbt::nondetPicks"],
    actions: modelActions,
    stateCount: STATE_COUNT,
  });
  return states.map(({ action, raw }, index) => ({
    action,
    model: decodeModelState(raw, path, index),
    picks: decodePicks(raw, path, index),
  }));
}

function requirePick(picks, name, action) {
  if (!picks.has(name)) throw new Error(`${action} has no ${name} nondet pick`);
  return picks.get(name);
}

function verificationCommand(output, expectedContent = output.content) {
  const code = `const fs = require("node:fs"); if (fs.readFileSync(${JSON.stringify(output.path)}, "utf8") !== ${JSON.stringify(expectedContent)}) process.exit(1);`;
  return `${quoteArg(process.execPath)} -e ${quoteArg(code)}`;
}

/** Workflow integration command approved with the plan: every task output holds its approved content. */
function integrationCommand() {
  const expected = Object.fromEntries(TASK_OUTPUTS.map(({ path, content }) => [path, content]));
  const code = `const fs = require("node:fs"); const expected = ${JSON.stringify(expected)}; for (const [path, content] of Object.entries(expected)) if (fs.readFileSync(path, "utf8") !== content) process.exit(1);`;
  return `${quoteArg(process.execPath)} -e ${quoteArg(code)}`;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function assistantResponse(content, toolCalls) {
  return {
    id: "governance-loopback",
    object: "chat.completion",
    choices: [{
      index: 0,
      message: { role: "assistant", content: content ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls ? "tool_calls" : "stop",
    }],
  };
}

function reviewNotes(verdict) {
  return verdict === "pass"
    ? "Verdict: PASS\nFindings: every replayed task output matches its approved contract.\n"
    : "Verdict: FAIL\nFindings: the deterministic replay stimulus rejects this slice.\n";
}

async function startLoopbackProvider(providerContext) {
  let callNumber = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
        sendJson(response, 404, { error: "unknown endpoint" });
        return;
      }
      const body = await readRequest(request);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const prompt = messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
      const followUp = messages.some((message) => message.role === "tool");
      const reviewRunId = prompt.match(/\(runId=([A-Za-z0-9._-]+), skill=review\)/)?.[1];
      const taskId = reviewRunId ? undefined : prompt.match(/(?:^|\n)Task: (TSK-[A-Za-z0-9-]+)/)?.[1];
      const taskIndex = taskId ? providerContext.taskIds.indexOf(taskId) : -1;
      if (reviewRunId) providerContext.counts.review += 1;
      if (taskIndex >= 0) providerContext.counts.task += 1;
      if (followUp) {
        sendJson(response, 200, assistantResponse("The requested fixture operation is complete.", undefined));
        return;
      }
      const hold = providerContext.hold;
      if (hold && taskId === hold.taskId) {
        hold.responses.push(response);
        hold.arrived();
        return;
      }
      let path;
      let contents;
      const challengeRunId = prompt.match(/runId=([A-Za-z0-9._-]+)/)?.[1];
      if (reviewRunId) {
        path = `.legion-cli/cache/runs/${reviewRunId}/review.md`;
        contents = reviewNotes(providerContext.reviewVerdict);
      } else if (prompt.includes("skill=spec-challenge") && challengeRunId) {
        path = `.legion-cli/cache/runs/${challengeRunId}/analysis.json`;
        contents = JSON.stringify({ schemaVersion: "legion-cli-spec-challenge-analysis/v1", concerns: [] });
      } else if (taskIndex >= 0) {
        path = TASK_OUTPUTS[taskIndex].path;
        contents = TASK_OUTPUTS[taskIndex].content;
      } else {
        const planPath = prompt.match(/\.legion-cli\/plans\/[A-Za-z0-9._-]+\.md/)?.[0];
        if (planPath) {
          path = planPath;
          contents = "# Public API replay plan\n\nImplement the approved task contracts and run their verification commands.\n";
        }
      }
      const writeTool = body.tools?.find((tool) => tool.function?.name === "write_file");
      if (path && writeTool) {
        const call = {
          id: `governance-tool-${++callNumber}`,
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path, contents }) },
        };
        sendJson(response, 200, assistantResponse(null, [call]));
        return;
      }
      sendJson(response, 200, assistantResponse("No fixture operation applies to this request.", undefined));
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback provider did not bind a TCP port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function assuranceManifest(specId, acceptanceIds, taskIds) {
  return {
    schemaVersion: "legion-cli-assurance-plan/v1",
    specId,
    acceptanceIds,
    taskIds,
    security: {
      mode: "adapter-default",
      sources: TASK_OUTPUTS.map(({ path }, index) => ({ id: `output-${index}`, path, classification: "workspace" })),
      sinks: [],
      transformations: [],
      tasks: taskIds.map((taskId, index) => ({ taskId, readPaths: [TASK_OUTPUTS[index].path], transformationIds: [] })),
      externalCalls: [],
    },
    knowledge: [],
    validators: [],
    delivery: { artifacts: [] },
  };
}

async function prepareProject({ engine, dir, baseUrl, providerContext, manifestDir }) {
  await writeFile(join(dir, "README.md"), "# Governance replay fixture\n");
  initGitRepo(dir);
  await engine.init({
    name: "Governance API replay",
    adapter: "http",
    http: { baseUrl, model: "deterministic-loopback", apiKeyEnv: PROVIDER_KEY_ENV, allowLoopback: true },
    workflowProfile: "focused",
  });
  await engine.beginIntent();
  for (const answers of [
    ["Teammates who keep missing who's in the office.", "They ping five chat apps every morning."],
    ["People can tap in or out on their phone in under five seconds.", "No payroll, no badges, no calendar sync in v0."],
    ["existing auth"],
    ["Open the board, tap In, see yourself listed, tap Out, see yourself leave.", "Empty board, network error, changed mind."],
    ["board", "phone"],
    ["none", "none"],
  ]) {
    await engine.intentTurn(answers);
  }
  await engine.confirmIntent(OPERATOR);
  const proposed = await engine.startDiscuss();
  await engine.discuss(proposed.map(({ id }) => ({ id, status: "accepted" })));
  const spec = await engine.draftSpec({ skipWireframes: true });
  const challenge = await engine.prepareSpecChallenge(spec.id);
  if (challenge.status !== "complete" || challenge.pendingConcerns.length !== 0) {
    throw new Error(`loopback spec challenge did not complete cleanly: ${challenge.status}; ${challenge.automationError ?? "no automation error reported"}`);
  }
  await engine.approveSpec(spec.id, OPERATOR);
  for (const output of TASK_OUTPUTS) {
    const task = await engine.fileTicket({
      title: `Implement ${output.path}`,
      type: "feature",
      priority: "P0",
      notes: "Write the one contract-declared output and verify its exact contents.",
      contract: {
        filesAllowed: [output.path],
        expectedArtifacts: [output.path],
        verificationCommands: [verificationCommand(output)],
        maxFilesTouched: BASE_MAX_FILES,
      },
    });
    providerContext.taskIds.push(task.id);
  }
  if (providerContext.taskIds.some((id, index, ids) => index > 0 && ids[index - 1].localeCompare(id) >= 0)) {
    throw new Error("filed task ids are not ascending; the interrupt child selects task 0 as the lowest id");
  }
  const readiness = await engine.plan(spec.id);
  if (readiness !== "PASS" && readiness !== "CONCERNS") {
    throw new Error(`public plan operation did not reach readiness: ${readiness}`);
  }
  const tasks = await engine.listSliceTasks();
  if (tasks.length !== TASK_OUTPUTS.length || tasks.some((task) => task.status !== "ready")) {
    throw new Error("public setup did not produce three ready, contract-approved tasks");
  }
  const manifestPath = join(manifestDir, "assurance.yaml");
  const acceptanceIds = spec.acceptance.map(({ id }) => id);
  await writeFile(manifestPath, `${JSON.stringify(assuranceManifest(spec.id, acceptanceIds, [...providerContext.taskIds]), null, 2)}\n`);
  await engine.approvePlan(OPERATOR, { assuranceManifestPath: manifestPath, verificationCommands: [integrationCommand()] });
  return { taskIds: [...providerContext.taskIds] };
}

async function expectRefusal(label, call, expectedMessage) {
  try {
    await call();
  } catch (error) {
    if (!(error instanceof LegionRefuseError) || (expectedMessage && !expectedMessage.test(error.message))) {
      throw new Error(`${label} returned an unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function currentApprovalId(engine) {
  return (await engine.store.readYaml(ASSURANCE_APPROVAL_PATH, AssuranceApprovalSchema)).approvalId;
}

async function governanceModelDigest(engine) {
  const config = await engine.store.readConfig();
  return stableHash({
    adapter: config.adapter ?? null,
    profiles: config.adapter.profiles ?? null,
    skillProfiles: config.adapter.skillProfiles ?? null,
  });
}

async function requireValidGovernance(engine, approvalId, label) {
  const { trace, violations } = await inspectGovernanceTrace(engine.store, approvalId, await governanceModelDigest(engine));
  if (trace.status !== "valid" || violations.length !== 0) {
    const detail = violations.map((violation) => `${violation.sequence}:${violation.code} ${violation.detail}`).join("; ");
    throw new Error(`${label}: governance trace for approval ${approvalId} is ${trace.status}${detail ? `; violations: ${detail}` : ""}`);
  }
  return trace;
}

const unexpectedConfirmation = async () => {
  throw new Error("ship reached preview confirmation in a state the model marks as refused before preparation");
};

async function interruptTask(engine, context) {
  const taskId = context.taskIds[0];
  let arrived;
  const arrival = new Promise((resolvePromise) => { arrived = resolvePromise; });
  context.providerContext.hold = { taskId, responses: [], arrived };
  const child = spawn(process.execPath, [CHILD_PATH, context.dir, context.baseUrl], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolvePromise) => child.once("exit", (code, signal) => resolvePromise({ code, signal })));
  try {
    let timer;
    const outcome = await Promise.race([
      arrival.then(() => "held"),
      exited.then(() => "exited"),
      new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise("timeout"), INTERRUPT_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (outcome !== "held") throw new Error(`interrupt child did not reach the held task request (${outcome}): ${output.trim()}`);
    child.kill("SIGKILL");
    const { signal, code } = await exited;
    if (signal !== "SIGKILL" && code === 0) throw new Error(`interrupt child exited cleanly instead of being killed: ${output.trim()}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    for (const response of context.providerContext.hold.responses) response.destroy();
    context.providerContext.hold = null;
  }
  await engine.recoverStaleInProgress();
}

async function invokeAction(step, engine, context) {
  const { action, picks, model: after } = step;
  switch (action) {
    case "init": {
      Object.assign(context, await prepareProject(context.setup()));
      return;
    }
    case "approvePlan":
      await engine.approvePlan(OPERATOR);
      return;
    case "setAdvisory":
      await engine.setControlMode("advisory");
      return;
    case "setGuarded":
      await engine.setControlMode("guarded");
      return;
    case "amendTask": {
      const index = requirePick(picks, "t", action);
      const outcome = requirePick(picks, "outcome", action);
      const taskId = context.taskIds[index];
      const task = (await engine.listSliceTasks()).find(({ id }) => id === taskId);
      await engine.amendTask(taskId, {
        ...task.contract,
        maxFilesTouched: BASE_MAX_FILES + after.amendmentCount,
        verificationCommands: [verificationCommand(TASK_OUTPUTS[index], outcome === "pass" ? TASK_OUTPUTS[index].content : FAILING_CONTENT)],
      });
      return;
    }
    case "amendTaskOverlapDenied": {
      const taskId = context.taskIds[2];
      const task = (await engine.listSliceTasks()).find(({ id }) => id === taskId);
      await expectRefusal("overlapping amendment", () => engine.amendTask(taskId, {
        ...task.contract,
        filesAllowed: [TASK_OUTPUTS[0].path, TASK_OUTPUTS[2].path],
      }), /^overlapping filesAllowed /);
      return;
    }
    case "executeWorkflow":
      await engine.executeWorkflow({ jobs: requirePick(picks, "jobs", action), untilBlocked: true });
      return;
    case "executeRetry":
      await engine.executeWorkflow({ retry: true });
      return;
    case "executeFailureUnchanged": {
      const counts = { ...context.providerContext.counts };
      const result = await engine.executeWorkflow({ jobs: 1, untilBlocked: true });
      if (result.status !== "blocked") throw new Error(`an unchanged failed workflow stage returned ${result.status} instead of blocked`);
      assert.deepEqual(context.providerContext.counts, counts, "an unchanged failed task or review stage was retried without --retry");
      return;
    }
    case "setReviewVerdict":
      context.providerContext.reviewVerdict = requirePick(picks, "verdict", action);
      return;
    case "unblockTask":
      await engine.unblockTask(context.taskIds[requirePick(picks, "t", action)]);
      return;
    case "undoTask":
      await engine.undoLastTask({ taskId: context.taskIds[requirePick(picks, "t", action)] });
      return;
    case "executeWithoutApproval":
      await expectRefusal("execute after the approval became stale", () => engine.executeWorkflow(), ADOPTED_STALE_APPROVAL);
      return;
    case "executeAdvisoryDenied":
      await expectRefusal("advisory execute", () => engine.executeWorkflow(), /^Execute is off in advisory mode$/);
      return;
    case "recordAcceptance": {
      const status = requirePick(picks, "acceptanceStatus", action);
      const required = (await engine.getWorkflowStatus()).acceptance.required;
      if (required.length === 0) throw new Error("the replayed spec has no required acceptance criteria");
      await engine.recordAcceptance(required.map((id) => ({
        id,
        status,
        ...(status === "failed" ? { note: "The deterministic replay recorded a failed acceptance check." } : {}),
      })), OPERATOR);
      return;
    }
    case "acceptanceDenied": {
      const required = (await engine.getWorkflowStatus()).acceptance.required;
      await expectRefusal("acceptance without fresh workflow evidence",
        () => engine.recordAcceptance(required.map((id) => ({ id, status: "passed" })), OPERATOR),
        /^complete, fresh workflow evidence is required before acceptance$/);
      return;
    }
    case "shipStaleApprovalDenied":
      await expectRefusal("ship after the approval became stale",
        () => engine.ship({ commit: true, confirm: unexpectedConfirmation }), ADOPTED_STALE_APPROVAL);
      return;
    case "shipDeniedNotReady":
      await expectRefusal("ship before the workflow is ready", () => engine.ship({ commit: true, confirm: unexpectedConfirmation }));
      return;
    case "shipPreviewChangedDenied": {
      const notePath = `docs/replay-note-${after.productEdits}.md`;
      await expectRefusal("ship after the confirmed preview changed", () => engine.ship({
        commit: true,
        confirm: async () => {
          await mkdir(join(context.dir, "docs"), { recursive: true });
          await writeFile(join(context.dir, notePath), `# Replay note ${after.productEdits}\n`);
          git(context.dir, ["add", "--", notePath]);
          return true;
        },
      }), /^ship staged files changed between preview and commit$/);
      return;
    }
    case "shipPrFailureRollback": {
      let rejected = false;
      try {
        await engine.ship({
          commit: true,
          pr: true,
          confirm: async () => true,
          prCreate: () => ({ error: "replay PR failure" }),
        });
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("ship with a failing pull request unexpectedly succeeded");
      const trace = await requireValidGovernance(engine, await currentApprovalId(engine), "PR failure rollback");
      const last = trace.frames.at(-1);
      if (last?.boundary !== "end" || last.action !== "ship-rollback" || last.outcome !== "success") {
        throw new Error(`PR failure did not end the governance trace with a successful ship-rollback (last: ${last?.boundary} ${last?.action} ${last?.outcome})`);
      }
      return;
    }
    case "shipConfirmed":
      await engine.ship({ commit: true, confirm: async () => true });
      context.shippedApprovalId = ((context.approvalIds.length - 1) % 2) + 1;
      return;
    case "interruptTask":
      await interruptTask(engine, context);
      return;
    case "abandon":
      await engine.abandon("The deterministic model replay selected the public abandon operation.");
      return;
    case "readStatus":
      await engine.getWorkflowStatus();
      return;
    default:
      throw new Error(`No public LegionEngine dispatcher for model action ${action}`);
  }
}

function observeAcceptance(workflowStatus) {
  const { required, passed, failed } = workflowStatus.acceptance;
  if (required.length > 0 && required.every((id) => passed.includes(id))) return { acceptance: "passed", acceptanceFresh: true };
  if (required.length > 0 && required.every((id) => failed.includes(id))) return { acceptance: "failed", acceptanceFresh: true };
  return { acceptance: null, acceptanceFresh: false };
}

async function countProductEdits(dir) {
  try {
    return (await readdir(join(dir, "docs"))).filter((name) => /^replay-note-\d+\.md$/.test(name)).length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function observe(engine, expected, context, label) {
  const [state, controlMode, workflowStatus, tasks, approvalId, productEdits] = await Promise.all([
    engine.getState(),
    engine.getControlMode(),
    engine.getWorkflowStatus(),
    engine.listSliceTasks(),
    currentApprovalId(engine),
    countProductEdits(context.dir),
  ]);
  if (approvalId !== context.approvalIds.at(-1)) context.approvalIds.push(approvalId);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (tasks.length !== TASK_OUTPUTS.length || context.taskIds.some((id) => !byId.has(id))) {
    throw new Error(`${label}: public task listing changed the three-task replay fixture`);
  }
  const ordered = context.taskIds.map((id) => byId.get(id));
  const acceptance = observeAcceptance(workflowStatus);
  const actual = {
    phase: state.phase,
    advisory: controlMode === "advisory",
    approvalId: ((context.approvalIds.length - 1) % 2) + 1,
    approvalFresh: workflowStatus.planApproval === "valid",
    taskStatus: new Map(ordered.map((task, index) => [index, task.status])),
    taskOutcome: new Map(ordered.map((task, index) => [
      index,
      task.contract.verificationCommands.length === 1 && task.contract.verificationCommands[0] === verificationCommand(TASK_OUTPUTS[index]) ? "pass" : "fail",
    ])),
    amendmentCount: Math.max(...ordered.map((task) => task.contract.maxFilesTouched)) - BASE_MAX_FILES,
    executionFresh: workflowStatus.execution === "complete",
    reviewVerdict: context.providerContext.reviewVerdict,
    blockedAtReview: workflowStatus.execution === "blocked" && Boolean(workflowStatus.blocker?.startsWith("independent review")),
    acceptance: acceptance.acceptance,
    acceptanceFresh: acceptance.acceptanceFresh,
    productEdits,
    shipped: state.phase === "shipped",
    shippedApprovalId: context.shippedApprovalId,
  };
  for (const field of MODEL_FIELDS) {
    if (expected.phase === "shipped" && UNOBSERVABLE_WHEN_SHIPPED.has(field)) continue;
    if (field === "acceptance" && !expected.acceptanceFresh) continue;
    const wanted = expected[field];
    const observed = actual[field];
    if (wanted instanceof Map) {
      for (const [key, value] of wanted) assert.equal(observed.get(key), value, `${label}: ${field}[${key}]`);
    } else {
      assert.equal(observed, wanted, `${label}: ${field}`);
    }
  }
}

async function replayOneTrace(tracePath, states) {
  const providerContext = { taskIds: [], reviewVerdict: "pass", counts: { task: 0, review: 0 }, hold: null };
  const { server, baseUrl } = await startLoopbackProvider(providerContext);
  const manifestDir = await mkdtemp(join(tmpdir(), "legion-governance-manifest-"));
  try {
    await withEngine(async ({ engine, dir }) => {
      const context = {
        dir,
        baseUrl,
        providerContext,
        taskIds: [],
        approvalIds: [],
        shippedApprovalId: 0,
        setup: () => ({ engine, dir, baseUrl, providerContext, manifestDir }),
      };
      for (const [index, step] of states.entries()) {
        const label = `${tracePath} state ${index} after ${step.action}`;
        try {
          await invokeAction(step, engine, context);
          await observe(engine, step.model, context, label);
          if (SHIP_ACTIONS.has(step.action)) await requireValidGovernance(engine, context.approvalIds.at(-1), label);
        } catch (error) {
          throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }
      for (const approvalId of new Set(context.approvalIds)) {
        await requireValidGovernance(engine, approvalId, `${tracePath} end of trace`);
      }
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(manifestDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const modelActions = parseStepActions(await readFile(MODEL_PATH, "utf8"));
  if (modelActions.size !== ACTIONS.size || [...ACTIONS].some((name) => !modelActions.has(name))) {
    throw new Error(`Model/API action mapping mismatch; model step dispatches [${[...modelActions].join(", ")}]`);
  }
  const files = await requireContiguousCorpus(options.directory, options.expectedTraces);
  const counts = new Map([["init", 0], ...[...modelActions].map((action) => [action, 0])]);
  const selected = [];
  for (const [index, file] of files.entries()) {
    const states = await readTrace(file, modelActions);
    for (const state of states) counts.set(state.action, counts.get(state.action) + 1);
    if (index % options.shard.count === options.shard.index) selected.push({ file, states });
  }
  const uncovered = [...modelActions].filter((action) => counts.get(action) === 0);
  if (uncovered.length > 0 && options.expectedTraces === 1000) {
    throw new Error(`The deterministic trace corpus did not exercise model actions: ${uncovered.join(", ")}`);
  }
  if (uncovered.length > 0) console.log(`Bounded probe did not sample these actions: ${uncovered.join(", ")}`);
  const previousKey = process.env[PROVIDER_KEY_ENV];
  process.env[PROVIDER_KEY_ENV] = "loopback-only-test-stimulus";
  let completed = 0;
  let nextTrace = 0;
  let firstFailure;
  const worker = async () => {
    while (firstFailure === undefined) {
      const index = nextTrace;
      nextTrace += 1;
      if (index >= selected.length) return;
      try {
        await replayOneTrace(selected[index].file, selected[index].states);
        completed += 1;
        if (completed % 25 === 0 || completed === selected.length) {
          console.log(`Replayed ${completed}/${selected.length} shard traces through LegionEngine public APIs`);
        }
      } catch (error) {
        firstFailure ??= error;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(options.jobs, selected.length) }, () => worker()));
    if (firstFailure !== undefined) throw firstFailure;
  } finally {
    if (previousKey === undefined) delete process.env[PROVIDER_KEY_ENV];
    else process.env[PROVIDER_KEY_ENV] = previousKey;
  }
  console.log(`Governance API action coverage (whole corpus): ${[...counts].map(([action, count]) => `${action}=${count}`).join(", ")}`);
  console.log(`PASS: shard ${options.shard.index}/${options.shard.count} replayed ${selected.length} of ${files.length} complete traces with valid governance traces and no semantic violations.`);
}

main().catch((error) => {
  console.error(`Governance ITF replay failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
