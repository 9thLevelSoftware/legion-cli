import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dropBackups, foldKey, Quarantine, revertTree, snapshotTree } from "../dist/index.js";
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
  const snapshot = await snapshotTree({
    projectRoot: dir,
    runId,
    preSpawnRef: gitHead(dir),
    controlDir: control,
    ...(opts.linkBackups === undefined ? {} : { linkBackups: opts.linkBackups }),
  });
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
    const { result, quarantineDir } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, ".env"), "TOKEN=stolen\n", "utf8");
    });
    assert.equal((await read(dir, ".env")).replaceAll("\r\n", "\n"), "TOKEN=real\n");
    assert.ok(result.restoredIgnored.includes(".env"), JSON.stringify(result));
    assert.equal(result.incident, false);
    // R-45: the credential-leak-relevant artifact is the agent's copy; it must be quarantined.
    assert.ok(quarantineDir);
    assert.equal(
      (await readFile(join(quarantineDir, "files", ".env"), "utf8")).replaceAll("\r\n", "\n"),
      "TOKEN=stolen\n",
    );
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
    // R-10: an ignored file the agent's own build touched is restored, but it is not scope creep,
    // so it is reported separately and never trips the FileContract gate.
    assert.ok(result.restoredIgnored.includes("config/local.json"), JSON.stringify(result));
    assert.ok(result.restoredIgnored.includes("dev.sqlite"), JSON.stringify(result));
    assert.deepEqual(result.reverted, []);
    assert.equal(result.incident, false);
    assert.ok(quarantineDir);
    assert.equal(
      (await readFile(join(quarantineDir, "files", "config", "local.json"), "utf8")).replaceAll("\r\n", "\n"),
      '{"port":666}\n',
    );
  });
});

// R-31: above the copy cap the file is hardlinked instead of left unprotected, so the common
// destruction paths (rename-over, rm, git clean) are now recoverable rather than silent losses.
test("an ignored file over the 4 MiB copy cap is hardlinked and still restored", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), "big.bin\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "big.bin"), Buffer.alloc(5 * 1024 * 1024, 1));
    const { result } = await roundTrip(dir, control, async () => {
      // rename-over, the way most tools write: the hardlink keeps the old inode alive.
      await writeFile(join(dir, "big.bin.tmp"), Buffer.alloc(5 * 1024 * 1024, 2));
      await rename(join(dir, "big.bin.tmp"), join(dir, "big.bin"));
    });
    assert.equal(result.incident, false, JSON.stringify(result));
    assert.ok(result.restoredIgnored.includes("big.bin"), JSON.stringify(result));
    const restored = await readFile(join(dir, "big.bin"));
    assert.equal(restored.length, 5 * 1024 * 1024);
    assert.equal(restored[0], 1);
  });
});

test("with no hardlink available an over-cap ignored file is named as LOST and left in place", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), "big.bin\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "big.bin"), Buffer.alloc(5 * 1024 * 1024, 1));
    const { result } = await roundTrip(
      dir,
      control,
      async () => {
        await writeFile(join(dir, "big.bin"), Buffer.alloc(5 * 1024 * 1024, 2));
      },
      { linkBackups: false },
    );
    assert.equal(result.incident, false);
    assert.ok(
      result.warnings.some((line) => line.startsWith("LOST: big.bin") && line.includes("backup cap")),
      JSON.stringify(result.warnings),
    );
    assert.deepEqual(result.reverted, []);
    // Left exactly as the agent wrote it, and said so — not quietly deleted.
    assert.equal((await readFile(join(dir, "big.bin")))[0], 2);
  });
});

// R-31 (round 2): a hardlinked backup SHARES the inode with the project file, so "same inode"
// proves nothing by itself. An in-place, same-size rewrite — a sqlite page update, a fixed-width
// binary — changes both at once, and must not be waved through as unchanged.
test("an in-place same-size rewrite of a hardlinked file is not mistaken for no change", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), "big.bin\n", "utf8");
    initGitRepo(dir);
    const original = Buffer.alloc(5 * 1024 * 1024, 1);
    await writeFile(join(dir, "big.bin"), original);
    const { result } = await roundTrip(dir, control, async () => {
      // Open r+ and overwrite in place: same length, same inode, backup destroyed with it.
      const handle = await open(join(dir, "big.bin"), "r+");
      try {
        await handle.write(Buffer.alloc(4096, 2), 0, 4096, 0);
      } finally {
        await handle.close();
      }
    });
    assert.equal(result.incident, true, JSON.stringify(result));
    assert.ok(
      result.unrestorable.some((line) => line.startsWith("big.bin") && line.includes("rewritten in place")),
      JSON.stringify(result.unrestorable),
    );
    // Fail-closed: the agent's version is still there and the loss is named, never silent.
    assert.equal((await readFile(join(dir, "big.bin")))[0], 2);
  });
});

// R-31 (round 2): the same shortcut must still clear a file nothing wrote to.
test("an untouched hardlinked file is confirmed unchanged without hashing it", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), "big.bin\nother.txt\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "big.bin"), Buffer.alloc(5 * 1024 * 1024, 1));
    await writeFile(join(dir, "other.txt"), "unrelated\n", "utf8");
    const { result } = await roundTrip(dir, control, async () => {
      // Touch only the directory, so `big.bin` is stat-identical.
      await writeFile(join(dir, "other.txt"), "changed\n", "utf8");
    });
    assert.equal(result.incident, false, JSON.stringify(result));
    assert.equal(result.unrestorable.length, 0);
    assert.equal(result.restoredIgnored.includes("big.bin"), false);
  });
});

// Round 2: a secret-NAMED directory inside an ignored directory is not enrolled in
// `ignoredSecrets` (which takes files), so it must still be reported.
test("a secret-named directory inside an ignored directory is still reported", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), "build/\n", "utf8");
    await mkdir(join(dir, "build", "secrets"), { recursive: true });
    await writeFile(join(dir, "build", "secrets", "a.txt"), "one\n", "utf8");
    initGitRepo(dir);
    const { result } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "build", "secrets", "b.txt"), "two\n", "utf8");
    });
    assert.ok(
      result.warnings.some((line) => line.startsWith("build/secrets")),
      JSON.stringify(result.warnings),
    );
  });
});

// R-5 / round 2: the mode is part of a file's identity, so a bare `chmod +x` out of contract is
// reverted rather than cleared by the content check, and a restored script stays executable.
test(
  "posix: a mode-only change is reverted and a restored script keeps its executable bit",
  { skip: process.platform === "win32" ? "POSIX modes only" : false },
  async () => {
    await withProject(async ({ dir, control }) => {
      await writeFile(join(dir, "run.sh"), "#!/bin/sh\necho hi\n", "utf8");
      await chmod(join(dir, "run.sh"), 0o755);
      await writeFile(join(dir, "plain.txt"), "plain\n", "utf8");
      await chmod(join(dir, "plain.txt"), 0o644);
      initGitRepo(dir);
      const { result } = await roundTrip(dir, control, async () => {
        await writeFile(join(dir, "run.sh"), "#!/bin/sh\necho pwned\n", "utf8");
        await chmod(join(dir, "run.sh"), 0o755);
        await chmod(join(dir, "plain.txt"), 0o777); // identical bytes, different mode
      });
      assert.equal((await read(dir, "run.sh")).replaceAll("\r\n", "\n"), "#!/bin/sh\necho hi\n");
      assert.equal((await lstat(join(dir, "run.sh"))).mode & 0o777, 0o755);
      assert.ok(result.reverted.includes("plain.txt"), JSON.stringify(result));
      assert.equal((await lstat(join(dir, "plain.txt"))).mode & 0o777, 0o644);
    });
  },
);

// R-6/R-16: an over-cap file that was only TOUCHED must not block the run.
test("touching an unbacked-up file without changing it is not an incident", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), "big.bin\n", "utf8");
    initGitRepo(dir);
    const bytes = Buffer.alloc(5 * 1024 * 1024, 1);
    await writeFile(join(dir, "big.bin"), bytes);
    const { result } = await roundTrip(
      dir,
      control,
      async () => {
        await writeFile(join(dir, "big.bin"), bytes);
      },
      { linkBackups: false },
    );
    assert.equal(result.incident, false, JSON.stringify(result));
    assert.deepEqual(result.reverted, []);
    assert.deepEqual(result.unrestorable, []);
  });
});

test("rewriting a file in an ignored directory, and a new ignored directory, are warnings only", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), "dist/\ncoverage/\n.env.local\n", "utf8");
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist", "x.js"), "old build\n", "utf8");
    initGitRepo(dir);
    const { result, quarantineDir } = await roundTrip(dir, control, async () => {
      // R-44: the same byte length, so only the mtime leg of the comparison can catch it.
      await writeFile(join(dir, "dist", "x.js"), "new build\n", "utf8");
      await mkdir(join(dir, "coverage"), { recursive: true });
      await writeFile(join(dir, "coverage", "lcov.info"), "TN:\n", "utf8");
      await writeFile(join(dir, ".env.local"), "TOKEN=planted\n", "utf8");
    });
    assert.equal(result.incident, false);
    assert.equal((await read(dir, "dist/x.js")).replaceAll("\r\n", "\n"), "new build\n");
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

// R-28: an ignored directory's contents are never walked, so a credential file inside one used to
// get at most a warning. Secret-like names there are backed up and restored.
test("a secret-like file inside an ignored directory is restored, and other files there are not", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), "secrets/\nbuild/\n", "utf8");
    await mkdir(join(dir, "secrets"), { recursive: true });
    await mkdir(join(dir, "build"), { recursive: true });
    await writeFile(join(dir, "secrets", "prod.env"), "TOKEN=real\n", "utf8");
    await writeFile(join(dir, "build", "x.js"), "old build\n", "utf8");
    initGitRepo(dir);
    const { result, quarantineDir } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "secrets", "prod.env"), "TOKEN=stolen\n", "utf8");
      await writeFile(join(dir, "build", "x.js"), "new build\n", "utf8");
    });
    assert.equal((await read(dir, "secrets/prod.env")).replaceAll("\r\n", "\n"), "TOKEN=real\n");
    assert.ok(result.restoredIgnored.includes("secrets/prod.env"), JSON.stringify(result));
    assert.equal(result.incident, false, JSON.stringify(result.unrestorable));
    assert.ok(quarantineDir);
    assert.equal(
      (await readFile(join(quarantineDir, "files", "secrets", "prod.env"), "utf8")).replaceAll("\r\n", "\n"),
      "TOKEN=stolen\n",
    );
    // Ordinary build output in an ignored directory is still only reported, never restored.
    assert.equal((await read(dir, "build/x.js")).replaceAll("\r\n", "\n"), "new build\n");
    assert.ok(
      result.warnings.some((line) => line.startsWith("build/x.js")),
      JSON.stringify(result.warnings),
    );
  });
});

// R-1: `git status` and `ls-files -i` are both silent about a nested checkout, so inferring
// "tracked-clean" by elimination destroyed the file. `ls-files` is the authoritative tracked set.
test("files in a nested repository are backed up, not inferred tracked-clean", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "seed.md"), "seed\n", "utf8");
    initGitRepo(dir);
    await mkdir(join(dir, "vendor"), { recursive: true });
    await writeFile(join(dir, "vendor", "lib.js"), "vendored\n", "utf8");
    git(join(dir, "vendor"), ["init"]);
    git(join(dir, "vendor"), ["config", "user.name", "v"]);
    git(join(dir, "vendor"), ["config", "user.email", "v@v.v"]);
    git(join(dir, "vendor"), ["add", "-A"]);
    git(join(dir, "vendor"), ["commit", "-m", "vendored"]);
    const { result, snapshot } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "vendor", "lib.js"), "agent broke this\n", "utf8");
    });
    assert.equal(snapshot.entries.get(foldKey("vendor/lib.js"))?.cls, "untracked");
    assert.equal((await read(dir, "vendor/lib.js")).replaceAll("\r\n", "\n"), "vendored\n");
    assert.ok(result.reverted.includes("vendor/lib.js"), JSON.stringify(result));
    assert.deepEqual(result.unrestorable, []);
  });
});

// R-26: the stat gate is the only detector, so an mtime-preserving same-size write must still be
// caught by the identity fields the same lstat already carries.
test("a same-size write that restores the mtime is still detected", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "README.md"), "aaaaaaa\n", "utf8");
    initGitRepo(dir);
    const before = await lstat(join(dir, "README.md"));
    const { result } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "README.md"), "bbbbbbb\n", "utf8");
      await utimes(join(dir, "README.md"), before.atime, before.mtime);
    });
    assert.ok(result.reverted.includes("README.md"), JSON.stringify(result));
    assert.equal((await read(dir, "README.md")).replaceAll("\r\n", "\n"), "aaaaaaa\n");
  });
});

// R-27: the ignored-path exemption must be decided by the PRE-run rules, not by a .gitignore the
// agent appended to on its way out.
test("an agent that gitignores its own out-of-contract file does not get the ignored exemption", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, ".gitignore"), "dist/\n", "utf8");
    initGitRepo(dir);
    const { result } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "planted.txt"), "out of contract\n", "utf8");
      await writeFile(join(dir, ".gitignore"), "dist/\nplanted.txt\n", "utf8");
    });
    assert.equal(existsSync(join(dir, "planted.txt")), false, "the planted file is quarantined, not left in place");
    assert.ok(result.reverted.includes("planted.txt"), JSON.stringify(result));
    assert.equal((await read(dir, ".gitignore")).replaceAll("\r\n", "\n"), "dist/\n");
  });
});

// R-25: an in-tree `.gitattributes` decides both the hash comparison and the restored bytes, and
// git honours it even when the file is brand new and untracked. The root one is in the protected
// set; a nested one is not, which is the gap this closes.
test("a planted nested .gitattributes is restored before anything is compared", async () => {
  await withProject(async ({ dir, control }) => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "const a = 1;\n", "utf8");
    initGitRepo(dir);
    const { result } = await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "src", ".gitattributes"), "*.ts working-tree-encoding=UTF-16LE\n", "utf8");
      await writeFile(join(dir, "src", "main.ts"), "const a = 2;\n", "utf8");
    });
    assert.equal(
      existsSync(join(dir, "src", ".gitattributes")),
      false,
      "the planted attributes file is quarantined",
    );
    assert.equal((await read(dir, "src/main.ts")).replaceAll("\r\n", "\n"), "const a = 1;\n");
    assert.ok(result.reverted.includes("src/main.ts"), JSON.stringify(result));
    assert.ok(
      result.warnings.some((line) => line.includes(".gitattributes/.gitignore changed")),
      JSON.stringify(result.warnings),
    );
  });
});

// R-4: the worktree restore must not leave the agent's content staged, where `ship` would commit it.
test("content the agent staged out of contract is unstaged by the revert", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "app.js"), "original\n", "utf8");
    initGitRepo(dir);
    await roundTrip(dir, control, async () => {
      await writeFile(join(dir, "app.js"), "agent content\n", "utf8");
      git(dir, ["add", "app.js"]);
    });
    assert.equal((await read(dir, "app.js")).replaceAll("\r\n", "\n"), "original\n");
    assert.equal(git(dir, ["status", "--porcelain"]).trim(), "", "nothing is left staged");
  });
});

// R-4: `git rm --cached` changes nothing on disk, so only the index snapshot can see it.
test("a git rm --cached the agent ran is put back", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "app.js"), "original\n", "utf8");
    initGitRepo(dir);
    await roundTrip(dir, control, async () => {
      git(dir, ["rm", "--cached", "-q", "app.js"]);
    });
    assert.equal(git(dir, ["status", "--porcelain"]).trim(), "", "the index entry is back");
  });
});

// R-3: a file the agent replaced with a directory must end as the file, not an empty directory.
test("a file replaced by a directory is restored as the file", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "config.js"), "module.exports = 1;\n", "utf8");
    initGitRepo(dir);
    const { result } = await roundTrip(dir, control, async () => {
      await rm(join(dir, "config.js"));
      await mkdir(join(dir, "config.js"), { recursive: true });
      await writeFile(join(dir, "config.js", "index.js"), "planted\n", "utf8");
    });
    assert.equal((await lstat(join(dir, "config.js"))).isFile(), true);
    assert.equal((await read(dir, "config.js")).replaceAll("\r\n", "\n"), "module.exports = 1;\n");
    assert.deepEqual(result.unrestorable, [], JSON.stringify(result));
  });
});

// R-41: the rename case the deleted `gitDiscoverChanges` test used to guard, on every platform.
test("an out-of-contract rename restores the source and quarantines the destination", async () => {
  await withProject(async ({ dir, control }) => {
    await writeFile(join(dir, "secret.ts"), "the secret\n", "utf8");
    initGitRepo(dir);
    const { result, quarantineDir } = await roundTrip(dir, control, async () => {
      git(dir, ["mv", "secret.ts", "leaked.ts"]);
    });
    assert.equal((await read(dir, "secret.ts")).replaceAll("\r\n", "\n"), "the secret\n");
    assert.equal(existsSync(join(dir, "leaked.ts")), false);
    assert.ok(result.reverted.includes("leaked.ts"), JSON.stringify(result));
    assert.ok(quarantineDir);
    assert.equal(
      (await readFile(join(quarantineDir, "files", "leaked.ts"), "utf8")).replaceAll("\r\n", "\n"),
      "the secret\n",
    );
    assert.equal(git(dir, ["status", "--porcelain"]).trim(), "");
  });
});

// R-39: the plan's NFC/NFD in-contract criterion, which nothing exercised before.
test("an NFD file on disk matches its NFC contract entry and is not flagged", async () => {
  await withProject(async ({ dir, control }) => {
    const nfd = "café.ts";
    const nfc = "café.ts".normalize("NFC");
    await writeFile(join(dir, "seed.md"), "seed\n", "utf8");
    await writeFile(join(dir, nfd), "before\n", "utf8");
    initGitRepo(dir);
    const { result } = await roundTrip(
      dir,
      control,
      async () => {
        await writeFile(join(dir, nfd), "the agent's legitimate artifact\n", "utf8");
      },
      { allowedRoots: [nfc] },
    );
    assert.deepEqual(result.reverted, [], JSON.stringify(result));
    assert.equal(
      (await readFile(join(dir, nfd), "utf8")).replaceAll("\r\n", "\n"),
      "the agent's legitimate artifact\n",
    );
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
    // R-43: and nothing half-moved was left behind in the quarantine folder.
    assert.equal(quarantine.dir, null, "no quarantine folder was created for a failed move");
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
