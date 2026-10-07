import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { finishStartedSpawn, resumeHttpSkillSpawn, startSkillSpawn, waitStartedSpawn } from "../dist/spawn.js";
import { initProject, withEngine, withFakeAdapter } from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../skills");

test("proposal-only planning jobs force a jail and grant writes only to their own run cache", async () => {
  await withFakeAdapter(async () => {
    for (const skillId of ["interview", "discuss", "spec", "plan"]) {
      await withEngine(async ({ dir, engine, store }) => {
        await initProject(engine);
        const canonical = ".legion-cli/wiki/product/protected.md";
        await mkdir(join(dir, ".legion-cli/wiki/product"), { recursive: true });
        await writeFile(join(dir, canonical), "saved human context\n");
        await mkdir(join(dir, "cmd"), { recursive: true });
        await writeFile(join(dir, "cmd/tool.go"), "func rollback() error { return nil }\n");
        await writeFile(join(dir, "cmd/credentials.json"), "credential must stay out of the jail\n");
        const config = await store.readConfig();
        const started = await startSkillSpawn({
          projectRoot: dir, config: { ...config, sandbox: { ...config.sandbox, skills: [] } },
          skillId, specId: "spec-demo", proposalOnly: true, planningReadRoots: ["cmd/tool.go", "missing-custom-input"], skillsDir, store,
          promptBody: "Produce a proposal only in this run cache.",
          fakeArtifacts: [
            { path: ".legion-cli/cache/runs/<id>/proposal.json", content: '{"proposal":"needs human review"}\n' },
            { path: canonical, content: "forged canonical context\n" },
            { path: ".legion-cli/tasks/TSK-999.md", content: "unauthorized task\n" },
            { path: ".legion-cli/cache/runs/other-run/proposal.json", content: "forged other proposal\n" },
          ],
        });
        assert.equal(started.spawned, true);
        assert.ok(started.sandbox, `${skillId} proposal requires a jail without sandbox.skills opt-in`);
        const policy = JSON.parse(await readFile(join(dir, `.legion-cli/cache/runs/${started.runId}/sandbox.json`), "utf8"));
        assert.deepEqual(policy.allowedWrites, [`.legion-cli/cache/runs/${started.runId}`]);
        assert.equal(await readFile(join(started.sandbox.jailRoot, "cmd/tool.go"), "utf8"), "func rollback() error { return nil }\n");
        await assert.rejects(readFile(join(started.sandbox.jailRoot, "cmd/credentials.json")), { code: "ENOENT" });
        assert.match(await readFile(join(dir, `.legion-cli/cache/runs/${started.runId}/prompt.md`), "utf8"), /missing-custom-input.*no readable/);
        const waited = await waitStartedSpawn(started);
        assert.equal(waited.error, undefined);
        // Even before copy-out/revert, adapter execution cannot mutate the authoritative checkout.
        assert.equal(await readFile(join(dir, canonical), "utf8"), "saved human context\n");
        const result = await finishStartedSpawn(started);
        assert.equal(await readFile(join(dir, canonical), "utf8"), "saved human context\n");
        assert.equal(await readFile(join(dir, `.legion-cli/cache/runs/${started.runId}/proposal.json`), "utf8"), '{"proposal":"needs human review"}\n');
        await assert.rejects(readFile(join(dir, ".legion-cli/tasks/TSK-999.md")), { code: "ENOENT" });
        await assert.rejects(readFile(join(dir, ".legion-cli/cache/runs/other-run/proposal.json")), { code: "ENOENT" });
        assert.ok(result.sandboxDropped.includes(canonical));
      });
    }
  });
});

test("proposal-only capability refuses additional write contracts and execution/resume jobs", async () => {
  for (const extra of [
    { extraAllowedRoots: ["src/**"] },
    { fileContract: { filesAllowed: ["src/main.ts"] } },
    { governed: {} },
    { skillId: "execute" },
  ]) {
    await assert.rejects(startSkillSpawn({ skillId: "interview", proposalOnly: true, ...extra }), /only their own run-cache/);
  }
  await assert.rejects(resumeHttpSkillSpawn({ proposalOnly: true }), /do not use execute resume/);
});

test("ordinary interview spawns retain existing optional-jail behavior", async () => {
  await withFakeAdapter(() => withEngine(async ({ dir, engine, store }) => {
    await initProject(engine);
    const config = await store.readConfig();
    const started = await startSkillSpawn({
      projectRoot: dir, config: { ...config, sandbox: { ...config.sandbox, skills: [] } },
      skillId: "interview", skillsDir, store, promptBody: "Ordinary interview.",
      fakeArtifacts: [{ path: ".legion-cli/wiki/product/ordinary.md", content: "ordinary interview result\n" }],
    });
    assert.equal(started.spawned, true);
    assert.equal(started.sandbox, undefined);
    const waited = await waitStartedSpawn(started);
    assert.equal(waited.error, undefined);
    await finishStartedSpawn(started);
    assert.equal(await readFile(join(dir, ".legion-cli/wiki/product/ordinary.md"), "utf8"), "ordinary interview result\n");
  }));
});

test("challenge jail reads use the same explicit policy boundary as citation and fingerprint helpers", async () => {
  await withFakeAdapter(async () => {
    for (const planningPolicy2 of [false, true]) {
      await withEngine(async ({ dir, engine, store }) => {
        await initProject(engine);
        await writeFile(join(dir, "pyproject.toml"), "[project]\n");
        await mkdir(join(dir, "cmd"));
        await writeFile(join(dir, "cmd/tool.go"), "func rollback() {}\n");
        const started = await startSkillSpawn({
          projectRoot: dir, config: await store.readConfig(), skillId: "spec-challenge",
          planningPolicy2, planningReadRoots: ["cmd/tool.go"], skillsDir, store,
          promptBody: "One bounded challenge.",
          fakeArtifacts: [{ path: ".legion-cli/cache/runs/<id>/analysis.json", content: '{"concerns":[]}\n' }],
        });
        assert.equal(started.spawned, true);
        assert.ok(started.sandbox);
        for (const path of ["pyproject.toml", "cmd/tool.go"]) {
          if (planningPolicy2) assert.ok((await readFile(join(started.sandbox.jailRoot, path), "utf8")).length);
          else await assert.rejects(readFile(join(started.sandbox.jailRoot, path)), { code: "ENOENT" });
        }
        await waitStartedSpawn(started);
        await finishStartedSpawn(started);
      });
    }
  });
});
