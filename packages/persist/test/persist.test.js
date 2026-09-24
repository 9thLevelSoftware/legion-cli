import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  DEFAULT_LOCK_TIMEOUT_MS,
  EMPTY_LOCK_STALE_MS,
  EngineLockedError,
  SymlinkRefusedError,
  listTaskFiles,
  nextFileId,
  ownProcessStartedAt,
  parseMarkdownDocument,
  processIdentity,
  sameProcessStart,
  startedAfterRecorded,
  atomicWriteFile,
  AuditTamperError,
  journalPreWrite,
  listIncidents,
  listJournalEntries,
  openEngineCommand,
  restoreEngineState,
  RestoreRefusedError,
  sha256Content,
  verifyAuditChain,
  writeTextFile,
  GITIGNORE_ENTRIES,
  GITIGNORE_TEMPLATE,
  LegionStore,
  PathEscapeError,
  PersistError,
  PersistValidationError,
  REBUILD_SQL,
  ensureGitignore,
  legionPaths,
  serveJsonPath,
  appendAuditEvent,
  auditEventsPath,
  formatAuditDayLine,
  readAuditEvents,
  summarizeAuditMetrics,
  gitAdd,
  gitCheckIgnore,
  gitDiscoverChanges,
  gitHead,
  gitBranchCreate,
  gitRevParse,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitStagedPaths,
  tryGitBranch,
  worktreeNodeStorePath,
  hasSecretPattern,
  queryIndex,
  redactSecrets,
  toFsPath,
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

test("toFsPath refuses nested drive-relative segments", () => {
  const dest = resolve(tmpdir(), "legion-tofs");
  assert.throws(() => toFsPath(dest, "nested/D:payload"), PathEscapeError);
  assert.throws(() => toFsPath(dest, "nested/C:../Windows/win.ini"), PathEscapeError);
  assert.throws(() => toFsPath(dest, "D:payload"), PathEscapeError);
  const colonName = toFsPath(dest, "docs/api:v2.md");
  assert.equal(colonName, resolve(dest, "docs", "api:v2.md"));
});

test("gitignore template covers index, cache, engine.lock, worktrees, sandbox, chat, serve", () => {
  assert.deepEqual([...GITIGNORE_ENTRIES], [
    ".legion-cli/index/",
    ".legion-cli/cache/",
    ".legion-cli/index/engine.lock",
    ".legion-cli/worktrees/",
    ".legion-cli/sandbox/",
    ".legion-cli/chat/",
    ".legion-cli/serve.json",
    ".legion-cli/runs/",
  ]);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/runs\//);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/index\//);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/cache\//);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/index\/engine\.lock/);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/worktrees\//);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/sandbox\//);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/chat\//);
  assert.match(GITIGNORE_TEMPLATE, /\.legion-cli\/serve\.json/);
});

test("legionPaths includes map, skills overlay, chat, and sandbox dirs", () => {
  const paths = legionPaths("proj");
  assert.equal(paths.mapDir, join("proj", ".legion-cli", "map"));
  assert.equal(paths.skillsOverlayDir, join("proj", ".legion-cli", "skills"));
  assert.equal(paths.chatDir, join("proj", ".legion-cli", "chat"));
  assert.equal(paths.sandboxDir, join("proj", ".legion-cli", "sandbox"));
  assert.equal(paths.serveJson, join("proj", ".legion-cli", "serve.json"));
  assert.equal(serveJsonPath(), ".legion-cli/serve.json");
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

test("fresh empty or invalid engine.lock files wait rather than steal", async () => {
  await withTempDir(async (dir) => {
    const store = new LegionStore(dir);
    await mkdir(store.paths.indexDir, { recursive: true });
    await writeFile(store.paths.lock, "", "utf8");
    await assert.rejects(() => store.acquireLock({ timeoutMs: 200 }), EngineLockedError);
    assert.equal(await readFile(store.paths.lock, "utf8"), "");

    await writeFile(store.paths.lock, "not-json\n", "utf8");
    await assert.rejects(() => store.acquireLock({ timeoutMs: 200 }), EngineLockedError);
    assert.equal(await readFile(store.paths.lock, "utf8"), "not-json\n");

    await writeFile(store.paths.lock, JSON.stringify({ pid: "nope" }), "utf8");
    await assert.rejects(() => store.acquireLock({ timeoutMs: 200 }), EngineLockedError);
  });
});

// Inverted from "empty or invalid engine.lock files wait rather than steal" (F-051, F-059):
// a crash between create and write left an empty lock that hung every verb forever.
test("an empty or unparseable engine.lock older than 10 s is stolen", async () => {
  await withTempDir(async (dir) => {
    const store = new LegionStore(dir);
    await mkdir(store.paths.indexDir, { recursive: true });
    const old = new Date(Date.now() - EMPTY_LOCK_STALE_MS - 5_000);
    for (const payload of ["", "not-json\n", JSON.stringify({ pid: "nope" })]) {
      await writeFile(store.paths.lock, payload, "utf8");
      await utimes(store.paths.lock, old, old);
      await store.acquireLock({ timeoutMs: 200 });
      const held = JSON.parse(await readFile(store.paths.lock, "utf8"));
      assert.equal(held.pid, process.pid, `payload ${JSON.stringify(payload)} was not stolen`);
      await store.releaseLock();
    }
  });
});

const LOCK_HOLDER_SCRIPT = `
import { readFileSync, writeFileSync, utimesSync } from "node:fs";
const { acquireEngineLock } = await import(process.argv[1]);
const lockPath = process.argv[2];
const mode = process.argv[3] ?? "aged";
await acquireEngineLock(lockPath, { timeoutMs: 5000 });
const held = JSON.parse(readFileSync(lockPath, "utf8"));
// Pretend the lock has been held for a day: the old rule stole by age.
const payload = { ...held, acquiredAt: "2000-01-01T00:00:00.000Z" };
// A lock written by an older legion-cli: no pidStartedAt, createdAt instead of acquiredAt.
if (mode === "legacy") {
  delete payload.pidStartedAt;
  delete payload.acquiredAt;
  payload.createdAt = "2000-01-01T00:00:00.000Z";
}
// The holder's own start estimate ran late (macOS sleep): recorded later than the OS value.
if (mode === "late-estimate") payload.pidStartedAt = Date.now() + 3_600_000;
writeFileSync(lockPath, JSON.stringify(payload) + "\\n");
const old = new Date(Date.now() - 86_400_000);
utimesSync(lockPath, old, old);
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;

function spawnLockHolder(lockPath, mode = "aged") {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", LOCK_HOLDER_SCRIPT, pathToFileURL(join(pkgRoot, "dist", "index.js")).href, lockPath, mode],
    { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
  );
  const ready = new Promise((resolveReady, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("ready")) resolveReady();
    });
    child.once("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
  return { child, ready };
}

async function killAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGKILL");
  await exited;
}

test("a lock held by a live process is never stolen by age", async () => {
  await withTempDir(async (dir) => {
    const store = new LegionStore(dir);
    await mkdir(store.paths.indexDir, { recursive: true });
    const { child, ready } = spawnLockHolder(store.paths.lock);
    try {
      await ready;
      const before = await readFile(store.paths.lock, "utf8");
      assert.equal(JSON.parse(before).pid, child.pid);
      await assert.rejects(
        () => store.acquireLock({ timeoutMs: 300 }),
        (err) => {
          assert.equal(err instanceof EngineLockedError, true);
          assert.match(err.message, /another legion-cli is running/);
          assert.match(err.message, new RegExp(`pid ${child.pid}`));
          assert.match(err.message, /delete .*engine\.lock/);
          return true;
        },
      );
      assert.equal(await readFile(store.paths.lock, "utf8"), before, "live holder's lock must survive");
    } finally {
      await killAndWait(child);
    }
    // Once the holder is dead the lock is stale.
    await store.acquireLock({ timeoutMs: 2_000 });
    assert.equal(JSON.parse(await readFile(store.paths.lock, "utf8")).pid, process.pid);
    await store.releaseLock();
  });
});

test("a lock whose pidStartedAt differs from the live PID's start time is stolen (PID reuse)", async () => {
  await withTempDir(async (dir) => {
    const store = new LegionStore(dir);
    await mkdir(store.paths.indexDir, { recursive: true });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      assert.ok(child.pid);
      await writeFile(
        store.paths.lock,
        `${JSON.stringify({
          pid: child.pid,
          pidStartedAt: Date.now() - 10 * 86_400_000,
          acquiredAt: new Date().toISOString(),
          token: "reused",
        })}\n`,
        "utf8",
      );
      await store.acquireLock({ timeoutMs: 200 });
      const held = JSON.parse(await readFile(store.paths.lock, "utf8"));
      assert.equal(held.pid, process.pid);
      assert.equal(typeof held.pidStartedAt, "number");
      assert.equal(typeof held.acquiredAt, "string");
      await store.releaseLock();
    } finally {
      await killAndWait(child);
    }
  });
});

for (const [mode, pattern] of [
  ["legacy", /Its start time could not be read, so the lock was not cleared/],
  ["late-estimate", /another legion-cli is running/],
]) {
  test(`a live holder's lock is not stolen (${mode} start time)`, async () => {
    await withTempDir(async (dir) => {
      const store = new LegionStore(dir);
      await mkdir(store.paths.indexDir, { recursive: true });
      const { child, ready } = spawnLockHolder(store.paths.lock, mode);
      try {
        await ready;
        const before = await readFile(store.paths.lock, "utf8");
        await assert.rejects(
          () => store.acquireLock({ timeoutMs: 300 }),
          (err) => {
            assert.equal(err instanceof EngineLockedError, true);
            assert.match(err.message, pattern);
            assert.match(err.message, new RegExp(`pid ${child.pid}`));
            return true;
          },
        );
        assert.equal(await readFile(store.paths.lock, "utf8"), before);
      } finally {
        await killAndWait(child);
      }
    });
  });
}

test("PID reuse is one-sided: only a process that started after the recorded start steals", () => {
  assert.equal(startedAfterRecorded(1_000_000 + 60_000, 1_000_000), true);
  assert.equal(startedAfterRecorded(1_000_000, 1_000_000 + 60_000), false, "a late estimate never steals");
  assert.equal(startedAfterRecorded(1_000_000 + 1_000, 1_000_000), false, "within tolerance");
});

test("an out-of-range pid is an unparseable lock with a recovery hint, never a TypeError", async () => {
  await withTempDir(async (dir) => {
    const store = new LegionStore(dir);
    await mkdir(store.paths.indexDir, { recursive: true });
    const crafted = `${JSON.stringify({ pid: 4_294_967_296, acquiredAt: "\u001b[31mred\u001b[0m" })}\n`;
    await writeFile(store.paths.lock, crafted, "utf8");
    await assert.rejects(
      () => store.acquireLock({ timeoutMs: 200 }),
      (err) => {
        assert.equal(err instanceof EngineLockedError, true, String(err));
        assert.match(err.message, /empty or unreadable/);
        assert.match(err.message, /delete .*engine\.lock/);
        assert.doesNotMatch(err.message, /\u001b/);
        return true;
      },
    );
    const old = new Date(Date.now() - EMPTY_LOCK_STALE_MS - 5_000);
    await utimes(store.paths.lock, old, old);
    await store.acquireLock({ timeoutMs: 200 });
    assert.equal(JSON.parse(await readFile(store.paths.lock, "utf8")).pid, process.pid);
    await store.releaseLock();
  });
});

test("two contenders stealing the same stale lock never hold it at the same time", async () => {
  await withTempDir(async (dir) => {
    const paths = legionPaths(dir);
    await mkdir(paths.indexDir, { recursive: true });
    for (let round = 0; round < 5; round += 1) {
      await writeFile(
        paths.lock,
        `${JSON.stringify({ pid: 2_000_000_000, pidStartedAt: 1, acquiredAt: new Date().toISOString(), token: "dead" })}\n`,
        "utf8",
      );
      let inside = 0;
      let overlap = false;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          const store = new LegionStore(dir);
          await store.withLock(
            async () => {
              inside += 1;
              if (inside > 1) overlap = true;
              await new Promise((done) => setTimeout(done, 20));
              inside -= 1;
            },
            { timeoutMs: 5_000 },
          );
        }),
      );
      assert.equal(overlap, false, `round ${round}`);
      assert.deepEqual((await readdir(paths.indexDir)).filter((name) => name.endsWith(".steal")), []);
    }
  });
});

test("a leftover steal guard makes acquisition wait and time out, then clear once stale or future-dated", async () => {
  await withTempDir(async (dir) => {
    const paths = legionPaths(dir);
    const guard = `${paths.lock}.steal`;
    await mkdir(paths.indexDir, { recursive: true });
    const deadLock = `${JSON.stringify({ pid: 2_000_000_000, pidStartedAt: 1, acquiredAt: new Date().toISOString(), token: "dead" })}\n`;
    await writeFile(paths.lock, deadLock, "utf8");
    // A stealer that crashed a moment ago: fresh guard. The old loop spun here until it aged out.
    await writeFile(guard, "", "utf8");
    const store = new LegionStore(dir);
    const started = Date.now();
    await assert.rejects(
      () => store.acquireLock({ timeoutMs: 300 }),
      (err) => {
        assert.equal(err instanceof EngineLockedError, true);
        assert.match(err.message, /engine\.lock\.steal is held/);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 250 && elapsed < 5_000, `timed out after ${elapsed} ms`);
    assert.equal(await readFile(paths.lock, "utf8"), deadLock);

    for (const [label, when] of [
      ["aged out", new Date(Date.now() - 11_000)],
      ["future-dated", new Date(Date.now() + 3_600_000)],
    ]) {
      await writeFile(paths.lock, deadLock, "utf8");
      await writeFile(guard, "", "utf8");
      await utimes(guard, when, when);
      await store.acquireLock({ timeoutMs: 2_000 });
      assert.equal(JSON.parse(await readFile(paths.lock, "utf8")).pid, process.pid, label);
      await store.releaseLock();
      assert.equal(existsSync(guard), false, label);
    }
  });
});

test("processIdentity reports this process's start time within tolerance", async () => {
  const actual = await processIdentity(process.pid);
  assert.equal(typeof actual, "number");
  assert.ok(sameProcessStart(actual, ownProcessStartedAt()), `${actual} vs ${ownProcessStartedAt()}`);
  assert.equal(await processIdentity(-1), null);
});

test("one store serializes concurrent withLock callers; nested calls re-enter", async () => {
  await withTempDir(async (dir) => {
    const store = new LegionStore(dir);
    let inside = 0;
    let maxInside = 0;
    const order = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        store.withLock(async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise((done) => setTimeout(done, 5));
          // Re-entrant: the same async chain must not wait on itself.
          await store.withLock(async () => order.push(i));
          inside -= 1;
        }),
      ),
    );
    assert.equal(maxInside, 1);
    assert.equal(order.length, 6);
    assert.equal(existsSync(store.paths.lock), false);
  });
});

test("a write that throws midway leaves the previous STATE.md intact and no temp file", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const store = new LegionStore(dir);
    const before = await readFile(store.paths.stateMd, "utf8");
    // Yields one chunk, then fails: an in-place writeFile would already have truncated the file.
    async function* tornBody() {
      yield "---\nschemaVersion: legion-cli-state/v1\nphase: exec";
      throw new Error("crash mid-write");
    }
    await assert.rejects(() => atomicWriteFile(store.paths.stateMd, tornBody(), { root: dir }), /crash mid-write/);
    assert.equal(await readFile(store.paths.stateMd, "utf8"), before);
    assert.deepEqual(
      (await readdir(dirname(store.paths.stateMd))).filter((name) => name.endsWith(".tmp")),
      [],
    );
    await store.readState();
  });
});

test("writer vs reader: no torn reads and no failed writes", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const store = new LegionStore(dir);
    const base = await store.readState();
    const initial = await readFile(store.paths.stateMd, "utf8");
    const body = "x".repeat(64 * 1024);
    const complete = (raw) => raw === initial || (raw.includes(body) && /x\n\d+\n$/.test(raw));
    let done = false;
    let tornReads = 0;
    let failedReads = 0;
    let reads = 0;
    const reader = (async () => {
      while (!done) {
        try {
          const raw = await readFile(store.paths.stateMd, "utf8");
          reads += 1;
          if (!complete(raw)) tornReads += 1;
        } catch {
          // win32: ENOENT/EPERM while the rename lands; the store's reader retries these.
        }
        try {
          await store.readState();
        } catch {
          failedReads += 1;
        }
      }
    })();
    let failedWrites = 0;
    for (let i = 0; i < 200; i += 1) {
      const data = { ...base.data, currentTaskId: `TSK-${String(i).padStart(4, "0")}` };
      try {
        await store.writeState(data, `${body}\n${i}\n`);
      } catch {
        failedWrites += 1;
      }
    }
    done = true;
    await reader;
    assert.ok(reads > 0);
    assert.equal(tornReads, 0);
    assert.equal(failedReads, 0);
    assert.equal(failedWrites, 0);
  });
});

test("a UTF-8 BOM before the frontmatter parses", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const store = new LegionStore(dir);
    const raw = await readFile(store.paths.stateMd, "utf8");
    await writeFile(store.paths.stateMd, `﻿${raw}`, "utf8");
    const state = await store.readState();
    assert.equal(typeof state.data.phase, "string");
    assert.deepEqual(parseMarkdownDocument(`﻿---\na: 1\n---\nbody\n`), { frontmatter: { a: 1 }, body: "body\n" });
  });
});

test("listTaskFiles lists invalid task files instead of dropping them", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const store = new LegionStore(dir);
    const good = await readFile(join(store.paths.tasksDir, "TSK-0002.md"), "utf8");
    await writeFile(join(store.paths.tasksDir, "TSK-0003.md"), good.replace(/status: \w+/, "status: Ready"), "utf8");
    await writeFile(join(store.paths.tasksDir, "TSK-0004.md"), good.slice(0, Math.floor(good.length / 3)), "utf8");
    const entries = await listTaskFiles(dir);
    assert.deepEqual(
      entries.map((entry) => [entry.file, entry.ok]),
      [
        ["TSK-0002.md", true],
        ["TSK-0003.md", false],
        ["TSK-0004.md", false],
      ],
    );
    assert.match(entries[1].error, /^status: /);
    assert.equal(entries[1].frontmatter.status, "Ready");
    assert.ok(entries[2].error.length > 0);
  });
});

test("nextFileId allocates from file names, valid or not, and leaves no placeholder", async () => {
  await withTempDir(async (dir) => {
    const tasks = join(dir, "tasks");
    assert.equal(await nextFileId(tasks, "TSK", 4), "TSK-0001");
    await mkdir(tasks, { recursive: true });
    await writeFile(join(tasks, "TSK-0001.md"), "ok", "utf8");
    await writeFile(join(tasks, "TSK-0007.md"), "not a task", "utf8");
    await writeFile(join(tasks, "PKT-0042.md"), "other prefix", "utf8");
    assert.equal(await nextFileId(tasks, "TSK", 4), "TSK-0008");
    assert.equal(existsSync(join(tasks, "TSK-0008.md")), false, "no empty reservation file");
  });
});

test("store writes refuse a junction or symlink between the project root and the target", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const store = new LegionStore(dir);
    const outside = await mkdtemp(join(tmpdir(), "legion-persist-outside-"));
    try {
      const task = await store.readTask("TSK-0002");
      await rm(store.paths.tasksDir, { recursive: true, force: true });
      await symlink(outside, store.paths.tasksDir, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(() => store.writeTask(task.data, task.body), SymlinkRefusedError);
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("engine.lock payload includes a token; dead pid is still stolen", async () => {
  await withTempDir(async (dir) => {
    const store = new LegionStore(dir);
    await store.acquireLock({ timeoutMs: 200 });
    const held = JSON.parse(await readFile(store.paths.lock, "utf8"));
    assert.equal(held.pid, process.pid);
    assert.equal(typeof held.token, "string");
    assert.ok(held.token.length >= 16);
    await store.releaseLock();

    await mkdir(store.paths.indexDir, { recursive: true });
    await writeFile(
      store.paths.lock,
      `${JSON.stringify({ pid: 2_000_000_000, createdAt: new Date().toISOString(), token: "dead" })}\n`,
      "utf8",
    );
    await store.acquireLock({ timeoutMs: 200 });
    const next = JSON.parse(await readFile(store.paths.lock, "utf8"));
    assert.equal(next.pid, process.pid);
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
      assert.equal(gitCheckIgnore(dir, ".legion-cli/sandbox/run-1"), true);
      assert.equal(gitCheckIgnore(dir, ".legion-cli/chat/session.json"), true);
      assert.equal(gitCheckIgnore(dir, ".legion-cli/serve.json"), true);
      assert.equal(gitCheckIgnore(dir, ".legion-cli/runs/aaaaaaaa/resume.json"), true);
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

test("8.3 short project paths canonicalize like ingest's realpath (RUNNER~1 TEMP)", async (t) => {
  await withTempDir(async (dir) => {
    const long = join(dir, "legion-long-project");
    await mkdir(long, { recursive: true });
    const short = shortPathOf(long);
    if (!short) {
      t.skip("needs a Windows 8.3 short-name alias (non-Windows, or 8dot3 names disabled on this volume)");
      return;
    }
    await writeFile(join(long, "README.md"), "app\n", "utf8");
    initGitRepo(long);
    const worktree = join(short, ".legion-cli", "worktrees", "dddddddd", "pr-1");
    gitWorktreeAdd(short, worktree, "brownfield/dddddddd/pr-1-x");
    assert.equal(gitWorktreeRemove(short, worktree), true);
    assert.equal(existsSync(worktree), false);

    await copyFixtureProject(long);
    await mkdir(join(long, "docs"), { recursive: true });
    const file = join(long, "docs", "notes.md");
    await writeFile(file, "# Office notes\n\nDurable fact.\n", "utf8");
    assert.equal(toProjectRelativePosix(short, file), "docs/notes.md");
    assert.equal(toProjectRelativePosix(long, join(short, "docs", "notes.md")), "docs/notes.md");
    const store = new LegionStore(short);
    const receipt = await store.ingest(["docs/notes.md"], { noCommit: true });
    assert.equal(receipt.pagesCreated[0], ".legion-cli/wiki/ingested/docs/notes.md");
  });
});

test("redactSecrets covers the documented secret patterns", () => {
  const leaked = [
    "AKIAIOSFODNN7EXAMPLE",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "sk-proj-testfixture000000000000000000",
    "sk-ant-testfixture000000000000000000",
    "xai-abcdefghijklmnopqrstuvwxyz",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
    "ghp_abcdefghijklmnopqrstuvwxyzABCD",
    "github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz",
  ].join("\n");
  const redacted = redactSecrets(leaked);
  assert.match(redacted, /\[REDACTED:aws-access-key\]/);
  assert.match(redacted, /\[REDACTED:sk\]/);
  assert.match(redacted, /\[REDACTED:sk-proj\]/);
  assert.match(redacted, /\[REDACTED:sk-ant\]/);
  assert.match(redacted, /\[REDACTED:xai\]/);
  assert.match(redacted, /\[REDACTED:private-key\]/);
  assert.match(redacted, /\[REDACTED:ghp\]/);
  assert.match(redacted, /\[REDACTED:github_pat\]/);
  assert.doesNotMatch(redacted, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(redacted, /sk-proj-testfixture/);
  assert.doesNotMatch(redacted, /sk-ant-testfixture/);
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
        "sk-proj-testfixture000000000000000000 sk-ant-testfixture000000000000000000",
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
    assert.match(page.body, /\[REDACTED:sk-proj\]/);
    assert.match(page.body, /\[REDACTED:sk-ant\]/);
    assert.match(page.body, /\[REDACTED:ghp\]/);
    assert.match(page.body, /\[REDACTED:xai\]/);
    assert.match(page.body, /\[REDACTED:github_pat\]/);
    assert.match(page.body, /\[REDACTED:private-key\]/);
    assert.doesNotMatch(page.body, /AKIAIOSFODNN7EXAMPLE/);
    assert.doesNotMatch(page.body, /sk-proj-testfixture/);
    assert.doesNotMatch(page.body, /sk-ant-testfixture/);
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

test("gitWorktreeAdd creates a missing branch at startPoint, not HEAD", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "README.md"), "app\n", "utf8");
    initGitRepo(dir);
    const base = git(dir, ["rev-parse", "HEAD"]);
    await writeFile(join(dir, "README.md"), "moved\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "main moved"]);
    const worktree = join(dir, ".legion-cli", "worktrees", "aaaaaaaa", "pr-1");
    gitWorktreeAdd(dir, worktree, "brownfield/aaaaaaaa/pr-1-x", base);
    assert.equal(git(worktree, ["rev-parse", "HEAD"]), base);
    assert.equal(gitRevParse(dir, "brownfield/aaaaaaaa/pr-1-x"), base);
    assert.equal(worktreeNodeStorePath("aaaaaaaa", "pr-1"), ".legion-cli/worktrees/aaaaaaaa/pr-1");
  });
});

test("gitWorktreeAdd never clears .git or a path outside .legion-cli/worktrees", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "README.md"), "app\n", "utf8");
    initGitRepo(dir);
    const outside = await mkdtemp(join(tmpdir(), "legion-outside-"));
    try {
      await writeFile(join(outside, "keep.txt"), "keep\n", "utf8");
      const refused = (path) =>
        assert.throws(
          () => gitWorktreeAdd(dir, path, "brownfield/dddddddd/pr-1-x"),
          (err) => err instanceof PersistError && /refusing to remove/.test(err.message),
        );
      refused(join(dir, ".git"));
      refused(join(dir, ".legion-cli", "worktrees", "dddddddd", ".git"));
      refused(join(dir, ".legion-cli", "worktrees"));
      refused(outside);
      assert.equal(existsSync(join(dir, ".git", "HEAD")), true);
      assert.equal(git(dir, ["rev-parse", "--is-inside-work-tree"]), "true");
      assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("gitWorktreeAdd refuses when .legion-cli/worktrees links outside the project", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "README.md"), "app\n", "utf8");
    initGitRepo(dir);
    const outside = await mkdtemp(join(tmpdir(), "legion-outside-"));
    try {
      await mkdir(join(outside, "r", "pr-1"), { recursive: true });
      await writeFile(join(outside, "r", "pr-1", "keep.txt"), "keep\n", "utf8");
      await mkdir(join(dir, ".legion-cli"), { recursive: true });
      try {
        await symlink(outside, join(dir, ".legion-cli", "worktrees"), process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        if (err?.code === "EPERM" || err?.code === "EACCES") return;
        throw err;
      }
      assert.throws(
        () => gitWorktreeAdd(dir, join(dir, ".legion-cli", "worktrees", "r", "pr-1"), "brownfield/r/pr-1-x"),
        (err) => err instanceof PersistError && /resolves outside the project/.test(err.message),
      );
      assert.equal(await readFile(join(outside, "r", "pr-1", "keep.txt"), "utf8"), "keep\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("gitWorktreeAdd reuses and removes a worktree when the project is reached through a link", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "README.md"), "app\n", "utf8");
    initGitRepo(dir);
    const linkParent = await mkdtemp(join(tmpdir(), "legion-link-"));
    try {
      const linked = join(linkParent, "project");
      try {
        await symlink(dir, linked, process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        if (err?.code === "EPERM" || err?.code === "EACCES") return;
        throw err;
      }
      const worktree = join(linked, ".legion-cli", "worktrees", "eeeeeeee", "pr-1");
      assert.equal(gitWorktreeAdd(linked, worktree, "brownfield/eeeeeeee/pr-1-x"), resolve(worktree));
      const tip = git(worktree, ["rev-parse", "HEAD"]);
      await writeFile(join(worktree, "wip.txt"), "wip\n", "utf8");
      // Second call: reuse the registered worktree (git lists it under the real path).
      assert.equal(gitWorktreeAdd(linked, worktree, "brownfield/eeeeeeee/pr-1-x"), resolve(worktree));
      assert.equal(await readFile(join(worktree, "wip.txt"), "utf8"), "wip\n");
      assert.equal(git(worktree, ["rev-parse", "HEAD"]), tip);
      assert.equal(gitWorktreeRemove(linked, worktree, { force: true }), true);
      assert.equal(existsSync(worktree), false);
      assert.equal(existsSync(join(dir, ".git", "HEAD")), true);
    } finally {
      await rm(linkParent, { recursive: true, force: true });
    }
  });
});

test("gitWorktreeRemove removes the checkout and keeps the branch", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "README.md"), "app\n", "utf8");
    initGitRepo(dir);
    const worktree = join(dir, ".legion-cli", "worktrees", "cccccccc", "pr-1");
    gitWorktreeAdd(dir, worktree, "brownfield/cccccccc/pr-1-x");
    assert.equal(gitWorktreeRemove(dir, worktree), true);
    assert.equal(existsSync(worktree), false);
    assert.notEqual(gitRevParse(dir, "brownfield/cccccccc/pr-1-x"), null);
    assert.equal(gitWorktreeRemove(dir, worktree), false);
  });
});

test("gitBranchCreate and tryGitBranch handle detached HEAD", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "README.md"), "app\n", "utf8");
    initGitRepo(dir);
    const head = git(dir, ["rev-parse", "HEAD"]);
    assert.ok(tryGitBranch(dir));
    assert.equal(gitBranchCreate(dir, "brownfield/x/pr-1-a", head), true);
    assert.equal(gitBranchCreate(dir, "brownfield/x/pr-1-a", head), false);
    git(dir, ["checkout", "--detach", head]);
    assert.equal(tryGitBranch(dir), null);
    assert.equal(gitRevParse(dir, "no-such-branch"), null);
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

test("formatAuditDayLine appends adapter when data.adapterId is a string", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".legion-cli", "audit"), { recursive: true });
    const line = formatAuditDayLine({
      schemaVersion: "legion-cli-audit/v1",
      ts: "2026-09-02T12:00:00.000Z",
      type: "execute",
      phase: "executing",
      taskId: "TSK-0100",
      actor: "agent",
      data: { adapterId: "grok" },
    });
    assert.equal(
      line,
      "- 2026-09-02T12:00:00.000Z execute phase=executing task=TSK-0100 actor=agent adapter=grok\n",
    );
    await appendAuditEvent(dir, {
      ts: "2026-09-02T12:00:00.000Z",
      type: "execute",
      phase: "executing",
      taskId: "TSK-0100",
      actor: "agent",
      data: { adapterId: "grok", durationMs: 12 },
    });
    const day = await readFile(join(dir, ".legion-cli", "audit", "2026-09-02.md"), "utf8");
    assert.match(day, /execute phase=executing task=TSK-0100 actor=agent adapter=grok/);
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

test("pre-image store restores byte-exact content; a digest alone cannot", async () => {
  await withTempDir(async (dir) => {
    const paths = legionPaths(dir);
    await mkdir(paths.tasksDir, { recursive: true });
    const taskPath = join(paths.tasksDir, "TSK-0001.md");
    const original = "original-bytes-please-keep\n";
    await writeFile(taskPath, original, "utf8");
    await openEngineCommand(dir, "cmd-pre");
    await writeFile(taskPath, "forged-done\n", "utf8");
    const result = await restoreEngineState(dir, "cmd-pre", { agentAlive: false, jailWritable: false });
    assert.equal(await readFile(taskPath, "utf8"), original);
    assert.ok(result.restored.includes(".legion-cli/tasks/TSK-0001.md"));
    assert.equal(sha256Content(await readFile(taskPath)), sha256Content(original));
  });
});

test("journaled engine write survives restore; mixed write is a tamper restore of journaled bytes", async () => {
  await withTempDir(async (dir) => {
    const paths = legionPaths(dir);
    await mkdir(paths.qaDir, { recursive: true });
    await mkdir(join(paths.qaDir, "scores"), { recursive: true });
    await openEngineCommand(dir, "cmd-mix");
    const scorePath = join(paths.qaDir, "scores", "qa-1.json");
    const engineBytes = '{"id":"qa-1","pass":true}\n';
    await writeTextFile(scorePath, engineBytes, { root: dir });
    await writeFile(scorePath, '{"id":"qa-1","pass":false,"forged":true}\n', "utf8");
    const result = await restoreEngineState(dir, "cmd-mix", { agentAlive: false, jailWritable: false });
    assert.equal(await readFile(scorePath, "utf8"), engineBytes);
    assert.ok(result.tampered.includes(".legion-cli/qa/scores/qa-1.json"));
    const incidents = await listIncidents(dir);
    assert.equal(incidents.some((row) => row.type === "tamper"), true);
  });
});

test("pre-op journal without post restores old-hash (SIGKILL mid-write); landed write is kept", async () => {
  await withTempDir(async (dir) => {
    const paths = legionPaths(dir);
    await mkdir(paths.tasksDir, { recursive: true });
    const taskPath = join(paths.tasksDir, "TSK-0001.md");
    const original = "engine-owned-original\n";
    await writeFile(taskPath, original, "utf8");
    await openEngineCommand(dir, "cmd-kill");
    const intended = "engine-owned-new\n";
    await journalPreWrite(dir, taskPath, Buffer.from(intended, "utf8"));
    const rolled = await restoreEngineState(dir, "cmd-kill", { agentAlive: false, jailWritable: false });
    assert.equal(await readFile(taskPath, "utf8"), original);
    assert.ok(rolled.reconciled.includes(".legion-cli/tasks/TSK-0001.md"));

    await writeFile(taskPath, original, "utf8");
    await openEngineCommand(dir, "cmd-kill-landed");
    const pre = await journalPreWrite(dir, taskPath, Buffer.from(intended, "utf8"));
    await atomicWriteFile(taskPath, intended, { root: dir });
    const kept = await restoreEngineState(dir, "cmd-kill-landed", { agentAlive: false, jailWritable: false });
    assert.equal(await readFile(taskPath, "utf8"), intended);
    assert.ok(kept.kept.includes(".legion-cli/tasks/TSK-0001.md"));
    assert.equal(pre.kind, "pre");
  });
});

test("restore refuses while agentAlive or jailWritable", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".legion-cli", "tasks"), { recursive: true });
    await writeFile(join(dir, ".legion-cli", "tasks", "TSK-0001.md"), "x\n", "utf8");
    await openEngineCommand(dir, "cmd-order");
    await assert.rejects(
      () => restoreEngineState(dir, "cmd-order", { agentAlive: true, jailWritable: false }),
      RestoreRefusedError,
    );
    await assert.rejects(
      () => restoreEngineState(dir, "cmd-order", { agentAlive: false, jailWritable: true }),
      RestoreRefusedError,
    );
  });
});

test("pre-image, journal, and incident store writes refuse a junction at the store root", async () => {
  await withTempDir(async (dir) => {
    const paths = legionPaths(dir);
    await mkdir(paths.indexDir, { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), "legion-store-junc-"));
    try {
      for (const storeRoot of [paths.preImageDir, paths.journalDir, paths.incidentDir]) {
        await rm(storeRoot, { recursive: true, force: true });
        await symlink(outside, storeRoot, process.platform === "win32" ? "junction" : "dir");
      }
      await mkdir(paths.tasksDir, { recursive: true });
      await writeFile(join(paths.tasksDir, "TSK-0001.md"), "x\n", "utf8");
      await assert.rejects(() => openEngineCommand(dir, "cmd-junc"), SymlinkRefusedError);
      await assert.rejects(
        () => writeTextFile(join(paths.tasksDir, "TSK-0001.md"), "y\n", { root: dir }),
        SymlinkRefusedError,
      );
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("audit digest chain refuses rewind and middle rewrite", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".legion-cli", "audit"), { recursive: true });
    await appendAuditEvent(dir, {
      ts: "2026-09-01T12:00:00.000Z",
      type: "execute",
      phase: "executing",
      actor: "agent",
      data: { ok: true },
    });
    await appendAuditEvent(dir, {
      ts: "2026-09-01T12:00:01.000Z",
      type: "qa",
      phase: "executing",
      actor: "user",
      data: { pass: true },
    });
    const chain = await verifyAuditChain(dir);
    assert.equal(chain.length, 2);
    const jsonl = join(dir, ...auditEventsPath().split("/"));
    const raw = await readFile(jsonl, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    await writeFile(jsonl, `${lines[0]}\n`, "utf8");
    await assert.rejects(() => verifyAuditChain(dir), AuditTamperError);
    await writeFile(jsonl, raw, "utf8");
    await verifyAuditChain(dir);
    const mutated = lines.map((line, i) => (i === 0 ? line.replace("execute", "forged") : line)).join("\n") + "\n";
    await writeFile(jsonl, mutated, "utf8");
    await assert.rejects(() => verifyAuditChain(dir), AuditTamperError);
  });
});

test("cross-instance journaled write is visible to restore", async () => {
  await withTempDir(async (dir) => {
    const paths = legionPaths(dir);
    await mkdir(paths.tasksDir, { recursive: true });
    const taskPath = join(paths.tasksDir, "TSK-0001.md");
    await writeFile(taskPath, "before\n", "utf8");
    await openEngineCommand(dir, "cmd-cross");
    const child = join(dir, "journal-child.mjs");
    const persistHref = pathToFileURL(join(pkgRoot, "dist", "index.js")).href;
    await writeFile(
      child,
      `import { writeTextFile } from ${JSON.stringify(persistHref)};
await writeTextFile(${JSON.stringify(taskPath)}, "dashboard-post\\n", { root: ${JSON.stringify(dir)} });
`,
      "utf8",
    );
    const spawned = spawnSync(process.execPath, [child], { encoding: "utf8", windowsHide: true });
    assert.equal(spawned.status, 0, spawned.stderr);
    assert.equal(await readFile(taskPath, "utf8"), "dashboard-post\n");
    const result = await restoreEngineState(dir, "cmd-cross", { agentAlive: false, jailWritable: false });
    assert.equal(await readFile(taskPath, "utf8"), "dashboard-post\n");
    assert.ok(result.kept.includes(".legion-cli/tasks/TSK-0001.md"));
    const entries = await listJournalEntries(dir);
    assert.ok(entries.some((entry) => entry.path === ".legion-cli/tasks/TSK-0001.md" && entry.kind === "post"));
  });
});
