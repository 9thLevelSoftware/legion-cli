import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dropBackups, Quarantine, revertTree, snapshotTree } from "../dist/index.js";
import { commitAll, git, gitHead, initGitRepo } from "./helpers.js";

/**
 * PR 5 (KD-16): the stat-first content revert. These exercise `snapshotTree` + `revertTree`
 * directly, which is where the pre/post walk, the content confirmation, the backups and the
 * ignored-path policy live; the engine wiring is covered by execute.test.js.
 */

let runs = 0;

async function withProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-revert-"));
  const control = await mkdtemp(join(tmpdir(), "legion-revert-ctl-"));
  try {
    await fn({ dir, control });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(control, { recursive: true, force: true });
  }
}

/** Take the pre-spawn snapshot, run `mutate` as the agent would, then revert. */
async function roundTrip(dir, control, mutate, opts = {}) {
  const runId = `execute-test-${(runs += 1).toString(36)}`;
  const snapshot = await snapshotTree({ projectRoot: dir, runId, preSpawnRef: gitHead(dir), controlDir: control });
  await mutate();
  const quarantine = new Quarantine(dir, runId);
  const result = await revertTree({
    snapshot,
    runId,
    allowedRoots: opts.allowedRoots ?? [],
    filesForbidden: opts.filesForbidden,
    quarantine,
  });
  const finalized = await quarantine.finalize();
  return { runId, snapshot, result, quarantine, quarantineDir: finalized?.dir ?? null };
}

function read(dir, rel) {
  return readFile(join(dir, ...rel.split("/")), "utf8");
}

test("a pre-dirty tracked file the agent overwrites comes back to its pre-dirty bytes", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "README.md"), "committed\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "README.md"), "my unsaved work\n", "utf8");
    const { result, quarantineDir } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "README.md"), "agent rewrote this\n", "utf8");
    });
    assert.equal((await read(dir, "README.md")).replaceAll("\r\n", "\n"), "my unsaved work\n");
    assert.ok(result.reverted.includes("README.md"), JSON.stringify(result));
    assert.deepEqual(result.unrestorable, []);
    assert.ok(quarantineDir, "the agent's version is quarantined");
    assert.equal(
      (await readFile(join(quarantineDir, "files", "README.md"), "utf8")).replaceAll("\r\n", "\n"),
      "agent rewrote this\n",
    );
  });
});

test("a tracked-clean file the agent touched but did not change is not reverted", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "src.ts"), "same\n", "utf8");
    initGitRepo(dir);
    const { result } = await roundTrip(dir, control, async () => {
      // Rewrite the identical bytes: the stat changes, the content does not.
      await writeFile(join(dir, "src.ts"), "same\n", "utf8");
    });
    assert.deepEqual(result.reverted, []);
    assert.equal(result.incident, false);
  });
});

test("an ignored .env the agent rewrites is restored from its backup", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), ".env\nconfig/local.json\ndev.sqlite\nbig.bin\ndist/\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, ".env"), "TOKEN=real\n", "utf8");
    const { result } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, ".env"), "TOKEN=stolen\n", "utf8");
    });
    assert.equal((await read(dir, ".env")).replaceAll("\r\n", "\n"), "TOKEN=real\n");
    assert.ok(result.reverted.includes(".env"));
    assert.equal(result.incident, false);
  });
});

test("non-secret ignored files that are overwritten or deleted are restored from backup", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), "config/local.json\ndev.sqlite\n", "utf8");
    await mkdir(join(dir, "config"), { recursive: true });
    initGitRepo(dir);
    await writeFile(join(dir, "config", "local.json"), '{"port":1}\n', "utf8");
    await writeFile(join(dir, "dev.sqlite"), "sqlite-bytes\n", "utf8");
    const { result, quarantineDir } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "config", "local.json"), '{"port":666}\n', "utf8");
      await rm(join(dir, "dev.sqlite"));
    });
    assert.equal((await read(dir, "config/local.json")).replaceAll("\r\n", "\n"), '{"port":1}\n');
    assert.equal((await read(dir, "dev.sqlite")).replaceAll("\r\n", "\n"), "sqlite-bytes\n");
    assert.ok(result.reverted.includes("config/local.json"));
    assert.ok(result.reverted.includes("dev.sqlite"));
    assert.equal(result.incident, false);
    assert.ok(quarantineDir);
    assert.equal(
      (await readFile(join(quarantineDir, "files", "config", "local.json"), "utf8")).replaceAll("\r\n", "\n"),
      '{"port":666}\n',
    );
  });
});

test("an ignored file over the 4 MiB cap is named in a warning, not restored, and is no incident", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), "big.bin\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "big.bin"), Buffer.alloc(5 * 1024 * 1024, 1));
    const { result } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "big.bin"), Buffer.alloc(5 * 1024 * 1024, 2));
    });
    assert.equal(result.incident, false);
    assert.ok(
      result.warnings.some((line) => line.startsWith("big.bin") && line.includes("not restorable")),
      JSON.stringify(result.warnings),
    );
    assert.deepEqual(result.reverted, []);
  });
});

test("rewriting a file in an ignored directory, and a new ignored directory, are warnings only", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), "dist/\ncoverage/\n.env.local\n", "utf8");
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist", "x.js"), "old build\n", "utf8");
    initGitRepo(dir);
    const { result, quarantineDir } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "dist", "x.js"), "new build output that is longer\n", "utf8");
      await mkdir(join(dir, "coverage"), { recursive: true });
      await writeFile(join(dir, "coverage", "lcov.info"), "TN:\n", "utf8");
      await writeFile(join(dir, ".env.local"), "TOKEN=planted\n", "utf8");
    });
    assert.equal(result.incident, false);
    assert.equal((await read(dir, "dist/x.js")).replaceAll("\r\n", "\n"), "new build output that is longer\n");
    assert.ok(result.warnings.some((line) => line.startsWith("dist/x.js")), JSON.stringify(result.warnings));
    assert.ok(result.warnings.some((line) => line.startsWith("coverage/")), JSON.stringify(result.warnings));
    // The secret-like exception: quarantined, not left in place.
    assert.equal(existsSync(join(dir, ".env.local")), false);
    assert.ok(result.reverted.includes(".env.local"));
    assert.ok(quarantineDir);
  });
});

test("a deleted untracked user file is restored from its backup", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "seed.md"), "seed\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "scratch.md"), "my notes\n", "utf8");
    const { result } = await roundTrip(dir, control, async () => {
      await rm(join(dir, "scratch.md"));
    });
    assert.equal((await read(dir, "scratch.md")).replaceAll("\r\n", "\n"), "my notes\n");
    assert.ok(result.reverted.includes("scratch.md"));
    assert.equal(result.incident, false);
  });
});

test("non-ASCII and spaced paths are restored, and an in-contract edit is not flagged", async () => {
  await withProject(async ({ dir, control }) => {
    for (const name of ["café.ts", "日本.ts", "a b.ts", "src-allowed.ts"]) {
      await writeFile(join(dir, name), `original ${name}\n`, "utf8");
    }
    initGitRepo(dir);
    const { result } = await roundTrip(
      dir,
      control,
      async () => {
        for (const name of ["café.ts", "日本.ts", "a b.ts", "src-allowed.ts"]) {
          await writeFile(join(dir, name), `agent ${name}\n`, "utf8");
        }
      },
      { allowedRoots: ["src-allowed.ts"] },
    );
    for (const name of ["café.ts", "日本.ts", "a b.ts"]) {
      assert.equal((await read(dir, name)).replaceAll("\r\n", "\n"), `original ${name}\n`, name);
      assert.ok(result.reverted.includes(name), `${name} in ${JSON.stringify(result.reverted)}`);
    }
    // In the contract: left exactly as the agent wrote it.
    assert.equal((await read(dir, "src-allowed.ts")).replaceAll("\r\n", "\n"), "agent src-allowed.ts\n");
    assert.equal(result.reverted.includes("src-allowed.ts"), false);
  });
});

test("a corrupted .git/index still lets the backup restores run, and the run is an incident", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "seed.md"), "seed\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "scratch.md"), "my notes\n", "utf8");
    const runId = "execute-corrupt";
    const snapshot = await snapshotTree({ projectRoot: dir, runId, preSpawnRef: gitHead(dir), controlDir: control });
    await writeFile(join(dir, "scratch.md"), "agent overwrote this\n", "utf8");
    await writeFile(join(dir, ".git", "index"), "not an index\n", "utf8");
    const quarantine = new Quarantine(dir, runId);
    const result = await revertTree({ snapshot, runId, allowedRoots: [], quarantine });
    await quarantine.finalize();
    assert.equal((await read(dir, "scratch.md")).replaceAll("\r\n", "\n"), "my notes\n");
    assert.equal(result.incident, true, JSON.stringify(result));
  });
});

test("an agent commit is an incident, is listed, and is kept reachable under refs/legion-quarantine", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "README.md"), "committed\n", "utf8");
    initGitRepo(dir);
    const { result, runId } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "README.md"), "agent edit\n", "utf8");
      commitAll(dir, "agent commit");
    });
    assert.equal(result.incident, true);
    assert.equal(result.agentCommits.headMoved, true);
    assert.equal(result.agentCommits.commits.length, 1);
    assert.match(result.agentCommits.recovery, /^git reset [0-9a-f]{40}$/);
    assert.equal(git(dir, ["rev-parse", `refs/legion-quarantine/${runId}`]), result.agentCommits.commits[0]);
    // The working tree is back even though the commit is still in the history.
    assert.equal((await read(dir, "README.md")).replaceAll("\r\n", "\n"), "committed\n");
  });
});

test("a branch switch during the run is an incident with a checkout recovery step", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "README.md"), "committed\n", "utf8");
    initGitRepo(dir);
    const before = git(dir, ["symbolic-ref", "--short", "HEAD"]);
    const { result } = await roundTrip(dir, control, async () => {
      git(dir, ["checkout", "-b", "agent-branch"]);
    });
    assert.equal(result.incident, true);
    assert.equal(result.agentCommits.branchMoved, true);
    assert.equal(result.agentCommits.recovery, `git checkout ${before}`);
  });
});

test("a clean run leaves no control-dir backups", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "seed.md"), "seed\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "scratch.md"), "my notes\n", "utf8");
    await snapshotTree({ projectRoot: dir, runId: "execute-clean", preSpawnRef: gitHead(dir), controlDir: control });
    assert.equal(existsSync(join(control, "pre")), true);
    await dropBackups(control);
    assert.equal(existsSync(join(control, "pre")), false);
    assert.equal(existsSync(join(control, "tree-manifest.json")), false);
  });
});

test("a quarantine that fails with EBUSY leaves the file unrestored and makes the run an incident", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "README.md"), "committed\n", "utf8");
    initGitRepo(dir);
    const runId = "execute-ebusy";
    const snapshot = await snapshotTree({ projectRoot: dir, runId, preSpawnRef: gitHead(dir), controlDir: control });
    await writeFile(join(dir, "README.md"), "agent rewrote this\n", "utf8");
    const quarantine = new Quarantine(dir, runId);
    quarantine.move = async () => {
      const err = new Error("EBUSY: resource busy or locked");
      err.code = "EBUSY";
      throw err;
    };
    const result = await revertTree({ snapshot, runId, allowedRoots: [], quarantine });
    assert.equal(result.incident, true);
    assert.deepEqual(result.reverted, []);
    assert.ok(
      result.unrestorable.some((line) => line.startsWith("README.md")),
      JSON.stringify(result),
    );
    // Never restored over an un-quarantined file: the agent's version is still the live one.
    assert.equal((await read(dir, "README.md")).replaceAll("\r\n", "\n"), "agent rewrote this\n");
  });
});

test(
  "win32: a case-only rename ends with the original spelling restored and the rename quarantined",
  { skip: process.platform === "win32" ? false : "win32 only (case-insensitive filesystem)" },
  async () => {
    await withProject(async ({ dir, control }) => {
      await writeFile(join(dir, "README.md"), "committed\n", "utf8");
      initGitRepo(dir);
      const { result, quarantineDir } = await roundTrip(dir, control, async () => {
        await rename(join(dir, "README.md"), join(dir, "readme.md"));
        await writeFile(join(dir, "readme.md"), "agent renamed and rewrote\n", "utf8");
      });
      assert.equal((await read(dir, "README.md")).replaceAll("\r\n", "\n"), "committed\n");
      assert.ok(result.reverted.includes("readme.md"), JSON.stringify(result));
      assert.ok(quarantineDir);
      assert.equal(
        (await readFile(join(quarantineDir, "files", "readme.md"), "utf8")).replaceAll("\r\n", "\n"),
        "agent renamed and rewrote\n",
      );
    });
  },
);

// R-18: the restore is verified against the `preSpawnRef` blob with GIT_NO_REPLACE_OBJECTS=1, so
// a replace ref the agent plants cannot swap what comes back. On Windows this also covers
// autocrlf: the worktree bytes must return CRLF-identical.
test("a planted replace ref does not change what is restored (autocrlf on Windows)", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "seed.md"), "seed\n", "utf8");
    initGitRepo(dir);
    if (process.platform === "win32") git(dir, ["config", "core.autocrlf", "true"]);
    await writeFile(join(dir, "text.txt"), "one\r\ntwo\r\n", "utf8");
    const good = commitAll(dir, "good");
    const before = await readFile(join(dir, "text.txt"));
    await writeFile(join(dir, "text.txt"), "evil\r\n", "utf8");
    const evil = commitAll(dir, "evil");
    git(dir, ["reset", "--hard", good]);
    git(dir, ["replace", "-f", good, evil]);
    const { result } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "text.txt"), "agent\r\n", "utf8");
    });
    assert.ok(result.reverted.includes("text.txt"), JSON.stringify(result));
    assert.deepEqual(result.unrestorable, []);
    assert.deepEqual(await readFile(join(dir, "text.txt")), before);
  });
});

test("a directory replaced by a link leaves the outside directory's files intact", async () => {
  await withProject(async ({ dir, control }) => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "mine\n", "utf8");
    initGitRepo(dir);
    const outside = await mkdtemp(join(tmpdir(), "legion-outside-"));
    await writeFile(join(outside, "main.ts"), "not yours\n", "utf8");
    let linked = false;
    const { result } = await roundTrip(dir, control, async () => {
      await rm(join(dir, "src"), { recursive: true, force: true });
      try {
        await symlink(outside, join(dir, "src"), "junction");
        linked = true;
      } catch (err) {
        if (err?.code !== "EPERM") throw err;
      }
    });
    try {
      // The outside directory is never recursed into or deleted (A-025).
      assert.equal((await readFile(join(outside, "main.ts"), "utf8")).replaceAll("\r\n", "\n"), "not yours\n");
      assert.equal((await read(dir, "src/main.ts")).replaceAll("\r\n", "\n"), "mine\n");
      assert.ok(result.reverted.includes("src/main.ts"), JSON.stringify(result));
      if (linked) assert.equal((await lstat(join(dir, "src"))).isDirectory(), true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
