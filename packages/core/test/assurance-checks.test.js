import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stringify } from "yaml";
import { parseExtensionFrontmatter, resolveExtensionDir } from "@9thlevelsoftware/legion-cli-agents";
import { AssuranceApprovalSchema, CheckEvidenceSchema } from "@9thlevelsoftware/legion-cli-schema";
import { inspectAssuranceEvidence, loadAssurance, prepareAssuranceCheck, runAssuranceChecks, writeAssuranceCheck } from "../dist/assurance.js";
import { namespacedOrigin } from "../dist/assurance-flow-labels.js";
import { workflowEnvironmentFingerprint, workflowFingerprint, workflowProductFingerprint, workflowProductPaths } from "../dist/workflow.js";
import { git, initProject, initGitRepo, passingVerificationCommand, seedPlanReady, withEngine, withFakeAdapter } from "./helpers.js";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const nativePresent = existsSync(join(repository, "packages/sandbox/dist/native/manifest.json"));
const nativeOptions = { skip: nativePresent ? false : "requires the packaged native host; root component smoke builds it" };
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-assurance-checks-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("workflow product paths preserve tracked ignored outputs and absent fingerprint scope", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, ".gitignore"), "dist/\n");
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist/tracked.txt"), "tracked output\n");
    initGitRepo(dir);
    git(dir, ["add", "-f", "dist/tracked.txt"]);
    git(dir, ["commit", "-m", "track ignored product output"]);

    const paths = await workflowProductPaths(dir);
    assert.deepEqual(paths, [".gitignore", "dist/tracked.txt"]);
    const baseline = await workflowProductFingerprint(dir, []);
    const expected = [];
    for (const path of paths) {
      const stat = await lstat(join(dir, path));
      const bytes = await readFile(join(dir, path));
      expected.push({
        path,
        kind: "file",
        mode: stat.mode,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    assert.equal(baseline, workflowFingerprint(expected));

    await writeFile(join(dir, "dist/untracked.txt"), "ignored output\n");
    await mkdir(join(dir, ".legion-cli/cache"), { recursive: true });
    await writeFile(join(dir, ".legion-cli/cache/engine.txt"), "engine cache\n");
    assert.deepEqual(await workflowProductPaths(dir), paths);
    assert.equal(await workflowProductFingerprint(dir, []), baseline);
  });
});

const explicitReview = { path: ".legion-cli/cache/runs/<id>/review.md", content: "# Independent review\n\nVerdict: PASS\n" };

async function fixture(fn, configure = {}) {
  const body = () => withEngine(async ({ engine, store, dir }) => {
    await initProject(engine, { workflowProfile: "focused" });
    await seedPlanReady(store, { phase: "executing", task: { status: "done", contract: { filesAllowed: ["src/main.ts"], expectedArtifacts: ["src/main.ts"], verificationCommands: [passingVerificationCommand()] } } });
    await writeFile(join(dir, ".legion-cli/plans/spec-checkin.md"), "# Reviewed plan\n\nPreserve the approved business value.\n");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/main.ts"), "export function approved() { return 42; }\n");
    await writeFile(join(dir, "src/dependency.ts"), "export const limit = 42;\n");
    await writeFile(join(dir, "src/business.json"), '{"answer":42}\n');
    const extension = await resolveExtensionDir({ projectRoot: dir, extensionId: "json-contract" });
    assert.equal(extension.ok, true);
    const parsed = parseExtensionFrontmatter(await readFile(join(extension.extensionDir, "SKILL.md"), "utf8"), "extensions/json-contract/SKILL.md");
    assert.equal(parsed.ok, true);
    const plan = {
      schemaVersion: "legion-cli-assurance-plan/v1", specId: "spec-checkin", acceptanceIds: ["AC-01"], taskIds: ["TSK-0001"],
      security: { mode: "adapter-default", sources: [], sinks: [], transformations: [], tasks: [], externalCalls: [] },
      knowledge: [
        { id: "approved-function", statement: "Return the approved answer", source: { path: "src/main.ts", selector: { kind: "function", qualifiedName: "approved" } }, acceptanceIds: ["AC-01"], taskIds: ["TSK-0001"], dependsOn: ["approved-limit"], checkIds: ["business-answer"] },
        { id: "approved-limit", statement: "Preserve the limit", source: { path: "src/dependency.ts", selector: { kind: "variable", qualifiedName: "limit" } }, acceptanceIds: ["AC-01"], taskIds: [], dependsOn: [], checkIds: [] },
      ],
      validators: [{ id: "business-answer", extensionRef: "extension:json-contract", extensionCheckId: "json-contract", componentSha256: parsed.manifest.runtime.sha256, inputUnitIds: ["approved-function"], inputFiles: ["src/business.json"], acceptanceIds: ["AC-01"], configuration: { assertions: [{ id: "approved-answer", predicate: { file: "src/business.json", pointer: "/answer", op: "eq", expected: 42 } }] } }],
      delivery: { artifacts: [] },
    };
    configure.plan?.(plan);
    await configure.setup?.({ store, dir });
    const draft = join(dir, "assurance-draft.yaml");
    await writeFile(draft, stringify(plan, { aliasDuplicateObjects: false }));
    await engine.approvePlan({ id: "operator" }, { assuranceManifestPath: draft });
    const approval = await store.readYaml(".legion-cli/workflow/assurance-approval.yaml", AssuranceApprovalSchema);
    await fn({ engine, store, dir, plan, approval });
  }, { fakeArtifacts: [explicitReview] });
  await (configure.fakeAdapter === false ? body() : withFakeAdapter(body));
}

async function receipt(store, checkId = "business-answer") {
  return store.readYaml(`.legion-cli/workflow/checks/${checkId}.yaml`, CheckEvidenceSchema);
}

test("complete packets preserve syntax-only comment reuse but invalidate dependency, raw bytes, configuration and epoch changes", nativeOptions, async () => {
  await fixture(async ({ dir, plan, approval }) => {
    const check = plan.validators[0];
    const first = await prepareAssuranceCheck(dir, plan, approval, check);
    assert.deepEqual(first.packet.unitIds, ["approved-function", "approved-limit"]);
    await writeFile(join(dir, "src/unrelated.ts"), "export const unrelated = true;\n");
    await writeFile(join(dir, "src/main.ts"), "// unrelated commentary\nexport function approved() { return 42; }\n");
    const comment = await prepareAssuranceCheck(dir, plan, approval, check);
    assert.equal(comment.reuseKey, first.reuseKey);
    assert.notEqual(comment.inputs.find((input) => input.kind === "unit" && input.unitId === "approved-function").observedFileDigest, first.inputs.find((input) => input.kind === "unit" && input.unitId === "approved-function").observedFileDigest);
    await writeFile(join(dir, "src/dependency.ts"), "export let limit = 42;\n");
    const dependency = await prepareAssuranceCheck(dir, plan, approval, check);
    assert.notEqual(dependency.reuseKey, comment.reuseKey);
    await writeFile(join(dir, "src/business.json"), '{ "answer": 42 }\n');
    const raw = await prepareAssuranceCheck(dir, plan, approval, check);
    assert.notEqual(raw.inputDigest, dependency.inputDigest);
    assert.notEqual(raw.reuseKey, dependency.reuseKey);
    const changedConfiguration = { ...check, configuration: { assertions: [{ id: "approved-answer", predicate: { file: "src/business.json", pointer: "/answer", op: "eq", expected: 43 } }] } };
    assert.notEqual((await prepareAssuranceCheck(dir, plan, approval, changedConfiguration)).reuseKey, raw.reuseKey);
    assert.notEqual((await prepareAssuranceCheck(dir, plan, { ...approval, approvalId: "new-epoch" }, check)).reuseKey, raw.reuseKey);
    assert.notEqual((await prepareAssuranceCheck(dir, plan, { ...approval, nativeHost: { ...approval.nativeHost, settingsDigest: "f".repeat(64) } }, check)).reuseKey, raw.reuseKey);
    if (process.platform !== "win32") {
      await chmod(join(dir, "src/main.ts"), 0o755);
      const mode = await prepareAssuranceCheck(dir, plan, approval, check);
      assert.equal(mode.inputDigest, raw.inputDigest);
      assert.notEqual(mode.reuseKey, raw.reuseKey);
    }
  });
});

test("actual business failures persist and are terminal; changed inputs get a fresh governed check", nativeOptions, async () => {
  await fixture(async ({ engine, store, dir }) => {
    await writeFile(join(dir, "src/business.json"), '{"answer":7}\n');
    const failed = await engine.executeWorkflow();
    assert.equal(failed.status, "blocked");
    const first = await receipt(store);
    assert.equal(first.result, "failed");
    assert.equal(first.extensionCheckId, "json-contract");
    assert.equal(first.output.observations[0].status, "failed");
    const coverage = await engine.getPlanEvidence();
    assert.equal(coverage.criteria[0].status, "failed");
    await assert.rejects(() => engine.recordAcceptance([{ id: "AC-01", status: "passed" }]));
    await assert.rejects(() => engine.ship());
    const again = await engine.executeWorkflow();
    assert.equal(again.status, "blocked");
    assert.equal(again.blocker, "validator business-answer is failed; explicit retry required");
    assert.equal(again.next, "legion-cli execute --retry");
    assert.equal((await receipt(store)).executionId, first.executionId);
  });
  await fixture(async ({ engine, store, dir }) => {
    await engine.executeWorkflow();
    const first = await receipt(store);
    assert.equal(first.result, "passed");
    await writeFile(join(dir, "src/business.json"), '{"answer":7}\n');
    const changed = await engine.executeWorkflow();
    assert.equal(changed.status, "blocked");
    const next = await receipt(store);
    assert.equal(next.result, "failed");
    assert.notEqual(next.executionId, first.executionId);
    assert.notEqual(next.inputDigest, first.inputDigest);
    assert.equal((await engine.getPlanEvidence()).criteria[0].status, "failed");
    await assert.rejects(() => engine.ship());
  });
});

test("safe reuse refers to the original actual execution while aggregate review and manual acceptance become stale", nativeOptions, async () => {
  await fixture(async ({ engine, store, dir }) => {
    await engine.executeWorkflow();
    const original = await receipt(store);
    assert.equal(original.result, "passed");
    assert.equal(original.reusedFrom, null);
    await engine.recordAcceptance([{ id: "AC-01", status: "passed" }]);
    await writeFile(join(dir, "src/unrelated.ts"), "export const untouched = 1;\n");
    const stale = await engine.getWorkflowStatus();
    assert.equal(stale.execution, "stale");
    assert.deepEqual(stale.acceptance.pending, ["AC-01"]);
    await engine.executeWorkflow();
    const firstReuse = await receipt(store);
    assert.equal(firstReuse.reusedFrom, original.executionId);
    assert.notEqual(firstReuse.executionId, original.executionId);
    await engine.executeWorkflow();
    const secondReuse = await receipt(store);
    assert.equal(secondReuse.reusedFrom, original.executionId);
    assert.notEqual(secondReuse.executionId, firstReuse.executionId);
  });
});

test("deleted bindings persist unavailable pre-admission evidence without a pretend guest digest", nativeOptions, async () => {
  await fixture(async ({ engine, store, dir }) => {
    await writeFile(join(dir, "src/main.ts"), "export function renamed() { return 42; }\n");
    await engine.executeWorkflow();
    const unavailable = await receipt(store);
    assert.equal(unavailable.result, "unavailable");
    assert.equal(unavailable.inputDigest, null);
    assert.equal(unavailable.output, null);
    assert.equal(unavailable.reusedFrom, null);
    assert.match(unavailable.reason, /unknown/);
    const evidence = await engine.getPlanEvidence();
    assert.equal(evidence.criteria[0].status, "unknown");
    const impact = await engine.getPlanImpact();
    assert.deepEqual(impact.impacts.find((entry) => entry.path === "src/main.ts").taskIds, ["TSK-0001"]);
    assert.deepEqual(impact.impacts.find((entry) => entry.path === "src/main.ts").checkIds, ["business-answer"]);
  });
});

test("a whole-product mutation around an actual component execution or reuse attachment cannot persist a pass", nativeOptions, async () => {
  await fixture(async ({ store, dir, plan, approval }) => {
    const baseline = await workflowProductFingerprint(dir);
    let observations = 0;
    const raced = await runAssuranceChecks({ store, plan, approval, productFingerprint: baseline, environmentFingerprint: workflowEnvironmentFingerprint(), retry: false, informationFlowPosture: "not-enforced",
      observeProduct: async () => {
        observations++;
        if (observations === 2) await writeFile(join(dir, "src/unrelated.ts"), "export const concurrent = true;\n");
        return workflowProductFingerprint(dir);
      }, persist: (check, aggregate) => writeAssuranceCheck(store, check, aggregate) });
    assert.equal(raced.raced, true);
    assert.equal((await receipt(store)).result, "unavailable");
    assert.notEqual((await receipt(store)).inputDigest, null);
    const current = await workflowProductFingerprint(dir);
    await runAssuranceChecks({ store, plan, approval, productFingerprint: current, environmentFingerprint: workflowEnvironmentFingerprint(), retry: true, informationFlowPosture: "not-enforced", observeProduct: () => workflowProductFingerprint(dir), persist: (check, aggregate) => writeAssuranceCheck(store, check, aggregate) });
    const actual = await receipt(store);
    assert.equal(actual.result, "passed");
    observations = 0;
    const reusedRace = await runAssuranceChecks({ store, plan, approval, productFingerprint: current, environmentFingerprint: workflowEnvironmentFingerprint(), retry: false, informationFlowPosture: "not-enforced",
      observeProduct: async () => {
        observations++;
        if (observations === 2) await writeFile(join(dir, "src/unrelated.ts"), "export const concurrent = false;\n");
        return workflowProductFingerprint(dir);
      }, persist: (check, aggregate) => writeAssuranceCheck(store, check, aggregate) });
    assert.equal(reusedRace.raced, true);
    const invalidated = await receipt(store);
    assert.equal(invalidated.result, "unavailable");
    assert.equal(invalidated.reusedFrom, null);
    assert.match(invalidated.reason, /reuse attachment/);
  });
});

test("information-flow component stages persist a joined observation label outside the reuse key", nativeOptions, async () => {
  await fixture(async ({ engine, store, dir, plan, approval }) => {
    const stage = async (informationFlowPosture) => runAssuranceChecks({
      store, plan, approval, productFingerprint: await workflowProductFingerprint(dir), environmentFingerprint: workflowEnvironmentFingerprint(), retry: false,
      informationFlowPosture, observeProduct: () => workflowProductFingerprint(dir), persist: (check, aggregate) => writeAssuranceCheck(store, check, aggregate),
    });
    const expectedLabel = {
      origins: [
        namespacedOrigin("file", { sourceId: "business", path: "src/business.json" }),
        namespacedOrigin("file", { sourceId: "main", path: "src/main.ts" }),
        namespacedOrigin("file", { sourceId: "unclassified", path: "src/dependency.ts" }),
        namespacedOrigin("file", { sourceId: "unexplained-change", path: "src/dependency.ts" }),
      ].sort(),
      integrity: "untrusted",
      confidentiality: "sealed",
    };
    const pending = await stage("pending");
    assert.equal(pending.blocker, null);
    assert.equal(pending.execution.policyStatus, "blocked");
    const executed = await receipt(store);
    assert.equal(executed.result, "passed");
    assert.equal(executed.reusedFrom, null);
    assert.deepEqual(executed.observationLabel, expectedLabel);

    await writeFile(join(dir, "src/unrelated.ts"), "export const unrelated = true;\n");
    const reusedKey = (await prepareAssuranceCheck(dir, plan, approval, plan.validators[0])).reuseKey;
    assert.equal(reusedKey, executed.reuseKey);
    const enforced = await stage("enforced");
    assert.equal(enforced.blocker, null);
    assert.equal(enforced.execution.policyStatus, "enforced");
    assert.deepEqual(enforced.decisions.map((decision) => decision.decision), ["reuse"]);
    const reused = await receipt(store);
    assert.equal(reused.reusedFrom, executed.executionId);
    assert.equal(reused.reuseKey, executed.reuseKey);
    assert.deepEqual(reused.observationLabel, expectedLabel);

    const evidence = await engine.getPlanEvidence();
    assert.equal(evidence.policyStatus, "blocked");
    assert.equal(evidence.checks[0].decision, "reuse");
    assert.deepEqual(evidence.criteria[0].observations.map((observation) => Object.keys(observation).sort()), [["checkId", "code", "id", "status"]]);

    const { observationLabel: _omitted, ...unlabeled } = reused;
    await store.writeYaml(".legion-cli/workflow/checks/business-answer.yaml", unlabeled);
    const missing = await inspectAssuranceEvidence(store, await loadAssurance(store), ["AC-01"], "enforced");
    assert.equal(missing.checks[0].result, "unavailable");
    assert.equal(missing.checks[0].decision, "execute");
    assert.equal(missing.checks[0].reason, "component receipt lacks its information-flow label");
    assert.equal(missing.criteria[0].status, "unknown");
    assert.equal(missing.policyStatus, "enforced");
  }, {
    fakeAdapter: false,
    plan: (plan) => {
      plan.security = {
        mode: "information-flow",
        sources: [
          { id: "business", path: "src/business.json", classification: "public" },
          { id: "main", path: "src/main.ts", classification: "workspace" },
        ],
        sinks: [], transformations: [], tasks: [{ taskId: "TSK-0001", readPaths: ["src/main.ts"], transformationIds: [] }], externalCalls: [],
      };
    },
    setup: async ({ store }) => {
      const config = await store.readConfig();
      await store.writeConfig({ ...config, adapter: { ...config.adapter, default: "http", http: { baseUrl: "http://127.0.0.1:9/v1", model: "fixture", apiKeyEnv: "LEGION_ASSURANCE_CHECKS_UNUSED_KEY", allowLoopback: true } } });
    },
  });
});

test("explicit retry reruns the first failed component, reuses passed checks and stops on the next failure", nativeOptions, async () => {
  const ids = ["check-one", "check-two", "check-three"];
  await fixture(async ({ engine, store, dir }) => {
    const exists = (checkId) => store.pathExists(`.legion-cli/workflow/checks/${checkId}.yaml`);
    const checkIds = (result) => result.assurance.checks.map((check) => check.checkId);

    const first = await engine.executeWorkflow();
    assert.equal(first.status, "blocked");
    assert.deepEqual(checkIds(first), ["check-one", "check-two"]);
    const one = await receipt(store, "check-one");
    const two = await receipt(store, "check-two");
    assert.equal(one.result, "passed");
    assert.equal(one.reusedFrom, null);
    assert.equal(two.result, "failed");
    assert.equal(await exists("check-three"), false);

    const unchanged = await engine.executeWorkflow();
    assert.equal(unchanged.status, "blocked");
    assert.equal(unchanged.assurance.checks.find((check) => check.checkId === "check-two").decision, "blocked");
    assert.equal((await receipt(store, "check-two")).executionId, two.executionId);
    assert.equal(await exists("check-three"), false);

    const retried = await engine.executeWorkflow({ retry: true });
    assert.equal(retried.status, "blocked");
    assert.deepEqual(checkIds(retried), ["check-one", "check-two"]);
    const retriedOne = retried.assurance.checks.find((check) => check.checkId === "check-one");
    assert.equal(retriedOne.decision, "reuse");
    assert.equal(retriedOne.reusedFrom, one.executionId);
    assert.equal((await receipt(store, "check-one")).reusedFrom, one.executionId);
    const retriedTwo = await receipt(store, "check-two");
    assert.notEqual(retriedTwo.executionId, two.executionId);
    assert.equal(retriedTwo.result, "failed");
    assert.equal(retriedTwo.reusedFrom, null);
    assert.equal(await exists("check-three"), false);

    await writeFile(join(dir, "src/check-two.json"), '{"value":2}\n');
    const fixed = await engine.executeWorkflow();
    assert.deepEqual(checkIds(fixed), ids);
    assert.deepEqual(fixed.assurance.checks.map((check) => [check.checkId, check.decision, check.result]), [
      ["check-one", "reuse", "passed"],
      ["check-two", "execute", "passed"],
      ["check-three", "execute", "passed"],
    ]);
    const fixedTwo = await receipt(store, "check-two");
    assert.notEqual(fixedTwo.executionId, retriedTwo.executionId);
    assert.equal(fixedTwo.reusedFrom, null);
    const three = await receipt(store, "check-three");
    assert.equal(three.result, "passed");
    assert.equal(three.reusedFrom, null);
  }, {
    plan: (plan) => {
      plan.knowledge = [];
      plan.validators = ids.map((id) => ({
        ...plan.validators[0], id, inputUnitIds: [], inputFiles: [`src/${id}.json`],
        configuration: { assertions: [{ id: `${id}-value`, predicate: { file: `src/${id}.json`, pointer: "/value", op: "eq", expected: ids.indexOf(id) + 1 } }] },
      }));
    },
    setup: async ({ dir }) => {
      await writeFile(join(dir, "src/check-one.json"), '{"value":1}\n');
      await writeFile(join(dir, "src/check-two.json"), '{"value":0}\n');
      await writeFile(join(dir, "src/check-three.json"), '{"value":3}\n');
    },
  });
});
