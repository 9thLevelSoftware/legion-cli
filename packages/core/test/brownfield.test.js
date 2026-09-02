import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { LegionRefuseError } from "../dist/index.js";
import { git, initGitRepo, initProject, withEngine } from "./helpers.js";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("init --mode brownfield writes mode brownfield", async () => {
  await withEngine(async ({ store, engine }) => {
    await engine.init({ name: "LegacyApp", adapter: "fake", mode: "brownfield" });
    const project = await store.readProject();
    assert.equal(project.data.mode, "brownfield");
    assert.equal((await engine.getState()).phase, "initialized");
  });
});

test("effort-1 brownfield writes run artifacts, not the wiki", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine, { mode: "brownfield" });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export {}\n", "utf8");
    initGitRepo(dir);

    const result = await engine.brownfield({
      effort: 1,
      context: "demo the check-in board",
      runId: "aaaaaaaa",
    });
    assert.equal(result.runId, "aaaaaaaa");
    assert.equal(result.effort, 1);
    assert.equal(result.execute, false);
    assert.equal(result.worktreePath, null);
    assert.equal(result.phase, "complete");
    assert.deepEqual(result.pages, [
      "intent.md",
      "assumptions.md",
      "architecture.md",
      "code.md",
      "analysis.md",
      "design.md",
    ]);

    const resumeRaw = JSON.parse(
      await readFile(join(dir, ".legion-cli", "runs", "aaaaaaaa", "resume.json"), "utf8"),
    );
    assert.equal(resumeRaw.schemaVersion, "legion-cli-run/v1");
    assert.equal(resumeRaw.runId, "aaaaaaaa");
    assert.match(resumeRaw.preSpawnRef, /^[0-9a-f]{7,40}$/i);

    const intent = await readFile(join(dir, ".legion-cli", "runs", "aaaaaaaa", "intent.md"), "utf8");
    assert.match(intent, /demo the check-in board/);
    assert.match(intent, /evidence, not ground truth/i);
    const architecture = await readFile(
      join(dir, ".legion-cli", "runs", "aaaaaaaa", "architecture.md"),
      "utf8",
    );
    assert.match(architecture, /No LSP/);
    assert.doesNotMatch(architecture, /language server/i);

    assert.equal(await store.pathExists(".legion-cli/wiki/runs/aaaaaaaa/intent.md"), false);
    assert.equal(await exists(join(dir, ".legion-cli", "worktrees", "aaaaaaaa")), false);
  });
});

test("run promote copies run pages into the wiki", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine, { mode: "brownfield" });
    initGitRepo(dir);
    await engine.brownfield({ effort: 1, runId: "bbbbbbbb" });
    const promoted = await engine.promoteRun("bbbbbbbb");
    assert.ok(promoted.pages.includes(".legion-cli/wiki/runs/bbbbbbbb/intent.md"));
    const page = await store.readWikiPage(".legion-cli/wiki/runs/bbbbbbbb/intent.md");
    assert.equal(page.data.trust, "reviewed");
    assert.equal(page.data.source, ".legion-cli/runs/bbbbbbbb/intent.md");
    const resume = JSON.parse(
      await readFile(join(dir, ".legion-cli", "runs", "bbbbbbbb", "resume.json"), "utf8"),
    );
    assert.equal(resume.promoted, true);
  });
});

test("brownfield --execute uses a git worktree", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    await writeFile(join(dir, "src-app.ts"), "export const n = 1;\n", "utf8");
    initGitRepo(dir);
    const result = await engine.brownfield({ effort: 1, execute: true, runId: "cccccccc" });
    assert.equal(result.worktreePath, ".legion-cli/worktrees/cccccccc");
    const worktree = join(dir, ".legion-cli", "worktrees", "cccccccc");
    assert.equal(git(worktree, ["rev-parse", "--is-inside-work-tree"]), "true");
    assert.match(git(worktree, ["branch", "--show-current"]), /brownfield\/cccccccc/);
    assert.equal(git(dir, ["branch", "--show-current"]) === "brownfield/cccccccc", false);
  });
});

test("brownfield --resume restores resume.json", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    initGitRepo(dir);
    await engine.brownfield({ effort: 1, runId: "dddddddd" });
    const resumed = await engine.brownfield({ resume: "dddddddd", execute: true });
    assert.equal(resumed.runId, "dddddddd");
    assert.equal(resumed.execute, true);
    assert.equal(resumed.worktreePath, ".legion-cli/worktrees/dddddddd");
  });
});

test("brownfield --execute without git refuses", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine, { mode: "brownfield" });
    await assert.rejects(() => engine.brownfield({ effort: 1, execute: true }), (err) => {
      assert.equal(err instanceof LegionRefuseError, true);
      assert.match(err.nextHint, /git/);
      return true;
    });
  });
});
