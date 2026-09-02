import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEFAULT_LOCK_TIMEOUT_MS,
  EngineLockedError,
  GITIGNORE_ENTRIES,
  GITIGNORE_TEMPLATE,
  LegionStore,
  PathEscapeError,
  PersistError,
  PersistValidationError,
  REBUILD_SQL,
  ensureGitignore,
  appendAuditEvent,
  auditEventsPath,
  readAuditEvents,
  summarizeAuditMetrics,
  gitAdd,
  gitCheckIgnore,
  gitDiscoverChanges,
  gitHead,
  gitWorktreeAdd,
  gitStagedPaths,
  hasSecretPattern,
  queryIndex,
  redactSecrets,
  toPosixPath,
  toProjectRelativePosix,
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

test("gitignore template covers index, cache, engine.lock, and worktrees", () => {
  assert.deepEqual([...GITIGNORE_ENTRIES], [
    ".legion-cli/index/",
    ".legion-cli/cache/",
    ".legion-cli/index/engine.lock",
    ".legion-cli/worktrees/",
  ]);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/index\//);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/cache\//);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/index\/engine\.lock/);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/worktrees\//);
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

    const context = await store.readContext();
    assert.equal(context.data.schemaVersion, "legion-cli-context/v1");
    await store.writeContext(context.data, context.body);
    assert.deepEqual((await store.readContext()).data, context.data);

    const discuss = await store.readDiscuss();
    assert.equal(discuss.data.decisions[0].id, "D-001");
    await store.writeDiscuss(discuss.data, discuss.body);
    assert.deepEqual((await store.readDiscuss()).data, discuss.data);

    const assumption = await store.readAssumption("ASM-0001");
    assert.equal(assumption.data.blocking, true);
    await store.writeAssumption(assumption.data, assumption.body);
    assert.deepEqual((await store.readAssumption("ASM-0001")).data, assumption.data);

    const decision = await store.readDecision("0001-mobile-web.md");
    assert.equal(decision.data.id, "D-001");
    assert.equal(decision.data.status, "accepted");
    await store.writeDecision("0001-mobile-web.md", decision.data, decision.body);
    assert.deepEqual((await store.readDecision("0001-mobile-web.md")).data, decision.data);

    const packet = {
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
    };
    await store.writePacket(packet, "Requested by pm.\n");
    const packetDoc = await store.readPacket("PKT-0001");
    assert.deepEqual(packetDoc.data, packet);
    assert.match(packetDoc.body, /Requested by pm/);
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

test("engine.lock default timeout is 30s", () => {
  assert.equal(DEFAULT_LOCK_TIMEOUT_MS, 30_000);
});

test("engine.lock is single-writer and times out", async () => {
  await withTempDir(async (dir) => {
    const a = new LegionStore(dir);
    const b = new LegionStore(dir);
    await a.acquireLock({ timeoutMs: 200 });
    const started = Date.now();
    await assert.rejects(() => b.acquireLock({ timeoutMs: 200 }), (err) => {
      assert.equal(err instanceof EngineLockedError, true);
      assert.equal(err.message, "another legion-cli is running.");
      return true;
    });
    assert.ok(Date.now() - started >= 150, "timeout must wait before refusing");
    await a.releaseLock();
    await b.acquireLock({ timeoutMs: 200 });
    await b.releaseLock();
  });
});

test("empty or invalid engine.lock files are treated as stale", async () => {
  await withTempDir(async (dir) => {
    const store = new LegionStore(dir);
    await mkdir(store.paths.indexDir, { recursive: true });
    await writeFile(store.paths.lock, "", "utf8");
    await store.acquireLock({ timeoutMs: 500 });
    await store.releaseLock();

    await writeFile(store.paths.lock, "not-json\n", "utf8");
    await store.acquireLock({ timeoutMs: 500 });
    await store.releaseLock();

    await writeFile(store.paths.lock, JSON.stringify({ pid: "nope" }), "utf8");
    await store.acquireLock({ timeoutMs: 500 });
    await store.releaseLock();
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
      assert.equal(gitCheckIgnore(dir, ".legion-cli/worktrees/tmp"), true);
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

test("re-ingest of unchanged file preserves reviewed trust and does not commit", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    await writeFile(join(dir, "notes.md"), "# Office notes\n\nDurable fact.\n", "utf8");
    initGitRepo(dir);
    const store = new LegionStore(dir);
    const first = await store.ingest(["notes.md"]);
    const pagePath = first.pagesCreated[0];
    const doc = await store.readWikiPage(pagePath);
    await store.writeWikiPage(pagePath, { ...doc.data, trust: "reviewed" }, doc.body);
    const headAfterTrust = gitHead(dir);

    const second = await store.ingest(["notes.md"]);
    assert.ok(second.skipped.includes("notes.md"));
    assert.equal(second.pagesCreated.length, 0);
    assert.equal(second.pagesUpdated.length, 0);
    const after = await store.readWikiPage(pagePath);
    assert.equal(after.data.trust, "reviewed");
    assert.equal(gitHead(dir), headAfterTrust);
  });
});

test("re-ingest of changed file resets trust to untrusted", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    await writeFile(join(dir, "notes.md"), "# Office notes\n\nDurable fact.\n", "utf8");
    initGitRepo(dir);
    const store = new LegionStore(dir);
    const first = await store.ingest(["notes.md"]);
    const pagePath = first.pagesCreated[0];
    const doc = await store.readWikiPage(pagePath);
    await store.writeWikiPage(pagePath, { ...doc.data, trust: "reviewed" }, doc.body);

    await writeFile(join(dir, "notes.md"), "# Office notes\n\nCHANGED_UNTRUSTED_BODY now lives here.\n", "utf8");
    const second = await store.ingest(["notes.md"]);
    assert.ok(second.pagesUpdated.includes(pagePath));
    assert.equal(second.pagesCreated.length, 0);
    const after = await store.readWikiPage(pagePath);
    assert.equal(after.data.trust, "untrusted");
    assert.match(after.body, /CHANGED_UNTRUSTED_BODY/);
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
      await assert.rejects(() => store.ingest([`../${name}`], { noCommit: true }), PathEscapeError);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("auto-commit ingest refuses before writes when not a git repo", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "notes.md"), "# Office notes\n\nDurable fact.\n", "utf8");
    const store = new LegionStore(dir);
    await assert.rejects(() => store.ingest(["docs/notes.md"]), (err) => {
      assert.equal(err instanceof PersistError, true);
      assert.match(err.message, /git repository/);
      return true;
    });
    assert.equal(await store.pathExists(".legion-cli/wiki/ingested/docs/notes.md"), false);
  });
});

test("directory ingest skips .legion-cli and does not clobber reviewed wiki", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "notes.md"), "# Office notes\n\nDurable fact.\n", "utf8");
    const store = new LegionStore(dir);
    const before = await store.readWikiPage(".legion-cli/wiki/README.md");
    assert.equal(before.data.trust, "reviewed");
    const receipt = await store.ingest(["."], { noCommit: true });
    assert.ok(receipt.pagesCreated.includes(".legion-cli/wiki/ingested/docs/notes.md"));
    assert.ok(!receipt.pagesCreated.some((p) => p === ".legion-cli/wiki/README.md"));
    const after = await store.readWikiPage(".legion-cli/wiki/README.md");
    assert.deepEqual(after.data, before.data);
    assert.equal(after.body.trim(), before.body.trim());
  });
});

test("overlapping ingest sources are deduped to one store path", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "notes.md"), "# Office notes\n\nDurable fact.\n", "utf8");
    const store = new LegionStore(dir);
    const receipt = await store.ingest(["docs", "docs/notes.md"], { noCommit: true });
    const page = ".legion-cli/wiki/ingested/docs/notes.md";
    const created = receipt.pagesCreated.filter((p) => p === page);
    const updated = receipt.pagesUpdated.filter((p) => p === page);
    assert.equal(created.length + updated.length, 1);
  });
});

test("ingest skips NUL-less binary files by extension and invalid UTF-8", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    await writeFile(join(dir, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x10, 0x4a, 0x46]));
    await writeFile(join(dir, "blob"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x10]));
    const store = new LegionStore(dir);
    const receipt = await store.ingest(["photo.jpg", "blob"], { noCommit: true });
    assert.ok(receipt.skipped.includes("photo.jpg"));
    assert.ok(receipt.skipped.includes("blob"));
    assert.equal(receipt.pagesCreated.length, 0);
  });
});

test("project containment compares canonical realpaths", async () => {
  await withTempDir(async (dir) => {
    const real = join(dir, "real");
    const alias = join(dir, "alias");
    await mkdir(real, { recursive: true });
    await copyFixtureProject(real);
    await mkdir(join(real, "docs"), { recursive: true });
    const file = join(real, "docs", "notes.md");
    await writeFile(file, "# Office notes\n\nDurable fact.\n", "utf8");
    try {
      await symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      if (process.platform === "win32") return;
      throw err;
    }
    assert.equal(toProjectRelativePosix(alias, file), "docs/notes.md");
    const store = new LegionStore(alias);
    const receipt = await store.ingest(["docs/notes.md"], { noCommit: true });
    assert.equal(receipt.pagesCreated[0], ".legion-cli/wiki/ingested/docs/notes.md");
  });
});

test("redactSecrets covers the documented secret patterns", () => {
  const leaked = [
    "AKIAIOSFODNN7EXAMPLE",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "xai-abcdefghijklmnopqrstuvwxyz",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
    "ghp_abcdefghijklmnopqrstuvwxyzABCD",
    "github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz",
  ].join("\n");
  const redacted = redactSecrets(leaked);
  assert.match(redacted, /\[REDACTED:aws-access-key\]/);
  assert.match(redacted, /\[REDACTED:sk\]/);
  assert.match(redacted, /\[REDACTED:xai\]/);
  assert.match(redacted, /\[REDACTED:private-key\]/);
  assert.match(redacted, /\[REDACTED:ghp\]/);
  assert.match(redacted, /\[REDACTED:github_pat\]/);
  assert.doesNotMatch(redacted, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(redacted, /xai-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(redacted, /BEGIN RSA PRIVATE KEY/);
  assert.doesNotMatch(redacted, /ghp_abcdefghijklmnopqrstuvwxyzABCD/);
  assert.doesNotMatch(redacted, /github_pat_11AAAAAAA0123456789/);
  assert.equal(hasSecretPattern(leaked), true);
  assert.equal(hasSecretPattern(redacted), false);
  assert.equal(hasSecretPattern("no secrets in this wiki page"), false);
});

test("ingest redacts secrets before wiki write", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    await writeFile(
      join(dir, "leaked.md"),
      [
        "# Leaked",
        "",
        "AKIAIOSFODNN7EXAMPLE key sk-abcdefghijklmnopqrstuvwxyz ghp_abcdefghijklmnopqrstuvwxyz",
        "xai-abcdefghijklmnopqrstuvwxyz",
        "github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "secret-material",
        "-----END OPENSSH PRIVATE KEY-----",
        "",
      ].join("\n"),
      "utf8",
    );
    const store = new LegionStore(dir);
    const receipt = await store.ingest(["leaked.md"], { noCommit: true });
    const page = await store.readWikiPage(receipt.pagesCreated[0]);
    assert.match(page.body, /\[REDACTED:aws-access-key\]/);
    assert.match(page.body, /\[REDACTED:sk\]/);
    assert.match(page.body, /\[REDACTED:ghp\]/);
    assert.match(page.body, /\[REDACTED:xai\]/);
    assert.match(page.body, /\[REDACTED:github_pat\]/);
    assert.match(page.body, /\[REDACTED:private-key\]/);
    assert.doesNotMatch(page.body, /AKIAIOSFODNN7EXAMPLE/);
    assert.doesNotMatch(page.body, /secret-material/);
    assert.equal(redactSecrets("xai-abcdefghijklmnopqrstuvwxyz").includes("xai-"), false);
  });
});

test("ingest documents write untrusted wiki pages", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const store = new LegionStore(dir);
    const receipt = await store.ingest([], {
      noCommit: true,
      documents: [
        {
          source: "https://example.com/guide",
          title: "Guide",
          body: "Public HTTPS excerpt.\n",
        },
      ],
    });
    assert.equal(receipt.pagesCreated.length, 1);
    assert.ok(receipt.pagesCreated[0].startsWith(".legion-cli/wiki/ingested/"));
    const page = await store.readWikiPage(receipt.pagesCreated[0]);
    assert.equal(page.data.trust, "untrusted");
    assert.equal(page.data.source, "https://example.com/guide");
    assert.match(page.body, /Public HTTPS excerpt/);
  });
});

test("gitDiscoverChanges lists both paths of a committed rename", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "secret.ts"), "secret\n", "utf8");
    initGitRepo(dir);
    const pre = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["mv", "secret.ts", "leaked.ts"]);
    git(dir, ["commit", "-m", "rename"]);
    const paths = gitDiscoverChanges(dir, pre);
    assert.ok(paths.includes("secret.ts"), `expected secret.ts in ${JSON.stringify(paths)}`);
    assert.ok(paths.includes("leaked.ts"), `expected leaked.ts in ${JSON.stringify(paths)}`);
  });
});

test("gitWorktreeAdd creates an isolated checkout", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "README.md"), "app\n", "utf8");
    initGitRepo(dir);
    const worktree = join(dir, ".legion-cli", "worktrees", "aaaaaaaa");
    const added = gitWorktreeAdd(dir, worktree, "brownfield/aaaaaaaa");
    assert.equal(added, resolve(worktree));
    assert.equal(git(worktree, ["rev-parse", "--is-inside-work-tree"]), "true");
    assert.match(git(worktree, ["branch", "--show-current"]), /brownfield\/aaaaaaaa/);
    gitWorktreeAdd(dir, worktree, "brownfield/aaaaaaaa");
  });
});

test("gitWorktreeAdd recreates a deleted checkout without resetting the branch", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "README.md"), "app\n", "utf8");
    initGitRepo(dir);
    const worktree = join(dir, ".legion-cli", "worktrees", "bbbbbbbb");
    gitWorktreeAdd(dir, worktree, "brownfield/bbbbbbbb");
    const branchTip = git(worktree, ["rev-parse", "HEAD"]);
    await writeFile(join(dir, "README.md"), "moved\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "main moved"]);
    const mainHead = git(dir, ["rev-parse", "HEAD"]);
    assert.notEqual(mainHead, branchTip);

    await rm(worktree, { recursive: true, force: true });
    gitWorktreeAdd(dir, worktree, "brownfield/bbbbbbbb");
    assert.equal(git(worktree, ["rev-parse", "--is-inside-work-tree"]), "true");
    assert.match(git(worktree, ["branch", "--show-current"]), /brownfield\/bbbbbbbb/);
    assert.equal(git(worktree, ["rev-parse", "HEAD"]), branchTip);
    assert.equal(git(dir, ["rev-parse", "HEAD"]), mainHead);
  });
});

test("appendAuditEvent writes events.jsonl and YYYY-MM-DD.md", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".legion-cli", "audit"), { recursive: true });
    const event = await appendAuditEvent(dir, {
      ts: "2026-09-01T12:00:00.000Z",
      type: "ship",
      phase: "shipped",
      actor: "user",
      data: { specId: "spec-checkin", qaMode: "full", qaScore: 94 },
    });
    assert.equal(event.schemaVersion, "legion-cli-audit/v1");
    const jsonl = await readFile(join(dir, ...auditEventsPath().split("/")), "utf8");
    assert.match(jsonl, /"type":"ship"/);
    assert.match(jsonl, /"qaScore":94/);
    const day = await readFile(join(dir, ".legion-cli", "audit", "2026-09-01.md"), "utf8");
    assert.match(day, /# 2026-09-01/);
    assert.match(day, /ship phase=shipped/);
  });
});

test("readAuditEvents skips missing and malformed lines", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await readAuditEvents(dir), []);
    await mkdir(join(dir, ".legion-cli", "audit"), { recursive: true });
    await appendAuditEvent(dir, {
      ts: "2026-09-01T12:00:00.000Z",
      type: "refuse",
      phase: "initialized",
      actor: "user",
      data: { kind: "plan" },
    });
    const jsonl = join(dir, ...auditEventsPath().split("/"));
    await appendFile(jsonl, "not-json\n", "utf8");
    await appendFile(jsonl, `${JSON.stringify({ schemaVersion: "nope" })}\n`, "utf8");
    const events = await readAuditEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "refuse");
  });
});

test("summarizeAuditMetrics counts refuses, QA, execute duration, timeouts", () => {
  const metrics = summarizeAuditMetrics([
    {
      schemaVersion: "legion-cli-audit/v1",
      ts: "2026-09-01T12:00:00.000Z",
      type: "refuse",
      phase: "initialized",
      actor: "user",
      data: { kind: "plan" },
    },
    {
      schemaVersion: "legion-cli-audit/v1",
      ts: "2026-09-01T12:00:01.000Z",
      type: "refuse",
      phase: "initialized",
      actor: "user",
      data: { kind: "plan" },
    },
    {
      schemaVersion: "legion-cli-audit/v1",
      ts: "2026-09-01T12:00:02.000Z",
      type: "qa",
      phase: "ready_to_ship",
      actor: "user",
      data: { pass: true, total: 94 },
    },
    {
      schemaVersion: "legion-cli-audit/v1",
      ts: "2026-09-01T12:00:03.000Z",
      type: "qa",
      phase: "executing",
      actor: "user",
      data: { pass: false, total: 70 },
    },
    {
      schemaVersion: "legion-cli-audit/v1",
      ts: "2026-09-01T12:00:04.000Z",
      type: "execute",
      phase: "executing",
      actor: "agent",
      data: { durationMs: 10, timedOut: false },
    },
    {
      schemaVersion: "legion-cli-audit/v1",
      ts: "2026-09-01T12:00:05.000Z",
      type: "execute",
      phase: "executing",
      actor: "agent",
      data: { durationMs: 30, timedOut: true },
    },
    {
      schemaVersion: "legion-cli-audit/v1",
      ts: "2026-09-01T12:00:06.000Z",
      type: "timeout",
      phase: "executing",
      actor: "agent",
      data: { skillId: "execute" },
    },
  ]);
  assert.equal(metrics.refusesByType.plan, 2);
  assert.equal(metrics.qa.runs, 2);
  assert.equal(metrics.qa.passes, 1);
  assert.equal(metrics.qa.passRate, 0.5);
  assert.equal(metrics.execute.runs, 2);
  assert.equal(metrics.execute.meanDurationMs, 20);
  assert.equal(metrics.timeouts, 1);
  assert.equal(
    summarizeAuditMetrics([
      {
        schemaVersion: "legion-cli-audit/v1",
        ts: "2026-09-01T12:00:07.000Z",
        type: "execute",
        phase: "executing",
        actor: "agent",
        data: { durationMs: 5, timedOut: true },
      },
    ]).timeouts,
    0,
  );
});

test("git add stages listed paths and not gitignored index/cache", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".legion-cli", "index"), { recursive: true });
    await mkdir(join(dir, ".legion-cli", "cache"), { recursive: true });
    await writeFile(join(dir, ".gitignore"), ".legion-cli/index/\n.legion-cli/cache/\n", "utf8");
    await writeFile(join(dir, ".legion-cli", "STATE.md"), "state\n", "utf8");
    await writeFile(join(dir, ".legion-cli", "index", "engine.lock"), "lock\n", "utf8");
    await writeFile(join(dir, ".legion-cli", "cache", "x"), "x\n", "utf8");
    await writeFile(join(dir, "src.ts"), "src\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "src.ts"), "src2\n", "utf8");
    await writeFile(join(dir, "other.ts"), "nope\n", "utf8");
    gitAdd(dir, ["src.ts", ".legion-cli"]);
    const staged = gitStagedPaths(dir);
    assert.ok(staged.includes("src.ts"), staged.join(","));
    assert.equal(staged.includes("other.ts"), false);
    assert.equal(staged.some((p) => p.startsWith(".legion-cli/index")), false);
    assert.equal(staged.some((p) => p.startsWith(".legion-cli/cache")), false);
  });
});
