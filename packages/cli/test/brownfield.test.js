import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

test("legion-cli brownfield writes .legion-cli/runs and not wiki", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const result = runCli(["brownfield", "--project", dir, "--json", "focus on checkout"]);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.effort, 1);
    assert.equal(body.execute, false);
    assert.match(body.runId, /^[0-9a-f]{8}$/);
    assert.equal(await exists(join(dir, ".legion-cli", "runs", body.runId, "resume.json")), true);
    assert.equal(await exists(join(dir, ".legion-cli", "runs", body.runId, "analysis.md")), true);
    assert.equal(await exists(join(dir, ".legion-cli", "wiki", "runs", body.runId, "analysis.md")), false);
    const resume = JSON.parse(
      await readFile(join(dir, ".legion-cli", "runs", body.runId, "resume.json"), "utf8"),
    );
    assert.equal(resume.schemaVersion, "legion-cli-run/v1");
    assert.match(await readFile(join(dir, ".legion-cli", "runs", body.runId, "architecture.md"), "utf8"), /No LSP/);
  });
});

test("legion-cli run promote copies run pages untrusted even with --yes", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const created = runCli(["brownfield", "--project", dir, "--json", "PROMOTE_UNTRUSTED_BODY_TOKEN"]);
    assert.equal(created.status, 0, created.stderr);
    const runId = JSON.parse(created.stdout).runId;
    const result = runCli(["run", "promote", runId, "--project", dir, "--yes", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.ok(body.pages.includes(`.legion-cli/wiki/runs/${runId}/intent.md`));
    assert.ok(body.pages.includes(`.legion-cli/wiki/runs/${runId}/analysis.md`));
    assert.equal(body.trust, "untrusted");
    assert.equal(body.next, `legion-cli wiki trust runs/${runId}/intent`);
    const page = await readFile(join(dir, ".legion-cli", "wiki", "runs", runId, "intent.md"), "utf8");
    assert.match(page, /trust: untrusted/);
    assert.match(page, /PROMOTE_UNTRUSTED_BODY_TOKEN/);
    const analysis = await readFile(join(dir, ".legion-cli", "wiki", "runs", runId, "analysis.md"), "utf8");
    assert.match(analysis, /trust: untrusted/);
    assert.match(analysis, /PROMOTE_UNTRUSTED_BODY_TOKEN/);

    const brief = runCli(["brief", "--project", dir, "--json"]);
    assert.equal(brief.status, 0, brief.stderr);
    const briefBody = JSON.parse(brief.stdout);
    const runWiki = briefBody.wiki.filter((item) => item.path.includes(`/runs/${runId}/`));
    assert.equal(runWiki.length > 0, true);
    for (const entry of runWiki) {
      assert.equal(entry.trust, "untrusted", entry.path);
      assert.equal(entry.summary ?? null, null, entry.path);
    }
    assert.doesNotMatch(brief.stdout, /PROMOTE_UNTRUSTED_BODY_TOKEN/);

    const search = runCli(["search", "--project", dir, "PROMOTE_UNTRUSTED_BODY_TOKEN"]);
    assert.equal(search.status, 0, search.stderr);
    assert.doesNotMatch(search.stdout, /PROMOTE_UNTRUSTED_BODY_TOKEN/);
  });
});

test("legion-cli run promote --trust is the only reviewed path", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const created = runCli(["brownfield", "--project", dir, "--json"]);
    assert.equal(created.status, 0, created.stderr);
    const runId = JSON.parse(created.stdout).runId;
    const withoutFlag = runCli(["run", "promote", runId, "--project", dir, "--json"]);
    assert.equal(withoutFlag.status, 0, withoutFlag.stderr);
    assert.equal(JSON.parse(withoutFlag.stdout).trust, "untrusted");
    const page = await readFile(join(dir, ".legion-cli", "wiki", "runs", runId, "intent.md"), "utf8");
    assert.match(page, /trust: untrusted/);

    const trusted = runCli(["run", "promote", runId, "--project", dir, "--trust", "--json"]);
    assert.equal(trusted.status, 0, trusted.stderr);
    const body = JSON.parse(trusted.stdout);
    assert.equal(body.trust, "reviewed");
    const reviewed = await readFile(join(dir, ".legion-cli", "wiki", "runs", runId, "intent.md"), "utf8");
    assert.match(reviewed, /trust: reviewed/);
  });
});

test("legion-cli brownfield --execute uses a git worktree", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const result = runCli(["brownfield", "--project", dir, "--execute", "--json"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.worktreePath, `.legion-cli/worktrees/${body.runId}`);
    const worktree = join(dir, ".legion-cli", "worktrees", body.runId);
    assert.equal(git(worktree, ["rev-parse", "--is-inside-work-tree"]), "true");
  });
});

test("greenfield execute stays in-place (no worktree)", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(await exists(join(dir, ".legion-cli", "worktrees")), false);
  });
});

test("legion-cli brownfield --effort 2 writes tests.md", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const result = runCli(["brownfield", "--project", dir, "--effort", "2", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.effort, 2);
    assert.ok(body.pages.includes("tests.md"));
    assert.equal(await exists(join(dir, ".legion-cli", "runs", body.runId, "tests.md")), true);
    const resume = JSON.parse(
      await readFile(join(dir, ".legion-cli", "runs", body.runId, "resume.json"), "utf8"),
    );
    assert.equal(resume.effort, 2);
  });
});

test("legion-cli brownfield --effort 6 still refuses range", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const result = runCli(["brownfield", "--project", dir, "--effort", "6"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /brownfield --effort must be 1–5/);
    assert.match(result.stderr, /legion-cli brownfield --effort 1\|2\|3\|4\|5/);
  });
});

test("legion-cli brownfield --lsp is ignored on effort 1–4", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const result = runCli(["brownfield", "--project", dir, "--effort", "2", "--lsp", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /--lsp is ignored for effort 1–4/);
    assert.equal(JSON.parse(result.stdout).effort, 2);
  });
});

test("legion-cli brownfield --effort 5 --lsp without a server refuses map --no-lsp", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const result = runCli(["brownfield", "--project", dir, "--effort", "5", "--lsp"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no language server on PATH/);
    assert.match(result.stderr, /Next: legion-cli map --no-lsp/);
  });
});

test("legion-cli brownfield --effort 5 writes map fingerprints and leaves specs untouched", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const result = runCli(["brownfield", "--project", dir, "--effort", "5", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.effort, 5);
    assert.ok(body.pages.includes("improvement-spec.md"));
    assert.equal(await exists(join(dir, ".legion-cli", "map", "fingerprints.json")), true);
    assert.equal(await exists(join(dir, ".legion-cli", "runs", body.runId, "improvement-spec.md")), true);
    assert.equal(await exists(join(dir, ".legion-cli", "specs", "improvement-spec.md")), false);
    const specBody = await readFile(join(dir, ".legion-cli", "runs", body.runId, "improvement-spec.md"), "utf8");
    assert.match(specBody, /this file is not SPEC\.md/);
    const listed = await readdir(join(dir, ".legion-cli", "specs")).catch(() => []);
    assert.deepEqual(listed, []);
  });
});
