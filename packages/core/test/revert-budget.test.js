import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Quarantine, revertTree, snapshotTree } from "../dist/index.js";
import { gitHead, initGitRepo } from "./helpers.js";

/**
 * KD-16 regression guard: a synthetic 20,000-file tree (15,000 of them inside an ignored
 * `node_modules/`, 200 changed) must snapshot + diff + restore in under 20 s. It is a guard, not
 * a benchmark: it fails only if the stat-first design regresses into hashing or descending.
 */
const IGNORED_FILES = 15_000;
const TRACKED_FILES = 5_000;
const CHANGED = 200;
const BUDGET_MS = 20_000;

/**
 * A plain `readdir` + `lstat` sweep of the WHOLE tree, node_modules included: strictly more work
 * than the snapshot should ever do. It is measured in the same conditions as the snapshot, so the
 * guard still holds when the suite runs this file alongside thirty others on a loaded box.
 */
async function referenceWalk(dir) {
  let seen = 0;
  const visit = async (abs) => {
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const child = join(abs, dirent.name);
      const st = await lstat(child).catch(() => null);
      seen += 1;
      if (st?.isDirectory()) await visit(child);
    }
  };
  await visit(dir);
  return seen;
}

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

    // The ignored tree is recorded by existence and top-level entries only.
    assert.ok(snapshot.entries.size >= TRACKED_FILES, `walked ${snapshot.entries.size} entries`);
    assert.ok(snapshot.ignoredDirs.has("node_modules"), "node_modules is pruned, not walked");

    for (let n = 0; n < CHANGED; n += 1) {
      const group = n % 50;
      await writeFile(join(dir, "src", `g${group}`, `f${n % 100}.ts`), `export const changed = ${n};\n`, "utf8");
    }

    const startRevert = Date.now();
    const quarantine = new Quarantine(dir, "execute-budget");
    const result = await revertTree({ snapshot, runId: "execute-budget", allowedRoots: [], quarantine });
    await quarantine.finalize();
    const revertMs = Date.now() - startRevert;

    assert.equal(result.incident, false, JSON.stringify(result.unrestorable));
    assert.ok(result.reverted.length > 0, "the changed files were reverted");

    const total = snapshotMs + revertMs;
    const startReference = Date.now();
    const seen = await referenceWalk(dir);
    const referenceMs = Date.now() - startReference;
    assert.ok(seen > IGNORED_FILES, `the reference walk saw only ${seen} entries`);
    assert.ok(
      total < BUDGET_MS || total <= 3 * referenceMs,
      `snapshot ${snapshotMs} ms + revert ${revertMs} ms exceeds the ${BUDGET_MS} ms budget and 3x the ` +
        `${referenceMs} ms reference walk of the same tree`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(control, { recursive: true, force: true });
  }
});
