import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runCli, withTempDir } from "./helpers.js";

test("recipe list reports empty when no recipes exist and lists recipes when added", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const res1 = runCli(["recipe", "list", "--project", dir]);
    assert.equal(res1.status, 0);
    assert.match(res1.stdout, /No recipes found/);

    const recipesDir = join(dir, ".legion-cli", "recipes");
    await mkdir(recipesDir, { recursive: true });
    await writeFile(
      join(recipesDir, "hello.yaml"),
      `schemaVersion: legion-cli-recipe/v1\nname: hello\ndescription: Say hello\nsteps:\n  - id: s1\n    description: echo\n    action: command\n    tool: node -e "console.log('HELLO_RECIPE')"\n`,
      "utf8",
    );

    const res2 = runCli(["recipe", "list", "--project", dir]);
    assert.equal(res2.status, 0);
    assert.match(res2.stdout, /hello/);

    const res3 = runCli(["recipe", "run", "hello", "--project", dir]);
    assert.equal(res3.status, 0);
    assert.match(res3.stdout, /HELLO_RECIPE/);
    assert.match(res3.stdout, /completed successfully/);
  });
});

test("recipe requires subcommand list or run", async () => {
  await withTempDir(async (dir) => {
    const res = runCli(["recipe", "--project", dir]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /recipe requires list or run/);
  });
});

test("undo reports error when no done task exists", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const res = runCli(["undo", "--project", dir]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no task or commit found to undo/);
  });
});
