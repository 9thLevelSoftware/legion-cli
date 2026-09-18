import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";

import { normalize, runCli, withTempDir } from "./helpers.js";

const AUTH_TS = "export function login() {}\nexport function logout() {}\n";

async function seedProject(dir) {
  const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
  assert.equal(init.status, 0, init.stderr);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "auth.ts"), AUTH_TS, "utf8");
}

test("help --all lists map in shipped adjacent, not later", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /Shipped adjacent[\s\S]*^ {2}map$/m);
  assert.match(out, /--refresh, --lsp, --no-lsp/);
  assert.doesNotMatch(out, /Later, not this series:[\s\S]*\bmap\b/);
  assert.doesNotMatch(out, /Later, not this series:\n {2}skills list\|install/);
});

test("map --help lists --refresh --lsp --no-lsp", () => {
  const result = runCli(["map", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /--refresh/);
  assert.match(out, /--lsp/);
  assert.match(out, /--no-lsp/);
});

test("map refuses until init and does not write the map dir", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["map", "--project", dir]);
    assert.equal(result.status, 1);
    const err = normalize(result.stderr);
    assert.match(err, /Legion CLI project first/);
    assert.match(err, /Next: legion-cli init/);
    assert.equal(existsSync(join(dir, ".legion-cli", "map")), false);
  });
});

test("map generates ARCHITECTURE.md and show kind map", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const result = runCli(["map", "--no-lsp", "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    const out = normalize(result.stdout);
    assert.match(out, /Map: \.legion-cli\/map\/ARCHITECTURE\.md/);
    assert.match(out, /backend: fallback/);
    assert.match(out, /Next: legion-cli show \.legion-cli\/map\/ARCHITECTURE\.md/);
    const arch = await readFile(join(dir, ".legion-cli", "map", "ARCHITECTURE.md"), "utf8");
    assert.match(arch, /<!-- legion-cli:generated:start -->/);
    assert.match(arch, /src\/auth\.ts/);

    const shown = runCli(["show", "--project", dir, ".legion-cli/map/ARCHITECTURE.md"]);
    assert.equal(shown.status, 0, shown.stderr);
    const shownOut = normalize(shown.stdout);
    assert.match(shownOut, /^map: Architecture$/m);
    assert.match(shownOut, /path: \.legion-cli\/map\/ARCHITECTURE\.md/);

    const jsonShow = runCli(["show", "--json", "--project", dir, "map/ARCHITECTURE.md"]);
    assert.equal(jsonShow.status, 0, jsonShow.stderr);
    const body = JSON.parse(jsonShow.stdout);
    assert.equal(body.kind, "map");
    assert.equal(body.path, ".legion-cli/map/ARCHITECTURE.md");

    const brief = runCli(["brief", "--json", "--project", dir]);
    assert.equal(brief.status, 0, brief.stderr);
    const briefBody = JSON.parse(brief.stdout);
    assert.match(briefBody.mapRootHash, /^[a-f0-9]{64}$/);
  });
});

test("map --refresh preserves prose outside generated markers", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const first = runCli(["map", "--no-lsp", "--project", dir]);
    assert.equal(first.status, 0, first.stderr);
    const archPath = join(dir, ".legion-cli", "map", "ARCHITECTURE.md");
    const existing = await readFile(archPath, "utf8");
    const start = "<!-- legion-cli:generated:start -->";
    const end = "<!-- legion-cli:generated:end -->";
    const i = existing.indexOf(start);
    const j = existing.indexOf(end);
    await writeFile(
      archPath,
      `${existing.slice(0, i + start.length)}\nCLOBBERED\n${existing.slice(j)}Human note: keep me.\n`,
      "utf8",
    );
    const refreshed = runCli(["map", "--refresh", "--no-lsp", "--project", dir]);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    const after = await readFile(archPath, "utf8");
    assert.match(after, /Human note: keep me/);
    assert.match(after, /<!-- legion-cli:generated:start -->/);
    assert.match(after, /src\/auth\.ts/);
    assert.doesNotMatch(after, /CLOBBERED/);
  });
});

test("map --lsp with no server refuses and leaves fingerprints unwritten", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const beforeState = await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8");
    const result = runCli(["map", "--lsp", "--project", dir], {
      env: { PATH: "", Path: "", PATHEXT: process.env.PATHEXT },
    });
    assert.equal(result.status, 1, result.stdout);
    const err = normalize(result.stderr);
    assert.match(err, /no language server on PATH/);
    assert.match(err, /Next: legion-cli map --no-lsp/);
    assert.equal(existsSync(join(dir, ".legion-cli", "map", "fingerprints.json")), false);
    assert.equal(existsSync(join(dir, ".legion-cli", "map", "ARCHITECTURE.md")), false);
    assert.equal(existsSync(join(dir, ".legion-cli", "map")), false);
    assert.equal(await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8"), beforeState);
  });
});

test("map --json reports next show path", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const result = runCli(["map", "--no-lsp", "--json", "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.path, ".legion-cli/map/ARCHITECTURE.md");
    assert.equal(body.backend, "fallback");
    assert.equal(body.next, "legion-cli show .legion-cli/map/ARCHITECTURE.md");
  });
});

test("map spawn writing src/main.ts is reverted", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const beforeState = await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8");
    const result = runCli(["map", "--no-lsp", "--project", dir], {
      env: {
        LEGION_CLI_ADAPTER: "fake",
        LEGION_CLI_FAKE_ARTIFACTS: JSON.stringify([
          { path: "src/main.ts", content: "export const leaked = true;\n" },
        ]),
      },
    });
    assert.equal(result.status, 1, result.stdout);
    const err = normalize(result.stderr);
    assert.match(err, /SkillContract/);
    assert.match(err, /src\/main\.ts/);
    assert.match(err, /Next: legion-cli map/);
    assert.equal(existsSync(join(dir, "src", "main.ts")), false);
    assert.equal(await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8"), beforeState);
    const engine = createLegionEngine(dir);
    assert.equal((await engine.getState()).phase, "initialized");
    const fingerprints = JSON.parse(
      await readFile(join(dir, ".legion-cli", "map", "fingerprints.json"), "utf8"),
    );
    assert.equal(fingerprints.schemaVersion, "legion-cli-fingerprint/v1");
    assert.match(fingerprints.rootHash, /^[a-f0-9]{64}$/);
  });
});

test("map --lsp --no-lsp uses fallback; --no-lsp --lsp requires a server", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const fallback = runCli(["map", "--lsp", "--no-lsp", "--project", dir]);
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(normalize(fallback.stdout), /backend: fallback/);
    const required = runCli(["map", "--no-lsp", "--lsp", "--project", dir], {
      env: { PATH: "", Path: "", PATHEXT: process.env.PATHEXT },
    });
    assert.equal(required.status, 1, required.stdout);
    assert.match(normalize(required.stderr), /no language server on PATH/);
    assert.match(normalize(required.stderr), /Next: legion-cli map --no-lsp/);
  });
});

test("show refuses a symlink ARCHITECTURE.md and does not follow it", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const first = runCli(["map", "--no-lsp", "--project", dir]);
    assert.equal(first.status, 0, first.stderr);
    const archPath = join(dir, ".legion-cli", "map", "ARCHITECTURE.md");
    const envPath = join(dir, "src", ".env");
    await writeFile(envPath, "SECRET=do-not-leak\n", "utf8");
    await unlink(archPath);
    let linked = false;
    try {
      await symlink(envPath, archPath);
      linked = true;
    } catch (err) {
      if (err?.code !== "EPERM") throw err;
    }
    if (!linked) return;
    const shown = runCli(["show", "--project", dir, ".legion-cli/map/ARCHITECTURE.md"]);
    assert.equal(shown.status, 1);
    const err = normalize(shown.stderr);
    assert.match(err, /symlink/);
    assert.doesNotMatch(err, /SECRET=do-not-leak/);
    assert.doesNotMatch(normalize(shown.stdout), /SECRET=do-not-leak/);
  });
});
