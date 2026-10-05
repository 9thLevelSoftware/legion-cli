import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectSandbox, prepareVerificationWrapper } from "@9thlevelsoftware/legion-cli-sandbox";
import { verificationRuntimeClosure } from "../dist/assurance-flow.js";

async function writePackage(directory, manifest, files = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
}

/** Project-local engine install: core -> dep-a (nested dep-b resolved by walking up), plus a missing optional dep. */
async function fakeEngineProject() {
  const project = realpathSync(await mkdtemp(join(os.tmpdir(), "legion-closure-")));
  const modules = join(project, "node_modules");
  const engine = join(modules, "@9thlevelsoftware", "legion-cli-core");
  await writePackage(engine, {
    name: "@9thlevelsoftware/legion-cli-core",
    dependencies: { "dep-a": "1.0.0" },
    optionalDependencies: { "missing-optional": "1.0.0" },
  }, { "index.js": "module.exports = 'engine';\n" });
  await writePackage(join(modules, "dep-a"), { name: "dep-a", dependencies: { "@scope/dep-b": "1.0.0" } });
  await writePackage(join(modules, "@scope", "dep-b"), { name: "@scope/dep-b" }, { "index.js": "module.exports = 'transitive';\n" });
  await writeFile(join(project, "product.txt"), "product");
  return { project, engine, depA: join(modules, "dep-a"), depB: join(modules, "@scope", "dep-b") };
}

test("engine runtime closure covers transitive dependencies and skips missing optional ones", async () => {
  const fixture = await fakeEngineProject();
  try {
    assert.deepEqual(
      verificationRuntimeClosure([fixture.engine]),
      [fixture.engine, fixture.depA, fixture.depB].sort(),
    );
  } finally {
    await rm(fixture.project, { recursive: true, force: true });
  }
});

test("engine runtime closure refuses missing required dependencies, invalid names, and exceeded bounds", async () => {
  const fixture = await fakeEngineProject();
  try {
    assert.throws(() => verificationRuntimeClosure([fixture.engine], { maxPackages: 2, maxDepth: 128 }), /exceeds its bound of 2 packages/);
    assert.throws(() => verificationRuntimeClosure([fixture.engine], { maxPackages: 100, maxDepth: 1 }), /exceeds its depth bound of 1/);
    await writePackage(fixture.depB, { name: "@scope/dep-b", dependencies: { "../escape": "1.0.0" } });
    assert.throws(() => verificationRuntimeClosure([fixture.engine]), /invalid dependency name/);
    await writePackage(fixture.depB, { name: "@scope/dep-b", dependencies: { "dep-missing": "1.0.0" } });
    assert.throws(
      () => verificationRuntimeClosure([fixture.engine]),
      /cannot resolve required engine runtime dependency dep-missing of @scope\/dep-b/,
    );
  } finally {
    await rm(fixture.project, { recursive: true, force: true });
  }
});

test("hardened information-flow verification cannot modify a project-local transitive engine dependency", async (t) => {
  const detected = detectSandbox();
  const backend = detected.backend;
  if (!detected.hardened || !((process.platform === "linux" && backend === "bwrap") || (process.platform === "darwin" && backend === "seatbelt"))) {
    t.skip(`hardened bwrap/seatbelt verification sandbox unavailable (detected ${backend}, hardened=${detected.hardened}, platform=${process.platform})`);
    return;
  }
  const fixture = await fakeEngineProject();
  try {
    await mkdir(join(fixture.project, ".legion-cli"), { recursive: true });
    const wrapper = await prepareVerificationWrapper(fixture.project, "closure-write-test", {
      tier: `hardened-${backend}`,
      note: "closure test",
      backend,
      copyJail: false,
    }, { informationFlow: { installedEnginePaths: [], readOnlyEnginePaths: verificationRuntimeClosure([fixture.engine]) } });
    assert.ok(wrapper, `real ${backend} wrapper`);
    const target = join(fixture.depB, "index.js");
    const script = [
      "const fs=require('fs');",
      `if(require(${JSON.stringify(fixture.depB)})!=='transitive') process.exit(11);`,
      `try { fs.writeFileSync(${JSON.stringify(target)}, 'tampered'); process.exit(12); } catch {}`,
      `try { fs.renameSync(${JSON.stringify(fixture.depB)}, ${JSON.stringify(`${fixture.depB}-moved`)}); process.exit(13); } catch {}`,
      `try { fs.renameSync(${JSON.stringify(join(fixture.project, "node_modules"))}, ${JSON.stringify(join(fixture.project, "node_modules-moved"))}); process.exit(14); } catch {}`,
      `try { fs.mkdirSync(${JSON.stringify(join(fixture.project, "node_modules", "missing-optional"))}); process.exit(15); } catch {}`,
      "fs.writeFileSync('product.txt','changed');",
    ].join("");
    const result = spawnSync(wrapper.bin, [...wrapper.argvPrefix, process.execPath, "-e", script], {
      cwd: fixture.project,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(target, "utf8"), "module.exports = 'transitive';\n");
    assert.equal(existsSync(join(fixture.project, "node_modules", "missing-optional")), false);
    assert.equal(await readFile(join(fixture.project, "product.txt"), "utf8"), "changed");
  } finally {
    await rm(fixture.project, { recursive: true, force: true });
  }
});
