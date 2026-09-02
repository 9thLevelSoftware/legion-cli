import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

import {
  computeQaPass,
  DesignSystemPackageSchema,
  BrownfieldRunSchema,
  FileContractSchema,
  JSON_SCHEMA_FILES,
  LegionConfigSchema,
  legionJsonSchemas,
  PhaseSchema,
  ProjectFileSchema,
  QAScoreSchema,
  SCHEMA_VERSION,
  SkillContractSchema,
  SpecSchema,
  StateFileSchema,
  TaskSchema,
} from "../dist/index.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  assert.ok(match, "expected YAML frontmatter");
  return parseYaml(match[1]);
}

function readFixture(name) {
  return readFileSync(join(pkgRoot, "test", "fixtures", name), "utf8");
}

function readSnapshot(name) {
  return JSON.parse(readFileSync(join(pkgRoot, "test", "snapshots", name), "utf8"));
}

test("PROJECT.md frontmatter snapshot", () => {
  const parsed = parseFrontmatter(readFixture("PROJECT.md"));
  const result = ProjectFileSchema.parse(parsed);
  assert.deepEqual(result, readSnapshot("PROJECT.json"));
});

test("STATE.md frontmatter snapshot", () => {
  const parsed = parseFrontmatter(readFixture("STATE.md"));
  const result = StateFileSchema.parse(parsed);
  assert.deepEqual(result, readSnapshot("STATE.json"));
});

test("SPEC.md frontmatter snapshot", () => {
  const parsed = parseFrontmatter(readFixture("SPEC.md"));
  const result = SpecSchema.parse(parsed);
  assert.deepEqual(result, readSnapshot("SPEC.json"));
});

test("unknown schemaVersion fail-closed", () => {
  const project = ProjectFileSchema.safeParse({
    schemaVersion: "legion-cli-project/v2",
    name: "Checkin",
    mode: "greenfield",
    controlMode: "guarded",
  });
  assert.equal(project.success, false);

  const state = StateFileSchema.safeParse({
    schemaVersion: "nope",
    phase: "executing",
  });
  assert.equal(state.success, false);

  const spec = SpecSchema.safeParse({
    schemaVersion: "legion-cli-spec/v1.1",
    id: "spec-checkin",
    title: "Office check-in",
    status: "draft",
    mustBeTrue: ["x"],
    mustNotChange: [],
    outOfScope: [],
    acceptance: [],
    personas: [],
    happyPath: "",
  });
  assert.equal(spec.success, false);
});

test("schemaVersion literals match the design", () => {
  assert.equal(SCHEMA_VERSION.project, "legion-cli-project/v1");
  assert.equal(SCHEMA_VERSION.state, "legion-cli-state/v1");
  assert.equal(SCHEMA_VERSION.context, "legion-cli-context/v1");
  assert.equal(SCHEMA_VERSION.intentAnswers, "legion-cli-intent-answers/v1");
  assert.equal(SCHEMA_VERSION.config, "legion-cli-config/v1");
  assert.equal(SCHEMA_VERSION.spec, "legion-cli-spec/v1");
  assert.equal(SCHEMA_VERSION.task, "legion-cli-task/v1");
  assert.equal(SCHEMA_VERSION.assumption, "legion-cli-assumption/v1");
  assert.equal(SCHEMA_VERSION.discuss, "legion-cli-discuss/v1");
  assert.equal(SCHEMA_VERSION.ingest, "legion-cli-ingest/v1");
  assert.equal(SCHEMA_VERSION.audit, "legion-cli-audit/v1");
  assert.equal(SCHEMA_VERSION.resume, "legion-cli-resume/v1");
  assert.equal(SCHEMA_VERSION.run, "legion-cli-run/v1");
  assert.equal(SCHEMA_VERSION.qa, "legion-cli-qa/v1");
  assert.equal(SCHEMA_VERSION.brief, "legion-cli-brief/v1");
  assert.equal(SCHEMA_VERSION.designSystem, "legion-cli-design-system/v1");
  assert.equal(SCHEMA_VERSION.designActive, "legion-cli-design-active/v1");
});

test("DesignSystemPackage is legion-cli-design-system/v1", () => {
  const pkg = DesignSystemPackageSchema.parse({
    schemaVersion: "legion-cli-design-system/v1",
    id: "acme",
    name: "Acme",
    description: "Brand",
    source: { type: "local", origin: "/tmp/acme" },
    files: { design: "DESIGN.md", tokens: "tokens.css" },
  });
  assert.equal(pkg.schemaVersion, "legion-cli-design-system/v1");
  assert.equal(
    DesignSystemPackageSchema.safeParse({
      schemaVersion: "od-design-system-project/v1",
      id: "acme",
      name: "Acme",
      description: "Brand",
      source: { type: "local", origin: "/tmp/acme" },
      files: { design: "DESIGN.md", tokens: "tokens.css" },
    }).success,
    false,
  );
});

test("BrownfieldRunSchema requires 8-hex runId and resume fields", () => {
  const run = {
    schemaVersion: "legion-cli-run/v1",
    runId: "a1b2c3d4",
    effort: 1,
    execute: false,
    phase: "complete",
    preSpawnRef: "abc123",
    startedAt: "2026-09-01T12:00:00Z",
    worktreePath: null,
    promoted: false,
    pages: ["intent.md"],
    context: "",
  };
  assert.deepEqual(BrownfieldRunSchema.parse(run).runId, "a1b2c3d4");
  assert.equal(BrownfieldRunSchema.safeParse({ ...run, runId: "not-hex" }).success, false);
  assert.equal(BrownfieldRunSchema.safeParse({ ...run, effort: 6 }).success, false);
});

test("plan_concerns is not a phase", () => {
  assert.equal(PhaseSchema.safeParse("plan_concerns").success, false);
  assert.equal(PhaseSchema.safeParse("plan_ready").success, true);
  assert.deepEqual(PhaseSchema.options.includes("plan_concerns"), false);
});

test("FileContract.filesAllowed rejects globs and .git/", () => {
  const base = {
    filesForbidden: [".git/**"],
    expectedArtifacts: ["src/main.ts"],
    verificationCommands: ["pnpm test"],
  };

  assert.equal(
    FileContractSchema.safeParse({
      ...base,
      filesAllowed: ["src/main.ts", "index.html", ".gitignore"],
    }).success,
    true,
  );

  for (const filesAllowed of [
    ["src/**"],
    ["src/*.ts"],
    ["src/foo?.ts"],
    ["**/*.ts"],
    [".git/config"],
    [".git/**"],
    ["vendor/.git/config"],
    ["pkg/.git/hooks/pre-commit"],
    ["src\\main.ts"],
    ["/src/main.ts"],
    ["C:/src/main.ts"],
    ["src/../secret.ts"],
  ]) {
    const result = FileContractSchema.safeParse({ ...base, filesAllowed });
    assert.equal(result.success, false, `expected reject ${filesAllowed.join(",")}`);
  }
});

test("SkillContract.allowedRoots may glob", () => {
  const result = SkillContractSchema.parse({
    skillId: "plan",
    allowedRoots: [
      ".legion-cli/plans/**",
      ".legion-cli/tasks/**",
      ".legion-cli/cache/runs/<id>/**",
      ".legion-cli/specs/*/prd.md",
    ],
  });
  assert.equal(result.allowedRoots.length, 4);

  assert.equal(
    SkillContractSchema.safeParse({
      skillId: "execute",
      allowedRoots: ["src\\main.ts"],
    }).success,
    false,
  );
});

test("QAScore.pass formula", () => {
  const passingBuckets = {
    p0: { points: 40, max: 40, failed: 0 },
    p1: { points: 27, max: 30, passRate: 0.9 },
    p2: { points: 12, max: 15, passRate: 0.8 },
    visual: { points: 15, max: 15, regressions: 0 },
  };

  const base = {
    schemaVersion: "legion-cli-qa/v1",
    id: "qa-1",
    specId: "spec-checkin",
    evidencePaths: [".legion-cli/qa/scores/qa-1.json"],
    createdAt: "2026-09-01T12:00:00Z",
  };

  const passScore = {
    ...base,
    mode: "full",
    buckets: passingBuckets,
    total: 94,
    pass: true,
  };
  assert.equal(computeQaPass(passScore), true);
  assert.deepEqual(QAScoreSchema.parse(passScore).pass, true);

  assert.equal(
    QAScoreSchema.safeParse({ ...passScore, pass: false }).success,
    false,
  );

  assert.equal(
    QAScoreSchema.safeParse({
      ...base,
      mode: "full",
      buckets: passingBuckets,
      total: 84,
      pass: true,
    }).success,
    false,
  );

  assert.equal(
    QAScoreSchema.safeParse({
      ...base,
      mode: "full",
      buckets: {
        ...passingBuckets,
        p0: { points: 0, max: 40, failed: 1 },
      },
      total: 94,
      pass: true,
    }).success,
    false,
  );

  assert.equal(
    QAScoreSchema.safeParse({
      ...base,
      mode: "full",
      buckets: {
        ...passingBuckets,
        visual: { points: 0, max: 15, regressions: 1 },
      },
      total: 94,
      pass: true,
    }).success,
    false,
  );

  const degraded = {
    ...base,
    mode: "no-browser",
    buckets: passingBuckets,
    total: 70,
    pass: false,
  };
  assert.equal(computeQaPass(degraded), false);
  assert.equal(QAScoreSchema.parse(degraded).pass, false);
  assert.equal(QAScoreSchema.safeParse({ ...degraded, pass: true }).success, false);

  assert.equal(
    QAScoreSchema.parse({
      ...base,
      mode: "full",
      buckets: {
        p0: { points: 0, max: 40, failed: 1 },
        p1: { points: 27, max: 30, passRate: 0.9 },
        p2: { points: 12, max: 15, passRate: 0.8 },
        visual: { points: 15, max: 15, regressions: 0 },
      },
      total: 54,
      pass: false,
    }).pass,
    false,
  );

  assert.equal(
    QAScoreSchema.safeParse({
      ...base,
      mode: "full",
      buckets: {
        p0: { points: 0, max: 40, failed: 0 },
        p1: { points: 0, max: 30, passRate: 0 },
        p2: { points: 0, max: 15, passRate: 0 },
        visual: { points: 0, max: 15, regressions: 0 },
      },
      total: 85,
      pass: true,
    }).success,
    false,
  );

  assert.equal(
    QAScoreSchema.safeParse({
      ...passScore,
      total: 101,
      pass: true,
    }).success,
    false,
  );
});

test("LegionConfig requires adapter.default and defaults ingest.autoCommit", () => {
  const parsed = LegionConfigSchema.parse({
    schemaVersion: "legion-cli-config/v1",
    adapter: { default: "fake" },
  });
  assert.equal(parsed.adapter.default, "fake");
  assert.equal(parsed.ingest.autoCommit, true);
  assert.equal(parsed.control_mode, "guarded");
  assert.equal(parsed.qa.mode, "full");
  assert.equal(parsed.qa.passScore, 85);
  assert.equal(parsed.dashboard.bind, "127.0.0.1");
  assert.equal(parsed.flags.mcpApps, false);

  assert.equal(
    LegionConfigSchema.safeParse({
      schemaVersion: "legion-cli-config/v1",
      adapter: {},
    }).success,
    false,
  );

  assert.equal(
    LegionConfigSchema.safeParse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "engine" },
    }).success,
    false,
  );

  assert.equal(
    LegionConfigSchema.safeParse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "generic" },
    }).success,
    false,
  );

  assert.equal(
    LegionConfigSchema.parse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "generic", generic: { binary: "claude", args: ["-p"] } },
    }).adapter.generic.binary,
    "claude",
  );

  assert.equal(
    LegionConfigSchema.safeParse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "fake" },
      control_mode: "autonomous",
    }).success,
    false,
  );

  assert.equal(
    LegionConfigSchema.safeParse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "fake" },
      qa: { mode: "full", passScore: 70 },
    }).success,
    false,
  );
});

test("Task.blockedBy and blocks reject empty ids", () => {
  const task = {
    schemaVersion: "legion-cli-task/v1",
    id: "TSK-0002",
    title: "in/out button",
    status: "ready",
    type: "feature",
    priority: "P0",
    specId: "spec-checkin",
    blockedBy: ["TSK-0001"],
    blocks: [],
    contract: {
      filesAllowed: ["src/main.ts"],
      filesForbidden: [".git/**"],
      expectedArtifacts: ["src/main.ts"],
      verificationCommands: ["pnpm test"],
    },
    assignee: "agent",
    notes: "",
  };
  assert.equal(TaskSchema.safeParse(task).success, true);
  assert.equal(TaskSchema.safeParse({ ...task, blockedBy: [""] }).success, false);
  assert.equal(TaskSchema.safeParse({ ...task, blocks: [""] }).success, false);
});

test("JSON Schema emit files match runtime schemas", () => {
  const jsonDir = join(pkgRoot, "json");
  const emitted = legionJsonSchemas();
  const onDisk = readdirSync(jsonDir).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(
    onDisk,
    [...JSON_SCHEMA_FILES].map((name) => `${name}.json`).sort(),
  );

  for (const name of JSON_SCHEMA_FILES) {
    const file = JSON.parse(readFileSync(join(jsonDir, `${name}.json`), "utf8"));
    assert.deepEqual(file, emitted[name]);
    assert.ok(file.$schema || file.type || file.$defs || file.properties || file.enum);
  }
});

test("JSON Schema overlays reject .git paths, no-browser pass, and generic without binary", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const emitted = legionJsonSchemas();
  const validateFileContract = ajv.compile(emitted["file-contract"]);
  const validateQa = ajv.compile(emitted["qa-score"]);
  const validateConfig = ajv.compile(emitted["legion-config"]);

  const contractBase = {
    filesForbidden: [".git/**"],
    expectedArtifacts: ["src/main.ts"],
    verificationCommands: ["pnpm test"],
  };
  assert.equal(validateFileContract({ ...contractBase, filesAllowed: ["src/main.ts"] }), true);
  assert.equal(validateFileContract({ ...contractBase, filesAllowed: [".git/config"] }), false);
  assert.equal(
    validateFileContract({ ...contractBase, filesAllowed: ["vendor/.git/config"] }),
    false,
  );

  const qaBase = {
    schemaVersion: "legion-cli-qa/v1",
    id: "qa-1",
    specId: "spec-checkin",
    mode: "no-browser",
    buckets: {
      p0: { points: 40, max: 40, failed: 0 },
      p1: { points: 27, max: 30, passRate: 0.9 },
      p2: { points: 12, max: 15, passRate: 0.8 },
      visual: { points: 15, max: 15, regressions: 0 },
    },
    total: 70,
    pass: false,
    evidencePaths: [],
    createdAt: "2026-09-01T12:00:00Z",
  };
  assert.equal(validateQa(qaBase), true);
  assert.equal(validateQa({ ...qaBase, pass: true }), false);

  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "fake" },
    }),
    true,
  );
  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "generic" },
    }),
    false,
  );
  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "generic", generic: { binary: "claude", args: ["-p"] } },
    }),
    true,
  );
});
