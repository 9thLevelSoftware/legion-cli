import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  gitCommitIndex,
  gitDiffCached,
  gitDiscoverChanges,
  gitIndexEntries,
  gitPorcelainPaths,
  gitStagedPaths,
  runGit,
} from "../dist/index.js";

function git(cwd, args, input) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, input, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "legion-git-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "diff.renames", "copies"]);
  git(dir, ["config", "status.renames", "copies"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

function commitAll(dir) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

// `"` cannot appear in a Windows file name; the other awkward characters can.
const AWKWARD = process.platform === "win32" ? ["é.txt", "with space.txt"] : ["é.txt", "with space.txt", 'q"uote.txt'];

test("ship index listing survives more than 12k tracked files (over the 1 MiB default buffer)", () => {
  const dir = tempRepo();
  try {
    const blob = git(dir, ["hash-object", "-w", "--stdin"], "x\n");
    const count = 12_000;
    const info = [];
    for (let i = 0; i < count; i++) info.push(`100644 ${blob}\tsrc/dir${i % 50}/module-with-a-reasonably-long-name-${i}.txt`);
    git(dir, ["update-index", "--add", "--index-info"], info.join("\n") + "\n");
    const raw = runGit(dir, ["ls-files", "-s", "-z", "--cached", "--full-name"]);
    assert.equal(raw.status, 0);
    assert.ok(raw.stdout.length > 1024 * 1024, "the fixture must exceed the default 1 MiB maxBuffer");
    assert.equal(gitIndexEntries(dir).length, count);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discovery returns thousands of long untracked paths whose listings exceed 1 MiB", () => {
  const dir = tempRepo();
  try {
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    commitAll(dir);
    const count = 8_800;
    const pad = "p".repeat(110);
    for (let d = 0; d < 44; d++) {
      const sub = join(dir, "bulk", `d${d}`);
      mkdirSync(sub, { recursive: true });
      for (let i = 0; i < count / 44; i++) writeFileSync(join(sub, `${pad}-${i}.txt`), "");
    }
    // Both git outputs the discovery relies on must be over the old default buffer.
    const status = runGit(dir, ["status", "--porcelain=v1", "-z", "-uall"]);
    const others = runGit(dir, ["ls-files", "-z", "--others", "--exclude-standard"]);
    assert.ok(status.stdout.length > 1024 * 1024, `status output ${status.stdout.length}`);
    assert.ok(others.stdout.length > 1024 * 1024, `ls-files output ${others.stdout.length}`);
    assert.equal(gitDiscoverChanges(dir, null).length, count);
    assert.equal(gitPorcelainPaths(dir).length, count);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a staged diff over 1 MiB is returned whole", () => {
  const dir = tempRepo();
  try {
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    commitAll(dir);
    writeFileSync(join(dir, "big.txt"), "0123456789abcdef\n".repeat(120_000));
    git(dir, ["add", "big.txt"]);
    const diff = gitDiffCached(dir);
    assert.ok(diff.length > 1024 * 1024);
    assert.ok(diff.endsWith("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a spawn failure and an output overflow are named failures", () => {
  const dir = tempRepo();
  try {
    const bad = runGit(dir, ["definitely-not-a-git-command"]);
    assert.notEqual(bad.status, 0);
    assert.equal(bad.error, undefined);
    const missing = runGit(join(dir, "does-not-exist"), ["status"]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.error ?? "", /^git status could not complete \(/);
    writeFileSync(join(dir, "some-file-name.txt"), "x\n");
    const overflow = runGit(dir, ["status", "--porcelain=v1", "-uall"], { maxBuffer: 4 });
    assert.equal(overflow.status, 1);
    assert.match(overflow.error ?? "", /ENOBUFS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing commit keeps its reason (stdout, bounded) and a failing listing embeds no stdout", () => {
  const dir = tempRepo();
  try {
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    commitAll(dir);
    assert.throws(() => gitCommitIndex(dir, "empty"), (err) => {
      assert.match(err.message, /^git commit failed: \S/);
      assert.ok(err.message.length < 700);
      return true;
    });
    // ENOBUFS on a listing: the message names the cause and carries none of the listing.
    const marker = "unique-listing-marker-name.txt";
    writeFileSync(join(dir, marker), "x\n");
    git(dir, ["add", "-A"]);
    const result = runGit(dir, ["ls-files", "-z"], { maxBuffer: 4 });
    assert.match(result.error ?? "", /ENOBUFS/);
    assert.ok(!result.stderr.includes(marker));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("names with é, a space and a quote are returned as real paths", () => {
  const dir = tempRepo();
  try {
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    commitAll(dir);
    for (const name of AWKWARD) writeFileSync(join(dir, name), "x\n");
    const untracked = gitDiscoverChanges(dir, null).sort();
    assert.deepEqual(untracked, [...AWKWARD].sort());
    git(dir, ["add", "-A"]);
    assert.deepEqual(gitStagedPaths(dir).sort(), [...AWKWARD].sort());
    assert.deepEqual(gitPorcelainPaths(dir).sort(), [...AWKWARD].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, kind] of [["rename", "R"], ["copy", "C"]]) {
  test(`${label} of awkward names yields source and destination (porcelain -z and name-status -z)`, () => {
    const dir = tempRepo();
    try {
      const pairs = AWKWARD.map((name, i) => [`src-${i}-${name}`, `dst-${i}-${name}`]);
      const body = Array.from({ length: 100 }, (_, n) => `line ${n}`).join("\n") + "\n";
      for (const [from] of pairs) writeFileSync(join(dir, from), body);
      const base = commitAll(dir);
      for (const [from, to] of pairs) {
        if (kind === "R") renameSync(join(dir, from), join(dir, to));
        else {
          copyFileSync(join(dir, from), join(dir, to));
          writeFileSync(join(dir, from), `${body}changed\n`); // a copy needs a modified source to be detected
        }
      }
      git(dir, ["add", "-A"]);
      const expected = pairs.flatMap(([from, to]) => [from, to]).sort();

      // porcelain path: staged, not committed
      const status = git(dir, ["status", "--porcelain=v1"]);
      assert.match(status, new RegExp(`^${kind}`, "m"), `git must report a ${label} for this test to mean anything`);
      const viaPorcelain = gitDiscoverChanges(dir, null).sort();
      assert.deepEqual(viaPorcelain, expected);

      // name-status path: committed since the base ref
      git(dir, ["commit", "-q", "-m", label]);
      const nameStatus = git(dir, ["diff", "--name-status", base, "HEAD"]);
      assert.match(nameStatus, new RegExp(`^${kind}`, "m"));
      assert.deepEqual(gitDiscoverChanges(dir, base).sort(), expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("mixed rename, copy, modify and untracked records keep their order and shapes", () => {
  const dir = tempRepo();
  try {
    const body = Array.from({ length: 100 }, (_, n) => `line ${n}`).join("\n") + "\n";
    for (const name of ["a-copy-src.txt", "b-mod.txt", "c-ren-src.txt"]) writeFileSync(join(dir, name), body);
    const base = commitAll(dir);
    writeFileSync(join(dir, "a-copy-src.txt"), `${body}changed\n`);
    copyFileSync(join(dir, "a-copy-src.txt"), join(dir, "a-copy-dst.txt"));
    renameSync(join(dir, "c-ren-src.txt"), join(dir, "c-ren-dst.txt"));
    git(dir, ["add", "a-copy-src.txt", "a-copy-dst.txt", "c-ren-src.txt", "c-ren-dst.txt"]);
    writeFileSync(join(dir, "b-mod.txt"), `${body}unstaged\n`);
    writeFileSync(join(dir, "d-new.txt"), "new\n");
    const expected = ["a-copy-dst.txt", "a-copy-src.txt", "b-mod.txt", "c-ren-dst.txt", "c-ren-src.txt", "d-new.txt"];

    // Pin the record shapes: porcelain -z is destination first.
    const raw = runGit(dir, ["status", "--porcelain=v1", "-z", "-uall"]).stdout;
    assert.ok(raw.includes("C  a-copy-dst.txt\0a-copy-src.txt\0"), JSON.stringify(raw));
    assert.ok(raw.includes("R  c-ren-dst.txt\0c-ren-src.txt\0"), JSON.stringify(raw));
    assert.deepEqual(gitDiscoverChanges(dir, null).sort(), expected);

    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "mixed"]);
    // name-status -z is source first.
    const ns = runGit(dir, ["diff", "--name-status", "-z", base, "HEAD"]).stdout;
    assert.match(ns, /C\d+\0a-copy-src\.txt\0a-copy-dst\.txt\0/);
    assert.match(ns, /R\d+\0c-ren-src\.txt\0c-ren-dst\.txt\0/);
    assert.deepEqual(gitDiscoverChanges(dir, base).sort(), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a POSIX file name containing a backslash is reported as is", { skip: process.platform === "win32" }, () => {
  const dir = tempRepo();
  try {
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    commitAll(dir);
    const name = ["docs", "x.md"].join(String.fromCharCode(92));
    writeFileSync(join(dir, name), "x\n");
    assert.deepEqual(gitDiscoverChanges(dir, null), [name]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
