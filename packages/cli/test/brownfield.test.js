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

test("legion-cli run promote copies run pages into the wiki", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const created = runCli(["brownfield", "--project", dir, "--json"]);
    assert.equal(created.status, 0, created.stderr);
    const runId = JSON.parse(created.stdout).runId;
    const result = runCli(["run", "promote", runId, "--project", dir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.ok(body.pages.includes(`.legion-cli/wiki/runs/${runId}/intent.md`));
    const page = await readFile(join(dir, ".legion-cli", "wiki", "runs", runId, "intent.md"), "utf8");
    assert.match(page, /trust: reviewed/);
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

test("legion-cli brownfield --effort 2 refuses", async () => {
  await withTempDir(async (dir) => {
    await seedBrownfield(dir);
    const result = runCli(["brownfield", "--project", dir, "--effort", "2"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /effort 2–5 is not implemented/);
  });
});
