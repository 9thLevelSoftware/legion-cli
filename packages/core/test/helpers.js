import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LegionEngine, projectSourceIdentity, qaSpecHash } from "../dist/index.js";
import { specHasUi } from "@9thlevelsoftware/legion-cli-qa";

export function quoteArg(value) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function passingVerificationCommand() {
  return `${quoteArg(process.execPath)} -e process.exit(0)`;
}

export function failingVerificationCommand() {
  return `${quoteArg(process.execPath)} -e process.exit(1)`;
}

export function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

export function gitHead(dir) {
  return git(dir, ["rev-parse", "HEAD"]);
}

export function initGitRepo(dir) {
  git(dir, ["init"]);
  git(dir, ["config", "user.name", "9thLevelSoftware"]);
  git(dir, ["config", "user.email", "engineering@9thlevelsoftware.com"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
  return gitHead(dir);
}

export function commitAll(dir, message = "seed") {
  git(dir, ["add", "-A"]);
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if ((status.stdout ?? "").trim() === "") return gitHead(dir);
  git(dir, ["commit", "-m", message]);
  return gitHead(dir);
}

export async function withEngine(fn, options) {
  const dir = await mkdtemp(join(tmpdir(), "legion-core-"));
  try {
    const engine = new LegionEngine(dir, undefined, { fakeQaScoreInjection: true, ...options });
    await fn({ dir, engine, store: engine.store });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function readLatestRunPrompt(dir, skillId) {
  const runsDir = join(dir, ".legion-cli", "cache", "runs");
  const names = (await readdir(runsDir)).filter((name) => name.startsWith(`${skillId}-`));
  if (names.length === 0) {
    throw new Error(`no ${skillId} run under ${runsDir}`);
  }
  names.sort();
  return readFile(join(runsDir, names[names.length - 1], "prompt.md"), "utf8");
}

export async function withFakeAdapter(fn) {
  const previous = process.env.LEGION_CLI_ADAPTER;
  process.env.LEGION_CLI_ADAPTER = "fake";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.LEGION_CLI_ADAPTER;
    else process.env.LEGION_CLI_ADAPTER = previous;
  }
}

export async function initProject(engine, opts = {}) {
  await engine.init({ name: "Checkin", adapter: "fake", ...opts });
  if (opts.keepSandbox) return;
  const config = await engine.store.readConfig();
  await engine.store.writeConfig({
    ...config,
    sandbox: { ...config.sandbox, allowCopyJail: true },
  });
}

/** Grok on PATH is still unspawnable when args omit {{pointer}}. */
export async function writeUnspawnableGrok(store, extra = {}) {
  const config = await store.readConfig();
  await store.writeConfig({
    ...config,
    adapter: {
      ...config.adapter,
      grok: { args: ["--model", "grok-4"] },
      ...extra,
    },
  });
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
    schemaVersion: "legion-cli-qa/v2",
    id: "qa-1",
    specId: "spec-checkin",
    mode: "full",
    buckets: {
      p0: { points: 40, max: 40, failed: 0 },
      p1: { points: 30, max: 30, passRate: 1 },
      p2: { points: 15, max: 15, passRate: 1 },
      visual: { points: 15, max: 15, regressions: 0 },
    },
    total: 100,
    pass: true,
    evidencePaths: [".legion-cli/qa/scores/qa-1.json"],
    createdAt: "2026-09-01T12:00:00Z",
    criteria: [
      { id: "AC-01", priority: "P0", outcome: "passed" },
    ],
    missingCriterionIds: [],
    failedCriterionIds: [],
    skippedCriterionIds: [],
    reportFailures: 0,
    specHash: "0".repeat(64),
    sourceHash: "0".repeat(64),
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
  const state = (await store.readState()).data;
  const spec = await store.readSpec(state.activeSpecId);
  const evidenceDir = join(store.paths.qaDir, "runs", score.id);
  await mkdir(evidenceDir, { recursive: true });
  const tests = score.criteria.flatMap((criterion) => {
    if (criterion.outcome === "missing") return [];
    return [{
      title: `criterion ${criterion.id} @ac(${criterion.id})`,
      status: criterion.outcome === "passed" ? "passed" : criterion.outcome === "failed" ? "failed" : "skipped",
    }];
  });
  if (tests.length === 0) tests.push({ title: "unlinked passing test", status: "passed" });
  const criterionFailures = score.criteria.filter((criterion) => criterion.outcome === "failed").length;
  const visualFailures = score.mode === "full" ? score.buckets.visual.regressions : 0;
  const visualTests = [];
  for (let i = 0; i < visualFailures; i += 1) {
    visualTests.push({ title: `visual regression ${i + 1} @visual`, status: "failed", visualFailure: true });
  }
  for (let i = criterionFailures + visualFailures; i < score.reportFailures; i += 1) {
    tests.push({ title: `unlinked report failure ${i + 1}`, status: "failed" });
  }
  await writeFile(join(evidenceDir, "unit.json"), `${JSON.stringify({ tests }, null, 2)}\n`, "utf8");
  await writeFile(
    join(evidenceDir, "unit.meta.json"),
    `${JSON.stringify({ version: 1, kind: "unit", capture: { started: true, status: 0, timedOut: false } }, null, 2)}\n`,
    "utf8",
  );
  const evidencePaths = [
    `.legion-cli/qa/runs/${score.id}/unit.json`,
    `.legion-cli/qa/runs/${score.id}/unit.meta.json`,
  ];
  if (score.mode === "full" && specHasUi(spec.data)) {
    const playwrightTests = visualTests.length > 0
      ? visualTests
      : [{ title: "playwright smoke", status: "passed" }];
    await writeFile(
      join(evidenceDir, "playwright.json"),
      `${JSON.stringify({ tests: playwrightTests }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(evidenceDir, "playwright.meta.json"),
      `${JSON.stringify({ version: 1, kind: "playwright", capture: { started: true, status: 0, timedOut: false } }, null, 2)}\n`,
      "utf8",
    );
    evidencePaths.push(
      `.legion-cli/qa/runs/${score.id}/playwright.json`,
      `.legion-cli/qa/runs/${score.id}/playwright.meta.json`,
    );
  }
  if (score.mode === "no-browser") {
    const passedCriterionIds = score.criteria
      .filter((criterion) => criterion.outcome === "passed")
      .map((criterion) => criterion.id)
      .sort();
    await writeFile(
      join(evidenceDir, "manual.json"),
      `${JSON.stringify({ version: 1, kind: "manual", specId: state.activeSpecId, passedCriterionIds }, null, 2)}\n`,
      "utf8",
    );
    evidencePaths.push(`.legion-cli/qa/runs/${score.id}/manual.json`);
  }
  score = {
    ...score,
    specId: state.activeSpecId,
    evidencePaths,
    specHash: qaSpecHash(spec.data, spec.body),
    sourceHash: await projectSourceIdentity(store.projectRoot),
  };
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

/** Positive review evidence: what a reviewer that really ran leaves behind (the engine then copies it to qa/review.md). */
export const REVIEW_NOTES_ARTIFACT = {
  path: ".legion-cli/cache/runs/<id>/review.md",
  content: "# Review\n\nRead the spec and every task; the slice meets the acceptance criteria.\n",
};

/** Engine options for a reviewer that wrote notes. Do not share with execute: an artifact outside its contract blocks the task. */
export function withReviewNotes(options = {}) {
  return { ...options, fakeArtifacts: [...(options.fakeArtifacts ?? []), REVIEW_NOTES_ARTIFACT] };
}
