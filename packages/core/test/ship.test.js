import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";

import { SymlinkRefusedError, appendAuditEvent, inspectGovernanceTrace, readDeliverySnapshot } from "@9thlevelsoftware/legion-cli-persist";
import { stableHash } from "@9thlevelsoftware/legion-cli-http";
import { LegionRefuseError } from "../dist/index.js";
import { appendFile } from "node:fs/promises";
import {
  git,
  gitHead,
  initGitRepo,
  initProject,
  makeQaScore,
  passingVerificationCommand,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
  writeQaFile,
} from "./helpers.js";

async function seedReadyToShip(store, extra = {}) {
  const seeded = await seedPlanReady(store, {
    phase: extra.phase ?? "ready_to_ship",
    lastReview: "PASS",
    lastQaId: extra.lastQaId ?? "qa-1",
    task: { status: "done", ...(extra.task ?? {}) },
    extraTasks: extra.extraTasks,
  });
  await writeQaFile(store, extra.score ?? makeQaScore());
  return seeded;
}

test("ship receipt records QA mode/score and writes events.jsonl", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    const taskBefore = await store.readTask("TSK-0001");
    const receipt = await engine.ship();
    assert.equal(receipt.phase, "shipped");
    assert.equal(receipt.qaMode, "full");
    assert.equal(receipt.qaScore, 100);
    assert.equal(receipt.qaPass, true);
    assert.equal((await engine.getState()).phase, "shipped");
    const receiptMd = await readFile(join(store.paths.auditDir, "ship-spec-checkin.md"), "utf8");
    assert.match(receiptMd, /qa\.mode: full/);
    assert.match(receiptMd, /qa\.total: 100/);
    const jsonl = await readFile(join(store.paths.auditDir, "events.jsonl"), "utf8");
    assert.match(jsonl, /"type":"ship"/);
    assert.match(jsonl, /"qaMode":"full"/);
    const taskAfter = await store.readTask("TSK-0001");
    assert.equal(taskAfter.body, taskBefore.body);
    assert.deepEqual(taskAfter.data, taskBefore.data);
  });
});

test("bundle capture finalizes immutable delivery facts and exports historical product", async (t) => {
  await withEngine(async ({ engine, store, dir }) => {
    const bundleRoot = await mkdtemp(join(tmpdir(), "legion-ship-bundle-"));
    t.after(() => rm(bundleRoot, { recursive: true, force: true }));
    await initProject(engine);
    const source = join(dir, "ship-source.txt");
    await writeFile(source, "captured bytes\n", "utf8");
    await seedReadyToShip(store);
    const bundle = join(bundleRoot, "first-bundle");
    const receipt = await engine.ship({ bundleDirectory: bundle, confirm: async () => true });
    assert.ok(receipt.snapshotId);
    assert.equal(receipt.bundle.status, "exported", JSON.stringify(receipt.bundle));
    const manifestSha256 = createHash("sha256").update(await readFile(join(bundle, "manifest.json"))).digest("hex");
    assert.deepEqual(Object.keys(receipt.bundle).sort(), ["manifestSha256", "path", "snapshotDigest", "status"]);
    assert.equal(receipt.bundle.path, bundle);
    assert.equal(receipt.bundle.manifestSha256, manifestSha256);
    const snapshot = await readDeliverySnapshot(store, receipt.snapshotId);
    assert.equal(snapshot.state, "complete");
    const frozen = JSON.parse(await readFile(join(bundle, "product.json"), "utf8"));
    await writeFile(source, "changed checkout\n", "utf8");
    const historical = join(bundleRoot, "historical-bundle");
    const exported = await engine.exportDeliverySnapshot(receipt.snapshotId, historical);
    assert.equal(exported.manifestSha256, manifestSha256);
    assert.equal(exported.predicateSha256, createHash("sha256").update(await readFile(join(historical, "predicate.json"))).digest("hex"));
    assert.deepEqual(JSON.parse(await readFile(join(historical, "product.json"), "utf8")), frozen);
  });
});

test("bundle target failure is reported without failing the completed ship", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    const target = join(dir, "occupied");
    await mkdir(target, { recursive: true });
    const receipt = await engine.ship({ bundleDirectory: target, confirm: async () => true });
    assert.equal(receipt.phase, "shipped");
    assert.equal(receipt.bundle.status, "failed");
    assert.deepEqual(Object.keys(receipt.bundle).sort(), ["path", "reason", "recoveryHint", "status"]);
    assert.equal(receipt.bundle.path, target);
    assert.match(receipt.bundle.reason, /already exists/);
    assert.equal(receipt.bundle.recoveryHint, `legion-cli ship export --snapshot ${receipt.snapshotId} --out ${target}.recovery`);
    assert.equal((await readDeliverySnapshot(store, receipt.snapshotId)).state, "complete");
  });
});
test("shipment success reports an unresolved delivery snapshot without treating it as exportable", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const delivered = true;\n", "utf8");
    initGitRepo(dir);
    await seedReadyToShip(store);
    let pullRequests = 0;
    const target = join(dir, "recovery-bundle");
    const receipt = await engine.ship({
      commit: true,
      pr: true,
      bundleDirectory: target,
      confirm: async () => true,
      prCreate: async ({ cwd }) => {
        pullRequests++;
        const snapshotDirs = await readdir(join(cwd, ".legion-cli", "audit", "delivery"));
        assert.equal(snapshotDirs.length, 1);
        await writeFile(join(cwd, ".legion-cli", "audit", "delivery", snapshotDirs[0], "outcome.yaml"), "not-json\n");
        return { url: "https://github.com/fixture/repo/pull/1" };
      },
    });
    assert.equal(receipt.phase, "shipped");
    assert.equal(pullRequests, 1);
    assert.equal(receipt.deliverySnapshot?.status, "pending");
    assert.match(receipt.deliverySnapshot?.recoveryHint ?? "", /Do not rerun shipment/);
    assert.equal(receipt.bundle?.status, "failed");
    assert.equal(receipt.bundle.path, target);
    assert.equal(receipt.bundle.reason, receipt.deliverySnapshot.error);
    assert.equal((await engine.getState()).phase, "shipped");
    await assert.rejects(() => engine.exportDeliverySnapshot(receipt.snapshotId, target));
  });
});


test("adopted ship refuses when core confirmation callback is missing", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine, { workflowProfile: "focused" });
    await seedReadyToShip(store);
    await writeFile(join(dir, ".legion-cli", "plans", "spec-checkin.md"), "# Reviewed plan\n\nImplement the approved task.\n", "utf8");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const value = 1;\n", "utf8");
    const draft = join(dir, "assurance-draft.yaml");
    await writeFile(draft, stringify({
      schemaVersion: "legion-cli-assurance-plan/v1",
      specId: "spec-checkin",
      acceptanceIds: ["AC-01"],
      taskIds: ["TSK-0001"],
      security: {
        mode: "adapter-default",
        sources: [{ id: "main", path: "src/main.ts", classification: "workspace" }],
        sinks: [],
        transformations: [],
        tasks: [{ taskId: "TSK-0001", readPaths: ["src/main.ts"], transformationIds: [] }],
        externalCalls: [],
      },
      knowledge: [],
      validators: [],
      delivery: { artifacts: [] },
    }));
    await engine.approvePlan();
    await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    await assert.rejects(() => engine.ship(), /delivery capture requires an explicit confirmation callback/);
  });
});

test("ship stages filesAllowed union plus .legion-cli and leaves unrelated files", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    await writeFile(join(dir, "unrelated.ts"), "leave me\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "src", "main.ts"), "export const ok = false;\n", "utf8");
    await writeFile(join(dir, "unrelated.ts"), "changed\n", "utf8");
    await writeQaFile(store, makeQaScore());

    const receipt = await engine.ship({
      confirm: async (preview) => {
        assert.equal(preview.unrelatedUnchanged, false);
        assert.ok(preview.unrelated.includes("unrelated.ts"));
        assert.match(preview.stagedDisplay, /src\//);
        assert.match(preview.stagedDisplay, /\.legion-cli\//);
        return true;
      },
    });
    assert.equal(receipt.phase, "shipped");
    const staged = git(dir, ["diff", "--cached", "--name-only"]);
    assert.match(staged, /src\/main\.ts/);
    assert.doesNotMatch(staged, /unrelated\.ts/);
    const status = git(dir, ["status", "--porcelain", "unrelated.ts"]);
    assert.match(status, /unrelated\.ts/);
  });
});

test("delivery snapshot captures every staged product entry and verifies the resulting commit tree", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "before\n", "utf8");
    await writeFile(join(dir, "unrelated.txt"), "before unrelated\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "src", "main.ts"), "shipped\n", "utf8");
    await writeFile(join(dir, "unrelated.txt"), "staged too\n", "utf8");
    git(dir, ["add", "unrelated.txt"]);
    await seedReadyToShip(store);
    const receipt = await engine.ship({
      commit: true,
      bundleDirectory: join(dir, "verified-bundle"),
      confirm: async () => true,
    });
    const snapshot = await readDeliverySnapshot(store, receipt.snapshotId);
    assert.equal(snapshot.state, "complete");
    assert.equal(snapshot.outcome.commit.status, "verified");
    assert.deepEqual(snapshot.prepared.product.entries.map((entry) => entry.path), [".gitignore", "src/main.ts", "unrelated.txt"]);
  });
});

test("delivery predicate tokenizes configured profile and model names without publishing them", async (t) => {
  await withEngine(async ({ engine, store }) => {
    const bundleRoot = await mkdtemp(join(tmpdir(), "legion-ship-tokens-"));
    t.after(() => rm(bundleRoot, { recursive: true, force: true }));
    await initProject(engine);
    const config = await store.readConfig();
    await store.writeConfig({
      ...config,
      adapter: {
        ...config.adapter,
        http: { baseUrl: "https://models.example.test/v1", model: "private-model-name", apiKeyEnv: "TOKEN_TEST_KEY", allowLoopback: false },
        profiles: { "zeta-private": { adapter: config.adapter.default, modelArgs: [] }, "alpha-private": { adapter: config.adapter.default, modelArgs: [] } },
      },
    });
    await seedReadyToShip(store);
    const bundle = join(bundleRoot, "bundle");
    const receipt = await engine.ship({ bundleDirectory: bundle, confirm: async () => true });
    assert.equal(receipt.bundle.status, "exported", JSON.stringify(receipt.bundle));
    const snapshot = await readDeliverySnapshot(store, receipt.snapshotId);
    const mapping = snapshot.prepared.tokenMapping;
    const profileTokens = mapping.filter((entry) => entry.kind === "profile");
    const modelTokens = mapping.filter((entry) => entry.kind === "model");
    assert.deepEqual(profileTokens.map((entry) => entry.localId), ["alpha-private", "zeta-private"]);
    assert.deepEqual(modelTokens.map((entry) => entry.localId), ["http:private-model-name"]);
    const predicateText = await readFile(join(bundle, "predicate.json"), "utf8");
    const predicate = JSON.parse(predicateText);
    assert.deepEqual(
      predicate.identities.filter((identity) => identity.kind === "profile" || identity.kind === "model"),
      [...profileTokens, ...modelTokens].map((entry) => ({ token: entry.token, kind: entry.kind, digest: null })),
    );
    for (const name of ["alpha-private", "zeta-private", "private-model-name"]) {
      assert.equal(predicateText.includes(name), false, `${name} leaked into predicate.json`);
    }
  });
});

test("ship --commit creates a commit after confirm", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    const before = initGitRepo(dir);
    await writeFile(join(dir, "src", "main.ts"), "export const shipped = true;\n", "utf8");
    await writeQaFile(store, makeQaScore());
    const receipt = await engine.ship({ commit: true });
    assert.equal(receipt.committed, true);
    assert.ok(receipt.commitSha);
    assert.notEqual(gitHead(dir), before);
    assert.equal(git(dir, ["rev-list", "--count", "HEAD", `^${before}`]), "1");
    const msg = git(dir, ["log", "-1", "--pretty=%s"]);
    assert.match(msg, /legion-cli ship: spec-checkin/);
    assert.match(git(dir, ["show", "HEAD:.legion-cli/STATE.md"]), /phase: shipped/);
    assert.match(git(dir, ["show", "HEAD:.legion-cli/audit/ship-spec-checkin.md"]), /committed: true/);
  });
});

test("ship --pr uses gh via the test seam", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    const before = initGitRepo(dir);
    const receipt = await engine.ship({
      pr: true,
      commit: true,
      prCreate: ({ title, body }) => {
        assert.match(title, /spec-checkin/);
        assert.match(body, /QA mode: full/);
        assert.match(readFileSync(store.paths.stateMd, "utf8"), /phase: shipped/);
        return { url: "https://example.test/pr/1" };
      },
    });
    assert.equal(receipt.prUrl, "https://example.test/pr/1");
    assert.equal((await engine.getState()).phase, "shipped");
    assert.equal(git(dir, ["rev-list", "--count", "HEAD", `^${before}`]), "1");
    assert.match(git(dir, ["show", "HEAD:.legion-cli/STATE.md"]), /phase: shipped/);
  });
});

test("ship cancel unstages and does not rewrite task bodies", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "src", "main.ts"), "export const dirty = true;\n", "utf8");
    await writeQaFile(store, makeQaScore());
    const taskBefore = await store.readTask("TSK-0001");
    await assert.rejects(
      () => engine.ship({ confirm: async () => false }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /cancelled/);
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "ready_to_ship");
    const staged = git(dir, ["diff", "--cached", "--name-only"]);
    assert.equal(staged.trim(), "");
    const taskAfter = await store.readTask("TSK-0001");
    assert.equal(taskAfter.body, taskBefore.body);
  });
});

test("ship --allow-degraded-qa from executing after no-browser QA", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store, {
      phase: "executing",
      score: makeQaScore({
        mode: "no-browser",
        pass: false,
        total: 70,
        buckets: {
          p0: { points: 40, max: 40, failed: 0 },
          p1: { points: 30, max: 30, passRate: 1 },
          p2: { points: 15, max: 15, passRate: 1 },
          visual: { points: 0, max: 15, regressions: 1 },
        },
      }),
    });
    const receipt = await engine.ship({ allowDegradedQa: true });
    assert.equal(receipt.phase, "shipped");
    assert.equal(receipt.qaMode, "no-browser");
    assert.equal(receipt.qaScore, 70);
    assert.equal(receipt.qaPass, false);
    assert.equal(receipt.allowDegradedQa, true);
  });
});

test("ship --allow-degraded-qa refuses missing last QA", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, {
      phase: "executing",
      lastReview: "PASS",
      lastQaId: null,
      task: { status: "done" },
    });
    await assert.rejects(
      () => engine.ship({ allowDegradedQa: true }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /no-browser QA score/);
        assert.match(err.nextHint, /legion-cli qa/);
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("ship --allow-degraded-qa refuses failed full QA including visual regressions", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store, {
      phase: "executing",
      score: makeQaScore({
        mode: "full",
        pass: false,
        total: 85,
        reportFailures: 1,
        buckets: {
          p0: { points: 40, max: 40, failed: 0 },
          p1: { points: 30, max: 30, passRate: 1 },
          p2: { points: 15, max: 15, passRate: 1 },
          visual: { points: 0, max: 15, regressions: 1 },
        },
      }),
    });
    await assert.rejects(
      () => engine.ship({ allowDegradedQa: true }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /no-browser/);
        assert.match(err.nextHint, /legion-cli qa/);
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "executing");
  });
});

test("ship --allow-degraded-qa refuses missing P0 criterion evidence", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store, {
      phase: "executing",
      score: makeQaScore({
        mode: "no-browser",
        criteria: [{ id: "AC-01", priority: "P0", outcome: "missing" }],
        missingCriterionIds: ["AC-01"],
        buckets: {
          p0: { points: 0, max: 40, failed: 1 },
          p1: { points: 30, max: 30, passRate: 1 },
          p2: { points: 15, max: 15, passRate: 1 },
          visual: { points: 0, max: 15, regressions: 1 },
        },
        total: 45,
        pass: false,
      }),
    });
    await assert.rejects(
      () => engine.ship({ allowDegradedQa: true }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /every P0 criterion/);
        return true;
      },
    );
  });
});

test("ship --allow-degraded-qa refuses genuine report failures", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store, {
      phase: "executing",
      score: makeQaScore({
        mode: "no-browser",
        total: 70,
        pass: false,
        reportFailures: 1,
        buckets: {
          p0: { points: 40, max: 40, failed: 0 },
          p1: { points: 30, max: 30, passRate: 1 },
          p2: { points: 15, max: 15, passRate: 1 },
          visual: { points: 0, max: 15, regressions: 1 },
        },
      }),
    });
    await assert.rejects(
      () => engine.ship({ allowDegradedQa: true }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /failed test reports/);
        return true;
      },
    );
  });
});

test("ship rejects a persisted score whose P0 outcome contradicts its buckets", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store, {
      score: makeQaScore({
        criteria: [{ id: "AC-01", priority: "P0", outcome: "missing" }],
        missingCriterionIds: ["AC-01"],
      }),
    });
    await assert.rejects(
      () => engine.ship(),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /QA must PASS/);
        return true;
      },
    );
  });
});

test("ship rejects a persisted score that omits active SPEC criteria", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store, { score: makeQaScore({ criteria: [] }) });
    await assert.rejects(
      () => engine.ship(),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /QA must PASS/);
        return true;
      },
    );
  });
});

test("ship rejects forged passing scores when command receipts record failure or timeout", async () => {
  for (const capture of [
    { started: true, status: 1, timedOut: false },
    { started: true, status: null, timedOut: true },
  ]) {
    await withEngine(async ({ engine, store }) => {
      await initProject(engine);
      await seedReadyToShip(store);
      await writeFile(
        join(store.paths.qaDir, "runs", "qa-1", "unit.meta.json"),
        `${JSON.stringify({ version: 1, kind: "unit", capture }, null, 2)}\n`,
        "utf8",
      );
      await assert.rejects(
        () => engine.ship(),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /QA must PASS/);
          return true;
        },
      );
    });
  }
});

test("ship stages deletions of tracked filesAllowed paths", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    initGitRepo(dir);
    await rm(join(dir, "src", "main.ts"));
    await writeQaFile(store, makeQaScore());
    const receipt = await engine.ship({
      commit: true,
      confirm: async (preview) => {
        assert.match(preview.diff, /src\/main\.ts/);
        assert.match(preview.diff, /deleted file/);
        return true;
      },
    });
    assert.equal(receipt.phase, "shipped");
    const tree = git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]);
    assert.equal(
      tree.split(/\r?\n/).includes("src/main.ts"),
      false,
      `expected deletion committed, tree=${tree}`,
    );
  });
});

test("ship skips a never-created filesAllowed path", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store, {
      task: { contract: { filesAllowed: ["src/main.ts", "src/ghost.ts"], expectedArtifacts: ["src/main.ts"] } },
    });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    initGitRepo(dir);
    await writeQaFile(store, makeQaScore());
    const receipt = await engine.ship();
    assert.equal(receipt.phase, "shipped");
    const staged = git(dir, ["diff", "--cached", "--name-only"]);
    assert.doesNotMatch(staged, /ghost\.ts/);
  });
});

test("ship --pr failure stays ready_to_ship", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    const before = initGitRepo(dir);
    await assert.rejects(
      () =>
        engine.ship({
          pr: true,
          commit: true,
          prCreate: () => ({ error: "gh failed" }),
        }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /gh failed/);
        assert.match(err.nextHint, /legion-cli ship --pr --commit/);
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "ready_to_ship");
    assert.equal(gitHead(dir), before);
  });
});

test("failed PR aborts the prepared immutable delivery snapshot", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    initGitRepo(dir);
    await assert.rejects(() => engine.ship({
      pr: true,
      commit: true,
      bundleDirectory: join(dir, "never-exported"),
      confirm: async () => true,
      prCreate: () => ({ error: "gh failed" }),
    }), /gh failed/);
    const snapshots = await readdir(join(store.paths.auditDir, "delivery"));
    assert.equal(snapshots.length, 1);
    const prepared = JSON.parse(await readFile(join(store.paths.auditDir, "delivery", snapshots[0], "prepared.json"), "utf8"));
    const snapshot = await readDeliverySnapshot(store, prepared.prepared.confirmationId);
    assert.equal(snapshot.state, "aborted");
    assert.equal(snapshot.reason, "pr-failed");
  });
});

test("adopted PR failure aborts the snapshot through a traced ship-rollback and blocks export", async () => {
  await withFakeAdapter(() => withEngine(async ({ engine, store, dir }) => {
    await initProject(engine, { workflowProfile: "focused" });
    await seedPlanReady(store);
    await writeFile(join(dir, ".legion-cli", "plans", "spec-checkin.md"), "# Reviewed plan\n\nImplement the approved task.\n", "utf8");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const value = 1;\n", "utf8");
    const task = await store.readTask("TSK-0001");
    await store.writeTask({
      ...task.data,
      contract: { ...task.data.contract, verificationCommands: [passingVerificationCommand()] },
    }, task.body);
    initGitRepo(dir);
    const config = await store.readConfig();
    await store.writeConfig({
      ...config,
      workflow: { ...(config.workflow ?? {}), verificationCommands: [passingVerificationCommand()] },
    });
    const draft = join(dir, "assurance-draft.yaml");
    await writeFile(draft, stringify({
      schemaVersion: "legion-cli-assurance-plan/v1",
      specId: "spec-checkin",
      acceptanceIds: ["AC-01"],
      taskIds: ["TSK-0001"],
      security: {
        mode: "adapter-default",
        sources: [{ id: "main", path: "src/main.ts", classification: "workspace" }],
        sinks: [],
        transformations: [],
        tasks: [{ taskId: "TSK-0001", readPaths: ["src/main.ts"], transformationIds: [] }],
        externalCalls: [],
      },
      knowledge: [],
      validators: [],
      delivery: { artifacts: [] },
    }));
    const approved = await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const executed = await engine.executeWorkflow();
    assert.match(executed.blocker ?? "", /acceptance evidence pending/);
    await engine.recordAcceptance([{ id: "AC-01", status: "passed" }], { id: "owner" });

    await assert.rejects(() => engine.ship({
      commit: true,
      pr: true,
      confirm: async () => true,
      prCreate: () => ({ error: "pr failure" }),
    }), /gh pr create failed: pr failure/);

    const snapshots = await readdir(join(store.paths.auditDir, "delivery"));
    assert.equal(snapshots.length, 1);
    const prepared = JSON.parse(await readFile(join(store.paths.auditDir, "delivery", snapshots[0], "prepared.json"), "utf8"));
    const snapshotId = prepared.prepared.confirmationId;
    const snapshot = await readDeliverySnapshot(store, snapshotId);
    assert.equal(snapshot.state, "aborted");
    assert.equal(snapshot.reason, "pr-failed");

    const finalConfig = await store.readConfig();
    const modelDigest = stableHash({
      adapter: finalConfig.adapter ?? null,
      profiles: finalConfig.adapter.profiles ?? null,
      skillProfiles: finalConfig.adapter.skillProfiles ?? null,
    });
    const inspected = await inspectGovernanceTrace(store, approved.approvalId, modelDigest);
    assert.deepEqual(inspected.violations, []);
    assert.equal(inspected.trace.status, "valid");
    const confirm = inspected.trace.frames.find((frame) => frame.boundary === "end" && frame.action === "ship-confirm");
    assert.equal(confirm.outcome, "success");
    assert.equal(confirm.before.ship.confirmed, false);
    assert.equal(confirm.after.ship.confirmed, true);
    const rollback = inspected.trace.frames.at(-1);
    assert.deepEqual([rollback.boundary, rollback.action, rollback.outcome], ["end", "ship-rollback", "success"]);
    assert.notEqual(rollback.after.phase, "shipped");
    assert.equal(rollback.after.ship.status, "aborted");

    const target = join(dir, "aborted-bundle");
    await assert.rejects(() => engine.exportDeliverySnapshot(snapshotId, target));
    assert.equal(existsSync(target), false);
  }, {
    fakeArtifacts: [
      { path: "src/main.ts", content: "export const value = 2;\n" },
      { path: ".legion-cli/cache/runs/<id>/review.md", content: "# Review\n\nVerdict: PASS\n" },
    ],
  }));
});

test("ship --pr without --commit is refused", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    initGitRepo(dir);
    await assert.rejects(
      () => engine.ship({ pr: true, prCreate: () => ({ url: "https://example.test/pr/1" }) }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /--pr requires --commit/);
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "ready_to_ship");
  });
});

test("abandon writes audit event and message", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
    await engine.abandon("scope changed");
    assert.equal((await engine.getState()).phase, "abandoned");
    const jsonl = await readFile(join(store.paths.auditDir, "events.jsonl"), "utf8");
    assert.match(jsonl, /"type":"abandon"/);
    assert.match(jsonl, /scope changed/);
    const md = await readFile(join(store.paths.auditDir, "abandon-spec-checkin.md"), "utf8");
    assert.match(md, /scope changed/);
  });
});

test("abandon refuses to write its receipt through a junctioned .legion-cli/audit (KD-8 ancestor walk)", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedPlanReady(store, { phase: "executing", lastReview: "PASS", task: { status: "done" } });
    const outside = await mkdtemp(join(tmpdir(), "legion-abandon-outside-"));
    try {
      await rm(store.paths.auditDir, { recursive: true, force: true });
      await symlink(outside, store.paths.auditDir, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(() => engine.abandon("scope changed"), SymlinkRefusedError);
      assert.deepEqual(
        (await readdir(outside)).filter((name) => name.startsWith("abandon-")),
        [],
      );
      assert.equal((await engine.getState()).phase, "executing");
    } finally {
      await rm(store.paths.auditDir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("ship refuses a staged file modified between preview and commit", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "src", "main.ts"), "export const shipped = true;\n", "utf8");
    await writeQaFile(store, makeQaScore());
    await assert.rejects(
      () =>
        engine.ship({
          commit: true,
          confirm: async () => {
            await writeFile(join(dir, "src", "main.ts"), "export const tampered = true;\n", "utf8");
            git(dir, ["add", "--", "src/main.ts"]);
            return true;
          },
        }),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /changed between preview and commit/, "toctou");
        return true;
      },
    );
    assert.equal((await engine.getState()).phase, "ready_to_ship");
  });
});

test("ship does not refuse when only .legion-cli/STATE.md changes between preview and commit", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    initGitRepo(dir);
    await writeFile(join(dir, "src", "main.ts"), "export const shipped = true;\n", "utf8");
    await writeQaFile(store, makeQaScore());
    const receipt = await engine.ship({
      commit: true,
      confirm: async () => {
        const statePath = join(dir, ".legion-cli", "STATE.md");
        await writeFile(statePath, `${await readFile(statePath, "utf8")}\n`, "utf8");
        git(dir, ["add", "--", ".legion-cli/STATE.md"]);
        return true;
      },
    });
    assert.equal(receipt.committed, true);
  });
});

test("ship preview and confirm complete when the index listing exceeds 1 MiB", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "export const ok = true;\n", "utf8");
    // Long names keep the file count (and runtime) low while the index listing passes 1 MiB.
    const pad = "p".repeat(75);
    for (let d = 0; d < 40; d++) {
      const sub = join(dir, "bulk", `dir-${d}`);
      await mkdir(sub, { recursive: true });
      for (let i = 0; i < 200; i++) await writeFile(join(sub, `${pad}-${i}.txt`), "");
    }
    initGitRepo(dir);
    const listing = spawnSync("git", ["ls-files", "-s", "-z", "--cached", "--full-name"], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.ok(listing.stdout.length > 1024 * 1024, "index listing must exceed the default 1 MiB buffer");
    await writeFile(join(dir, "src", "main.ts"), "export const shipped = true;\n", "utf8");
    await writeQaFile(store, makeQaScore());
    const receipt = await engine.ship({ commit: true });
    assert.equal(receipt.committed, true);
    assert.equal(receipt.phase, "shipped");
  });
});

test("spec new appends an audit event and does not compact tasks", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    const taskBefore = await store.readTask("TSK-0001");
    await engine.ship();
    await engine.newSpec();
    assert.equal((await engine.getState()).phase, "intent_draft");
    const jsonl = await readFile(join(store.paths.auditDir, "events.jsonl"), "utf8");
    assert.match(jsonl, /"type":"spec_new"/);
    const taskAfter = await store.readTask("TSK-0001");
    assert.equal(taskAfter.data.status, "done");
    assert.equal(taskAfter.body, taskBefore.body);
  });
});

test("ship --pr failure rolls back receipt, audit, phase and staged set consistently", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    const before = initGitRepo(dir);
    await assert.rejects(() =>
      engine.ship({ pr: true, commit: true, prCreate: () => ({ error: "gh failed" }) }),
    );
    assert.equal((await engine.getState()).phase, "ready_to_ship");
    assert.equal(gitHead(dir), before);
    assert.equal(existsSync(join(dir, ".legion-cli", "audit", "ship-spec-checkin.md")), false);
    const events = (await readFile(join(dir, ".legion-cli", "audit", "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const types = events.map((e) => e.type);
    const shipIdx = types.lastIndexOf("ship");
    assert.equal(types[shipIdx + 1], "ship_rolled_back");
    assert.equal(events[shipIdx + 1].phase, "ready_to_ship");
    assert.equal(git(dir, ["diff", "--cached", "--name-only"]).trim(), "");
  });
});

test("ship --pr failure still restores STATE when the receipt cannot be removed", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    initGitRepo(dir);
    const receiptPath = join(dir, ".legion-cli", "audit", "ship-spec-checkin.md");
    await assert.rejects(() =>
      engine.ship({
        pr: true,
        commit: true,
        prCreate: () => {
          // Stand in for a locked file: a non-empty directory that rm(force) cannot remove.
          rmSync(receiptPath, { force: true });
          mkdirSync(receiptPath);
          writeFileSync(join(receiptPath, "held"), "x", "utf8");
          return { error: "gh failed" };
        },
      }),
      /gh pr create failed/,
    );
    assert.equal((await engine.getState()).phase, "ready_to_ship");
    const events = (await readFile(join(dir, ".legion-cli", "audit", "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const rolledBack = events.findLast((e) => e.type === "ship_rolled_back");
    assert.ok(rolledBack?.data?.receiptKept, "the kept receipt is recorded");
  });
});

test("ship --pr failure with no url (no error text) rolls back the same way", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    const before = initGitRepo(dir);
    await assert.rejects(() => engine.ship({ pr: true, commit: true, prCreate: () => ({}) }), /no pull request url/);
    assert.equal((await engine.getState()).phase, "ready_to_ship");
    assert.equal(gitHead(dir), before);
    assert.equal(existsSync(join(dir, ".legion-cli", "audit", "ship-spec-checkin.md")), false);
    assert.equal(git(dir, ["diff", "--cached", "--name-only"]).trim(), "");
  });
});

test("ship --pr failure in a repo with no prior commit keeps the root commit and records it", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    git(dir, ["init"]);
    git(dir, ["config", "user.name", "9thLevelSoftware"]);
    git(dir, ["config", "user.email", "engineering@9thlevelsoftware.com"]);
    await assert.rejects(() => engine.ship({ pr: true, commit: true, prCreate: () => ({ error: "gh failed" }) }));
    const head = gitHead(dir);
    assert.ok(head);
    assert.equal((await engine.getState()).phase, "ready_to_ship");
    const events = (await readFile(join(dir, ".legion-cli", "audit", "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const rolled = events.find((e) => e.type === "ship_rolled_back");
    assert.equal(rolled.data.commitKept, head);
    assert.equal(existsSync(join(dir, ".legion-cli", "audit", "ship-spec-checkin.md")), true);
  });
});

test("ship replays the whole audit chain: a middle-line edit refuses", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    for (let i = 0; i < 4; i++) {
      await appendAuditEvent(dir, {
        ts: `2026-01-01T00:00:0${i}.000Z`,
        type: "note",
        phase: "ready_to_ship",
        actor: "user",
        data: { marker: `line-${i}` },
      });
    }
    const jsonl = join(store.paths.auditDir, "events.jsonl");
    const lines = (await readFile(jsonl, "utf8")).split(/\r?\n/);
    const at = lines.findIndex((line) => line.includes("line-1"));
    assert.ok(at > 0 && at < lines.length - 2, "edited line is in the middle of the log");
    lines[at] = lines[at].replace("line-1", "line-X");
    await writeFile(jsonl, lines.join("\n"), "utf8");
    await assert.rejects(() => engine.ship(), (err) => err instanceof LegionRefuseError && /audit chain/.test(err.message));
    assert.notEqual((await engine.getState()).phase, "shipped");
  });
});

test("ship heals a crash gap in the audit chain (an event line without its chain write) and ships", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    const jsonl = join(store.paths.auditDir, "events.jsonl");
    const event = { schemaVersion: "legion-cli-audit/v1", ts: "2026-01-01T00:00:00.000Z", type: "note", phase: "ready_to_ship", actor: "user", data: {} };
    await appendFile(jsonl, JSON.stringify(event) + String.fromCharCode(10), "utf8");
    const receipt = await engine.ship();
    assert.equal(receipt.phase, "shipped");
  });
});

test("ship and other mutating verbs refuse before changing state when chain.json is corrupt, naming the remedy", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    await writeFile(join(store.paths.auditDir, "chain.json"), "{not json", "utf8");
    await assert.rejects(
      () => engine.ship(),
      (err) => err instanceof LegionRefuseError && /chain\.json/.test(err.message) && /rebaseline-audit/.test(err.message),
    );
    assert.notEqual((await engine.getState()).phase, "shipped");
  });
});

test("a deleted chain.json over a multi-line log refuses ship (no silent re-chain)", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seedReadyToShip(store);
    for (let i = 0; i < 3; i++) {
      await appendAuditEvent(store.projectRoot, { ts: "2026-01-01T00:00:0" + i + ".000Z", type: "note", phase: "ready_to_ship", actor: "user", data: { i } });
    }
    await rm(join(store.paths.auditDir, "chain.json"));
    await assert.rejects(() => engine.ship(), (err) => err instanceof LegionRefuseError && /rebaseline-audit/.test(err.message));
  });
});
