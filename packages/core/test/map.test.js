import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { HINT, LegionEngine, LegionRefuseError } from "../dist/index.js";
import { initGitRepo, initProject, withEngine, withFakeAdapter } from "./helpers.js";

const AUTH_TS = "export function login() {}\nexport function logout() {}\n";

async function seedSources(dir) {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "auth.ts"), AUTH_TS, "utf8");
}

test("map refuses until init and does not write the map dir", async () => {
  await withEngine(async ({ engine, dir }) => {
    await assert.rejects(
      () => engine.map(),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /Legion CLI project first/);
        assert.equal(err.nextHint, HINT.init);
        return true;
      },
    );
    assert.equal(existsSync(join(dir, ".legion-cli", "map")), false);
  });
});

test("map writes ARCHITECTURE.md markers and does not change phase", async () => {
  await withEngine(async ({ engine, dir }) => {
    await initProject(engine);
    await seedSources(dir);
    const before = await engine.getState();
    const result = await engine.map({ lsp: "off" });
    assert.equal(result.path, ".legion-cli/map/ARCHITECTURE.md");
    assert.equal(result.fingerprintsPath, ".legion-cli/map/fingerprints.json");
    assert.equal(result.backend, "fallback");
    assert.ok(result.modules >= 1);
    assert.equal(result.next, "legion-cli show .legion-cli/map/ARCHITECTURE.md");
    const arch = await readFile(join(dir, ".legion-cli", "map", "ARCHITECTURE.md"), "utf8");
    assert.match(arch, /<!-- legion-cli:generated:start -->/);
    assert.match(arch, /<!-- legion-cli:generated:end -->/);
    assert.match(arch, /src\/auth\.ts/);
    const after = await engine.getState();
    assert.equal(after.phase, before.phase);
    const brief = await engine.brief();
    assert.equal(typeof brief.mapRootHash, "string");
    assert.match(brief.mapRootHash, /^[a-f0-9]{64}$/);
  });
});

test("map --refresh preserves prose outside generated markers", async () => {
  await withEngine(async ({ engine, dir }) => {
    await initProject(engine);
    await seedSources(dir);
    await engine.map({ lsp: "off" });
    const archPath = join(dir, ".legion-cli", "map", "ARCHITECTURE.md");
    const existing = await readFile(archPath, "utf8");
    await writeFile(archPath, `${existing}\nHuman note: keep me.\n`, "utf8");
    const result = await engine.map({ refresh: true, lsp: "off" });
    assert.equal(result.backend, "fallback");
    const refreshed = await readFile(archPath, "utf8");
    assert.match(refreshed, /Human note: keep me/);
    assert.match(refreshed, /<!-- legion-cli:generated:start -->/);
  });
});

test("map lsp require with no server refuses and leaves fingerprints unwritten", async () => {
  await withEngine(async ({ engine, dir }) => {
    await initProject(engine);
    await seedSources(dir);
    const beforeState = await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8");
    await assert.rejects(
      () => engine.map({ lsp: "require", resolveBinary: () => null }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /no language server on PATH/);
        assert.equal(err.nextHint, "legion-cli map --no-lsp");
        return true;
      },
    );
    assert.equal(existsSync(join(dir, ".legion-cli", "map", "fingerprints.json")), false);
    assert.equal(existsSync(join(dir, ".legion-cli", "map", "ARCHITECTURE.md")), false);
    assert.equal(await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8"), beforeState);
  });
});

test("map spawn writing src/main.ts is reverted", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, dir }) => {
      await initProject(engine);
      await seedSources(dir);
      initGitRepo(dir);
      const beforeState = await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8");
      const spawning = new LegionEngine(dir, undefined, {
        fakeArtifacts: [{ path: "src/main.ts", content: "export const leaked = true;\n" }],
      });
      await assert.rejects(
        () => spawning.map({ lsp: "off" }),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /SkillContract/);
          assert.match(err.message, /src\/main\.ts/);
          assert.equal(err.nextHint, HINT.map);
          return true;
        },
      );
      assert.equal(existsSync(join(dir, "src", "main.ts")), false);
      assert.equal(await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8"), beforeState);
      assert.equal(existsSync(join(dir, ".legion-cli", "map", "ARCHITECTURE.md")), true);
    });
  });
});
