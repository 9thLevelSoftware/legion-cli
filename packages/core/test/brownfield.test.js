import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BrownfieldDagSchema,
  BrownfieldRunSchema,
} from "@9thlevelsoftware/legion-cli-schema";
import {
  computeRoster,
  LegionEngine,
  LegionRefuseError,
  mergeSpecialists,
  normSeverity,
  orderRunPages,
  parsePrPlan,
  parseReview,
  reviewerSlots,
  reviewStatus,
  section,
  signalText,
  slugify,
  splitBlocks,
  titleOf,
} from "../dist/index.js";
import { PathEscapeError } from "@9thlevelsoftware/legion-cli-persist";
import { storeAbs } from "../dist/brownfield/paths.js";
import { git, initGitRepo, initProject, withEngine } from "./helpers.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "brownfield");

function runDir(dir, runId) {
  return join(dir, ".legion-cli", "runs", runId);
}

async function readFixture(rel) {
  return readFile(join(FIXTURES, ...rel.split("/")), "utf8");
}

async function seedFile(dir, runId, rel, text) {
  const abs = join(runDir(dir, runId), ...rel.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text, "utf8");
}

async function seedFixture(dir, runId, fixtureRel, targetRel = fixtureRel, { crlf = false } = {}) {
  const text = await readFixture(fixtureRel);
  await seedFile(dir, runId, targetRel, crlf ? text.replaceAll("\n", "\r\n") : text);
}

/** design.md with a valid PR plan plus a design review, so pr-plan may enter execute. */
async function seedReady(dir, runId) {
  await seedFixture(dir, runId, "design-ok.md", "design.md");
  await seedFile(dir, runId, "reviews/design-review.md", "# Design Review\n");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Initialized brownfield project with one commit and one source file. */
async function setupProject({ dir, engine }) {
  await initProject(engine, { mode: "brownfield" });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "main.ts"), "export const n = 1;\n", "utf8");
  return initGitRepo(dir);
}

async function assertRefuses(promise, pattern) {
  await assert.rejects(promise, (err) => {
    assert.equal(err instanceof LegionRefuseError, true, String(err));
    if (pattern) assert.match(`${err.message} | ${err.nextHint}`, pattern);
    return true;
  });
}

// ---------------------------------------------------------------- pure parsers

test("section and splitBlocks tolerate numbering, case, CRLF, and fenced headings", () => {
  const text = "# T\r\n\r\n## 2. findings\r\n```\r\n### fenced\r\n```\r\n### A\r\n- **Severity**: major\r\n- Evidence: one\r\n  two\r\n## Next\r\n### B\r\n";
  const body = section(text, "Findings");
  const blocks = splitBlocks(body);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].heading, "A");
  assert.equal(blocks[0].fields.severity, "major");
  assert.equal(blocks[0].fields.evidence, "one two");
  assert.equal(section(text, "Missing"), "");
});

test("normSeverity maps legacy words on word boundaries", () => {
  assert.equal(normSeverity("Critical"), "critical");
  assert.equal(normSeverity("High"), "major");
  assert.equal(normSeverity("bug"), "major");
  assert.equal(normSeverity("blocker"), "critical");
  assert.equal(normSeverity("medium"), "minor");
  assert.equal(normSeverity("suggestion"), "minor");
  assert.equal(normSeverity("info"), "nit");
  assert.equal(normSeverity("highlight"), "minor");
  assert.equal(normSeverity(""), "minor");
});

test("titleOf strips ids and tags", () => {
  assert.equal(titleOf("F-007: Order lookup"), "Order lookup");
  assert.equal(titleOf("F-001 [Architecture, Code] Order lookup"), "Order lookup");
  assert.equal(titleOf("[tests] R-3: Flaky"), "Flaky");
  assert.equal(titleOf("API: missing auth"), "API: missing auth");
});

test("computeRoster follows effort and signals", () => {
  const out = (s) => `analysis/${s}.md`;
  const e1 = computeRoster(1, "", false, out);
  assert.deepEqual(e1.pass1, ["architecture"]);
  assert.deepEqual(e1.pass2, ["code"]);
  assert.equal(e1.injectDoctrine, false);
  assert.deepEqual(e1.executeReviewersDefault, []);

  const e2 = computeRoster(2, "worried about the login flow", true, out);
  assert.deepEqual(e2.pass1, ["architecture", "product-intent"]);
  assert.deepEqual(e2.pass2, ["code", "tests", "security"]);
  assert.deepEqual(e2.addedBySignal, ["security"]);

  const e5 = computeRoster(5, "", true, out);
  assert.deepEqual(e5.pass2, ["code", "code-2", "tests", "security", "performance", "documentation"]);
  assert.equal(e5.designReviewers, 2);
  assert.deepEqual(e5.executeReviewersDefault, ["general", "general-2", "security", "tests", "plan-alignment"]);
  assert.equal(e5.outputs["code-2"], "analysis/code-2.md");

  assert.deepEqual(reviewerSlots(4, "auth"), ["general", "general-2", "security", "tests"]);
  assert.deepEqual(reviewerSlots(1, "auth tests"), ["general"]);
});

test("signalText ignores intent template boilerplate", () => {
  const intent = [
    "# Intent Brief",
    "## Goal",
    "Make checkout trustworthy.",
    "## Axioms (must be true)",
    "| FP-1 | tests prove totals | test |",
    "## Success criteria",
    "- [ ] coverage of docs and README",
    "## Symptoms reported",
    "Totals sometimes off.",
  ].join("\n");
  const text = signalText("", intent);
  assert.match(text, /checkout/);
  assert.doesNotMatch(text, /README/);
  const roster = computeRoster(1, text, false, (s) => s);
  assert.deepEqual(roster.addedBySignal, ["security"]);
});

test("mergeSpecialists dedupes, sorts, flags blocking, and reports ignored blocks", async () => {
  const inputs = [];
  for (const [tag, name] of [
    ["Architecture", "architecture"],
    ["Code", "code"],
    ["Product-Intent", "product-intent"],
    ["Tests", "tests"],
  ]) {
    inputs.push({ tag, text: await readFixture(`analysis/${name}.md`) });
  }
  const model = mergeSpecialists(inputs);
  assert.deepEqual(
    model.findings.map((f) => [f.id, f.severity, f.title]),
    [
      ["F-001", "critical", "Refund path swallows errors"],
      ["F-002", "major", "Order lookup skips owner check"],
      ["F-003", "major", "CSV export silently drops rows"],
      ["F-004", "minor", "Totals rounded per line item"],
      ["F-005", "nit", "Highlight colour is hard-coded"],
    ],
  );
  assert.deepEqual(model.findings[1].sources, ["Architecture", "Code"]);
  assert.equal(model.assumptions.length, 2);
  const deleted = model.assumptions.find((a) => a.statement === "Deleted accounts keep their orders");
  assert.equal(deleted.confidence, "low");
  assert.equal(deleted.status, "needs-confirmation");
  assert.equal(deleted.blocking, true);
  assert.equal(deleted.question, "Should orders survive account deletion?");
  assert.equal(model.assumptions.find((a) => a.statement.startsWith("Payments")).blocking, true);
  assert.deepEqual(
    model.ignored.map((b) => b.source),
    ["Architecture", "Code"],
  );
  assert.deepEqual(model.perSource.Tests, { findings: 0, assumptions: 0 });

  const crlf = mergeSpecialists(inputs.map((i) => ({ ...i, text: i.text.replaceAll("\n", "\r\n") })));
  assert.deepEqual(
    crlf.findings.map((f) => [f.id, f.severity, f.title, f.sources]),
    model.findings.map((f) => [f.id, f.severity, f.title, f.sources]),
  );
});

test("reviewStatus verdict ladder", async () => {
  const current = parseReview(await readFixture("reviews/design-review.md"));
  const previous = parseReview(await readFixture("reviews/design-review.prev.md"));
  assert.equal(current.items.length, 5);
  assert.equal(current.ignored.length, 1);
  const escalate = reviewStatus(current.items, previous.items, false);
  assert.equal(escalate.verdict, "escalate");
  assert.deepEqual(escalate.stalemates.map((i) => i.id), ["R-3"]);
  assert.deepEqual(escalate.needsUserInput.map((i) => i.id), ["R-4"]);

  const withoutEscalation = current.items.filter((i) => i.id !== "R-3" && i.id !== "R-4");
  assert.equal(reviewStatus(withoutEscalation, previous.items, false).verdict, "revise");
  const minorOnly = withoutEscalation.filter((i) => i.id !== "R-1");
  assert.equal(reviewStatus(minorOnly, null, false).verdict, "pass-with-minor");
  assert.equal(reviewStatus(minorOnly, null, true).verdict, "revise");
  assert.equal(reviewStatus(parseReview("# Design Review — round 3\n\nNo open issues.\n").items, null, true).verdict, "pass");
});

test("parsePrPlan builds stacked branches and rejects bad plans", async () => {
  const ok = parsePrPlan(await readFixture("design-ok.md"), "abcdef12", "0123456789abcdef");
  assert.equal(ok.ok, true);
  assert.equal(ok.levels, 3);
  assert.deepEqual(ok.nodes.map((n) => n.id), ["pr-1", "pr-2", "pr-3"]);
  const [pr1, pr2, pr3] = ok.nodes;
  assert.equal(pr1.branch, "brownfield/abcdef12/pr-1-add-owner-check-to-order-lookup");
  assert.equal(pr1.base, "0123456789abcdef");
  assert.deepEqual(pr1.files, ["src/orders.ts", "test/orders.test.ts"]);
  assert.equal(pr2.base, pr1.branch);
  assert.equal(pr3.base, pr1.branch);
  assert.deepEqual(pr3.mergeIn, [pr2.branch]);
  assert.deepEqual(pr3.files, []);
  assert.equal(pr3.branch, "brownfield/abcdef12/pr-3-round-totals-once-at-the-end-of-checkout");
  assert.equal(BrownfieldDagSchema.safeParse({ schemaVersion: "legion-cli-dag/v1", runId: "abcdef12", nodes: ok.nodes }).success, true);

  for (const [fixture, pattern] of [
    ["design-cycle.md", /cycle/],
    ["design-missing-dep.md", /pr-2 depends on missing pr-7/],
    ["design-dup.md", /duplicate PR 1/],
    ["design-no-plan.md", /no '## PR Plan'/],
  ]) {
    const bad = parsePrPlan(await readFixture(fixture), "abcdef12", "0123456789abcdef");
    assert.equal(bad.ok, false, fixture);
    assert.match(bad.error, pattern, fixture);
  }
  assert.equal(slugify("!!!"), "unnamed");
});

test("orderRunPages puts intent first and nested dirs last", () => {
  assert.deepEqual(
    orderRunPages(["analysis/code.md", "design.md", "zeta.md", "intent.md", "reviews/design-review.md", "evidence/tests.md"]),
    ["intent.md", "design.md", "zeta.md", "analysis/code.md", "reviews/design-review.md", "evidence/tests.md"],
  );
});

// ------------------------------------------------------------------ engine flow

test("init mode brownfield writes mode brownfield", async () => {
  await withEngine(async ({ engine, store }) => {
    await engine.init({ name: "LegacyApp", adapter: "fake", mode: "brownfield" });
    assert.equal((await store.readProject()).data.mode, "brownfield");
  });
});

test("brownfield init writes resume.json, subdirs, gitignore, and no wiki or worktree", async () => {
  await withEngine(async (ctx) => {
    const { dir, engine, store } = ctx;
    const head = await setupProject(ctx);
    const result = await engine.brownfield({ effort: 3, context: "demo the check-in board", runId: "aaaaaaaa" });
    assert.equal(result.kind, "init");
    assert.equal(result.runId, "aaaaaaaa");
    assert.equal(result.effort, 3);
    assert.equal(result.phase, "intent");
    assert.equal(result.preSpawnRef, head);
    assert.equal(result.baseBranch, git(dir, ["branch", "--show-current"]));
    assert.equal(result.size.tier, "tiny");
    assert.equal(result.paths.findings, ".legion-cli/runs/aaaaaaaa/findings.md");
    assert.match(result.warnings.join("\n"), /exceeds the suggested max 2/);
    assert.match(result.next, /intent\.md/);
    for (const sub of ["analysis", "reviews", "evidence", "exec"]) {
      assert.equal(existsSync(join(runDir(dir, "aaaaaaaa"), sub)), true, sub);
    }
    const resume = BrownfieldRunSchema.parse(await readJson(join(runDir(dir, "aaaaaaaa"), "resume.json")));
    assert.equal(resume.context, "demo the check-in board");
    assert.match(await readFile(join(dir, ".gitignore"), "utf8"), /\.legion-cli\/runs\//);
    assert.equal(await store.pathExists(".legion-cli/wiki/runs/aaaaaaaa/intent.md"), false);
    assert.equal(existsSync(join(dir, ".legion-cli", "worktrees")), false);
    assert.equal(git(dir, ["status", "--porcelain", "--", ".legion-cli/runs"]), "");
  });
});

test("brownfield init always refreshes the codebase map", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    for (const effort of [1, 3]) {
      const runId = effort === 1 ? "a1a1a1a1" : "a3a3a3a3";
      const result = await engine.brownfield({ effort, runId });
      assert.equal(result.map.path, ".legion-cli/map/ARCHITECTURE.md");
      assert.equal(result.map.fingerprintsPath, ".legion-cli/map/fingerprints.json");
      assert.equal(result.map.backend, "fallback");
      assert.ok(result.map.modules >= 1, `effort ${effort}`);
      const fingerprints = await readJson(join(dir, ".legion-cli", "map", "fingerprints.json"));
      assert.ok(fingerprints.modules.some((m) => m.path === "src/main.ts"), `effort ${effort}`);
      const resume = await readJson(join(runDir(dir, runId), "resume.json"));
      assert.deepEqual(resume.meta.map, { backend: "fallback", modules: result.map.modules, path: result.map.path });
    }
  });
});

test("brownfield --lsp with no language server refuses and creates no run", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    await assertRefuses(
      engine.brownfield({ runId: "b1b1b1b1", lsp: true, resolveBinary: () => null }),
      /no language server on PATH/,
    );
    assert.equal(existsSync(runDir(dir, "b1b1b1b1")), false);
  });
});

test("brownfield defaults to effort 2 and refuses bad input", async () => {
  await withEngine(async ({ engine }) => {
    await assertRefuses(engine.brownfield({}), /until init/);
  });
  await withEngine(async ({ engine }) => {
    await initProject(engine, { mode: "brownfield" });
    await assertRefuses(engine.brownfield({}), /git repository/);
  });
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { engine } = ctx;
    assert.equal((await engine.brownfield({ runId: "bbbbbbbb" })).effort, 2);
    await assertRefuses(engine.brownfield({ effort: 6 }), /1–5/);
    await assertRefuses(engine.brownfield({ effort: 2.5 }), /1–5/);
    await assertRefuses(engine.brownfield({ runId: "bbbbbbbb" }), /already exists/);
    await assertRefuses(engine.brownfield({ runId: "nothex!!" }), /8 hex/);
    await assertRefuses(engine.brownfield({ resume: "cccccccc" }), /not found/);
    await assertRefuses(engine.brownfield({ resume: "bbbbbbbb", effort: 4 }), /cannot change effort/);
  });
});

test("brownfield --execute without a commit refuses", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    git(dir, ["init"]);
    await assertRefuses(engine.brownfield({ execute: true }), /HEAD/);
  });
});

test("state get/set, whitelist, meta bag, and resume with execute", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { engine } = ctx;
    await engine.brownfield({ runId: "dddddddd" });
    const set = await engine.brownfieldState("dddddddd", [
      "phase=design",
      "designReviewRounds=2",
      'meta.writer="agent-1"',
      "meta.notes=plain text",
    ]);
    assert.equal(set.state.phase, "design");
    assert.equal(set.state.designReviewRounds, 2);
    assert.equal(set.state.meta.writer, "agent-1");
    assert.equal(set.state.meta.notes, "plain text");
    assert.equal(set.state.meta.map.backend, "fallback");
    assert.match(set.next, /design writer/);
    await assertRefuses(engine.brownfieldState("dddddddd", ["runId=eeeeeeee"]), /not settable/);
    await assertRefuses(engine.brownfieldState("dddddddd", ["phase=nope"]), /phase must be one of/);
    await assertRefuses(engine.brownfieldState("dddddddd", ["designReviewRounds=-1"]), /invalid designReviewRounds/);
    await assertRefuses(engine.brownfieldState("dddddddd", ["noequals"]), /key=value/);

    const resumed = await engine.brownfield({ resume: "DDDDDDDD", execute: true });
    assert.equal(resumed.kind, "state");
    assert.equal(resumed.state.execute, true);
    assert.equal(resumed.state.phase, "design");
  });
});

test("legacy 3-phase resume.json still resumes and promotes", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine, store } = ctx;
    await seedFixture(dir, "0a0a0a0a", "resume-legacy.json", "resume.json");
    await seedFile(dir, "0a0a0a0a", "intent.md", "# Intent brief\n\nlegacy\n");
    await seedFile(dir, "0a0a0a0a", "architecture.md", "# Architecture (effort 1)\n");
    const state = await engine.brownfield({ resume: "0a0a0a0a" });
    assert.equal(state.state.phase, "complete");
    assert.match(state.next, /run promote 0a0a0a0a/);
    const promoted = await engine.promoteRun("0a0a0a0a");
    assert.deepEqual(promoted.pages, [
      ".legion-cli/wiki/runs/0a0a0a0a/intent.md",
      ".legion-cli/wiki/runs/0a0a0a0a/architecture.md",
    ]);
    assert.equal((await store.readWikiPage(promoted.pages[0])).data.trust, "untrusted");
    const execState = await engine.brownfield({ resume: "0a0a0a0a", execute: true });
    assert.match(execState.next, /pr-plan 0a0a0a0a/);
    await assertRefuses(engine.brownfieldPrPlan("0a0a0a0a"), /design\.md/);
  });
});

test("roster persists and advances intent to plan", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    await engine.brownfield({ runId: "12121212", effort: 2, context: "slow checkout" });
    await seedFile(dir, "12121212", "intent.md", "# Intent\n\n## Goal\nUsers get logged out.\n");
    const roster = await engine.brownfieldRoster("12121212");
    assert.deepEqual(roster.pass2, ["code", "tests", "security", "performance"]);
    assert.equal(roster.outputs.code, ".legion-cli/runs/12121212/analysis/code.md");
    const state = await engine.brownfieldState("12121212");
    assert.equal(state.state.phase, "plan");
    assert.deepEqual(state.state.roster.pass1, ["architecture", "product-intent"]);
    assert.equal(state.analysisOutputs.architecture, "missing");
  });
});

test("merge writes findings.md and assumptions.md and keeps recorded answers", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    await engine.brownfield({ runId: "13131313" });
    await assertRefuses(engine.brownfieldMerge("13131313"), /no specialist outputs/);
    for (const name of ["architecture", "code", "product-intent", "tests"]) {
      await seedFixture(dir, "13131313", `analysis/${name}.md`, `analysis/${name}.md`, { crlf: name === "code" });
    }
    await seedFile(dir, "13131313", "evidence/tests.md", "## Findings\n### Should not merge\n- Severity: critical\n");
    const merged = await engine.brownfieldMerge("13131313");
    assert.equal(merged.findingsTotal, 5);
    assert.deepEqual(merged.bySeverity, { critical: 1, major: 2, minor: 1, nit: 1 });
    assert.deepEqual(merged.emptySources, ["Tests"]);
    assert.equal(merged.blockingAssumptions.length, 2);
    assert.equal(merged.ignoredBlocks.length, 2);
    assert.equal("Evidence" in merged.perSource, false);
    const findings = await readFile(join(runDir(dir, "13131313"), "findings.md"), "utf8");
    assert.match(findings, /\| critical \| 1 \|/);
    assert.match(findings, /### F-002 \[Architecture, Code\] Order lookup skips owner check\n- Severity: major/);
    assert.doesNotMatch(findings, /\*\*Severity\*\*: High/);
    const assumptionsPath = join(runDir(dir, "13131313"), "assumptions.md");
    let assumptions = await readFile(assumptionsPath, "utf8");
    assert.match(assumptions, /- Blocking: yes/);
    assert.equal((await engine.brownfieldState("13131313")).state.phase, "assumptions");

    // The user answers A-001; re-merging must keep the answer and unblock it.
    assumptions = assumptions.replace(
      /(### A-001: Deleted accounts keep their orders[\s\S]*?- Status: )needs-confirmation/,
      "$1confirmed",
    );
    assumptions = assumptions.replace("- Sources: Architecture, Code", "- Sources: Architecture, Code\n- Answer: yes, keep them");
    await writeFile(assumptionsPath, assumptions, "utf8");
    const again = await engine.brownfieldMerge("13131313");
    assert.equal(again.blockingAssumptions.length, 1);
    const rewritten = await readFile(assumptionsPath, "utf8");
    assert.match(rewritten, /- Status: confirmed/);
    assert.match(rewritten, /- Answer: yes, keep them/);
  });
});

test("review-status reads run files, snapshots, and refuses escapes", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    await engine.brownfield({ runId: "14141414" });
    await assertRefuses(engine.brownfieldReviewStatus("14141414"), /not found/);
    await seedFixture(dir, "14141414", "reviews/design-review.md");
    const first = await engine.brownfieldReviewStatus("14141414");
    assert.equal(first.verdict, "escalate");
    assert.equal(first.previous, null);
    assert.deepEqual(first.stalemates, []);
    await seedFixture(dir, "14141414", "reviews/design-review.prev.md");
    const second = await engine.brownfieldReviewStatus("14141414");
    assert.equal(second.verdict, "escalate");
    assert.deepEqual(second.stalemates.map((item) => item.id), ["R-3"]);
    assert.equal(second.previous, ".legion-cli/runs/14141414/reviews/design-review.prev.md");
    await seedFile(dir, "14141414", "reviews/pr-1.md", "# PR 1 review\n\n### R-1: nit\n- Severity: nit\n- Status: open\n");
    const pr = await engine.brownfieldReviewStatus("14141414", { file: "reviews/pr-1.md", snapshot: true });
    assert.equal(pr.verdict, "pass-with-minor");
    assert.equal(pr.snapshot, ".legion-cli/runs/14141414/reviews/pr-1.prev.md");
    assert.equal(existsSync(join(runDir(dir, "14141414"), "reviews", "pr-1.prev.md")), true);
    assert.equal((await engine.brownfieldReviewStatus("14141414", { file: "reviews/pr-1.md", strict: true })).verdict, "revise");
    await assertRefuses(engine.brownfieldReviewStatus("14141414", { file: "../../STATE.md" }), /inside the run directory/);
    await assertRefuses(
      engine.brownfieldReviewStatus("14141414", { file: "reviews/pr-1.md", previous: "reviews/nope.md" }),
      /previous review not found/,
    );
  });
});

test("pr-plan, dag, and per-PR worktrees stack on the audited commit", async () => {
  await withEngine(async (ctx) => {
    const head = await setupProject(ctx);
    const { dir, engine } = ctx;
    await engine.brownfield({ runId: "15151515", execute: true });
    await assertRefuses(engine.brownfieldDag("15151515"), /no dag\.json/);
    for (const bad of ["design-cycle.md", "design-missing-dep.md", "design-dup.md", "design-no-plan.md"]) {
      await seedFixture(dir, "15151515", bad, "design.md");
      await assertRefuses(engine.brownfieldPrPlan("15151515"), /pr-plan/);
      assert.equal(existsSync(join(runDir(dir, "15151515"), "dag.json")), false, bad);
    }
    assert.equal((await engine.brownfieldState("15151515")).state.phase, "intent");

    // Main moves after the audit; roots must still start at the audited commit.
    await writeFile(join(dir, "src", "main.ts"), "export const n = 2;\n", "utf8");
    git(dir, ["commit", "-am", "main moved"]);

    await seedFixture(dir, "15151515", "design-ok.md", "design.md");
    await assertRefuses(engine.brownfieldPrPlan("15151515"), /pr-plan: phase=execute needs reviews\/design-review\.md/);
    assert.equal(existsSync(join(runDir(dir, "15151515"), "dag.json")), false);
    assert.equal((await engine.brownfieldState("15151515")).state.phase, "intent");
    await seedReady(dir, "15151515");
    const plan = await engine.brownfieldPrPlan("15151515");
    assert.equal(plan.count, 3);
    assert.equal(plan.levels, 3);
    assert.equal(plan.order[0].base, head);
    BrownfieldDagSchema.parse(await readJson(join(runDir(dir, "15151515"), "dag.json")));
    assert.equal((await engine.brownfieldState("15151515")).state.phase, "execute");

    let dag = await engine.brownfieldDag("15151515");
    assert.deepEqual(dag.ready, ["pr-1"]);
    assert.equal(dag.done, false);

    await assertRefuses(engine.brownfieldWorktree("15151515", "pr-2"), /does not exist yet/);
    const wt1 = await engine.brownfieldWorktree("15151515", "pr-1");
    assert.equal(wt1.created, true);
    assert.equal(wt1.worktree, ".legion-cli/worktrees/15151515/pr-1");
    const wt1Abs = join(dir, ".legion-cli", "worktrees", "15151515", "pr-1");
    assert.equal(git(wt1Abs, ["rev-parse", "HEAD"]), head);
    assert.equal(git(wt1Abs, ["branch", "--show-current"]), plan.order[0].branch);
    assert.notEqual(git(dir, ["branch", "--show-current"]), plan.order[0].branch);
    assert.equal((await engine.brownfieldWorktree("15151515", "pr-1")).created, false);

    await writeFile(join(wt1Abs, "src", "main.ts"), "export const n = 3;\n", "utf8");
    git(wt1Abs, ["commit", "-am", "pr-1"]);
    const pr1Tip = git(wt1Abs, ["rev-parse", "HEAD"]);
    dag = await engine.brownfieldDag("15151515", "pr-1", ["status=implementing", "agentId=a1"]);
    assert.deepEqual(dag.inFlight, ["pr-1"]);
    dag = await engine.brownfieldDag("15151515", "pr-1", ["status=completed", `commit=${pr1Tip}`, "reviewRounds=2"]);
    assert.deepEqual(dag.ready, ["pr-2"]);
    assert.equal(dag.nodes[0].commit, pr1Tip);

    const wt2 = await engine.brownfieldWorktree("15151515", "pr-2");
    const wt2Abs = join(dir, ...wt2.worktree.split("/"));
    assert.equal(git(wt2Abs, ["rev-parse", "HEAD"]), pr1Tip);

    await assertRefuses(engine.brownfieldDag("15151515", "pr-2", ["status=done"]), /status must be one of/);
    await assertRefuses(engine.brownfieldDag("15151515", "pr-9", ["status=failed"]), /unknown node/);
    await assertRefuses(engine.brownfieldDag("15151515", "pr-2", ["branch=x"]), /not settable/);
    dag = await engine.brownfieldDag("15151515", "pr-2", ["status=failed", "error=tests red"]);
    const pr3 = dag.nodes.find((n) => n.id === "pr-3");
    assert.equal(pr3.status, "skipped");
    assert.match(pr3.error, /pr-2/);
    assert.equal(dag.done, true);
    assert.deepEqual(dag.counts, { completed: 1, failed: 1, skipped: 1 });

    const removed = await engine.brownfieldWorktree("15151515", "pr-1", { remove: true });
    assert.equal(removed.removed, true);
    assert.equal(existsSync(wt1Abs), false);
    assert.equal(git(dir, ["rev-parse", plan.order[0].branch]), pr1Tip);
    const after = await engine.brownfieldDag("15151515");
    assert.equal(after.nodes[0].worktree, null);
    assert.match((await engine.brownfieldState("15151515")).next, /phase=verify/);
  });
});

test("worktree refuses to nest inside a legacy single-run worktree", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    await engine.brownfield({ runId: "16161616", execute: true });
    await seedReady(dir, "16161616");
    await engine.brownfieldPrPlan("16161616");
    git(dir, ["worktree", "add", "-b", "brownfield/16161616", join(dir, ".legion-cli", "worktrees", "16161616")]);
    await assertRefuses(engine.brownfieldWorktree("16161616", "pr-1"), /legacy single worktree/);
  });
});

/** Windows 8.3 alias of `abs` (e.g. `…\LEGION~1`), or null when none is available. */
function shortPathOf(abs) {
  if (process.platform !== "win32") return null;
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `"for %I in ("${abs}") do @echo %~sI"`], {
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  const short = result.status === 0 ? result.stdout.trim() : "";
  return short && short.toLowerCase() !== abs.toLowerCase() ? short : null;
}

test("per-PR worktrees match git's long-form paths from an 8.3 short project root (RUNNER~1 TEMP)", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "legion-core-"));
  try {
    const long = join(parent, "legion-long-project");
    await mkdir(long, { recursive: true });
    const dir = shortPathOf(long);
    if (!dir) {
      t.skip("needs a Windows 8.3 short-name alias (non-Windows, or 8dot3 names disabled on this volume)");
      return;
    }
    const engine = new LegionEngine(dir);
    await setupProject({ dir, engine });
    await engine.brownfield({ runId: "18181818", execute: true });
    await seedFixture(dir, "18181818", "design-ok.md", "design.md");
    await engine.brownfieldPrPlan("18181818");
    assert.equal((await engine.brownfieldWorktree("18181818", "pr-1")).created, true);
    assert.equal((await engine.brownfieldWorktree("18181818", "pr-1")).created, false);

    await engine.brownfield({ runId: "19191919", execute: true });
    await seedFixture(dir, "19191919", "design-ok.md", "design.md");
    await engine.brownfieldPrPlan("19191919");
    git(dir, ["worktree", "add", "-b", "brownfield/19191919", join(dir, ".legion-cli", "worktrees", "19191919")]);
    await assertRefuses(engine.brownfieldWorktree("19191919", "pr-1"), /legacy single worktree/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("pr-plan roots use the audited SHA when HEAD was detached", async () => {
  await withEngine(async (ctx) => {
    const head = await setupProject(ctx);
    const { dir, engine } = ctx;
    git(dir, ["checkout", "--detach", head]);
    const init = await engine.brownfield({ runId: "17171717", execute: true });
    assert.equal(init.baseBranch, null);
    await seedReady(dir, "17171717");
    const plan = await engine.brownfieldPrPlan("17171717");
    assert.equal(plan.order[0].base, head);
  });
});

test("worktree ignores a hand-edited dag worktree path (.git, ../x, absolute) and leaves them intact", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    const outside = await mkdtemp(join(tmpdir(), "legion-outside-"));
    try {
      await writeFile(join(outside, "keep.txt"), "keep\n", "utf8");
      await engine.brownfield({ runId: "18181818", execute: true });
      await seedReady(dir, "18181818");
      await engine.brownfieldPrPlan("18181818");
      await assertRefuses(engine.brownfieldDag("18181818", "pr-1", ["worktree=.git"]), /worktree is not settable/);

      const dagFile = join(runDir(dir, "18181818"), "dag.json");
      for (const bad of [".git", relative(dir, outside).split(sep).join("/"), outside]) {
        const dag = await readJson(dagFile);
        dag.nodes[0].worktree = bad;
        await writeFile(dagFile, `${JSON.stringify(dag, null, 2)}\n`, "utf8");
        const wt = await engine.brownfieldWorktree("18181818", "pr-1");
        assert.equal(wt.worktree, ".legion-cli/worktrees/18181818/pr-1", bad);
        assert.equal(existsSync(join(dir, ".git", "HEAD")), true, bad);
        assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep\n", bad);
        assert.equal(git(dir, ["rev-parse", "--is-inside-work-tree"]), "true", bad);
        await engine.brownfieldWorktree("18181818", "pr-1", { remove: true });
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("stale worktree cleanup unlinks a junction, never its target", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    const outside = await mkdtemp(join(tmpdir(), "legion-outside-"));
    try {
      await writeFile(join(outside, "keep.txt"), "keep\n", "utf8");
      await engine.brownfield({ runId: "19191919", execute: true });
      await seedReady(dir, "19191919");
      await engine.brownfieldPrPlan("19191919");
      const wtAbs = join(dir, ".legion-cli", "worktrees", "19191919", "pr-1");
      await mkdir(dirname(wtAbs), { recursive: true });
      try {
        await symlink(outside, wtAbs, process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        if (err?.code === "EPERM" || err?.code === "EACCES") return;
        throw err;
      }
      const wt = await engine.brownfieldWorktree("19191919", "pr-1");
      assert.equal(wt.created, true);
      await assertOwnWorktree(dir, wtAbs, "pr-1");
      assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep\n");
      assert.equal(existsSync(join(outside, "src")), false);

      // A dangling junction (target deleted): existsSync says "absent", but git refuses the path.
      await engine.brownfieldWorktree("19191919", "pr-1", { remove: true });
      const gone = await mkdtemp(join(tmpdir(), "legion-gone-"));
      await symlink(gone, wtAbs, process.platform === "win32" ? "junction" : "dir");
      await rm(gone, { recursive: true, force: true });
      const dangling = await engine.brownfieldWorktree("19191919", "pr-1");
      assert.equal(dangling.created, true);
      await assertOwnWorktree(dir, wtAbs, "pr-1");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

async function assertOwnWorktree(dir, wtAbs, nodeId) {
  assert.equal(lstatSync(wtAbs).isSymbolicLink(), false);
  assert.equal(await realpath(git(wtAbs, ["rev-parse", "--show-toplevel"])), await realpath(wtAbs));
  assert.match(git(wtAbs, ["branch", "--show-current"]), new RegExp(`/${nodeId}-`));
  assert.ok(git(dir, ["worktree", "list", "--porcelain"]).includes(`${nodeId}`));
}

test("worktree never reuses a leftover directory or a link into the main checkout", async () => {
  await withEngine(async (ctx) => {
    const head = await setupProject(ctx);
    const { dir, engine } = ctx;
    await engine.brownfield({ runId: "1d1d1d1d", execute: true });
    await seedReady(dir, "1d1d1d1d");
    await engine.brownfieldPrPlan("1d1d1d1d");
    const mainBranch = git(dir, ["branch", "--show-current"]);

    // (a) A plain leftover directory (e.g. a half-removed worktree) is "inside" the main work tree.
    const leftover = join(dir, ".legion-cli", "worktrees", "1d1d1d1d", "pr-1");
    await mkdir(join(leftover, "src"), { recursive: true });
    await writeFile(join(leftover, "src", "junk.ts"), "junk\n", "utf8");
    const a = await engine.brownfieldWorktree("1d1d1d1d", "pr-1");
    assert.equal(a.created, true);
    await assertOwnWorktree(dir, leftover, "pr-1");
    assert.equal(existsSync(join(leftover, "src", "junk.ts")), false);
    await engine.brownfieldWorktree("1d1d1d1d", "pr-1", { remove: true });

    // (b) A junction/symlink from the node path to the project root.
    try {
      await symlink(dir, leftover, process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      if (err?.code === "EPERM" || err?.code === "EACCES") return;
      throw err;
    }
    const b = await engine.brownfieldWorktree("1d1d1d1d", "pr-1");
    assert.equal(b.created, true);
    await assertOwnWorktree(dir, leftover, "pr-1");
    assert.equal(existsSync(join(dir, "src", "main.ts")), true);

    // Nothing landed on the main checkout.
    await writeFile(join(leftover, "src", "main.ts"), "export const n = 9;\n", "utf8");
    git(leftover, ["commit", "-am", "pr-1 work"]);
    assert.equal(git(dir, ["branch", "--show-current"]), mainBranch);
    assert.equal(git(dir, ["rev-parse", "HEAD"]), head);
    assert.equal(await readFile(join(dir, "src", "main.ts"), "utf8"), "export const n = 1;\n");
  });
});

test("worktree resume and remove work when the project is reached through a link", async () => {
  await withEngine(async ({ dir, engine: real }) => {
    await setupProject({ dir, engine: real });
    const linkParent = await mkdtemp(join(tmpdir(), "legion-link-"));
    try {
      const linked = join(linkParent, "project");
      try {
        await symlink(dir, linked, process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        if (err?.code === "EPERM" || err?.code === "EACCES") return;
        throw err;
      }
      const engine = new LegionEngine(linked);
      await engine.brownfield({ runId: "1e1e1e1e", execute: true });
      await seedReady(linked, "1e1e1e1e");
      await engine.brownfieldPrPlan("1e1e1e1e");
      const first = await engine.brownfieldWorktree("1e1e1e1e", "pr-1");
      assert.equal(first.created, true);
      const again = await engine.brownfieldWorktree("1e1e1e1e", "pr-1");
      assert.equal(again.created, false);
      const removed = await engine.brownfieldWorktree("1e1e1e1e", "pr-1", { remove: true });
      assert.equal(removed.removed, true);
      assert.equal(existsSync(join(dir, ".legion-cli", "worktrees", "1e1e1e1e", "pr-1")), false);
    } finally {
      await rm(linkParent, { recursive: true, force: true });
    }
  });
});

test("storeAbs refuses absolute and escaping store paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "legion-storeabs-"));
  try {
    assert.equal(storeAbs(root, ".legion-cli/runs/x"), join(root, ".legion-cli", "runs", "x"));
    for (const bad of ["../x", ".legion-cli/../../x", "/abs", "C:/x", "c:\\x"]) {
      assert.throws(() => storeAbs(root, bad), (err) => err instanceof PathEscapeError, bad);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pr-plan refuses to reset DAG progress unless --force", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    await engine.brownfield({ runId: "1a1a1a1a", execute: true });
    await seedReady(dir, "1a1a1a1a");
    await engine.brownfieldPrPlan("1a1a1a1a");
    await engine.brownfieldPrPlan("1a1a1a1a"); // all pending: re-running is harmless
    const head = git(dir, ["rev-parse", "HEAD"]);
    await engine.brownfieldDag("1a1a1a1a", "pr-2", [`commit=${head}`]);
    await assertRefuses(engine.brownfieldPrPlan("1a1a1a1a"), /pr-2 pending @.*--force/);
    await engine.brownfieldDag("1a1a1a1a", "pr-1", ["status=completed"]);
    await assertRefuses(engine.brownfieldPrPlan("1a1a1a1a"), /pr-1 completed/);
    assert.equal((await engine.brownfieldDag("1a1a1a1a")).nodes[0].status, "completed");
    await engine.brownfieldPrPlan("1a1a1a1a", { force: true });
    assert.deepEqual((await engine.brownfieldDag("1a1a1a1a")).counts, { pending: 3 });

    // An unreadable or invalid dag.json may still hold progress: fail closed.
    const dagFile = join(runDir(dir, "1a1a1a1a"), "dag.json");
    await writeFile(dagFile, '{"runId": "1a1a1a1a", "nodes": [{"id": "pr-1", "status": "completed"', "utf8");
    await assertRefuses(engine.brownfieldPrPlan("1a1a1a1a"), /dag\.json is not valid JSON.*--force/);
    await writeFile(dagFile, JSON.stringify({ runId: "1a1a1a1a", nodes: [{ id: "pr-1", status: "completed" }] }), "utf8");
    await assertRefuses(engine.brownfieldPrPlan("1a1a1a1a"), /dag\.json failed schema validation.*--force/);
    await engine.brownfieldPrPlan("1a1a1a1a", { force: true });
    assert.deepEqual((await engine.brownfieldDag("1a1a1a1a")).counts, { pending: 3 });
  });
});

test("run phases: execute/verify need a design review, verify needs a completed PR, the skill's sequences pass", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    await engine.brownfield({ runId: "1b1b1b1b", execute: true });
    await assertRefuses(engine.brownfieldState("1b1b1b1b", ["phase=execute"]), /design-review\.md/);
    await assertRefuses(engine.brownfieldState("1b1b1b1b", ["phase=verify"]), /design-review\.md/);
    assert.equal((await engine.brownfieldState("1b1b1b1b")).state.phase, "intent");

    await seedFile(dir, "1b1b1b1b", "reviews/design-review.md", "# Design Review\n");
    await seedFixture(dir, "1b1b1b1b", "design-ok.md", "design.md");
    for (const phase of ["analysis", "design", "review", "design", "review", "present", "execute"]) {
      assert.equal((await engine.brownfieldState("1b1b1b1b", [`phase=${phase}`])).state.phase, phase);
    }
    await engine.brownfieldPrPlan("1b1b1b1b");
    await assertRefuses(engine.brownfieldState("1b1b1b1b", ["phase=verify"]), /skip verify.*phase=complete/);
    // Every node failed or skipped: `next` must point at the skip-verify path, not at phase=verify.
    const dagFile = join(runDir(dir, "1b1b1b1b"), "dag.json");
    const pendingDag = await readFile(dagFile, "utf8");
    await engine.brownfieldDag("1b1b1b1b", "pr-1", ["status=failed"]);
    const allFailed = await engine.brownfieldState("1b1b1b1b");
    assert.equal(allFailed.dag.done, true);
    assert.equal(allFailed.dag.completed, 0);
    assert.match(allFailed.next, /no PR completed; skip verify: .*phase=complete/);
    assert.doesNotMatch(allFailed.next, /phase=verify/);
    await writeFile(dagFile, pendingDag, "utf8");
    await engine.brownfieldDag("1b1b1b1b", "pr-1", ["status=completed"]);
    for (const phase of ["verify", "complete"]) {
      assert.equal((await engine.brownfieldState("1b1b1b1b", [`phase=${phase}`])).state.phase, phase);
    }

    await engine.brownfield({ runId: "1c1c1c1c" });
    await seedFile(dir, "1c1c1c1c", "reviews/design-review.md", "# Design Review\n");
    for (const phase of ["review", "present", "complete"]) {
      assert.equal((await engine.brownfieldState("1c1c1c1c", [`phase=${phase}`])).state.phase, phase);
    }
  });
});

test("evidence writes tests.md and security.md with redaction and no audit without a lockfile", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "tests", "main.test.ts"), "test('x', () => {});\n", "utf8");
    await writeFile(join(dir, "src", "orphan.ts"), "export {};\n", "utf8");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "legacy", scripts: { test: "echo AKIAIOSFODNN7EXAMPLE" } }),
      "utf8",
    );
    await mkdir(join(dir, ".legion-cli", "wiki"), { recursive: true });
    await writeFile(join(dir, ".legion-cli", "wiki", "leaked.md"), "token AKIAIOSFODNN7EXAMPLE leaked\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "seed"]);
    await engine.brownfield({ runId: "18181818" });
    const result = await engine.brownfieldEvidence("18181818");
    assert.equal(result.files.tests, ".legion-cli/runs/18181818/evidence/tests.md");
    assert.equal(result.testFiles, 1);
    assert.equal(result.coverageGaps, 1);
    assert.equal(result.auditRan, false);
    const tests = await readFile(join(runDir(dir, "18181818"), "evidence", "tests.md"), "utf8");
    assert.match(tests, /tests\/main\.test\.ts/);
    assert.match(tests, /src\/orphan\.ts/);
    assert.doesNotMatch(tests, /- src\/main\.ts/);
    assert.match(tests, /\[REDACTED:aws-access-key\]/);
    assert.doesNotMatch(tests, /AKIAIOSFODNN7EXAMPLE/);
    assert.doesNotMatch(tests, /### /);
    const security = await readFile(join(runDir(dir, "18181818"), "evidence", "security.md"), "utf8");
    assert.match(security, /leaked\.md` \(aws-access-key\): \[REDACTED:aws-access-key\]/);
    assert.doesNotMatch(security, /AKIAIOSFODNN7EXAMPLE/);
    assert.match(security, /no audit \(no lockfile\)/);
  });
});

test("evidence audit names packages from stdout and never runs a planted project binary", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(dir, "pnpm.cmd"), "@echo off\r\necho PWNED> PWNED.txt\r\n", "utf8");
    const bin = await mkdtemp(join(tmpdir(), "legion-audit-bin-"));
    const script = [
      "const args = process.argv.slice(2);",
      "if (args[0] === 'audit') {",
      "  process.stderr.write('npm warn extra\\nthis is not json\\n');",
      "  process.stdout.write(JSON.stringify({ vulnerabilities: { leftpad: {} } }));",
      "  process.exit(0);",
      "}",
      "process.exit(1);",
      "",
    ].join("\n");
    await writeFile(join(bin, "pnpm.mjs"), script, "utf8");
    if (process.platform === "win32") {
      await writeFile(join(bin, "pnpm.cmd"), `@echo off\r\n"${process.execPath}" "${join(bin, "pnpm.mjs")}" %*\r\n`, "utf8");
    } else {
      await writeFile(join(bin, "pnpm"), `#!${process.execPath}\n${script}`, "utf8");
      await chmod(join(bin, "pnpm"), 0o755);
    }
    await engine.brownfield({ runId: "19191919" });
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
    try {
      const result = await engine.brownfieldEvidence("19191919");
      assert.equal(result.auditRan, true);
      const security = await readFile(join(runDir(dir, "19191919"), "evidence", "security.md"), "utf8");
      assert.equal(existsSync(join(dir, "PWNED.txt")), false);
      assert.match(security, /packages: leftpad/);
      const skipped = await engine.brownfieldEvidence("19191919", { skipAudit: true });
      assert.equal(skipped.auditRan, false);
    } finally {
      process.env.PATH = previous;
      await rm(bin, { recursive: true, force: true });
    }
  });
});

test("evidence docs.md uses map fingerprints when present and says so when absent", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    await writeFile(join(dir, "src", "documented.ts"), "export const a = 1;\n", "utf8");
    await writeFile(join(dir, "src", "documented.md"), "# documented\n", "utf8");
    await engine.brownfield({ runId: "22222222" });

    // Init just mapped the repo, so docs evidence has fingerprints straight away.
    const fromInit = await engine.brownfieldEvidence("22222222", { skipAudit: true });
    assert.equal(fromInit.mapFingerprints, true);
    assert.match(await readFile(join(runDir(dir, "22222222"), "evidence", "docs.md"), "utf8"), /`src\/main\.ts` export `n`/);

    await rm(join(dir, ".legion-cli", "map", "fingerprints.json"));
    const before = await engine.brownfieldEvidence("22222222", { skipAudit: true });
    assert.equal(before.files.docs, ".legion-cli/runs/22222222/evidence/docs.md");
    assert.equal(before.mapFingerprints, false);
    const noMap = await readFile(join(runDir(dir, "22222222"), "evidence", "docs.md"), "utf8");
    assert.match(noMap, /run `legion-cli map` first/);
    assert.match(noMap, /## README\n- missing/);

    const sha = "0".repeat(64);
    await mkdir(join(dir, ".legion-cli", "map"), { recursive: true });
    await writeFile(
      join(dir, ".legion-cli", "map", "fingerprints.json"),
      JSON.stringify({
        schemaVersion: "legion-cli-fingerprint/v1",
        generatedAt: "2026-09-18T00:00:00Z",
        backend: "fallback",
        rootHash: sha,
        modules: [
          { path: "src/main.ts", language: "ts", exports: ["n"], imports: [], hash: sha },
          { path: "src/documented.ts", language: "ts", exports: ["a"], imports: [], hash: sha },
          { path: "src/gone.ts", language: "ts", exports: ["g"], imports: [], hash: sha },
        ],
      }),
      "utf8",
    );
    const after = await engine.brownfieldEvidence("22222222", { skipAudit: true });
    assert.equal(after.mapFingerprints, true);
    assert.equal(after.undocumentedExports, 1);
    const docs = await readFile(join(runDir(dir, "22222222"), "evidence", "docs.md"), "utf8");
    assert.match(docs, /`src\/main\.ts` export `n`/);
    assert.doesNotMatch(docs, /documented\.ts/);
    assert.doesNotMatch(docs, /gone\.ts/);
  });
});

test("evidence skips a junction to an outside .env", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    const outside = await mkdtemp(join(tmpdir(), "legion-escape-"));
    try {
      await writeFile(join(outside, ".env"), "AKIAIOSFODNN7EXAMPLE\n", "utf8");
      try {
        await symlink(outside, join(dir, "escaped"), process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        if (err?.code === "EPERM" || err?.code === "EACCES") return;
        throw err;
      }
      await engine.brownfield({ runId: "20202020" });
      await engine.brownfieldEvidence("20202020", { skipAudit: true });
      const security = await readFile(join(runDir(dir, "20202020"), "evidence", "security.md"), "utf8");
      assert.doesNotMatch(security, /AKIAIOSFODNN7EXAMPLE/);
      assert.doesNotMatch(security, /escaped/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("patterns count lessons across runs", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine } = ctx;
    assert.deepEqual((await engine.brownfieldPatterns()).top, []);
    await engine.brownfieldPatterns({ add: ["missing authz on object access", "  swallowed   errors "] });
    const again = await engine.brownfieldPatterns({ add: ["missing authz on object access"], top: 1 });
    assert.deepEqual(again.top, [{ pattern: "missing authz on object access", count: 2 }]);
    const file = await readJson(join(dir, ".legion-cli", "runs", "patterns.json"));
    assert.equal(file.patterns["swallowed errors"].count, 1);
    await assertRefuses(engine.brownfieldPatterns({ top: 0 }), /positive integer/);
  });
});

test("run promote copies nested run pages untrusted, intent first, no snapshots", async () => {
  await withEngine(async (ctx) => {
    await setupProject(ctx);
    const { dir, engine, store } = ctx;
    await engine.brownfield({ runId: "21212121", context: "PROMOTE_UNTRUSTED_BODY_TOKEN" });
    await assertRefuses(engine.promoteRun("21212121"), /no markdown pages/);
    await seedFile(dir, "21212121", "design.md", "# Design\n");
    await seedFile(dir, "21212121", "intent.md", "# Intent\n\nPROMOTE_UNTRUSTED_BODY_TOKEN\n");
    await seedFixture(dir, "21212121", "analysis/code.md");
    await seedFixture(dir, "21212121", "reviews/design-review.md");
    await seedFixture(dir, "21212121", "reviews/design-review.prev.md");
    const promoted = await engine.promoteRun("21212121");
    assert.deepEqual(promoted.pages, [
      ".legion-cli/wiki/runs/21212121/intent.md",
      ".legion-cli/wiki/runs/21212121/design.md",
      ".legion-cli/wiki/runs/21212121/analysis/code.md",
      ".legion-cli/wiki/runs/21212121/reviews/design-review.md",
    ]);
    assert.equal(promoted.trust, "untrusted");
    for (const page of promoted.pages) assert.equal((await store.readWikiPage(page)).data.trust, "untrusted", page);
    const nested = await store.readWikiPage(".legion-cli/wiki/runs/21212121/analysis/code.md");
    assert.equal(nested.data.source, ".legion-cli/runs/21212121/analysis/code.md");
    assert.equal(nested.data.title, "Brownfield 21212121 analysis/code");
    assert.equal((await readJson(join(runDir(dir, "21212121"), "resume.json"))).promoted, true);

    const brief = await engine.brief();
    assert.doesNotMatch(JSON.stringify(brief.wiki), /PROMOTE_UNTRUSTED_BODY_TOKEN/);
    await engine.wikiTrust(".legion-cli/wiki/runs/21212121/intent.md");
    assert.equal((await store.readWikiPage(promoted.pages[0])).data.trust, "reviewed");

    const trusted = await engine.promoteRun("21212121", { trust: true });
    assert.equal(trusted.trust, "reviewed");
    const again = await engine.promoteRun("21212121");
    assert.equal((await store.readWikiPage(again.pages[0])).data.trust, "untrusted");
  });
});
