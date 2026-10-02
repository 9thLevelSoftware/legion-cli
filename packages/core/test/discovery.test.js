import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { assertDiscoverySelection, prepareDiscovery, recordDiscoverySelection } from "../dist/discovery.js";
import { initProject, withEngine } from "./helpers.js";

test("greenfield discovery does not create an audit", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    assert.equal(await prepareDiscovery(engine), null);
    assert.equal(await engine.store.pathExists(".legion-cli/map/DISCOVERY.md"), false);
  });
});

test("brownfield change records orientation and detects implementation drift without executing scripts", async () => {
  await withEngine(async ({ engine, dir }) => {
    await initProject(engine, { mode: "brownfield", brownfieldGoal: "change" });
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/service.ts"), "export const answer = 1;\n");
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 42" } }));
    const first = await prepareDiscovery(engine);
    assert.equal(first.goal, "change");
    assert.equal(first.sourceFiles, 1);
    assert.deepEqual(first.findings, []);
    assert.match(await readFile(join(dir, first.path), "utf8"), /exit 42/);
    await writeFile(join(dir, "src/service.ts"), "export const answer = 2;\n");
    assert.notEqual((await prepareDiscovery(engine)).sourceFingerprint, first.sourceFingerprint);
    assert.equal(await readFile(join(dir, "src/service.ts"), "utf8"), "export const answer = 2;\n");
  });
});

test("brownfield audit findings carry evidence and leave remediation to the user", async () => {
  await withEngine(async ({ engine, dir }) => {
    await initProject(engine, { mode: "brownfield", brownfieldGoal: "audit" });
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/service.py"), "def answer():\n    return 1\n");
    const result = await prepareDiscovery(engine);
    assert.equal(result.goal, "audit");
    assert.ok(result.findings.length > 0);
    assert.ok(result.findings.every((finding) => finding.evidence.includes("src/service.py")));
    const body = await readFile(join(dir, result.path), "utf8");
    assert.match(body, /Select a bounded remediation increment/);
    assert.match(body, /No checks or remediation were executed/);
    assert.equal((await engine.getState()).phase, "initialized");
    await assert.rejects(() => assertDiscoverySelection(engine), /select a bounded audit/);
    await assert.rejects(() => recordDiscoverySelection(engine, { goal: "Fix everything", affectedArea: "whole repository" }), /bounded affected area/);
    const selected = await recordDiscoverySelection(engine, { goal: "Add a regression test for answer", affectedArea: "src/service.py" });
    await assertDiscoverySelection(engine);
    assert.deepEqual((await prepareDiscovery(engine)).selection, selected);
    await writeFile(join(dir, "src/service.py"), "def answer():\n    return 2\n");
    assert.equal((await prepareDiscovery(engine)).selection, null);
    await assert.rejects(() => assertDiscoverySelection(engine), /select a bounded audit/);
  });
});
