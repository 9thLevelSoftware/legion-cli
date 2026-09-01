import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { normalize, runCli, withTempDir } from "./helpers.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const odFixture = join(repoRoot, "packages", "design-system", "test", "fixtures", "od-acme");
const legionFixture = join(repoRoot, "design-systems", "_fixture-neutral");

test("design-system install rejects github:", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const result = runCli(["design-system", "install", "github:acme/brand", "--project", dir]);
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /github:/);
    assert.match(normalize(result.stderr), /local directory/);
  });
});

test("design-system install/import-od/generate refuse UNC and protocol-relative paths", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);

    const githubSlash = runCli(["design-system", "install", "//github.com/acme/brand", "--project", dir]);
    assert.equal(githubSlash.status, 1);
    assert.match(normalize(githubSlash.stderr), /github:/);

    const githubUnc = runCli(["design-system", "install", "\\\\github.com\\acme\\brand", "--project", dir]);
    assert.equal(githubUnc.status, 1);
    assert.match(normalize(githubUnc.stderr), /github:/);

    const other = runCli(["design-system", "import-od", "//example.com/brand.css", "--project", dir]);
    assert.equal(other.status, 1);
    assert.match(normalize(other.stderr), /local directory copy only/);

    const gen = runCli([
      "design-system",
      "generate",
      "--project",
      dir,
      "--name",
      "Checkin",
      "--work-type",
      "product UI",
      "--platforms",
      "phone",
      "--wcag",
      "AA",
      "--brand",
      "//example.com/brand.css",
    ]);
    assert.equal(gen.status, 1);
    assert.match(normalize(gen.stderr), /URL fetch/);
  });
});

test("design-system import-od then install", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const imported = runCli(["design-system", "import-od", odFixture, "--project", dir, "--json"]);
    assert.equal(imported.status, 0, imported.stderr);
    const body = JSON.parse(imported.stdout);
    assert.equal(body.schemaVersion, "legion-cli-design-system/v1");
    assert.equal(body.id, "acme");

    const rawInstall = runCli(["design-system", "install", odFixture, "--project", dir]);
    assert.equal(rawInstall.status, 1);
    assert.match(normalize(rawInstall.stderr), /OpenDesign/);

    const installed = runCli(["design-system", "install", body.dest, "--project", dir, "--json"]);
    assert.equal(installed.status, 0, installed.stderr);
    const shown = runCli(["design-system", "show", "--project", dir, "--json"]);
    assert.equal(shown.status, 0, shown.stderr);
    const showBody = JSON.parse(shown.stdout);
    assert.equal(showBody.packageId, "acme");
    assert.equal(showBody.source.type, "local");
  });
});

test("design-system generate from flags does not fetch URLs", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const url = runCli([
      "design-system",
      "generate",
      "--project",
      dir,
      "--name",
      "Checkin",
      "--work-type",
      "product UI",
      "--platforms",
      "phone",
      "--wcag",
      "AA",
      "--brand",
      "https://example.com/brand.css",
    ]);
    assert.equal(url.status, 1);
    assert.match(normalize(url.stderr), /URL fetch/);

    const ok = runCli([
      "design-system",
      "generate",
      "--project",
      dir,
      "--name",
      "Checkin",
      "--work-type",
      "product UI",
      "--platforms",
      "phone and desktop",
      "--wcag",
      "AA",
      "--brand",
      "none",
      "--json",
    ]);
    assert.equal(ok.status, 0, ok.stderr);
    const body = JSON.parse(ok.stdout);
    assert.equal(body.id, "checkin");
    assert.equal(body.brandViolation, false);
  });
});

test("design-system install copies the local fixture", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["design-system", "install", legionFixture, "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(normalize(result.stdout), /fixture-neutral/);
    assert.match(normalize(result.stdout), /Brand tokens win/);
  });
});

test("help --all lists design-system commands", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /design-system show/);
  assert.match(out, /design-system install/);
  assert.match(out, /design-system import-od/);
  assert.match(out, /design-system generate/);
});
