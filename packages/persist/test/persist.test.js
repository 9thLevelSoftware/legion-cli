import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  EngineLockedError,
  GITIGNORE_ENTRIES,
  GITIGNORE_TEMPLATE,
  LegionStore,
  PathEscapeError,
  PersistValidationError,
  REBUILD_SQL,
  ensureGitignore,
  gitCheckIgnore,
  gitHead,
  queryIndex,
  toPosixPath,
  toStorePath,
} from "../dist/index.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureProject = join(pkgRoot, "test", "fixtures", "project");

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

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-persist-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function copyFixtureProject(dir) {
  await cp(join(fixtureProject, "legion-cli"), join(dir, ".legion-cli"), { recursive: true });
  await cp(join(fixtureProject, ".gitignore"), join(dir, ".gitignore"));
}

function initGitRepo(dir) {
  git(dir, ["init"]);
  git(dir, ["config", "user.name", "9thLevelSoftware"]);
  git(dir, ["config", "user.email", "engineering@9thlevelsoftware.com"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
}

test("Windows backslash ingest paths normalize to POSIX store paths", () => {
  assert.equal(toPosixPath("src\\ui\\button.ts"), "src/ui/button.ts");
  assert.equal(toStorePath("src\\ui\\button.ts"), "src/ui/button.ts");
  assert.equal(toStorePath(".\\src\\ui\\button.ts"), "src/ui/button.ts");
  assert.equal(toPosixPath("src/ui/button.ts"), "src/ui/button.ts");
});

test("gitignore template covers index, cache, and engine.lock", () => {
  assert.deepEqual([...GITIGNORE_ENTRIES], [
    ".legion-cli/index/",
    ".legion-cli/cache/",
    ".legion-cli/index/engine.lock",
  ]);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/index\//);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/cache\//);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/index\/engine\.lock/);
});

test("rebuild SQL is idempotent DROP+CREATE including FTS5", () => {
  assert.match(REBUILD_SQL, /DROP TABLE IF EXISTS pages_fts/);
  assert.match(REBUILD_SQL, /DROP TABLE IF EXISTS pages/);
  assert.match(REBUILD_SQL, /CREATE TABLE pages \(/);
  assert.match(REBUILD_SQL, /CREATE VIRTUAL TABLE pages_fts USING fts5/);
  assert.match(REBUILD_SQL, /CREATE TABLE links \(/);
  assert.match(REBUILD_SQL, /CREATE TABLE tasks_idx \(/);
});

test("round-trip .legion-cli markdown and intent-answers.yaml", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const store = new LegionStore(dir);

    const project = await store.readProject();
    assert.equal(project.data.schemaVersion, "legion-cli-project/v1");
    assert.equal(project.data.name, "Checkin");
    await store.writeProject(project.data, project.body);
    const project2 = await store.readProject();
    assert.deepEqual(project2.data, project.data);
    assert.equal(project2.body.trim(), project.body.trim());

    const state = await store.readState();
    assert.equal(state.data.phase, "executing");
    assert.equal(state.data.lastReview, null);
    await store.writeState(state.data, state.body);
    assert.deepEqual((await store.readState()).data, state.data);

    const answers = await store.readIntentAnswers();
    assert.equal(answers.schemaVersion, "legion-cli-intent-answers/v1");
    assert.equal(answers.rounds.length, 2);
    assert.equal(answers.mapped.problem, "They ping five chat apps every morning.");
    await store.writeIntentAnswers(answers);
    assert.deepEqual(await store.readIntentAnswers(), answers);

    const spec = await store.readSpec("spec-checkin");
    assert.equal(spec.data.id, "spec-checkin");
    await store.writeSpec(spec.data, spec.body);
    assert.deepEqual((await store.readSpec("spec-checkin")).data, spec.data);

    const task = await store.readTask("TSK-0002");
    assert.equal(task.data.status, "ready");
    assert.deepEqual(task.data.contract.filesAllowed, ["src/main.ts"]);
    await store.writeTask(task.data, task.body);
    assert.deepEqual((await store.readTask("TSK-0002")).data, task.data);

    const config = await store.readConfig();
    assert.equal(config.adapter.default, "fake");
    assert.equal(config.ingest.autoCommit, true);
  });
});

test("unknown schemaVersion fails closed", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const store = new LegionStore(dir);
    await writeFile(
      join(dir, ".legion-cli", "PROJECT.md"),
      "---\nschemaVersion: legion-cli-project/v2\nname: X\nmode: greenfield\ncontrolMode: guarded\n---\n\n",
      "utf8",
    );
    await assert.rejects(() => store.readProject(), PersistValidationError);
  });
});

test("engine.lock is single-writer and times out", async () => {
  await withTempDir(async (dir) => {
    const a = new LegionStore(dir);
    const b = new LegionStore(dir);
    await a.acquireLock({ timeoutMs: 200 });
    await assert.rejects(() => b.acquireLock({ timeoutMs: 200 }), (err) => {
      assert.equal(err instanceof EngineLockedError, true);
      assert.match(err.message, /another legion-cli is running/);
      return true;
    });
    await a.releaseLock();
    await b.acquireLock({ timeoutMs: 200 });
    await b.releaseLock();
  });
});

test("rebuild() is idempotent and indexes wiki, tasks, decisions, assumptions", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const store = new LegionStore(dir);
    await store.rebuild();
    const pages1 = queryIndex(dir, "SELECT id, path, title, trust FROM pages ORDER BY id");
    const tasks1 = queryIndex(dir, "SELECT id, status, spec_id FROM tasks_idx ORDER BY id");
    const decisions1 = queryIndex(dir, "SELECT id, status FROM decisions ORDER BY id");
    const assumptions1 = queryIndex(dir, "SELECT id, blocking FROM assumptions_idx ORDER BY id");
    const links1 = queryIndex(dir, "SELECT from_id, to_id, kind FROM links ORDER BY from_id, to_id");

    assert.ok(pages1.length >= 2);
    assert.ok(pages1.every((row) => !String(row.path).includes("\\")));
    assert.deepEqual(tasks1, [{ id: "TSK-0002", status: "ready", spec_id: "spec-checkin" }]);
    assert.deepEqual(decisions1, [{ id: "D-001", status: "accepted" }]);
    assert.deepEqual(assumptions1, [{ id: "ASM-0001", blocking: 1 }]);
    assert.ok(links1.some((row) => row.kind === "wikilink"));

    await store.rebuild();
    const pages2 = queryIndex(dir, "SELECT id, path, title, trust FROM pages ORDER BY id");
    const tasks2 = queryIndex(dir, "SELECT id, status, spec_id FROM tasks_idx ORDER BY id");
    const fts = queryIndex(dir, "SELECT title FROM pages_fts ORDER BY title");
    assert.deepEqual(pages2, pages1);
    assert.deepEqual(tasks2, tasks1);
    assert.equal(fts.length, pages1.length);
  });
});

test("index db and engine.lock are gitignored", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    await ensureGitignore(dir);
    initGitRepo(dir);
    const store = new LegionStore(dir);
    await store.rebuild();
    await store.acquireLock({ timeoutMs: 500 });
    try {
      assert.equal(gitCheckIgnore(dir, ".legion-cli/index/legion-cli.db"), true);
      assert.equal(gitCheckIgnore(dir, ".legion-cli/index/engine.lock"), true);
      assert.equal(gitCheckIgnore(dir, ".legion-cli/cache/tmp"), true);
      const status = spawnSync("git", ["status", "--porcelain"], {
        cwd: dir,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(status.status, 0);
      assert.doesNotMatch(status.stdout, /legion-cli\.db/);
      assert.doesNotMatch(status.stdout, /engine\.lock/);
    } finally {
      await store.releaseLock();
    }
  });
});

test("successful ingest auto-commits wiki pages unless noCommit", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "notes.md"), "# Office notes\n\nDurable fact.\n", "utf8");
    initGitRepo(dir);
    const store = new LegionStore(dir);
    const before = gitHead(dir);

    const receipt = await store.ingest(["docs/notes.md"]);
    assert.ok(receipt.pagesCreated.length === 1);
    assert.equal(receipt.pagesCreated[0], ".legion-cli/wiki/ingested/docs/notes.md");
    assert.ok(!receipt.pagesCreated[0].includes("\\"));
    const page = await store.readWikiPage(receipt.pagesCreated[0]);
    assert.equal(page.data.trust, "untrusted");
    assert.equal(page.data.source, "docs/notes.md");
    assert.equal(page.data.schemaVersion, "legion-cli-wiki-page/v1");

    const after = gitHead(dir);
    assert.notEqual(after, before);
    const message = git(dir, ["log", "-1", "--pretty=%s"]);
    assert.equal(message, `legion-cli ingest: ${receipt.id}`);
    const names = git(dir, ["show", "--name-only", "--pretty=format:", "HEAD"]);
    assert.match(names, /\.legion-cli\/wiki\/ingested\/docs\/notes\.md/);
    assert.doesNotMatch(names, /legion-cli\.db/);

    await writeFile(join(dir, "docs", "skip.md"), "# Skip me\n\nno commit\n", "utf8");
    const headBeforeSkip = gitHead(dir);
    const skipped = await store.ingest(["docs/skip.md"], { noCommit: true });
    assert.equal(skipped.pagesCreated.length, 1);
    assert.equal(gitHead(dir), headBeforeSkip);
    const onDisk = await readFile(
      join(dir, ".legion-cli", "wiki", "ingested", "docs", "skip.md"),
      "utf8",
    );
    assert.match(onDisk, /Skip me/);
  });
});

test("ingest accepts Windows backslash paths and stores POSIX", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    await mkdir(join(dir, "src", "ui"), { recursive: true });
    await writeFile(join(dir, "src", "ui", "button.ts"), "export const label = 'In';\n", "utf8");
    initGitRepo(dir);
    const store = new LegionStore(dir);
    const receipt = await store.ingest(["src\\ui\\button.ts"]);
    assert.deepEqual(receipt.sources, ["src/ui/button.ts"]);
    assert.equal(receipt.pagesCreated[0], ".legion-cli/wiki/ingested/src/ui/button.ts.md");
    const indexed = queryIndex(dir, "SELECT path, title FROM pages WHERE path LIKE '%button%'");
    assert.equal(indexed.length, 1);
    assert.equal(indexed[0].path, ".legion-cli/wiki/ingested/src/ui/button.ts.md");
    assert.ok(!String(indexed[0].path).includes("\\"));
  });
});

test("ingest refuses path traversal outside the workspace", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const store = new LegionStore(dir);
    const name = `secret-${process.pid}-${Date.now()}.md`;
    const outside = join(dir, "..", name);
    await writeFile(outside, "nope\n", "utf8");
    try {
      await assert.rejects(() => store.ingest([`../${name}`]), PathEscapeError);
    } finally {
      await rm(outside, { force: true });
    }
  });
});
