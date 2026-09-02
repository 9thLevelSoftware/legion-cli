import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LegionEngine } from "../dist/index.js";

export async function withEngine(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-core-"));
  try {
    const engine = new LegionEngine(dir);
    await fn({ dir, engine, store: engine.store });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function initProject(engine, opts = {}) {
  await engine.init({ name: "Checkin", adapter: "fake", ...opts });
}

export function makeSpec(overrides = {}) {
  return {
    schemaVersion: "legion-cli-spec/v1",
    id: "spec-checkin",
    title: "Office check-in",
    status: "draft",
    mustBeTrue: ["People can tap in or out on their phone in under five seconds"],
    mustNotChange: ["auth"],
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
    ...overrides,
  };
}

export function makeTask(overrides = {}) {
  const { contract, ...rest } = overrides;
  return {
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
    ...rest,
    contract: {
      filesAllowed: ["src/main.ts"],
      filesForbidden: [".git/**"],
      expectedArtifacts: ["src/main.ts"],
      verificationCommands: ["pnpm test"],
      maxFilesTouched: 20,
      ...contract,
    },
  };
}

export function makeQaScore(overrides = {}) {
  return {
    schemaVersion: "legion-cli-qa/v1",
    id: "qa-1",
    specId: "spec-checkin",
    mode: "full",
    buckets: {
      p0: { points: 40, max: 40, failed: 0 },
      p1: { points: 27, max: 30, passRate: 0.9 },
      p2: { points: 12, max: 15, passRate: 0.8 },
      visual: { points: 15, max: 15, regressions: 0 },
    },
    total: 94,
    pass: true,
    evidencePaths: [".legion-cli/qa/scores/qa-1.json"],
    createdAt: "2026-09-01T12:00:00Z",
    ...overrides,
  };
}

export async function patchState(store, patch) {
  const doc = await store.readState();
  await store.writeState({ ...doc.data, ...patch }, doc.body);
}

export async function writeSpec(store, spec, body = "Spec body.\n") {
  await store.writeSpec(spec, body);
}

export async function writeTask(store, task, body = "Task body.\n") {
  await store.writeTask(task, body);
}

export async function writeQaFile(store, score) {
  const dir = join(store.paths.qaDir, "scores");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${score.id}.json`), `${JSON.stringify(score, null, 2)}\n`, "utf8");
}

export async function seedFrozenSpec(store, specOverrides = {}) {
  const spec = makeSpec({
    status: "frozen",
    frozenAt: "2026-09-01T12:00:00.000Z",
    frozenBy: "tester",
    ...specOverrides,
  });
  await writeSpec(store, spec);
  const project = await store.readProject();
  await store.writeProject({ ...project.data, activeSpecId: spec.id }, project.body);
  await patchState(store, { phase: "spec_frozen", activeSpecId: spec.id });
  return spec;
}

export async function seedPlanReady(store, opts = {}) {
  const spec = await seedFrozenSpec(store, opts.spec ?? {});
  const task = makeTask({ status: "ready", ...(opts.task ?? {}) });
  await writeTask(store, task);
  if (opts.extraTasks) {
    for (const extra of opts.extraTasks) {
      await writeTask(store, extra);
    }
  }
  await patchState(store, {
    phase: opts.phase ?? "plan_ready",
    activeSpecId: spec.id,
    lastReadiness: opts.lastReadiness ?? "PASS",
    lastReview: opts.lastReview ?? null,
    lastQaId: opts.lastQaId ?? null,
    currentTaskId: opts.currentTaskId ?? null,
  });
  return { spec, task };
}
