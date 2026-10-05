#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GovernanceFrameSchema,
  SCHEMA_VERSION,
  overlappingWritePaths,
  validateGovernanceFrames,
} from "../packages/schema/dist/index.js";
import { canonicalJson } from "../packages/persist/dist/index.js";
import { decodeItfValue, parseStepActions, readItfStates, requireContiguousCorpus } from "./lib/itf.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_PATH = join(root, "models", "governance-boundaries.qnt");
const STATE_COUNT = 41;
const FIELDS = [
  "phase", "controlMode", "taskStatus", "taskOwner", "approvalId", "approvalFresh", "claimOwner", "claimLive",
  "integration", "review", "component", "acceptance", "acceptanceFresh", "shipStatus", "preview", "confirmed",
  "preparedPreview", "explicitRetry",
];
const BOOLEAN_FIELDS = ["approvalFresh", "claimLive", "acceptanceFresh", "confirmed", "explicitRetry"];
const DOMAINS = {
  phase: new Set(["plan_ready", "executing", "ready_to_ship", "shipped", "abandoned"]),
  controlMode: new Set(["guarded", "advisory"]),
  claimOwner: new Set(["none", "c1", "c2"]),
  integration: new Set(["not-run", "running", "passed", "failed", "stale"]),
  review: new Set(["not-run", "running", "passed", "failed", "stale"]),
  component: new Set(["not-run", "running", "passed", "failed", "stale"]),
  acceptance: new Set(["not-recorded", "passed", "failed"]),
  shipStatus: new Set(["none", "prepared", "complete", "aborted"]),
  preview: new Set(["none", "p1", "p2"]),
  preparedPreview: new Set(["none", "p1", "p2"]),
};
const TASK_STATUSES = new Set(["todo", "ready", "in_progress", "verifying", "done", "blocked", "compacted"]);
const TASK_OWNERS = new Map([["none", null], ["w1", "worker-1"], ["w2", "worker-2"]]);
const CLAIM_OWNERS = new Map([["c1", "claim-owner-1"], ["c2", "claim-owner-2"]]);
const APPROVAL_IDS = new Map([[1, "approval-epoch-1"], [2, "approval-epoch-2"]]);
const TASKS = [
  { id: "TSK-0001", writes: ["src/model"] },
  { id: "TSK-0002", writes: ["src/other.ts"] },
  { id: "TSK-0003", writes: ["src/model/child.ts"] },
];
/** The model's fixed overlap relation (T0/T2); checked against the schema predicate at startup. */
const MODEL_OVERLAPS = new Set(["0:2", "2:0"]);
const ACCEPTANCE_ID = "AC-01";
const COMPONENT_ID = "c0";
const TRACE_APPROVAL_ID = "boundary-model-trace";
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const PREVIEW_DIGESTS = new Map([["p1", sha256("legion-cli-boundary-preview/p1")], ["p2", sha256("legion-cli-boundary-preview/p2")]]);
const TASK_CHECKS = new Map([
  ["todo", "not-run"], ["ready", "not-run"], ["in_progress", "not-run"], ["verifying", "running"],
  ["done", "passed"], ["compacted", "passed"], ["blocked", "failed"],
]);
/** Model action -> engine governance boundary; `null` marks control-mode changes made outside a boundary. */
const ACTIONS = new Map([
  ["approvalAdopt", { action: "approval-adopt", outcome: "success" }],
  ["claimAcquire", { action: "claim-acquire", outcome: "success" }],
  ["claimRelease", { action: "claim-release", outcome: "success" }],
  ["recover", { action: "recover", outcome: "success" }],
  ["taskStart", { action: "task-start", outcome: "success" }],
  ["taskVerify", { action: "task-verify", outcome: "success" }],
  ["taskComplete", { action: "task-complete", outcome: "success" }],
  ["taskBlock", { action: "task-block", outcome: "success" }],
  ["integrationStart", { action: "integration-start", outcome: "success" }],
  ["integrationComplete", { action: "integration-complete", outcome: "success" }],
  ["reviewStart", { action: "review-start", outcome: "success" }],
  ["reviewComplete", { action: "review-complete", outcome: "success" }],
  ["acceptanceRecord", { action: "acceptance-record", outcome: "success" }],
  ["shipPrepare", { action: "ship-prepare", outcome: "success" }],
  ["shipConfirm", { action: "ship-confirm", outcome: "success" }],
  ["shipComplete", { action: "ship-complete", outcome: "success" }],
  ["shipRollback", { action: "ship-rollback", outcome: "success" }],
  ["amendInputs", { action: "amend-inputs", outcome: "success" }],
  ["unblock", { action: "unblock", outcome: "success" }],
  ["undo", { action: "undo", outcome: "success" }],
  ["abandon", { action: "abandon", outcome: "success" }],
  ["compact", { action: "compact", outcome: "success" }],
  ["taskStartRefused", { action: "task-start", outcome: "refused" }],
  ["acceptanceRecordRefused", { action: "acceptance-record", outcome: "refused" }],
  ["shipPrepareRefused", { action: "ship-prepare", outcome: "refused" }],
  ["setAdvisory", null],
  ["setGuarded", null],
]);

function usage() {
  return [
    "Usage: node scripts/check-governance-boundaries.mjs --directory <itf-dir> --expected-traces <n>",
    "",
    "Decode every models/governance-boundaries.qnt --mbt ITF trace, map each state to a schema-valid",
    "GovernanceProjection, emit hash-chained begin/end frame pairs, and require validateGovernanceFrames",
    "to accept every trace. Then append one synthetic violating step per counterexample class to each",
    "trace and require exactly the expected violation code. Requires built schema and persist packages.",
  ].join("\n");
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage());
    process.exit(0);
  }
  let directory;
  let expectedTraces;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--directory" && args[i + 1]) {
      directory = args[++i];
    } else if (arg === "--expected-traces" && args[i + 1]) {
      const count = Number(args[++i]);
      if (!Number.isSafeInteger(count) || count < 1) throw new Error("--expected-traces must be a positive integer");
      expectedTraces = count;
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}\n${usage()}`);
    }
  }
  if (!directory || expectedTraces === undefined) throw new Error(`--directory and --expected-traces are required\n${usage()}`);
  return { directory: resolve(directory), expectedTraces };
}

function decodeState(raw, file, index) {
  const label = `${file}[${index}]`;
  const state = {};
  for (const field of FIELDS) state[field] = decodeItfValue(raw[field], `${label}.${field}`);
  for (const field of BOOLEAN_FIELDS) {
    if (typeof state[field] !== "boolean") throw new Error(`${label}: ${field} must be boolean`);
  }
  for (const [field, domain] of Object.entries(DOMAINS)) {
    if (!domain.has(state[field])) throw new Error(`${label}: ${field} has out-of-domain value ${JSON.stringify(state[field])}`);
  }
  if (!APPROVAL_IDS.has(state.approvalId)) throw new Error(`${label}: approvalId must be 1 or 2`);
  for (const field of ["taskStatus", "taskOwner"]) {
    const map = state[field];
    if (!(map instanceof Map) || map.size !== TASKS.length || TASKS.some((_, task) => !map.has(task))) {
      throw new Error(`${label}: ${field} must map exactly tasks 0..${TASKS.length - 1}`);
    }
  }
  for (const [task, status] of state.taskStatus) {
    if (!TASK_STATUSES.has(status)) throw new Error(`${label}: task ${task} status ${JSON.stringify(status)} is out of domain`);
    if (!TASK_OWNERS.has(state.taskOwner.get(task))) throw new Error(`${label}: task ${task} owner is out of domain`);
  }
  return state;
}

function project(state) {
  const claimOwner = state.claimOwner === "none" ? null : CLAIM_OWNERS.get(state.claimOwner);
  return {
    schemaVersion: SCHEMA_VERSION.governanceProjection,
    phase: state.phase,
    controlMode: state.controlMode,
    tasks: TASKS.map(({ id, writes }, task) => ({
      id,
      status: state.taskStatus.get(task),
      owner: TASK_OWNERS.get(state.taskOwner.get(task)),
      writes: [...writes],
      checks: TASK_CHECKS.get(state.taskStatus.get(task)),
    })),
    approval: { id: APPROVAL_IDS.get(state.approvalId), freshness: state.approvalFresh ? "current" : "stale" },
    claim: { owner: claimOwner, liveness: claimOwner === null ? "none" : state.claimLive ? "live" : "dead" },
    integration: state.integration,
    components: [{ checkId: COMPONENT_ID, status: state.component }],
    review: state.review,
    acceptance: [{ id: ACCEPTANCE_ID, status: state.acceptance, freshness: state.acceptanceFresh ? "current" : "stale" }],
    sourceFingerprint: state.preview === "none" ? null : PREVIEW_DIGESTS.get(state.preview),
    evidenceFingerprint: null,
    ship: {
      confirmationId: state.preparedPreview === "none" ? null : `confirmation-${state.preparedPreview}`,
      previewFingerprint: state.preparedPreview === "none" ? null : PREVIEW_DIGESTS.get(state.preparedPreview),
      confirmed: state.confirmed,
      status: state.shipStatus,
    },
  };
}

class FrameChain {
  constructor(modelDigest, frames = []) {
    this.modelDigest = modelDigest;
    this.frames = [...frames];
  }

  #append(fields) {
    const sequence = this.frames.length;
    const unsigned = {
      schemaVersion: SCHEMA_VERSION.governanceFrame,
      approvalId: TRACE_APPROVAL_ID,
      sequence,
      previousDigest: sequence === 0 ? null : this.frames[sequence - 1].digest,
      modelDigest: this.modelDigest,
      recordedAt: new Date(Date.UTC(2026, 0, 1) + sequence * 1000).toISOString(),
      ...fields,
    };
    const frame = { ...unsigned, digest: sha256(`legion-cli-governance-frame-digest/v1\n${canonicalJson(unsigned)}`) };
    const parsed = GovernanceFrameSchema.safeParse(frame);
    if (!parsed.success) throw new Error(`frame ${sequence} (${fields.action}) is not schema-valid: ${parsed.error.message}`);
    this.frames.push(frame);
  }

  boundary({ action, before, after, outcome, explicitRetry }) {
    const correlationId = `boundary-${this.frames.length}`;
    this.#append({ boundary: "begin", action, correlationId, before, after: null, outcome: "pending", explicitRetry });
    this.#append({ boundary: "end", action, correlationId, before, after, outcome, explicitRetry });
  }

  fork() {
    return new FrameChain(this.modelDigest, this.frames);
  }
}

function withTasks(projection, statusFor) {
  return {
    ...projection,
    tasks: projection.tasks.map((task, index) => {
      const status = statusFor(index, task.status);
      const active = status === "in_progress" || status === "verifying";
      return { ...task, status, owner: active ? task.owner ?? `worker-${index + 1}` : null, checks: TASK_CHECKS.get(status) };
    }),
  };
}

const passedChecks = (projection) => ({
  ...projection,
  integration: "passed",
  review: "passed",
  components: projection.components.map((component) => ({ ...component, status: "passed" })),
});
const current = (projection) => ({ ...projection, approval: { ...projection.approval, freshness: "current" } });
const idleTasks = (projection) => withTasks(projection, (_, status) => status === "in_progress" || status === "verifying" ? "blocked" : status);

/** One synthetic violating step per counterexample class, built from a trace's last projection. */
const COUNTEREXAMPLES = [
  {
    name: "stale acceptance",
    code: "stale-authority-use",
    steps: (last) => {
      const before = { ...passedChecks(last), approval: { ...last.approval, freshness: "stale" } };
      return [{ action: "acceptance-record", before, after: { ...before, acceptance: [{ id: ACCEPTANCE_ID, status: "passed", freshness: "current" }] } }];
    },
  },
  {
    name: "overlapping contracts",
    code: "overlapping-active-writes",
    steps: (last) => {
      const base = { ...current(last), controlMode: "guarded", phase: "executing" };
      const before = withTasks(base, (index, status) => index === 0 ? "in_progress" : index === 2 ? "ready" : status);
      return [{ action: "task-start", before, after: withTasks(before, (index, status) => index === 2 ? "in_progress" : status) }];
    },
  },
  {
    name: "advisory execution",
    code: "advisory-execution",
    steps: (last) => {
      const before = withTasks({ ...idleTasks(current(last)), controlMode: "advisory", phase: "executing" }, (index, status) => index === 1 ? "ready" : status);
      return [{ action: "task-start", before, after: withTasks(before, (index, status) => index === 1 ? "in_progress" : status) }];
    },
  },
  {
    name: "duplicate claim",
    code: "duplicate-claim",
    steps: (last) => {
      const before = { ...last, claim: { owner: CLAIM_OWNERS.get("c1"), liveness: "live" } };
      return [{ action: "claim-acquire", before, after: { ...before, claim: { owner: CLAIM_OWNERS.get("c2"), liveness: "live" } } }];
    },
  },
  {
    name: "implicit retry",
    code: "implicit-retry",
    steps: (last) => {
      const before = { ...idleTasks(current(last)), controlMode: "guarded", phase: "executing", integration: "failed" };
      return [{ action: "integration-start", before, after: { ...before, integration: "running" } }];
    },
  },
  {
    name: "changed preview",
    code: "preview-mismatch",
    steps: (last) => {
      const ready = {
        ...passedChecks(idleTasks(current(last))),
        controlMode: "guarded",
        phase: "ready_to_ship",
        acceptance: [{ id: ACCEPTANCE_ID, status: "passed", freshness: "current" }],
        ship: { confirmationId: null, previewFingerprint: null, confirmed: false, status: "none" },
      };
      const prepared = { ...ready, ship: { confirmationId: "confirmation-counterexample", previewFingerprint: PREVIEW_DIGESTS.get("p1"), confirmed: false, status: "prepared" } };
      const confirmed = { ...prepared, ship: { ...prepared.ship, previewFingerprint: PREVIEW_DIGESTS.get("p2"), confirmed: true } };
      return [
        { action: "ship-prepare", before: ready, after: prepared },
        { action: "ship-confirm", before: prepared, after: confirmed },
      ];
    },
  },
  {
    name: "rollback with complete",
    code: "rollback-claims-delivery",
    steps: (last) => {
      const before = {
        ...idleTasks(last),
        phase: "ready_to_ship",
        ship: { confirmationId: "confirmation-counterexample", previewFingerprint: PREVIEW_DIGESTS.get("p1"), confirmed: false, status: "prepared" },
      };
      return [{ action: "ship-rollback", before, after: { ...before, ship: { ...before.ship, status: "complete" } } }];
    },
  },
];

function assertOverlapRelation() {
  for (let a = 0; a < TASKS.length; a += 1) {
    for (let b = 0; b < TASKS.length; b += 1) {
      if (a === b) continue;
      const schemaOverlap = overlappingWritePaths([
        { id: TASKS[a].id, paths: TASKS[a].writes },
        { id: TASKS[b].id, paths: TASKS[b].writes },
      ]).length > 0;
      if (schemaOverlap !== MODEL_OVERLAPS.has(`${a}:${b}`)) {
        throw new Error(`model overlap relation disagrees with overlappingWritePaths for T${a}/T${b}`);
      }
    }
  }
}

function describe(violations) {
  return violations.map((violation) => `${violation.sequence}:${violation.code} (${violation.detail})`).join("; ");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = await readFile(MODEL_PATH);
  const modelActions = parseStepActions(source.toString("utf8"));
  if (modelActions.size !== ACTIONS.size || [...ACTIONS.keys()].some((name) => !modelActions.has(name))) {
    throw new Error(`Model/boundary action mapping mismatch; model step dispatches [${[...modelActions].join(", ")}]`);
  }
  assertOverlapRelation();
  const modelDigest = createHash("sha256").update(source).digest("hex");
  const files = await requireContiguousCorpus(options.directory, options.expectedTraces);
  const coverage = new Map([...ACTIONS.keys()].map((name) => [name, 0]));
  const rejected = new Map(COUNTEREXAMPLES.map(({ name }) => [name, 0]));
  const mismatches = [];
  let frameCount = 0;
  for (const file of files) {
    const states = await readItfStates(file, { fields: FIELDS, actions: modelActions, stateCount: STATE_COUNT });
    const decoded = states.map(({ raw }, index) => decodeState(raw, file, index));
    const chain = new FrameChain(modelDigest);
    for (let index = 1; index < states.length; index += 1) {
      const name = states[index].action;
      coverage.set(name, coverage.get(name) + 1);
      const boundary = ACTIONS.get(name);
      if (!boundary) continue;
      chain.boundary({
        action: boundary.action,
        outcome: boundary.outcome,
        explicitRetry: decoded[index].explicitRetry,
        before: project(decoded[index - 1]),
        after: project(decoded[index]),
      });
    }
    frameCount += chain.frames.length;
    const baseViolations = validateGovernanceFrames(chain.frames);
    if (baseViolations.length > 0) {
      mismatches.push(`${file}: model trace rejected: ${describe(baseViolations)}`);
      continue;
    }
    const last = project(decoded.at(-1));
    for (const counterexample of COUNTEREXAMPLES) {
      const fork = chain.fork();
      for (const step of counterexample.steps(last)) fork.boundary({ ...step, outcome: "success", explicitRetry: false });
      const violations = validateGovernanceFrames(fork.frames);
      const exact = violations.length > 0 &&
        violations.every((violation) => violation.code === counterexample.code && violation.sequence >= chain.frames.length);
      if (exact) rejected.set(counterexample.name, rejected.get(counterexample.name) + 1);
      else mismatches.push(`${file}: ${counterexample.name} expected only ${counterexample.code}, got ${describe(violations) || "no violation"}`);
    }
  }
  console.log(`Boundary model traces: ${files.length}; frames emitted: ${frameCount}`);
  console.log(`Boundary action coverage: ${[...coverage].map(([name, count]) => `${name}=${count}`).join(", ")}`);
  console.log(`Rejected counterexamples: ${[...rejected].map(([name, count]) => `${name}=${count}/${files.length}`).join(", ")}`);
  const totalRejected = [...rejected.values()].reduce((sum, count) => sum + count, 0);
  console.log(`Mismatches: ${mismatches.length}; rejected ${totalRejected}/${COUNTEREXAMPLES.length * files.length} counterexamples`);
  if (mismatches.length > 0) {
    for (const mismatch of mismatches.slice(0, 20)) console.error(mismatch);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS: validateGovernanceFrames accepted ${files.length} model traces and rejected every counterexample with its exact code.`);
}

main().catch((error) => {
  console.error(`Governance boundary check failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
