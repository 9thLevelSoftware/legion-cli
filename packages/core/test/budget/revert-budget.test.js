import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Quarantine, revertTree, snapshotTree } from "../../dist/index.js";
import { gitHead, initGitRepo } from "../helpers.js";

/**
 * KD-16 regression guard: a synthetic 20,000-file tree (15,000 of them inside an ignored
 * `node_modules/`, 200 changed) must snapshot + diff + restore in under 20 s.
 *
 * It lives in `test/budget/` and the core `test` script runs that directory with
 * `--test-concurrency=1` (PR 5 review R-47): a wall-clock guard cannot share a box with thirty
 * other test files and still mean anything. The assertion itself is the unconditional bound
 * KD-16 specifies — no load-relative escape hatch.
 */
const IGNORED_FILES = 15_000;
const TRACKED_FILES = 5_000;
const CHANGED = 200;
const BUDGET_MS = 20_000;

async function buildTree(dir) {
  await writeFile(join(dir, ".gitignore"), "node_modules/\n", "utf8");
  // 15,000 ignored files, spread over 150 packages, that the walk must never descend into.
  for (let pkg = 0; pkg < 150; pkg += 1) {
    const pkgDir = join(dir, "node_modules", `pkg-${pkg}`);
    await mkdir(pkgDir, { recursive: true });
    const writes = [];
    for (let file = 0; file < IGNORED_FILES / 150; file += 1) {
      writes.push(writeFile(join(pkgDir, `f${file}.js`), `module.exports = ${pkg}${file};\n`, "utf8"));
    }
    await Promise.all(writes);
  }
  // 5,000 tracked files over 50 directories.
  for (let group = 0; group < 50; group += 1) {
    const groupDir = join(dir, "src", `g${group}`);
    await mkdir(groupDir, { recursive: true });
    const writes = [];
    for (let file = 0; file < TRACKED_FILES / 50; file += 1) {
      writes.push(writeFile(join(groupDir, `f${file}.ts`), `export const v${file} = ${group};\n`, "utf8"));
    }
    await Promise.all(writes);
  }
}

/** The n-th changed file, as 200 DISTINCT paths (the old `n % 100` produced only 100, R-47). */
function changedPath(dir, n) {
  return join(dir, "src", `g${n % 50}`, `f${Math.floor(n / 50)}.ts`);
}

test(`snapshot + diff + restore of a 20,000-file tree stays under ${BUDGET_MS} ms`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-budget-"));
  const control = await mkdtemp(join(tmpdir(), "legion-budget-ctl-"));
  try {
    await buildTree(dir);
    initGitRepo(dir);

    const startSnapshot = Date.now();
    const snapshot = await snapshotTree({
      projectRoot: dir,
      runId: "execute-budget",
      preSpawnRef: gitHead(dir),
      controlDir: control,
    });
    const snapshotMs = Date.now() - startSnapshot;

    // The ignored tree is recorded by existence and top-level entries only. The UPPER bound is the
    // assertion that actually catches a walk that descends into `node_modules` (R-38).
    assert.ok(snapshot.ignoredDirs.has("node_modules"), "node_modules is recorded as an ignored directory");
    assert.ok(snapshot.entries.size >= TRACKED_FILES, `walked only ${snapshot.entries.size} entries`);
    assert.ok(
      snapshot.entries.size < TRACKED_FILES + 200,
      `the walk descended into ignored trees: ${snapshot.entries.size} entries`,
    );

    for (let n = 0; n < CHANGED; n += 1) {
      await writeFile(changedPath(dir, n), `export const changed = ${n};\n`, "utf8");
    }

    const startRevert = Date.now();
    const quarantine = new Quarantine(dir, "execute-budget");
    const result = await revertTree({ snapshot, runId: "execute-budget", allowedRoots: [], quarantine });
    await quarantine.finalize();
    const revertMs = Date.now() - startRevert;

    assert.equal(result.incident, false, JSON.stringify(result.unrestorable));
    assert.equal(result.reverted.length, CHANGED, `reverted ${result.reverted.length} of ${CHANGED}`);
    assert.ok(
      snapshotMs + revertMs < BUDGET_MS,
      `snapshot ${snapshotMs} ms + revert ${revertMs} ms exceeds the ${BUDGET_MS} ms budget`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(control, { recursive: true, force: true });
  }
});
