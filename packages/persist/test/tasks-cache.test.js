import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  legionPaths,
  listTaskSummaries,
  openEngineCommand,
  persistWork,
  resetPersistWork,
  restoreEngineState,
} from "../dist/index.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-taskcache-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const task = (status, pad = "") => `---\nid: TSK-0001\ntitle: t${pad}\nstatus: ${status}\nspecId: s\n---\n`;

test("a size-only change (mtime restored) is still re-read", async () => {
  await withTempDir(async (dir) => {
    const tasks = legionPaths(dir).tasksDir;
    await mkdir(tasks, { recursive: true });
    const abs = join(tasks, "TSK-0001.md");
    await writeFile(abs, task("ready"), "utf8");
    const { mtime } = await stat(abs);
    assert.equal((await listTaskSummaries(dir))[0].status, "ready");
    await writeFile(abs, task("done", "-longer"), "utf8");
    await utimes(abs, mtime, mtime);
    resetPersistWork();
    assert.equal((await listTaskSummaries(dir))[0].status, "done");
    assert.equal(persistWork.taskFileReads >= 1, true);
  });
});

test("restoring a task file (applyDigest) refreshes its cache entry without a re-read", async () => {
  await withTempDir(async (dir) => {
    const paths = legionPaths(dir);
    await mkdir(paths.tasksDir, { recursive: true });
    const abs = join(paths.tasksDir, "TSK-0001.md");
    await writeFile(abs, task("ready"), "utf8");
    await openEngineCommand(dir, "cmd-cache");
    await writeFile(abs, task("done", "-agent"), "utf8"); // agent edit, bypasses the engine
    assert.equal((await listTaskSummaries(dir))[0].status, "done");
    await restoreEngineState(dir, "cmd-cache", {
      agentAlive: false,
      jailWritable: false,
      allowedRoots: [".legion-cli/tasks/**"],
    });
    const cache = JSON.parse(await readFile(join(paths.indexDir, "task-summaries.json"), "utf8"));
    const entry = cache.files["TSK-0001.md"];
    const st = await stat(abs);
    assert.equal(entry.status, "ready", "cache follows the restored bytes");
    assert.equal(entry.mtimeMs, st.mtimeMs);
    assert.equal(entry.size, st.size);
  });
});
