import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { MAX_SECRET_WALK_DEPTH, scanWikiSecrets } from "../dist/secrets.js";
import { withTempDir } from "./helpers.js";

test("scanWikiSecrets is stable across re-scans and skips wiki symlinks", async () => {
  await withTempDir(async (dir) => {
    const wiki = join(dir, "wiki");
    await mkdir(join(wiki, "ingested"), { recursive: true });
    await writeFile(
      join(wiki, "ingested", "leaked.md"),
      "AKIAIOSFODNN7EXAMPLE\nsk-proj-testfixture000000000000000000\n",
      "utf8",
    );
    const first = await scanWikiSecrets(wiki);
    const second = await scanWikiSecrets(wiki);
    assert.deepEqual(
      first.map((hit) => hit.name).sort(),
      second.map((hit) => hit.name).sort(),
    );
    assert.ok(first.some((hit) => hit.name === "aws-access-key"));
    assert.ok(first.some((hit) => hit.name === "sk-proj"));

    const outside = join(dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "leaked.md"), "ghp_OUTSIDESECRETTOKEN0000000000\n", "utf8");
    await symlink(outside, join(wiki, "ingested", "link"), process.platform === "win32" ? "junction" : "dir");
    const afterLink = await scanWikiSecrets(wiki);
    assert.equal(
      afterLink.some((hit) => hit.name === "ghp"),
      false,
      "symlink-in-wiki",
    );
  });
});

test("scanWikiSecrets does not walk past the depth bound", async () => {
  await withTempDir(async (dir) => {
    const wiki = join(dir, "wiki");
    let cursor = wiki;
    await mkdir(cursor, { recursive: true });
    for (let i = 0; i <= MAX_SECRET_WALK_DEPTH + 2; i += 1) {
      cursor = join(cursor, `d${i}`);
      await mkdir(cursor, { recursive: true });
    }
    await writeFile(join(cursor, "deep.md"), "AKIAIOSFODNN7EXAMPLE\n", "utf8");
    const hits = await scanWikiSecrets(wiki);
    assert.equal(hits.length, 0, "depth-bound");
  });
});
