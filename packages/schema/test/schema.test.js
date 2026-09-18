import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

import {
  ADAPTER_ID_HELP,
  ADAPTER_IDS,
  ChatActionSchema,
  ChatProposalActionSchema,
  ChatReadActionSchema,
  ChatSessionFileSchema,
  computeQaPass,
  DesignSystemPackageSchema,
  BrownfieldDagSchema,
  BrownfieldPatternsFileSchema,
  BrownfieldRunSchema,
  FileContractSchema,
  FingerprintFileSchema,
  JSON_SCHEMA_FILES,
  LegionConfigSchema,
  legionJsonSchemas,
  PacketSchema,
  PhaseSchema,
  ProjectFileSchema,
  QAScoreSchema,
  ResumeFileSchema,
  SCHEMA_VERSION,
  ServeFileSchema,
  SessionBriefSchema,
  SkillCatalogSchema,
  SkillContractSchema,
  SkillIdSchema,
  SkillOverlayPinSchema,
  TopicsFileSchema,
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

test("TopicsFileSchema is legion-cli-topics/v1", () => {
  const file = TopicsFileSchema.parse({
    schemaVersion: "legion-cli-topics/v1",
    topics: {
      product: ["product/intent"],
      wiki: ["index", "README"],
    },
  });
  assert.equal(file.schemaVersion, "legion-cli-topics/v1");
  assert.deepEqual(file.topics.wiki, ["index", "README"]);
  assert.equal(
    TopicsFileSchema.safeParse({
      schemaVersion: "legion-cli-topics/v2",
      topics: {},
    }).success,
    false,
  );
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
  assert.equal(SCHEMA_VERSION.dag, "legion-cli-dag/v1");
  assert.equal(SCHEMA_VERSION.brownfieldPatterns, "legion-cli-brownfield-patterns/v1");
  assert.equal(SCHEMA_VERSION.qa, "legion-cli-qa/v1");
  assert.equal(SCHEMA_VERSION.brief, "legion-cli-brief/v1");
  assert.equal(SCHEMA_VERSION.skillCatalog, "legion-cli-skill-catalog/v1");
  assert.equal(SCHEMA_VERSION.topics, "legion-cli-topics/v1");
  assert.equal(SCHEMA_VERSION.designSystem, "legion-cli-design-system/v1");
  assert.equal(SCHEMA_VERSION.designActive, "legion-cli-design-active/v1");
  assert.equal(SCHEMA_VERSION.packet, "legion-cli-packet/v1");
  assert.equal(SCHEMA_VERSION.map, "legion-cli-map/v1");
  assert.equal(SCHEMA_VERSION.fingerprint, "legion-cli-fingerprint/v1");
  assert.equal(SCHEMA_VERSION.skillOverlay, "legion-cli-skill-overlay/v1");
  assert.equal(SCHEMA_VERSION.chatSession, "legion-cli-chat/v1");
  assert.equal(SCHEMA_VERSION.serve, "legion-cli-serve/v1");
  assert.equal("sandbox" in SCHEMA_VERSION, false);
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

test("BrownfieldRunSchema parses legacy 3-phase resume files with defaults", () => {
  const legacy = {
    schemaVersion: "legion-cli-run/v1",
    runId: "a1b2c3d4",
    effort: 1,
    execute: true,
    phase: "execute",
    preSpawnRef: "abc123",
    startedAt: "2026-09-01T12:00:00Z",
    worktreePath: ".legion-cli/worktrees/a1b2c3d4",
    promoted: false,
    pages: ["intent.md"],
    context: "",
  };
  const parsed = BrownfieldRunSchema.parse(legacy);
  assert.equal(parsed.designReviewRounds, 0);
  assert.equal(parsed.assumptionRounds, 0);
  assert.equal(parsed.baseBranch, null);
  assert.deepEqual(parsed.meta, {});
  assert.equal(parsed.size, undefined);
  const { pages: _pages, worktreePath: _wt, ...minimal } = legacy;
  assert.deepEqual(BrownfieldRunSchema.parse({ ...minimal, phase: "intent" }).pages, []);
  for (const phase of ["intent", "plan", "assumptions", "design", "review", "present", "verify"]) {
    assert.equal(BrownfieldRunSchema.safeParse({ ...legacy, phase }).success, true, phase);
  }
  assert.equal(BrownfieldRunSchema.safeParse({ ...legacy, phase: "bogus" }).success, false);
  assert.equal(
    BrownfieldRunSchema.safeParse({
      ...legacy,
      size: { files: 1, lines: 10, tier: "tiny", maxPrs: 3, suggestedEffortMax: 2, extra: 1 },
    }).success,
    false,
  );
});

test("BrownfieldDagSchema validates node ids and statuses", () => {
  const node = {
    id: "pr-1",
    number: 1,
    title: "Add owner check",
    branch: "brownfield/a1b2c3d4/pr-1-add-owner-check",
    dependsOn: [],
    files: ["src/orders.ts"],
    tracesTo: "F-001",
    risk: "low",
    spec: "### PR 1: Add owner check",
    status: "pending",
    level: 0,
    base: "main",
    mergeIn: [],
  };
  const dag = BrownfieldDagSchema.parse({ schemaVersion: "legion-cli-dag/v1", runId: "a1b2c3d4", nodes: [node] });
  assert.equal(dag.nodes[0].commit, null);
  assert.equal(dag.nodes[0].reviewRounds, 0);
  const bad = (patch) =>
    BrownfieldDagSchema.safeParse({ schemaVersion: "legion-cli-dag/v1", runId: "a1b2c3d4", nodes: [{ ...node, ...patch }] })
      .success;
  assert.equal(bad({ id: "PR-1" }), false);
  assert.equal(bad({ id: "pr-0" }), false);
  assert.equal(bad({ status: "done" }), false);
  assert.equal(bad({ dependsOn: ["pr-x"] }), false);
});

test("BrownfieldPatternsFileSchema counts lessons", () => {
  const file = {
    schemaVersion: "legion-cli-brownfield-patterns/v1",
    patterns: { "missing authz on object access": { count: 2, firstSeen: "a", lastSeen: "b" } },
  };
  assert.equal(BrownfieldPatternsFileSchema.parse(file).patterns["missing authz on object access"].count, 2);
  assert.equal(
    BrownfieldPatternsFileSchema.safeParse({ ...file, patterns: { x: { count: 0, firstSeen: "a", lastSeen: "b" } } })
      .success,
    false,
  );
});

test("PacketSchema accepts open and responded packets", () => {
  const open = PacketSchema.parse({
    schemaVersion: "legion-cli-packet/v1",
    id: "PKT-0001",
    title: "Dark mode",
    status: "open",
    requester: "pm",
    request: "Users want a dark theme.",
    specId: "spec-checkin",
    ticketIds: [],
    createdAt: "2026-09-01T12:00:00.000Z",
    respondedAt: null,
    response: null,
  });
  assert.equal(open.status, "open");
  assert.deepEqual(open.ticketIds, []);

  const responded = PacketSchema.parse({
    ...open,
    status: "responded",
    ticketIds: ["TSK-0003"],
    respondedAt: "2026-09-01T13:00:00.000Z",
    response: "Spawned tickets for this request.",
  });
  assert.equal(responded.status, "responded");
  assert.equal(PacketSchema.safeParse({ ...open, schemaVersion: "legion-cli-packet/v2" }).success, false);
  assert.equal(PacketSchema.safeParse({ ...open, status: "executing" }).success, false);
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
  assert.equal(parsed.flags.webmcp, false);
  assert.equal(parsed.adapter.http, undefined);
  assert.equal(parsed.sandbox.requireHardened, true);
  assert.equal(parsed.sandbox.allowCopyJail, false);
  assert.equal(parsed.sandbox.backend, "auto");
  assert.deepEqual(parsed.sandbox.skills, ["execute"]);
  assert.deepEqual(parsed.skills.trustKeys, []);
  assert.deepEqual(parsed.map, {});

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

  for (const id of ["grok", "openai", "codex", "mimo", "minimax"]) {
    assert.equal(
      LegionConfigSchema.parse({
        schemaVersion: "legion-cli-config/v1",
        adapter: { default: id },
      }).adapter.default,
      id,
    );
  }

  assert.equal(
    LegionConfigSchema.parse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "openai", openai: { binary: "codex", args: ["{{pointer}}"] } },
    }).adapter.openai.binary,
    "codex",
  );

  assert.equal(
    LegionConfigSchema.parse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "minimax", minimax: { binary: "mcode" } },
    }).adapter.minimax.binary,
    "mcode",
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

test("adapter routing: generic-if-routed, strict HTTP keys, named keys, optional task/resume/brief", () => {
  const configBase = { schemaVersion: "legion-cli-config/v1" };

  assert.equal(
    LegionConfigSchema.parse({
      ...configBase,
      adapter: { default: "claude", routes: { plan: "grok" } },
    }).adapter.routes.plan,
    "grok",
  );

  assert.equal(
    LegionConfigSchema.safeParse({
      ...configBase,
      adapter: { default: "claude", routes: { plan: "generic" } },
    }).success,
    false,
  );

  assert.equal(
    LegionConfigSchema.parse({
      ...configBase,
      adapter: {
        default: "claude",
        routes: { plan: "generic" },
        generic: { binary: "claude", args: ["-p"] },
      },
    }).adapter.routes.plan,
    "generic",
  );

  assert.equal(
    LegionConfigSchema.safeParse({
      ...configBase,
      adapter: { default: "claude", named: { ui: "generic" } },
    }).success,
    false,
  );

  assert.equal(
    LegionConfigSchema.parse({
      ...configBase,
      adapter: {
        default: "claude",
        named: { ui: "generic" },
        generic: { binary: "claude", args: ["-p"] },
      },
    }).adapter.named.ui,
    "generic",
  );

  assert.equal(
    LegionConfigSchema.parse({
      ...configBase,
      adapter: { default: "claude", named: { ui: "grok", api: "codex" } },
    }).adapter.named.ui,
    "grok",
  );

  for (const key of ["claude", "generic", "fake", "grok", "openai", "codex", "mimo", "minimax", "http"]) {
    assert.equal(
      LegionConfigSchema.safeParse({
        ...configBase,
        adapter: { default: "claude", named: { [key]: "grok" } },
      }).success,
      false,
      `named key ${key} must not be an AdapterId`,
    );
  }

  const ajvNamed = new Ajv2020({ strict: false, allErrors: true });
  const validateNamed = ajvNamed.compile(legionJsonSchemas()["legion-config"]);
  assert.equal(
    validateNamed({
      ...configBase,
      adapter: { default: "claude", named: { claude: "grok" } },
    }),
    false,
  );

  for (const extra of [{ apiKey: "sk" }, { apiBase: "https://api" }, { model: "gpt-4" }, { provider: "openai" }]) {
    assert.equal(
      LegionConfigSchema.safeParse({
        ...configBase,
        adapter: { default: "claude", ...extra },
      }).success,
      false,
      `HTTP-router key ${Object.keys(extra)[0]} must fail parse`,
    );
    assert.equal(
      LegionConfigSchema.safeParse({
        ...configBase,
        adapter: { default: "claude", grok: extra },
      }).success,
      false,
      `nested extra HTTP-router key ${Object.keys(extra)[0]} must fail parse`,
    );
  }

  const task = {
    schemaVersion: "legion-cli-task/v1",
    id: "TSK-0002",
    title: "in/out button",
    status: "ready",
    type: "feature",
    priority: "P0",
    specId: "spec-checkin",
    blockedBy: [],
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
  assert.equal(TaskSchema.parse(task).adapter, undefined);
  assert.equal(TaskSchema.parse({ ...task, adapter: "grok" }).adapter, "grok");
  assert.equal(TaskSchema.safeParse({ ...task, adapter: "not-a-cli" }).success, false);

  const resume = {
    schemaVersion: "legion-cli-resume/v1",
    runId: "run-1",
    skillId: "execute",
    preSpawnRef: "abc123",
    startedAt: "2026-09-01T12:00:00Z",
  };
  assert.equal(ResumeFileSchema.parse(resume).adapterId, undefined);
  assert.equal(ResumeFileSchema.parse({ ...resume, enginePid: 1234, pid: 5678 }).enginePid, 1234);
  assert.deepEqual(
    ResumeFileSchema.parse({
      ...resume,
      adapterId: "grok",
      binary: "grok",
      argvSummary: "--model grok-4 {{pointer}}",
      resolutionSource: "task",
    }).resolutionSource,
    "task",
  );
  assert.equal(
    ResumeFileSchema.safeParse({ ...resume, resolutionSource: "named" }).success,
    false,
  );

  const brief = {
    schemaVersion: "legion-cli-brief/v1",
    project: { name: "Checkin", mode: "greenfield", controlMode: "guarded" },
    phase: "executing",
    currentTask: { id: "TSK-0100", title: "settings screen" },
    blockers: [],
    decisions: [],
    wiki: [],
    characterCount: 0,
  };
  assert.equal(SessionBriefSchema.parse(brief).currentTask.adapter, undefined);
  assert.equal(
    SessionBriefSchema.parse({
      ...brief,
      currentTask: { ...brief.currentTask, adapter: "grok" },
    }).currentTask.adapter,
    "grok",
  );
  assert.equal(SessionBriefSchema.parse(brief).skills, undefined);
  assert.equal(SessionBriefSchema.parse(brief).mapRootHash, undefined);
  assert.equal(
    SessionBriefSchema.parse({
      ...brief,
      skills: [
        {
          skillId: "execute",
          name: "execute",
          description: "Write product code. Activated only by legion-cli execute.",
          active: true,
        },
      ],
    }).skills[0].skillId,
    "execute",
  );
  assert.equal(
    SessionBriefSchema.parse({
      ...brief,
      mapRootHash: "a".repeat(64),
    }).mapRootHash,
    "a".repeat(64),
  );
  assert.equal(
    SessionBriefSchema.safeParse({ ...brief, mapRootHash: "not-a-hash" }).success,
    false,
  );
});

test("SkillCatalogSchema is legion-cli-skill-catalog/v1", () => {
  const catalog = SkillCatalogSchema.parse({
    schemaVersion: "legion-cli-skill-catalog/v1",
    skills: [
      {
        skillId: "execute",
        name: "execute",
        description: "Write product code. Activated only by legion-cli execute.",
        required: true,
        bodyChars: 12,
        path: "skills/execute/SKILL.md",
      },
    ],
  });
  assert.equal(catalog.schemaVersion, "legion-cli-skill-catalog/v1");
  assert.deepEqual(catalog.skills[0].resources, { scripts: [], references: [], assets: [] });
  assert.equal(
    SkillCatalogSchema.safeParse({
      schemaVersion: "legion-cli-skill-catalog/v2",
      skills: [],
    }).success,
    false,
  );
  assert.equal(
    SkillCatalogSchema.safeParse({
      schemaVersion: "legion-cli-skill-catalog/v1",
      skills: [
        {
          skillId: "execute",
          name: "Execute",
          description: "bad name",
          required: true,
          bodyChars: 0,
          path: "skills/execute/SKILL.md",
        },
      ],
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
  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "claude", routes: { plan: "generic" } },
    }),
    false,
  );
  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "claude", routes: { plan: "grok" } },
    }),
    true,
  );
  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: {
        default: "claude",
        routes: { plan: "generic" },
        generic: { binary: "claude", args: ["-p"] },
      },
    }),
    true,
  );
  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "claude", named: { ui: "generic" } },
    }),
    false,
  );
  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "claude", named: { claude: "grok" } },
    }),
    false,
  );
  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "claude", named: { ui: "grok" } },
    }),
    true,
  );
  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "http" },
    }),
    false,
  );
  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: {
        default: "http",
        http: { baseUrl: "https://api.x.ai/v1", model: "grok-4", apiKeyEnv: "XAI_API_KEY" },
      },
    }),
    true,
  );
  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "claude", routes: { map: "generic" } },
    }),
    false,
  );
  const httpOk = {
    schemaVersion: "legion-cli-config/v1",
    adapter: {
      default: "http",
      http: {
        baseUrl: "https://api.x.ai/v1",
        model: "grok-4",
        apiKeyEnv: "XAI_API_KEY",
        headers: { "X-Request-Id": "abc" },
      },
    },
  };
  assert.equal(validateConfig(httpOk), true);
  for (const header of ["Authorization", "authorization", "X-Api-Key", "x-api-key"]) {
    assert.equal(
      validateConfig({
        ...httpOk,
        adapter: {
          ...httpOk.adapter,
          http: { ...httpOk.adapter.http, headers: { [header]: "secret" } },
        },
      }),
      false,
      `Ajv headers.${header} must fail`,
    );
  }
  assert.equal(
    validateConfig({
      ...httpOk,
      adapter: {
        ...httpOk.adapter,
        http: { ...httpOk.adapter.http, apiKey: "sk-secret" },
      },
    }),
    false,
  );
  assert.equal(
    validateConfig({
      ...httpOk,
      adapter: {
        ...httpOk.adapter,
        http: { ...httpOk.adapter.http, provider: "openai" },
      },
    }),
    false,
  );
  assert.equal(
    validateConfig({
      ...httpOk,
      adapter: {
        ...httpOk.adapter,
        http: { ...httpOk.adapter.http, baseUrl: "http://169.254.169.254/latest" },
      },
    }),
    false,
  );
  assert.equal(
    validateConfig({
      ...httpOk,
      adapter: {
        ...httpOk.adapter,
        http: { ...httpOk.adapter.http, baseUrl: "https://sk-secret@api.openai.com/v1" },
      },
    }),
    false,
  );
  assert.equal(
    validateConfig({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "fake" },
      map: { roots: ["src"] },
    }),
    true,
  );
  for (const roots of [["../.ssh"], ["/etc"], ["src/../secret"]]) {
    assert.equal(
      validateConfig({
        schemaVersion: "legion-cli-config/v1",
        adapter: { default: "fake" },
        map: { roots },
      }),
      false,
      `Ajv map.roots ${roots.join(",")} must fail`,
    );
  }
  const loopbackHttp = {
    schemaVersion: "legion-cli-config/v1",
    adapter: {
      default: "http",
      http: {
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "grok-4",
        apiKeyEnv: "XAI_API_KEY",
        allowLoopback: true,
      },
    },
  };
  assert.equal(validateConfig(loopbackHttp), true);
  assert.equal(
    validateConfig({
      ...loopbackHttp,
      adapter: {
        ...loopbackHttp.adapter,
        http: { ...loopbackHttp.adapter.http, allowLoopback: false },
      },
    }),
    false,
  );
  for (const baseUrl of ["http://localhost:11434/v1", "http://[::1]/v1", "http://[::1]:8080/v1"]) {
    assert.equal(
      validateConfig({
        ...loopbackHttp,
        adapter: {
          ...loopbackHttp.adapter,
          http: { ...loopbackHttp.adapter.http, baseUrl },
        },
      }),
      true,
      `Ajv baseUrl ${baseUrl} with allowLoopback must pass`,
    );
    assert.equal(
      validateConfig({
        ...loopbackHttp,
        adapter: {
          ...loopbackHttp.adapter,
          http: { ...loopbackHttp.adapter.http, baseUrl, allowLoopback: false },
        },
      }),
      false,
      `Ajv baseUrl ${baseUrl} without allowLoopback must fail`,
    );
  }
  for (const baseUrl of [
    "https://?",
    "https://#",
    "https:// ",
    "https://?q=1",
    "https://:",
    "https://[]",
    "https://example.com:99999/v1",
    "https://256.256.256.256",
    "https://1.2.3.999/path",
    "https://[1:::]",
  ]) {
    assert.equal(
      validateConfig({
        schemaVersion: "legion-cli-config/v1",
        adapter: {
          default: "http",
          http: { baseUrl, model: "grok-4", apiKeyEnv: "XAI_API_KEY" },
        },
      }),
      false,
      `Ajv baseUrl ${JSON.stringify(baseUrl)} must fail without a valid authority`,
    );
  }
  assert.equal(
    validateConfig({
      ...loopbackHttp,
      adapter: {
        ...loopbackHttp.adapter,
        http: { ...loopbackHttp.adapter.http, baseUrl: "http://localhost:99999/v1" },
      },
    }),
    false,
    "Ajv loopback baseUrl with port 99999 must fail",
  );
});

test("SkillId enum has twelve ids including map, wireframe, chat", () => {
  assert.deepEqual([...SkillIdSchema.options], [
    "interview",
    "discuss",
    "spec",
    "ingest",
    "plan",
    "execute",
    "verify",
    "review",
    "qa",
    "map",
    "wireframe",
    "chat",
  ]);
  assert.equal(SkillIdSchema.options.length, 12);
});

test("ADAPTER_IDS includes http and spawn extras stay strict", () => {
  assert.deepEqual([...ADAPTER_IDS], [
    "claude",
    "generic",
    "fake",
    "grok",
    "openai",
    "codex",
    "mimo",
    "minimax",
    "http",
  ]);
  assert.equal(ADAPTER_ID_HELP, "claude|generic|fake|grok|openai|codex|mimo|minimax");
  const configBase = { schemaVersion: "legion-cli-config/v1" };
  assert.equal(
    LegionConfigSchema.safeParse({ ...configBase, adapter: { default: "http" } }).success,
    false,
  );
  const http = LegionConfigSchema.parse({
    ...configBase,
    adapter: {
      default: "http",
      http: {
        baseUrl: "https://api.x.ai/v1",
        model: "grok-4",
        apiKeyEnv: "XAI_API_KEY",
      },
    },
  }).adapter.http;
  assert.equal(http.baseUrl, "https://api.x.ai/v1");
  assert.equal(http.model, "grok-4");
  assert.equal(http.apiKeyEnv, "XAI_API_KEY");
  assert.equal(http.allowLoopback, false);

  assert.equal(
    LegionConfigSchema.safeParse({
      ...configBase,
      adapter: { default: "http", http: { baseUrl: "https://api.x.ai/v1", model: "grok-4", apiKeyEnv: "XAI_API_KEY", apiKey: "sk-secret" } },
    }).success,
    false,
  );
  assert.equal(
    LegionConfigSchema.safeParse({
      ...configBase,
      adapter: { default: "http", http: { baseUrl: "https://api.x.ai/v1", model: "grok-4", apiKeyEnv: "XAI_API_KEY", provider: "openai" } },
    }).success,
    false,
  );
  for (const header of ["Authorization", "authorization", "AUTHORIZATION", "X-Api-Key", "x-api-key"]) {
    assert.equal(
      LegionConfigSchema.safeParse({
        ...configBase,
        adapter: {
          default: "http",
          http: {
            baseUrl: "https://api.x.ai/v1",
            model: "grok-4",
            apiKeyEnv: "XAI_API_KEY",
            headers: { [header]: "secret" },
          },
        },
      }).success,
      false,
      `headers.${header} must fail parse`,
    );
  }
  assert.equal(
    LegionConfigSchema.parse({
      ...configBase,
      adapter: {
        default: "http",
        http: {
          baseUrl: "https://api.x.ai/v1",
          model: "grok-4",
          apiKeyEnv: "XAI_API_KEY",
          allowLoopback: true,
          headers: { "X-Request-Id": "abc" },
        },
      },
    }).adapter.http.allowLoopback,
    true,
  );
  assert.equal(
    LegionConfigSchema.safeParse({
      ...configBase,
      adapter: { default: "claude", grok: { provider: "openai" } },
    }).success,
    false,
  );

  const httpBlock = { baseUrl: "https://api.x.ai/v1", model: "grok-4", apiKeyEnv: "XAI_API_KEY" };
  for (const bad of [
    "http://169.254.169.254/latest",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://api.x.ai/v1",
    "https://sk-secret@api.openai.com/v1",
    "http://127.0.0.1:8080/v1",
    "https://:",
    "https://[]",
    "https://example.com:99999/v1",
    "https://256.256.256.256",
    "https://1.2.3.999/path",
    "https://[1:::]",
  ]) {
    assert.equal(
      LegionConfigSchema.safeParse({
        ...configBase,
        adapter: { default: "http", http: { ...httpBlock, baseUrl: bad } },
      }).success,
      false,
      `baseUrl ${bad} must fail parse`,
    );
  }
  const loopbackUrls = [
    "http://127.0.0.1:8080/v1",
    "http://localhost:11434/v1",
    "http://[::1]/v1",
    "http://[::1]:8080/v1",
  ];
  for (const baseUrl of loopbackUrls) {
    assert.equal(
      LegionConfigSchema.safeParse({
        ...configBase,
        adapter: { default: "http", http: { ...httpBlock, baseUrl } },
      }).success,
      false,
      `baseUrl ${baseUrl} without allowLoopback must fail parse`,
    );
    assert.equal(
      LegionConfigSchema.parse({
        ...configBase,
        adapter: { default: "http", http: { ...httpBlock, baseUrl, allowLoopback: true } },
      }).adapter.http.baseUrl,
      baseUrl,
      `baseUrl ${baseUrl} with allowLoopback must parse`,
    );
  }
  assert.equal(
    LegionConfigSchema.safeParse({
      ...configBase,
      adapter: {
        default: "http",
        http: { ...httpBlock, baseUrl: "http://localhost:99999/v1", allowLoopback: true },
      },
    }).success,
    false,
    "baseUrl http://localhost:99999/v1 must fail parse even with allowLoopback",
  );
  for (const env of ["xai_api_key", "1ABC", "A", ""]) {
    assert.equal(
      LegionConfigSchema.safeParse({
        ...configBase,
        adapter: { default: "http", http: { ...httpBlock, apiKeyEnv: env } },
      }).success,
      false,
      `apiKeyEnv ${env} must fail parse`,
    );
  }
  assert.equal(
    LegionConfigSchema.safeParse({
      ...configBase,
      adapter: { default: "http", http: { model: "grok-4", apiKeyEnv: "XAI_API_KEY" } },
    }).success,
    false,
  );
  assert.equal(
    LegionConfigSchema.safeParse({
      ...configBase,
      adapter: { default: "claude" },
      apiKey: "sk-secret",
    }).success,
    false,
  );
});

test("sandbox, skills.trustKeys, and map config are additive", () => {
  const parsed = LegionConfigSchema.parse({
    schemaVersion: "legion-cli-config/v1",
    adapter: { default: "fake" },
    sandbox: { requireHardened: false, allowCopyJail: true, backend: "copy", skills: ["execute", "plan"] },
    skills: { trustKeys: ["minisign-pub"] },
    map: { roots: ["src", "packages"], ignore: ["**/*.test.*"] },
  });
  assert.equal(parsed.sandbox.requireHardened, false);
  assert.equal(parsed.sandbox.allowCopyJail, true);
  assert.equal(parsed.sandbox.backend, "copy");
  assert.deepEqual(parsed.sandbox.skills, ["execute", "plan"]);
  assert.deepEqual(parsed.skills.trustKeys, ["minisign-pub"]);
  assert.deepEqual(parsed.map.roots, ["src", "packages"]);
  assert.deepEqual(parsed.map.ignore, ["**/*.test.*"]);
  assert.equal(
    LegionConfigSchema.safeParse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "fake" },
      sandbox: { requireHardened: true, unknown: true },
    }).success,
    false,
  );
  assert.equal(
    LegionConfigSchema.safeParse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "fake" },
      map: { extra: true },
    }).success,
    false,
  );
  assert.equal(
    LegionConfigSchema.safeParse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "fake" },
      skills: { extra: true },
    }).success,
    false,
  );
  assert.equal(
    LegionConfigSchema.safeParse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "fake" },
      sandbox: { backend: "docker" },
    }).success,
    false,
  );
  assert.equal(
    LegionConfigSchema.safeParse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "fake" },
      sandbox: { skills: ["pwned"] },
    }).success,
    false,
  );
  assert.equal(
    LegionConfigSchema.safeParse({
      schemaVersion: "legion-cli-config/v1",
      adapter: { default: "fake" },
      sandbox: { skills: [] },
    }).success,
    false,
  );
  for (const roots of [["../.ssh"], ["/etc"], ["src/../secret"]]) {
    assert.equal(
      LegionConfigSchema.safeParse({
        schemaVersion: "legion-cli-config/v1",
        adapter: { default: "fake" },
        map: { roots },
      }).success,
      false,
      `map.roots ${roots.join(",")} must fail parse`,
    );
  }
});

test("FingerprintFileSchema, SkillOverlayPinSchema, ChatAction, ServeFileSchema", () => {
  const hash = "a".repeat(64);
  const fingerprints = FingerprintFileSchema.parse({
    schemaVersion: "legion-cli-fingerprint/v1",
    generatedAt: "2026-09-17T00:00:00Z",
    backend: "fallback",
    rootHash: hash,
    modules: [
      {
        path: "src/auth.ts",
        language: "ts",
        exports: ["login"],
        imports: ["node:fs"],
        hash,
      },
    ],
  });
  assert.equal(fingerprints.backend, "fallback");
  assert.equal(FingerprintFileSchema.safeParse({ ...fingerprints, schemaVersion: "legion-cli-map/v1" }).success, false);
  assert.equal(FingerprintFileSchema.safeParse({ ...fingerprints, rootHash: "not-a-hash" }).success, false);
  assert.equal(FingerprintFileSchema.safeParse({ ...fingerprints, extra: true }).success, false);

  const localPin = SkillOverlayPinSchema.parse({
    schemaVersion: "legion-cli-skill-overlay/v1",
    skillId: "execute",
    source: { type: "local", origin: "/tmp/skills/execute" },
    integrity: { sha256: hash },
    installedAt: "2026-09-17T00:00:00Z",
  });
  assert.equal(localPin.integrity.minisign, undefined);
  assert.equal(
    SkillOverlayPinSchema.safeParse({
      ...localPin,
      source: { type: "github", origin: "acme/skills", ref: "v1.0.0" },
    }).success,
    false,
  );
  assert.equal(
    SkillOverlayPinSchema.parse({
      ...localPin,
      source: { type: "github", origin: "acme/skills", ref: "v1.0.0" },
      integrity: { sha256: hash, minisign: "untrusted comment: ..." },
    }).source.type,
    "github",
  );
  assert.equal(
    SkillOverlayPinSchema.safeParse({
      ...localPin,
      source: { type: "github", origin: "acme/skills" },
      integrity: { sha256: hash, minisign: "sig" },
    }).success,
    false,
  );
  assert.equal(
    SkillOverlayPinSchema.safeParse({
      ...localPin,
      extra: true,
    }).success,
    false,
  );
  assert.equal(
    SkillOverlayPinSchema.safeParse({
      ...localPin,
      source: { type: "github", origin: "https://github.com/acme/skills", ref: "v1.0.0" },
      integrity: { sha256: hash, minisign: "sig" },
    }).success,
    false,
  );

  assert.equal(ChatReadActionSchema.parse({ type: "status" }).type, "status");
  assert.equal(ChatReadActionSchema.parse({ type: "search", q: "where" }).q, "where");
  assert.equal(ChatReadActionSchema.parse({ type: "next_verb" }).type, "next_verb");
  assert.equal(ChatReadActionSchema.safeParse({ type: "search" }).success, false);
  assert.equal(
    ChatProposalActionSchema.parse({ type: "intent_answer", answers: ["a", "b"] }).type,
    "intent_answer",
  );
  assert.equal(
    ChatProposalActionSchema.safeParse({ type: "intent_answer", answers: [] }).success,
    false,
  );
  assert.equal(
    ChatProposalActionSchema.safeParse({ type: "intent_answer", answers: ["a", "b", "c"] }).success,
    false,
  );
  assert.equal(
    ChatProposalActionSchema.parse({ type: "discuss_decide", id: "D-001", status: "accepted" }).id,
    "D-001",
  );
  assert.equal(
    ChatProposalActionSchema.parse({ type: "assume_answer", id: "ASM-0001", status: "confirmed" }).status,
    "confirmed",
  );
  assert.equal(ChatProposalActionSchema.parse({ type: "ticket", title: "Dark mode" }).type, "ticket");
  assert.equal(ChatProposalActionSchema.safeParse({ type: "ticket", title: "" }).success, false);
  assert.equal(ChatProposalActionSchema.safeParse({ type: "discuss_decide", id: "", status: "accepted" }).success, false);
  assert.equal(ChatActionSchema.safeParse({ type: "execute" }).success, false);
  assert.equal(ChatActionSchema.safeParse({ type: "ship" }).success, false);

  const session = ChatSessionFileSchema.parse({
    schemaVersion: "legion-cli-chat/v1",
    id: "s1",
    startedAt: "2026-09-17T00:00:00Z",
    turns: [{ role: "user", text: "where am I", action: { type: "status" } }],
  });
  assert.equal(session.schemaVersion, "legion-cli-chat/v1");
  assert.equal(session.id, "s1");
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].role, "user");
  assert.equal(session.turns[0].text, "where am I");
  assert.deepEqual(session.turns[0].action, { type: "status" });
  assert.equal(ChatSessionFileSchema.safeParse({ ...session, extra: true }).success, false);
  assert.equal(
    ChatSessionFileSchema.safeParse({ ...session, schemaVersion: "legion-cli-chat/v2" }).success,
    false,
  );
  assert.equal(
    ChatSessionFileSchema.safeParse({
      ...session,
      turns: [{ role: "system", text: "nope" }],
    }).success,
    false,
  );
  assert.equal(ChatSessionFileSchema.safeParse({ ...session, id: "" }).success, false);

  const serve = ServeFileSchema.parse({
    schemaVersion: "legion-cli-serve/v1",
    port: 7420,
    bind: "127.0.0.1",
    mcpPath: "/mcp",
    mcpHttp: true,
    tokenSha256: hash,
    startedAt: "2026-09-17T00:00:00Z",
    pid: 1234,
  });
  assert.equal(serve.mcpPath, "/mcp");
  assert.equal(ServeFileSchema.safeParse({ ...serve, mcpPath: "/engine" }).success, false);
  assert.equal(ServeFileSchema.safeParse({ ...serve, tokenSha256: "deadbeef" }).success, false);
  assert.equal(ServeFileSchema.safeParse({ ...serve, port: 0 }).success, false);
  assert.equal(ServeFileSchema.safeParse({ ...serve, port: 70000 }).success, false);
  assert.equal(ServeFileSchema.safeParse({ ...serve, extra: true }).success, false);
});

test("DesignSystemPackage integrity may include minisign", () => {
  const pkg = DesignSystemPackageSchema.parse({
    schemaVersion: "legion-cli-design-system/v1",
    id: "acme",
    name: "Acme",
    description: "Brand",
    source: { type: "github", origin: "acme/brand@v1" },
    files: { design: "DESIGN.md", tokens: "tokens.css" },
    integrity: { sha256: "a".repeat(64), minisign: "untrusted comment: ..." },
  });
  assert.equal(pkg.integrity.minisign, "untrusted comment: ...");
  assert.equal(
    DesignSystemPackageSchema.safeParse({
      schemaVersion: "legion-cli-design-system/v1",
      id: "acme",
      name: "Acme",
      description: "Brand",
      source: { type: "github", origin: "acme/brand@v1" },
      files: { design: "DESIGN.md", tokens: "tokens.css" },
      integrity: { sha256: "deadbeef" },
    }).success,
    false,
  );
});

test("JSON Schema overlays refuse unsigned github pins and validate new files", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const emitted = legionJsonSchemas();
  const validatePin = ajv.compile(emitted["skill-overlay-pin"]);
  const validateFingerprint = ajv.compile(emitted["fingerprint-file"]);
  const validateChat = ajv.compile(emitted["chat-action"]);
  const validateSession = ajv.compile(emitted["chat-session"]);
  const validateServe = ajv.compile(emitted["serve-file"]);
  const hash = "a".repeat(64);

  const localPin = {
    schemaVersion: "legion-cli-skill-overlay/v1",
    skillId: "execute",
    source: { type: "local", origin: "/tmp/skills/execute" },
    integrity: { sha256: hash },
    installedAt: "2026-09-17T00:00:00Z",
  };
  assert.equal(validatePin(localPin), true);
  assert.equal(
    validatePin({
      ...localPin,
      source: { type: "github", origin: "acme/skills", ref: "v1.0.0" },
    }),
    false,
  );
  assert.equal(
    validatePin({
      ...localPin,
      source: { type: "github", origin: "acme/skills", ref: "v1.0.0" },
      integrity: { sha256: hash, minisign: "sig" },
    }),
    true,
  );
  assert.equal(
    validatePin({
      ...localPin,
      source: { type: "github", origin: "acme/skills" },
      integrity: { sha256: hash, minisign: "sig" },
    }),
    false,
  );
  assert.equal(
    validatePin({
      ...localPin,
      source: { type: "github", origin: "https://github.com/acme/skills", ref: "v1.0.0" },
      integrity: { sha256: hash, minisign: "sig" },
    }),
    false,
  );

  assert.equal(
    validateFingerprint({
      schemaVersion: "legion-cli-fingerprint/v1",
      generatedAt: "2026-09-17T00:00:00Z",
      backend: "fallback",
      rootHash: hash,
      modules: [],
    }),
    true,
  );
  assert.equal(validateChat({ type: "next_verb" }), true);
  assert.equal(validateChat({ type: "search" }), false);
  const sessionOk = {
    schemaVersion: "legion-cli-chat/v1",
    id: "s1",
    startedAt: "2026-09-17T00:00:00Z",
    turns: [{ role: "user", text: "where am I", action: { type: "status" } }],
  };
  assert.equal(validateSession(sessionOk), true);
  assert.equal(validateSession({ ...sessionOk, schemaVersion: "legion-cli-chat/v2" }), false);
  assert.equal(
    validateSession({
      ...sessionOk,
      turns: [{ role: "system", text: "nope" }],
    }),
    false,
  );
  assert.equal(validateSession({ ...sessionOk, id: "" }), false);
  assert.equal(validateSession({ ...sessionOk, extra: true }), false);
  assert.equal(
    validateServe({
      schemaVersion: "legion-cli-serve/v1",
      port: 7420,
      bind: "127.0.0.1",
      mcpPath: "/mcp",
      mcpHttp: true,
      tokenSha256: hash,
      startedAt: "2026-09-17T00:00:00Z",
      pid: 1,
    }),
    true,
  );
  assert.equal(
    validateServe({
      schemaVersion: "legion-cli-serve/v1",
      port: 7420,
      bind: "127.0.0.1",
      mcpPath: "/mcp",
      mcpHttp: true,
      tokenSha256: "deadbeef",
      startedAt: "2026-09-17T00:00:00Z",
      pid: 1,
    }),
    false,
  );
});
