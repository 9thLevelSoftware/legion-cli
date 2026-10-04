import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { governanceTraceDirectory, readGovernanceTrace } from "@9thlevelsoftware/legion-cli-persist";
import { stableHash } from "@9thlevelsoftware/legion-cli-http";
import { LegionEngine } from "../dist/index.js";
import { initProject, seedPlanReady, withEngine, withFakeAdapter } from "./helpers.js";

const faultChild = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "governance-fault-child.mjs");
const BLOCKED = /adopted governance trace is invalid, incomplete, or records a failed operation/;

function manifest() {
  return {
    schemaVersion: "legion-cli-assurance-plan/v1", specId: "spec-checkin",
    acceptanceIds: ["AC-01"], taskIds: ["TSK-0001"],
    security: {
      mode: "adapter-default", sources: [{ id: "main", path: "src/main.ts", classification: "workspace" }],
      sinks: [], transformations: [], tasks: [{ taskId: "TSK-0001", readPaths: ["src/main.ts"], transformationIds: [] }], externalCalls: [],
    },
    knowledge: [], validators: [], delivery: { artifacts: [] },
  };
}

async function adoptedFixture(fn, options = {}) {
  await withFakeAdapter(() => withEngine(async ({ engine, store, dir }) => {
    await initProject(engine, { workflowProfile: "focused" });
    await seedPlanReady(store);
    await writeFile(join(dir, ".legion-cli/plans/spec-checkin.md"), "# Reviewed plan\n\nImplement the approved task.\n");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/main.ts"), "export const value = 1;\n");
    const draft = join(dir, "assurance-draft.yaml");
    await writeFile(draft, stringify(manifest()));
    // Normalize the seeded contract (default filesForbidden) before approval, so the governed amends
    // below rewrite identical inputs and keep the approval current.
    const seeded = await store.readTask("TSK-0001");
    await engine.amendTask(seeded.data.id, seeded.data.contract);
    const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const config = await store.readConfig();
    const modelDigest = stableHash({
      adapter: config.adapter ?? null,
      profiles: config.adapter.profiles ?? null,
      skillProfiles: config.adapter.skillProfiles ?? null,
    });
    await fn({ engine, store, dir, approved, modelDigest });
  }, options));
}

/** Runs the governed amend in a child that is SIGKILLed at `point`, and proves it died there. */
function killChildAt(dir, point) {
  const child = spawnSync(process.execPath, [faultChild, dir, point], { encoding: "utf8", timeout: 120_000 });
  assert.equal(child.error, undefined, `fault child could not run: ${child.error?.message}`);
  assert.doesNotMatch(child.stdout, /"ok":true/, `fault child survived ${point}: ${child.stderr}`);
  // Windows has no POSIX signals: libuv terminates the process via TerminateProcess with exit code 1.
  if (process.platform === "win32") assert.equal(child.status, 1, child.stderr);
  else assert.equal(child.signal, "SIGKILL", child.stderr);
}

async function readHead(dir, approvalId) {
  return JSON.parse(await readFile(join(dir, governanceTraceDirectory(approvalId), "head.json"), "utf8"));
}

for (const point of ["after-begin-frame", "after-begin-head", "after-mutation"]) {
  test(`kill at ${point} leaves an incomplete epoch that refuses writes until reapproval`, async () => {
    await adoptedFixture(async ({ store, dir, approved, modelDigest }) => {
      const before = await store.readTask("TSK-0001");
      killChildAt(dir, point);

      // The child stopped exactly at the point: the begin frame exists, no end frame does, and the head
      // moved to the open begin only when the kill landed after the begin head write.
      const segment = join(dir, governanceTraceDirectory(approved.approvalId));
      const begin = JSON.parse(await readFile(join(segment, "2.json"), "utf8"));
      assert.deepEqual([begin.boundary, begin.action, begin.outcome], ["begin", "amend-inputs", "pending"]);
      await assert.rejects(() => readFile(join(segment, "3.json")), { code: "ENOENT" });
      const head = await readHead(dir, approved.approvalId);
      assert.deepEqual(
        [head.sequence, head.status],
        point === "after-begin-frame" ? [1, "valid"] : [2, "incomplete"],
      );

      const fresh = new LegionEngine(dir);
      // Begin points never ran the mutation; after-mutation is restored or kept by the store's journal.
      // Either way the amend reapplies the identical contract, so the task is byte-for-byte the pre-image.
      const restored = await store.readTask("TSK-0001");
      assert.deepEqual(restored.data, before.data);
      assert.equal(restored.body, before.body);
      await assert.rejects(() => fresh.amendTask(before.data.id, before.data.contract), BLOCKED);
      const interrupted = await readGovernanceTrace(store, approved.approvalId, modelDigest);
      assert.equal(interrupted.status, "incomplete");
      assert.deepEqual(interrupted.frames.slice(-1).map(({ boundary, action }) => [boundary, action]), [["begin", "amend-inputs"]]);
      assert.equal((await fresh.inspectGovernance()).current.status, "incomplete");
      await assert.rejects(() => fresh.amendTask(before.data.id, before.data.contract), BLOCKED);

      const next = await fresh.approvePlan({ id: "operator" });
      assert.notEqual(next.approvalId, approved.approvalId);
      await fresh.amendTask(before.data.id, before.data.contract);
      assert.equal((await readGovernanceTrace(store, approved.approvalId, modelDigest)).status, "incomplete");
      assert.equal((await readGovernanceTrace(store, next.approvalId, modelDigest)).status, "valid");
      assert.equal((await fresh.inspectGovernance()).current.status, "valid");
    });
  });
}

test("kill at after-end-frame leaves one valid orphan that reconciles beyond the stale head", async () => {
  await adoptedFixture(async ({ store, dir, approved, modelDigest }) => {
    const before = await store.readTask("TSK-0001");
    killChildAt(dir, "after-end-frame");

    const staleHead = await readHead(dir, approved.approvalId);
    assert.deepEqual([staleHead.sequence, staleHead.status], [2, "incomplete"]);
    const orphan = JSON.parse(await readFile(join(dir, governanceTraceDirectory(approved.approvalId), "3.json"), "utf8"));
    assert.deepEqual([orphan.boundary, orphan.action, orphan.outcome], ["end", "amend-inputs", "success"]);

    const fresh = new LegionEngine(dir);
    await fresh.amendTask(before.data.id, before.data.contract);
    const trace = await readGovernanceTrace(store, approved.approvalId, modelDigest);
    assert.equal(trace.status, "valid");
    assert.deepEqual(trace.frames.map(({ boundary, action, outcome }) => [boundary, action, outcome]), [
      ["begin", "approval-adopt", "pending"], ["end", "approval-adopt", "success"],
      ["begin", "amend-inputs", "pending"], ["end", "amend-inputs", "success"],
      ["begin", "amend-inputs", "pending"], ["end", "amend-inputs", "success"],
    ]);
    assert.equal(trace.frames[3].digest, orphan.digest);
    assert.equal(trace.frames[3].correlationId, trace.frames[2].correlationId);
    assert.equal((await readHead(dir, approved.approvalId)).sequence, 5);
  });
});

test("kill at after-end-head leaves a valid epoch", async () => {
  await adoptedFixture(async ({ store, dir, approved, modelDigest }) => {
    const before = await store.readTask("TSK-0001");
    killChildAt(dir, "after-end-head");

    const completed = await readGovernanceTrace(store, approved.approvalId, modelDigest);
    assert.equal(completed.status, "valid");
    assert.deepEqual(completed.frames.slice(-2).map(({ boundary, action, outcome }) => [boundary, action, outcome]), [
      ["begin", "amend-inputs", "pending"], ["end", "amend-inputs", "success"],
    ]);
    const fresh = new LegionEngine(dir);
    assert.equal((await fresh.inspectGovernance()).current.status, "valid");
    await fresh.amendTask(before.data.id, before.data.contract);
    assert.equal((await readGovernanceTrace(store, approved.approvalId, modelDigest)).frames.length, 6);
  });
});

test("an error after the mutation records a failed outcome that blocks later governed mutation", async () => {
  let armed = false;
  await adoptedFixture(async ({ engine, store, approved, modelDigest }) => {
    const task = await store.readTask("TSK-0001");
    armed = true;
    await assert.rejects(() => engine.amendTask(task.data.id, task.data.contract), /injected after-mutation failure/);
    armed = false;
    const trace = await readGovernanceTrace(store, approved.approvalId, modelDigest);
    assert.equal(trace.status, "valid");
    assert.deepEqual([trace.frames.at(-1).boundary, trace.frames.at(-1).action, trace.frames.at(-1).outcome], ["end", "amend-inputs", "failed"]);
    await assert.rejects(() => engine.amendTask(task.data.id, task.data.contract), /failed operation/);
    assert.equal((await engine.inspectGovernance()).current.status, "invalid");
  }, {
    fakeGovernanceFault: async (point) => {
      if (armed && point === "after-mutation") throw new Error("injected after-mutation failure");
    },
  });
});
