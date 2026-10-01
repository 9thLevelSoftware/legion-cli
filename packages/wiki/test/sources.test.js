import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { MAX_INGEST_FILE_BYTES } from "@9thlevelsoftware/legion-cli-persist";

import { materializeIngestSources } from "../dist/index.js";
import { withTempDir } from "./helpers.js";

function git(dir, args) {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

async function repoWithChange(dir, content) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  await writeFile(join(dir, "a.txt"), "base\n", "utf8");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  await writeFile(join(dir, "a.txt"), content, "utf8");
}

test("wiki ingest --diff keeps a small diff body", async () => {
  await withTempDir(async (dir) => {
    await repoWithChange(dir, "changed\n");
    const got = await materializeIngestSources({ projectRoot: dir, sources: [], diff: "HEAD" });
    assert.equal(got.documents.length, 1);
    assert.equal(got.documents[0].source, "diff:HEAD");
    assert.match(got.documents[0].body, /\+changed/);
  });
});

test("wiki ingest --diff over MAX_INGEST_FILE_BYTES gets an empty body like an oversize file", async () => {
  await withTempDir(async (dir) => {
    await repoWithChange(dir, `${"x".repeat(1023)}\n`.repeat(Math.ceil(MAX_INGEST_FILE_BYTES / 1024) + 16));
    const got = await materializeIngestSources({ projectRoot: dir, sources: [], diff: "HEAD" });
    assert.equal(got.documents.length, 1);
    assert.equal(got.documents[0].source, "diff:HEAD");
    assert.equal(got.documents[0].body, "");
  });
});
