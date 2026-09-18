import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runCli, withTempDir } from "./helpers.js";

function git(cwd, args) {
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

function initGitRepo(dir) {
  git(dir, ["init"]);
  git(dir, ["config", "user.name", "9thLevelSoftware"]);
  git(dir, ["config", "user.email", "engineering@9thlevelsoftware.com"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function seedBrownfield(dir) {
  const init = runCli([
    "init",
    "--project",
    dir,
    "--name",
    "LegacyApp",
    "--adapter",
    "fake",
    "--mode",
    "brownfield",
  ]);
  assert.equal(init.status, 0, init.stderr);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "app.ts"), "export const n = 1;\n", "utf8");
  initGitRepo(dir);
}

function cliJson(args) {
  const result = runCli([...args, "--json"]);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function seedRunFile(dir, runId, rel, text) {
  const abs = join(dir, ".legion-cli", "runs", runId, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, text, "utf8");
}

const DESIGN = [
  "# Plan",
  "",
  "## PR Plan",
  "### PR 1: Add owner check",
  "- Depends on: none",
  "- Files: src/app.ts",
  "",
  "### PR 2: Pin refund errors",
  "- Depends on: PR 1",
  "",
].join("\n");

test("legion-cli brownfield starts a run under .legion-cli/runs and not the wiki", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const body = cliJson(["brownfield", "--project", dir, "focus on checkout"]);
    assert.equal(body.kind, "init");
    assert.equal(body.effort, 2);
    assert.equal(body.execute, false);
    assert.equal(body.phase, "intent");
    assert.match(body.runId, /^[0-9a-f]{8}$/);
    assert.equal(body.paths.intent, `.legion-cli/runs/${body.runId}/intent.md`);
    assert.match(body.next, /roster/);
    assert.equal(body.map.path, ".legion-cli/map/ARCHITECTURE.md");
    assert.ok(body.map.modules >= 1);
    assert.equal(await exists(join(dir, ".legion-cli", "map", "fingerprints.json")), true);
    const resume = JSON.parse(await readFile(join(dir, ".legion-cli", "runs", body.runId, "resume.json"), "utf8"));
    assert.equal(resume.schemaVersion, "legion-cli-run/v1");
    assert.equal(resume.context, "focus on checkout");
    assert.equal(await exists(join(dir, ".legion-cli", "wiki", "runs", body.runId)), false);
    assert.equal(await exists(join(dir, ".legion-cli", "worktrees")), false);
  });
});

test("brownfield text output ends with Next and --resume reports state", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const text = runCli(["brownfield", "init", "--project", dir, "--run-id", "aaaaaaaa", "--effort", "3", "--execute"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Brownfield run aaaaaaaa, effort 3/);
    assert.match(text.stdout, /execute: yes/);
    assert.match(text.stdout, /^Map: \d+ modules \(fallback\) at \.legion-cli\/map\/ARCHITECTURE\.md$/m);
    assert.match(text.stdout, /^Next: /m);
    assert.equal(await exists(join(dir, ".legion-cli", "worktrees", "aaaaaaaa")), false);

    const state = cliJson(["brownfield", "--project", dir, "--resume", "aaaaaaaa"]);
    assert.equal(state.kind, "state");
    assert.equal(state.state.execute, true);
    assert.equal(state.artifacts.intent, false);

    const refused = runCli(["brownfield", "--project", dir, "--resume", "aaaaaaaa", "--effort", "1", "--json"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout + refused.stderr, /cannot change effort/);
  });
});

test("brownfield subcommands drive roster → merge → review-status → pr-plan → dag → worktree", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    cliJson(["brownfield", "init", "--project", dir, "--run-id", "bbbbbbbb", "--execute", "the login is broken"]);
    const roster = cliJson(["brownfield", "roster", "bbbbbbbb", "--project", dir]);
    assert.deepEqual(roster.pass2, ["code", "tests", "security"]);

    const merge = runCli(["brownfield", "merge", "bbbbbbbb", "--project", dir, "--json"]);
    assert.equal(merge.status, 1);
    assert.match(merge.stdout + merge.stderr, /no specialist outputs/);

    await seedRunFile(
      dir,
      "bbbbbbbb",
      "analysis/code.md",
      "# Code\n\n## Findings\n### Owner check missing\n- Severity: major\n- Location: src/app.ts:1\n",
    );
    const merged = cliJson(["brownfield", "merge", "bbbbbbbb", "--project", dir]);
    assert.equal(merged.findingsTotal, 1);
    assert.equal(merged.bySeverity.major, 1);

    await seedRunFile(dir, "bbbbbbbb", "reviews/design-review.md", "# Design Review\n\n### R-1: x\n- Severity: minor\n- Status: open\n");
    const review = cliJson(["brownfield", "review-status", "bbbbbbbb", "--project", dir, "--snapshot"]);
    assert.equal(review.verdict, "pass-with-minor");
    assert.equal(review.snapshot, ".legion-cli/runs/bbbbbbbb/reviews/design-review.prev.md");
    const strict = cliJson(["brownfield", "review-status", "bbbbbbbb", "reviews/design-review.md", "--project", dir, "--strict"]);
    assert.equal(strict.verdict, "revise");

    await seedRunFile(dir, "bbbbbbbb", "design.md", DESIGN);
    const plan = cliJson(["brownfield", "pr-plan", "bbbbbbbb", "--project", dir]);
    assert.equal(plan.count, 2);
    assert.equal(plan.order[1].base, plan.order[0].branch);

    const dag = cliJson(["brownfield", "dag", "bbbbbbbb", "--project", dir]);
    assert.deepEqual(dag.ready, ["pr-1"]);
    assert.match(dag.next, /worktree bbbbbbbb pr-1/);

    const wt = cliJson(["brownfield", "worktree", "bbbbbbbb", "pr-1", "--project", dir]);
    assert.equal(wt.worktree, ".legion-cli/worktrees/bbbbbbbb/pr-1");
    const wtAbs = join(dir, ".legion-cli", "worktrees", "bbbbbbbb", "pr-1");
    assert.equal(git(wtAbs, ["rev-parse", "--is-inside-work-tree"]), "true");
    assert.equal(git(wtAbs, ["branch", "--show-current"]), plan.order[0].branch);

    const updated = cliJson(["brownfield", "dag", "bbbbbbbb", "pr-1", "status=failed", "error=tests red", "--project", dir]);
    assert.equal(updated.done, true);
    assert.equal(updated.nodes[1].status, "skipped");

    const removed = cliJson(["brownfield", "worktree", "bbbbbbbb", "pr-1", "--remove", "--project", dir]);
    assert.equal(removed.removed, true);
    assert.equal(await exists(wtAbs), false);

    const state = cliJson(["brownfield", "state", "bbbbbbbb", "phase=verify", "meta.note=done", "--project", dir]);
    assert.equal(state.state.phase, "verify");
    assert.equal(state.state.meta.note, "done");
  });
});

test("brownfield evidence and patterns", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    cliJson(["brownfield", "init", "--project", dir, "--run-id", "cccccccc"]);
    const evidence = cliJson(["brownfield", "evidence", "cccccccc", "--skip-audit", "--project", dir]);
    assert.equal(evidence.auditRan, false);
    assert.equal(await exists(join(dir, ".legion-cli", "runs", "cccccccc", "evidence", "security.md")), true);
    cliJson(["brownfield", "patterns", "--add", "missing authz on object access", "--project", dir]);
    const listed = cliJson(["brownfield", "patterns", "--add", "missing authz on object access", "--top", "5", "--project", dir]);
    assert.deepEqual(listed.top, [{ pattern: "missing authz on object access", count: 2 }]);
  });
});

test("legion-cli run promote copies run pages untrusted even with --yes", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const runId = cliJson(["brownfield", "--project", dir]).runId;
    await seedRunFile(dir, runId, "intent.md", "# Intent\n\nPROMOTE_UNTRUSTED_BODY_TOKEN\n");
    await seedRunFile(dir, runId, "analysis/code.md", "# Code\n\nPROMOTE_UNTRUSTED_BODY_TOKEN\n");
    const body = cliJson(["run", "promote", runId, "--project", dir, "--yes"]);
    assert.deepEqual(body.pages, [
      `.legion-cli/wiki/runs/${runId}/intent.md`,
      `.legion-cli/wiki/runs/${runId}/analysis/code.md`,
    ]);
    assert.equal(body.trust, "untrusted");
    assert.equal(body.next, `legion-cli wiki trust runs/${runId}/intent`);
    const page = await readFile(join(dir, ".legion-cli", "wiki", "runs", runId, "intent.md"), "utf8");
    assert.match(page, /trust: untrusted/);

    const brief = runCli(["brief", "--project", dir, "--json"]);
    assert.equal(brief.status, 0, brief.stderr);
    assert.doesNotMatch(brief.stdout, /PROMOTE_UNTRUSTED_BODY_TOKEN/);
    const search = runCli(["search", "--project", dir, "PROMOTE_UNTRUSTED_BODY_TOKEN"]);
    assert.equal(search.status, 0, search.stderr);
    assert.doesNotMatch(search.stdout, /PROMOTE_UNTRUSTED_BODY_TOKEN/);

    const trusted = cliJson(["run", "promote", runId, "--project", dir, "--trust"]);
    assert.equal(trusted.trust, "reviewed");
    assert.match(await readFile(join(dir, ".legion-cli", "wiki", "runs", runId, "intent.md"), "utf8"), /trust: reviewed/);
  });
});

test("greenfield init creates no worktrees dir", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(await exists(join(dir, ".legion-cli", "worktrees")), false);
  });
});

test("legion-cli brownfield --effort 6 refuses", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const result = runCli(["brownfield", "--project", dir, "--effort", "6"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--effort must be 1–5/);
  });
});

test("brownfield --help lists the bookkeeping subcommands", () => {
  const result = runCli(["brownfield", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  for (const sub of ["init", "state", "roster", "evidence", "merge", "review-status", "pr-plan", "dag", "worktree", "patterns"]) {
    assert.match(result.stdout, new RegExp(`^  ${sub} `, "m"), sub);
  }
  assert.doesNotMatch(result.stdout, /--run-id/);
});
