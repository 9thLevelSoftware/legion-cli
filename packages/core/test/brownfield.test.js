import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HINT, LegionRefuseError } from "../dist/index.js";
import { git, initGitRepo, initProject, withEngine, withFakeAdapter } from "./helpers.js";

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

test("run promote copies run pages into the wiki as untrusted", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine, { mode: "brownfield" });
    initGitRepo(dir);
    await engine.brownfield({
      effort: 1,
      runId: "bbbbbbbb",
      context: "PROMOTE_UNTRUSTED_BODY_TOKEN unique run evidence",
    });
    const promoted = await engine.promoteRun("bbbbbbbb");
    assert.ok(promoted.pages.includes(".legion-cli/wiki/runs/bbbbbbbb/intent.md"));
    assert.ok(promoted.pages.includes(".legion-cli/wiki/runs/bbbbbbbb/analysis.md"));
    assert.equal(promoted.trust, "untrusted");
    for (const dest of promoted.pages) {
      const doc = await store.readWikiPage(dest);
      assert.equal(doc.data.trust, "untrusted", dest);
    }
    const page = await store.readWikiPage(".legion-cli/wiki/runs/bbbbbbbb/intent.md");
    assert.equal(page.data.source, ".legion-cli/runs/bbbbbbbb/intent.md");
    assert.match(page.body, /PROMOTE_UNTRUSTED_BODY_TOKEN/);
    const analysis = await store.readWikiPage(".legion-cli/wiki/runs/bbbbbbbb/analysis.md");
    assert.match(analysis.body, /PROMOTE_UNTRUSTED_BODY_TOKEN/);
    const resume = JSON.parse(
      await readFile(join(dir, ".legion-cli", "runs", "bbbbbbbb", "resume.json"), "utf8"),
    );
    assert.equal(resume.promoted, true);

    const brief = await engine.brief();
    const runWiki = brief.wiki.filter((item) => item.path.includes("/runs/bbbbbbbb/"));
    assert.equal(runWiki.length > 0, true);
    for (const entry of runWiki) {
      assert.equal(entry.trust, "untrusted", entry.path);
      assert.equal(entry.summary ?? null, null, entry.path);
    }
    assert.doesNotMatch(JSON.stringify(brief.wiki), /PROMOTE_UNTRUSTED_BODY_TOKEN/);

    const index = await store.readWikiPage(".legion-cli/wiki/index.md");
    assert.match(index.body, /runs\/bbbbbbbb\/intent/);
    assert.match(index.body, /runs\/bbbbbbbb\/analysis/);
    assert.match(index.body, /Untrusted \(titles only; run legion-cli wiki trust\)/);
    assert.doesNotMatch(index.body, /PROMOTE_UNTRUSTED_BODY_TOKEN/);

    await engine.wikiTrust(".legion-cli/wiki/runs/bbbbbbbb/intent.md");
    const trustedPage = await store.readWikiPage(".legion-cli/wiki/runs/bbbbbbbb/intent.md");
    assert.equal(trustedPage.data.trust, "reviewed");
    const trustedBrief = await engine.brief();
    const trustedEntry = trustedBrief.wiki.find(
      (item) => item.path === ".legion-cli/wiki/runs/bbbbbbbb/intent.md",
    );
    assert.ok(trustedEntry);
    assert.equal(trustedEntry.trust, "reviewed");
    assert.notEqual(trustedEntry.summary ?? null, null);
  });
});

test("run promote re-promote overwrites wiki trust", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine, { mode: "brownfield" });
    initGitRepo(dir);
    await engine.brownfield({ effort: 1, runId: "abababab" });
    const trusted = await engine.promoteRun("abababab", { trust: true });
    assert.equal(trusted.trust, "reviewed");
    assert.equal(
      (await store.readWikiPage(".legion-cli/wiki/runs/abababab/intent.md")).data.trust,
      "reviewed",
    );
    const again = await engine.promoteRun("abababab");
    assert.equal(again.trust, "untrusted");
    assert.equal(
      (await store.readWikiPage(".legion-cli/wiki/runs/abababab/intent.md")).data.trust,
      "untrusted",
    );
  });
});

test("run promote --trust is the only reviewed path", async () => {
  await withEngine(async ({ dir, engine, store }) => {
    await initProject(engine, { mode: "brownfield" });
    initGitRepo(dir);
    await engine.brownfield({ effort: 1, runId: "ffffffff" });
    const promoted = await engine.promoteRun("ffffffff", { trust: true });
    assert.equal(promoted.trust, "reviewed");
    const page = await store.readWikiPage(".legion-cli/wiki/runs/ffffffff/intent.md");
    assert.equal(page.data.trust, "reviewed");
    const brief = await engine.brief();
    const entry = brief.wiki.find((item) => item.path === ".legion-cli/wiki/runs/ffffffff/intent.md");
    assert.ok(entry);
    assert.equal(entry.trust, "reviewed");
    assert.notEqual(entry.summary ?? null, null);
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

test("brownfield --resume --execute recreates a deleted worktree", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    initGitRepo(dir);
    const created = await engine.brownfield({ effort: 1, execute: true, runId: "eeeeeeee" });
    assert.equal(created.worktreePath, ".legion-cli/worktrees/eeeeeeee");
    const worktree = join(dir, ".legion-cli", "worktrees", "eeeeeeee");
    const mainBranch = git(dir, ["branch", "--show-current"]);
    await rm(worktree, { recursive: true, force: true });
    assert.equal(await exists(worktree), false);

    const resumed = await engine.brownfield({ resume: "eeeeeeee", execute: true });
    assert.equal(resumed.worktreePath, ".legion-cli/worktrees/eeeeeeee");
    assert.equal(git(worktree, ["rev-parse", "--is-inside-work-tree"]), "true");
    assert.match(git(worktree, ["branch", "--show-current"]), /brownfield\/eeeeeeee/);
    assert.equal(git(dir, ["branch", "--show-current"]), mainBranch);
    assert.notEqual(mainBranch, "brownfield/eeeeeeee");
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

test("HINT.brownfield lists efforts 1-5", () => {
  assert.equal(HINT.brownfield, "legion-cli brownfield --effort 1|2|3|4|5");
});

test("effort-2 brownfield writes tests.md and resume effort 2", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export {}\n", "utf8");
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "tests", "main.test.ts"), "export {}\n", "utf8");
    initGitRepo(dir);

    const result = await engine.brownfield({ effort: 2, runId: "22222222" });
    assert.equal(result.effort, 2);
    assert.equal(result.phase, "complete");
    assert.ok(result.pages.includes("intent.md"));
    assert.ok(result.pages.includes("tests.md"));
    assert.equal(result.pages.includes("security.md"), false);
    const resume = JSON.parse(
      await readFile(join(dir, ".legion-cli", "runs", "22222222", "resume.json"), "utf8"),
    );
    assert.equal(resume.effort, 2);
    const tests = await readFile(join(dir, ".legion-cli", "runs", "22222222", "tests.md"), "utf8");
    assert.match(tests, /tests\/main\.test\.ts/);
    assert.match(tests, /A-T01|Coverage gaps/);
  });
});

test("effort 6 still refuses range", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    initGitRepo(dir);
    await assert.rejects(() => engine.brownfield({ effort: 6 }), (err) => {
      assert.equal(err instanceof LegionRefuseError, true);
      assert.match(err.message, /brownfield --effort must be 1–5/);
      assert.equal(err.nextHint, HINT.brownfield);
      return true;
    });
  });
});

test("resume effort-1 run with --effort 5 refuses", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    initGitRepo(dir);
    await engine.brownfield({ effort: 1, runId: "11111111" });
    await assert.rejects(() => engine.brownfield({ resume: "11111111", effort: 5 }), (err) => {
      assert.equal(err instanceof LegionRefuseError, true);
      assert.match(err.message, /cannot change effort/);
      assert.equal(err.nextHint, HINT.brownfield);
      return true;
    });
  });
});

test("effort 3 fixture with AKIA in a wiki page appears redacted in security.md", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    await mkdir(join(dir, ".legion-cli", "wiki"), { recursive: true });
    await writeFile(
      join(dir, ".legion-cli", "wiki", "leaked.md"),
      "token AKIAIOSFODNN7EXAMPLE leaked\n",
      "utf8",
    );
    initGitRepo(dir);
    const result = await engine.brownfield({ effort: 3, runId: "33333333" });
    assert.equal(result.effort, 3);
    assert.ok(result.pages.includes("security.md"));
    const security = await readFile(join(dir, ".legion-cli", "runs", "33333333", "security.md"), "utf8");
    assert.match(security, /leaked\.md/);
    assert.match(security, /aws-access-key/);
    assert.match(security, /\[REDACTED:aws-access-key\]/);
    assert.doesNotMatch(security, /AKIAIOSFODNN7EXAMPLE/);
  });
});

test("effort 3 with no lockfile writes no audit and still completes", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    initGitRepo(dir);
    const result = await engine.brownfield({ effort: 3, runId: "34343434" });
    assert.equal(result.phase, "complete");
    const security = await readFile(join(dir, ".legion-cli", "runs", "34343434", "security.md"), "utf8");
    assert.match(security, /no audit \(no lockfile\)/);
  });
});

test("effort 5 calls map, writes fingerprints, leaves .legion-cli/specs untouched", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.ts"), "export const n = 1;\n", "utf8");
    initGitRepo(dir);
    const result = await engine.brownfield({
      effort: 5,
      runId: "55555555",
      context: "demo the check-in board",
    });
    assert.equal(result.effort, 5);
    assert.equal(result.phase, "complete");
    assert.ok(result.pages.includes("tests.md"));
    assert.ok(result.pages.includes("security.md"));
    assert.ok(result.pages.includes("docs.md"));
    assert.ok(result.pages.includes("improvement-spec.md"));
    assert.equal(await exists(join(dir, ".legion-cli", "map", "fingerprints.json")), true);
    const fingerprints = JSON.parse(
      await readFile(join(dir, ".legion-cli", "map", "fingerprints.json"), "utf8"),
    );
    assert.equal(fingerprints.backend, "fallback");
    const spec = await readFile(join(dir, ".legion-cli", "runs", "55555555", "improvement-spec.md"), "utf8");
    assert.match(spec, /# Improvement SPEC draft \(not frozen\)/);
    assert.match(spec, /demo the check-in board/);
    assert.match(spec, /this file is not SPEC\.md/);
    assert.equal(await exists(join(dir, ".legion-cli", "specs", "improvement-spec.md")), false);
    const specDir = join(dir, ".legion-cli", "specs");
    const listed = await readdir(specDir).catch(() => []);
    assert.deepEqual(listed, []);
    const architecture = await readFile(
      join(dir, ".legion-cli", "runs", "55555555", "architecture.md"),
      "utf8",
    );
    assert.match(architecture, /backend: fallback/);
    assert.match(architecture, /Durable map/);
    const docs = await readFile(join(dir, ".legion-cli", "runs", "55555555", "docs.md"), "utf8");
    assert.match(docs, /Exports without nearby markdown/);
    assert.match(docs, /src\/app\.ts/);
    assert.match(docs, /export `n`/);
  });
});

test("effort 5 --lsp with no server refuses and does not persist the run", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.ts"), "export const n = 1;\n", "utf8");
    initGitRepo(dir);
    await assert.rejects(
      () => engine.brownfield({ effort: 5, lsp: true, runId: "56565656" }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /no language server on PATH/);
        assert.equal(err.nextHint, "legion-cli map --no-lsp");
        return true;
      },
    );
    assert.equal(await exists(join(dir, ".legion-cli", "runs", "56565656", "resume.json")), false);
  });
});

test("effort 3 skips a junction to an outside .env", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    const outside = await mkdtemp(join(tmpdir(), "legion-escape-"));
    try {
      await writeFile(join(outside, ".env"), "AKIAIOSFODNN7EXAMPLE\n", "utf8");
      try {
        await symlink(outside, join(dir, "escaped"), process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        if (err?.code === "EPERM" || err?.code === "EACCES") return;
        throw err;
      }
      initGitRepo(dir);
      const result = await engine.brownfield({ effort: 3, runId: "37373737" });
      const security = await readFile(join(dir, ".legion-cli", "runs", result.runId, "security.md"), "utf8");
      assert.doesNotMatch(security, /AKIAIOSFODNN7EXAMPLE/);
      assert.doesNotMatch(security, /escaped/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("effort 5 with spawnable adapter does not spawn map skill", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ dir, engine }) => {
        await initProject(engine, { mode: "brownfield" });
        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src", "app.ts"), "export const n = 1;\n", "utf8");
        initGitRepo(dir);
        const result = await engine.brownfield({ effort: 5, runId: "58585858" });
        assert.equal(result.phase, "complete");
        assert.equal(existsSync(join(dir, "src", "leaked.ts")), false);
        const cacheRuns = await readdir(join(dir, ".legion-cli", "cache", "runs")).catch(() => []);
        assert.equal(
          cacheRuns.some((name) => name.startsWith("map-")),
          false,
        );
      },
      { fakeArtifacts: [{ path: "src/leaked.ts", content: "export const leaked = true;\n" }] },
    );
  });
});

test("tests.md redacts secrets in package.json scripts.test", async () => {
  await withEngine(async ({ dir, engine }) => {
    await initProject(engine, { mode: "brownfield" });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "legacy", scripts: { test: "echo AKIAIOSFODNN7EXAMPLE" } }),
      "utf8",
    );
    initGitRepo(dir);
    const result = await engine.brownfield({ effort: 2, runId: "29292929" });
    const tests = await readFile(join(dir, ".legion-cli", "runs", result.runId, "tests.md"), "utf8");
    assert.match(tests, /package\.json scripts\.test:/);
    assert.match(tests, /\[REDACTED:aws-access-key\]/);
    assert.doesNotMatch(tests, /AKIAIOSFODNN7EXAMPLE/);
  });
});
