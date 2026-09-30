import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { legionPaths, listTaskSummaries, persistWork, resetPersistWork } from "../dist/index.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-tasks-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const task = (status) => `---\nid: TSK-0001\ntitle: t\nstatus: ${status}\nspecId: s\n---\n`;

test("a task file changed outside the engine (git checkout) shows in the summaries", async () => {
  await withTempDir(async (dir) => {
    const tasks = legionPaths(dir).tasksDir;
    await mkdir(tasks, { recursive: true });
    const abs = join(tasks, "TSK-0001.md");
    await writeFile(abs, task("ready"), "utf8");
    assert.equal((await listTaskSummaries(dir))[0].status, "ready");
    // Same size, later mtime: only the mtime differs.
    await writeFile(abs, task("READY"), "utf8");
    const later = new Date(Date.now() + 5000);
    await utimes(abs, later, later);
    assert.equal((await listTaskSummaries(dir))[0].status, "READY");
    // Unchanged file: served from the cache with no re-read.
    resetPersistWork();
    await listTaskSummaries(dir);
    assert.equal(persistWork.taskFileReads, 0);
  });
});

test("a cache entry without mtimeMs/size (old format) is re-read once and upgraded", async () => {
  await withTempDir(async (dir) => {
    const paths = legionPaths(dir);
    await mkdir(paths.tasksDir, { recursive: true });
    await mkdir(paths.indexDir, { recursive: true });
    await writeFile(join(paths.tasksDir, "TSK-0001.md"), task("done"), "utf8");
    await writeFile(
      join(paths.indexDir, "task-summaries.json"),
      JSON.stringify({
        version: 1,
        files: {
          "TSK-0001.md": { id: "TSK-0001", file: "TSK-0001.md", status: "ready", title: "t", specId: "s", ok: true },
        },
      }),
      "utf8",
    );
    assert.equal((await listTaskSummaries(dir))[0].status, "done");
    resetPersistWork();
    await listTaskSummaries(dir);
    assert.equal(persistWork.taskFileReads, 0, "upgraded entry is now trusted by mtime and size");
  });
});
