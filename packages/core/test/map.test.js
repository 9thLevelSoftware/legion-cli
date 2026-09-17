import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { HINT, LegionEngine, LegionRefuseError } from "../dist/index.js";
import {
  initGitRepo,
  initProject,
  passingVerificationCommand,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
} from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

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

test("map --refresh restores a clobbered generated region and keeps prose", async () => {
  await withEngine(async ({ engine, dir }) => {
    await initProject(engine);
    await seedSources(dir);
    await engine.map({ lsp: "off" });
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
    const result = await engine.map({ refresh: true, lsp: "off" });
    assert.equal(result.backend, "fallback");
    const refreshed = await readFile(archPath, "utf8");
    assert.match(refreshed, /<!-- legion-cli:generated:start -->/);
    assert.match(refreshed, /src\/auth\.ts/);
    assert.doesNotMatch(refreshed, /CLOBBERED/);
    assert.match(refreshed, /Human note: keep me/);
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
    assert.equal(existsSync(join(dir, ".legion-cli", "map")), false);
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
      const fingerprints = JSON.parse(
        await readFile(join(dir, ".legion-cli", "map", "fingerprints.json"), "utf8"),
      );
      assert.equal(fingerprints.schemaVersion, "legion-cli-fingerprint/v1");
    });
  });
});

test("map spawn overwriting fingerprints.json is restored from the in-process result", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ engine, dir }) => {
      await initProject(engine);
      await seedSources(dir);
      initGitRepo(dir);
      const spawning = new LegionEngine(dir, undefined, {
        fakeArtifacts: [{ path: ".legion-cli/map/fingerprints.json", content: '{"pwned":true}\n' }],
      });
      const result = await spawning.map({ lsp: "off" });
      assert.equal(result.backend, "fallback");
      const runNames = await readdir(join(dir, ".legion-cli", "cache", "runs"));
      assert.ok(runNames.some((name) => name.startsWith("map-")), "map skill spawn must have run");
      const fingerprints = JSON.parse(
        await readFile(join(dir, ".legion-cli", "map", "fingerprints.json"), "utf8"),
      );
      assert.equal(fingerprints.schemaVersion, "legion-cli-fingerprint/v1");
      assert.equal(fingerprints.pwned, undefined);
      assert.match(fingerprints.rootHash, /^[a-f0-9]{64}$/);
    });
  });
});

test("map refuses while execute is in_progress; live-spawn.json unchanged", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ store, dir }) => {
      const readyPath = join(dir, ".legion-cli", "cache", "fake-wait", "map-ready");
      const releasePath = join(dir, ".legion-cli", "cache", "fake-wait", "map-release");
      const engine = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeHoldWait: { readyPath, releasePath, timeoutMs: 15_000 },
      });
      await initProject(engine);
      await seedPlanReady(store, {
        task: {
          contract: {
            filesAllowed: ["src/main.ts"],
            expectedArtifacts: ["src/main.ts"],
            verificationCommands: [passingVerificationCommand()],
          },
        },
      });
      initGitRepo(dir);
      await seedSources(dir);
      const pending = engine.execute("auto");
      const start = Date.now();
      while (!existsSync(readyPath)) {
        if (Date.now() - start > 10_000) throw new Error("fake wait never became ready");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const livePath = join(dir, ".legion-cli", "cache", "live-spawn.json");
      const liveBefore = await readFile(livePath, "utf8");
      await assert.rejects(
        () => engine.map({ lsp: "off" }),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /refused while/);
          assert.equal(err.nextHint, HINT.status);
          return true;
        },
      );
      assert.equal(await readFile(livePath, "utf8"), liveBefore);
      assert.equal(existsSync(join(dir, ".legion-cli", "map", "fingerprints.json")), false);
      await writeFile(releasePath, "go\n");
      const result = await pending;
      assert.equal(result.status, "done");
    });
  });
});
