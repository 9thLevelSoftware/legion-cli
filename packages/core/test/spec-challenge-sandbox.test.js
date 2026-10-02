import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { skillContract } from "../dist/index.js";
import { finishStartedSpawn, startSkillSpawn, waitStartedSpawn } from "../dist/spawn.js";
import { initProject, withEngine, withFakeAdapter } from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../skills");

test("challenge is always jailed and copies only its own run output", async () => {
  await withFakeAdapter(() => withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    const context = ".legion-cli/wiki/product/intent.md";
    await mkdir(join(dir, ".legion-cli/wiki/product"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, context), "saved interview\n");
    await writeFile(join(dir, "src/main.ts"), "original source\n");
    for (const secret of ["credentials.json", ".npmrc", "private-key.pem"]) {
      await writeFile(join(dir, "src", secret), "credential must stay outside the challenge jail\n");
    }
    await store.writeYaml(".legion-cli/workflow/spec-challenge/spec-demo.yaml", { human: "saved" });
    const config = await store.readConfig();
    const started = await startSkillSpawn({
      projectRoot: dir, config: { ...config, sandbox: { ...config.sandbox, skills: [] } },
      skillId: "spec-challenge", skillsDir, store, promptBody: "analysis mode",
      fakeArtifacts: [
        { path: ".legion-cli/cache/runs/<id>/analysis.json", content: '{"concerns":[]}\n' },
        { path: "src/main.ts", content: "unauthorized source\n" },
        { path: ".legion-cli/workflow/spec-challenge/spec-demo.yaml", content: "human: forged\n" },
        { path: ".legion-cli/cache/runs/other-run/forged.json", content: "forged\n" },
      ],
    });
    assert.equal(started.spawned, true);
    assert.ok(started.sandbox, "challenge must be jailed without sandbox.skills opt-in");
    assert.equal(await readFile(join(started.sandbox.jailRoot, context), "utf8"), "saved interview\n");
    for (const secret of ["credentials.json", ".npmrc", "private-key.pem"]) {
      await assert.rejects(readFile(join(started.sandbox.jailRoot, "src", secret)), { code: "ENOENT" });
    }
    const waited = await waitStartedSpawn(started);
    assert.equal(waited.error, undefined);
    const result = await finishStartedSpawn(started);
    assert.equal(await readFile(join(dir, "src/main.ts"), "utf8"), "original source\n");
    assert.match(await readFile(join(dir, ".legion-cli/workflow/spec-challenge/spec-demo.yaml"), "utf8"), /saved/);
    assert.equal(await readFile(join(dir, `.legion-cli/cache/runs/${started.runId}/analysis.json`), "utf8"), '{"concerns":[]}\n');
    await assert.rejects(readFile(join(dir, ".legion-cli/cache/runs/other-run/forged.json")), { code: "ENOENT" });
    assert.ok(result.sandboxDropped.includes("src/main.ts"));
    assert.ok(result.sandboxDropped.includes(".legion-cli/workflow/spec-challenge/spec-demo.yaml"));
  }));
});

test("challenge cannot broaden its write contract", async () => {
  assert.deepEqual(skillContract("spec-challenge", { runId: "round-1" }).allowedRoots, [".legion-cli/cache/runs/round-1/**"]);
  await assert.rejects(startSkillSpawn({ skillId: "spec-challenge", extraAllowedRoots: ["src/**"] }), /permits only its run-cache output/);
  await assert.rejects(startSkillSpawn({ skillId: "spec-challenge", fileContract: { filesAllowed: ["src/main.ts"] } }), /permits only its run-cache output/);
});

test("governed wait refuses nonzero exits and aborted calls", async () => {
  for (const result of [{ exitCode: 1 }, { exitCode: null }, { exitCode: 0, aborted: true }]) {
    const waited = await waitStartedSpawn({ started: Date.now(), handle: { wait: async () => result } });
    assert.match(String(waited.error), /spawn (exited|aborted)/);
  }
});
