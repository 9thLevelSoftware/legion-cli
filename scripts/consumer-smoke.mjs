import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installPackedConsumer } from "./lib/packed-consumer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "legion-consumer-"));
try {
  const { consumer, bin, packed, runOk, runRefused, initGitRepo } = await installPackedConsumer(root, temporary);
  const project = join(consumer, "project");
  await mkdir(project);
  const initialized = JSON.parse(runOk(process.execPath, [bin, "init", "--adapter", "fake", "--name", "Consumer", "--project", project, "--json"], consumer));
  assert.notEqual(initialized.ok, false);
  const status = JSON.parse(runOk(process.execPath, [bin, "status", "--project", project, "--json"], consumer));
  assert.notEqual(status.ok, false);
  const skills = JSON.parse(runOk(process.execPath, [bin, "skills", "list", "--project", project, "--json"], consumer));
  assert.match(JSON.stringify(skills), /execute/);
  assert.match(JSON.stringify(skills), /accessibility/, "extension packs must ship in the installed package");
  const craft = await readFile(join(project, ".legion-cli", "design", "craft", "typography.md"), "utf8");
  assert.ok(craft.length > 0);
  const packageProbe = join(consumer, "package-probe.mjs");
  await writeFile(packageProbe, [
    'import * as persist from "@9thlevelsoftware/legion-cli-persist";',
    'import * as sandbox from "@9thlevelsoftware/legion-cli-sandbox";',
    'import { readWorkflowPreparation } from "@9thlevelsoftware/legion-cli-core";',
    'import { WORKFLOW_STAGE_FIELDS } from "@9thlevelsoftware/legion-cli-schema";',
    "export { persist, sandbox, readWorkflowPreparation, WORKFLOW_STAGE_FIELDS };",
    "",
  ].join("\n"), "utf8");
  const { persist, sandbox, readWorkflowPreparation, WORKFLOW_STAGE_FIELDS } = await import(pathToFileURL(packageProbe).href);
  const store = persist.createLegionStore(project);
  const config = await store.readConfig();
  const hardened = sandbox.hardenedSandboxAvailable(config.sandbox);
  let activeSpecId;
  if (hardened) {
    // The installed fake agent needs concrete policy-2 outputs just like a real
    // planning agent. Keep the default focused lifecycle and its approval gates.
    const digest = (content) => createHash("sha256").update(content).digest("hex");
    const stageOutput = (specId, stage, fields, inputs = []) => {
      const content = `# ${stage}\n\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n`;
      const base = ["context", "requirements"].includes(stage) ? `specs/${specId}/preparation` : `plans/${specId}`;
      const path = `.legion-cli/${base}/${stage}.md`;
      return { path, content, artifact: { stage, path, digest: digest(content), inputs, fields } };
    };
    const preparationEnv = (record, outputs) => ({ LEGION_CLI_FAKE_ARTIFACTS: JSON.stringify([
      ...outputs.map(({ path, content }) => ({ path, content })),
      { path: ".legion-cli/cache/runs/<id>/preparation.json", content: JSON.stringify(record) },
    ]) });
    const specOutputs = [
      stageOutput("spec-consumer", "context", {
        goal: "Specify the bounded check-in behavior", affectedPaths: "src/main.js will provide the check-in result",
        constraints: "Preserve authentication and exclude payroll", assumptions: "This is a local lifecycle fixture with no existing product implementation",
      }),
      stageOutput("spec-consumer", "requirements", {
        outcomes: "Record and confirm check-in promptly", invariants: "Existing authentication remains unchanged",
        acceptanceIds: "AC-P0-01, AC-P1-01", qualityAttributes: "Clear failure handling and a responsive check-in interaction",
      }),
    ];
    const specPreparation = {
      schemaVersion: "legion-cli-workflow-preparation/v1",
      assessment: { schemaVersion: "legion-cli-workflow-assessment/v1", policyVersion: 2, specId: "spec-consumer",
        inputFingerprint: digest("[]"), unresolvedDecisions: [],
        stageDecisions: Object.keys(WORKFLOW_STAGE_FIELDS).map((stage) => ({ stage,
          decision: stage === "infrastructure-design" ? "not_applicable" : "required",
          rationale: stage === "infrastructure-design" ? "The local fixture requests no hosting change" : "The check-in behavior and local delivery require reviewed preparation",
          evidenceRefs: ["assumption: this fixture specifies a bounded local check-in module"],
        })) },
      specArtifacts: specOutputs.map(({ artifact }) => artifact), planArtifacts: [], acceptanceMappings: [],
    };
    const specAnswers = [
      "Teammates who need a simple check-in.",
      "They cannot tell who is available.",
      "A check-in is recorded in under five seconds.",
      "Do not change auth. We will not build payroll.",
      "Open the CLI, check in, see confirmation.",
      "Return a clear error when unavailable.",
      "none",
      "CLI",
      "none",
      "none",
      "Y",
      "Y",
    ].join("\n") + "\n";
    runOk(process.execPath, [bin, "spec", "--project", project], consumer, specAnswers, preparationEnv(specPreparation, specOutputs));
    const state = await store.readState();
    activeSpecId = state.data.activeSpecId;
    assert.ok(activeSpecId, "spec command must set the active spec through the public store");
    const spec = await store.readSpec(activeSpecId);
    assert.equal(spec.data.workflowPolicyVersion, 2, "the packed lifecycle must exercise current preparation gates");
    assert.ok(spec.data.acceptance.length > 0, "active spec must provide acceptance criteria");
    const challenge = JSON.parse(runOk(process.execPath, [bin, "spec", "--json", "--project", project], consumer));
    if (challenge.challenge.status === "manual_required") {
      runOk(process.execPath, [bin, "spec", "--manual-review", "--project", project], consumer, [
        "People can complete a check-in in under five seconds.",
        "Show a clear retryable error when check-in cannot be saved.",
        "Keep authentication unchanged and exclude payroll from this increment.",
        "I acknowledge",
      ].join("\n") + "\n");
    } else {
      assert.equal(challenge.challenge.status, "complete", "spec challenge must complete or require its documented manual fallback");
    }
    runOk(process.execPath, [bin, "spec", "approve", "--message", "Consumer smoke acceptance", "--project", project], consumer);

    const taskId = "TSK-consumer-smoke-task";
    await store.writeTask({
      schemaVersion: "legion-cli-task/v1",
      id: taskId,
      title: "Write the check-in result",
      status: "ready",
      type: "feature",
      priority: "P0",
      specId: activeSpecId,
      blockedBy: [],
      blocks: [],
      assignee: "agent",
      notes: "",
      contract: {
        filesAllowed: ["src/main.js"],
        filesForbidden: [".git/**"],
        expectedArtifacts: ["src/main.js"],
        verificationCommands: ['node -e "process.exit(0)"'],
        maxFilesTouched: 20,
      },
    }, "Implement the approved check-in behavior.\n");
    await store.writeMarkdown(`.legion-cli/plans/${activeSpecId}.md`, {}, "# Consumer plan\n\nImplement the check-in behavior.\n");
    // The fixture carries the check-in module the task contract names: the fake adapter writes only the artifacts
    // it is given, and this smoke proves lifecycle wiring, not generated code.
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "main.js"), "export function checkIn(name) {\n  return `${name} checked in`;\n}\n");
    await initGitRepo(project);
    // Manual challenge completion can add acceptance criteria; consume the
    // engine's current approved preparation instead of rebuilding its inputs.
    const preparation = await readWorkflowPreparation(store, activeSpecId);
    const approvedSpec = (await store.readSpec(activeSpecId)).data;
    const designFields = {
      decision: "Keep one local check-in module and preserve the existing authentication boundary",
      interfaces: "The task exclusively owns src/main.js and its checkIn result",
      failureCompatibility: "Keep payroll out of scope and report unavailable check-in clearly",
      verification: "Run the approved task check and independent review before recording acceptance",
      installation: "Deliver the local source change through the human ship gate",
      recovery: "Revert the bounded change if the check-in behavior fails review",
      externalChecks: "This local lifecycle fixture does not deploy to an external provider",
      operator: "The project maintainer reviews and accepts local delivery",
    };
    const planOutputs = preparation.assessment.stageDecisions
      .filter(({ stage, decision }) => decision === "required" && !["context", "requirements"].includes(stage))
      .map(({ stage }) => stageOutput(activeSpecId, stage,
        Object.fromEntries(WORKFLOW_STAGE_FIELDS[stage].map((key) => [key, designFields[key]])),
        preparation.specArtifacts.map(({ path, digest }) => ({ path, digest }))));
    const plannedPreparation = { ...preparation, planArtifacts: planOutputs.map(({ artifact }) => artifact),
      acceptanceMappings: approvedSpec.acceptance.map(({ id }) => ({ criterionId: id, taskIds: [taskId], methods: [{
        id: `${id}-task-check`, kind: "task_check", taskId, command: 'node -e "process.exit(0)"',
        expectedObservation: "The approved fixture check succeeds; independent review assesses check-in behavior",
      }] })) };
    const plan = JSON.parse(runOk(process.execPath, [bin, "plan", "--project", project, "--json"], consumer, undefined,
      preparationEnv(plannedPreparation, planOutputs)));
    assert.notEqual(plan.readiness, "FAIL", JSON.stringify(plan));
    runOk(process.execPath, [
      bin, "plan", "approve", "--project", project, "--check", 'node -e "process.exit(0)"',
    ], consumer);
    // Focused execute runs the task, its planned checks and the independent review in one call. The installed
    // CLI's fake-adapter seam supplies the reviewer's explicit run-cache notes.
    const reviewNotes = JSON.stringify([
      { path: ".legion-cli/cache/runs/<id>/review.md", content: "# Independent review\n\nThe check-in task meets the approved spec.\n\nVerdict: PASS\n" },
    ]);
    const execution = runRefused(process.execPath, [bin, "execute", "--project", project, "--json"], consumer,
      /"status": "blocked"[\s\S]*"blocker": "acceptance evidence pending/, { LEGION_CLI_FAKE_ARTIFACTS: reviewNotes });
    assert.match(execution, new RegExp(`"completedTaskIds": \\[\\s*"${taskId}"`), execution);
    const acceptanceIds = (await store.readSpec(activeSpecId)).data.acceptance.map((criterion) => criterion.id);
    runOk(process.execPath, [bin, "plan", "acceptance", "--pass", ...acceptanceIds, "--note", "Consumer smoke manual acceptance", "--project", project], consumer);
    const shipped = runOk(process.execPath, [bin, "ship", "--project", project], consumer, "y\n");
    assert.match(shipped, /Ship receipt written/);
    assert.ok((await readFile(join(project, "src", "main.js"), "utf8")).length > 0);
  } else {
    console.log(`SKIP lifecycle init→spec→plan→execute→ship: installed sandbox configuration (${config.sandbox.backend}) has no hardened backend`);
  }

  const validatorData = join(project, "data", "product.json");
  const validatorInput = join(consumer, "validator-input.json");
  await mkdir(join(project, "data"));
  await writeFile(validatorData, JSON.stringify({ release: "consumer-smoke", approved: true }));
  await writeFile(validatorInput, JSON.stringify({
    schemaVersion: "legion-cli-component-invocation/v1",
    checks: [{
      id: "json-contract",
      configuration: {
        assertions: [{
          id: "approved-release",
          predicate: { file: "data/product.json", pointer: "/approved", op: "eq", expected: true },
        }],
      },
      files: ["data/product.json"],
    }],
  }));
  const validator = JSON.parse(runOk(process.execPath, [
    bin, "skills", "run", "extension:json-contract", "--project", project, "--validator-input", validatorInput, "--json",
  ], consumer));
  assert.equal(validator.ok, true, JSON.stringify(validator));
  assert.equal(validator.counts.passed, 1, JSON.stringify(validator));
  assert.equal(validator.evidence.checks[0].status, "passed", JSON.stringify(validator));
  const legacyGovernedRun = runRefused(process.execPath, [
    bin, "skills", "run", "extension:accessibility", "--project", project,
  ], consumer, /evidence\.json/i);
  assert.doesNotMatch(legacyGovernedRun, /validator-input.*only supported for component/i);

  runRefused(process.execPath, [
    bin, "skills", "run", "extension:accessibility", "--project", project, "--validator-input", validatorInput,
  ], consumer, /validator-input.*only supported for component/i);
  const legacyFixture = join(consumer, "legacy-vendor");
  await mkdir(legacyFixture);
  await writeFile(join(legacyFixture, "vendor-input.json"), await readFile(validatorInput, "utf8"));
  const legacyRefusal = runRefused(process.execPath, [
    bin, "skills", "run", "extension:accessibility", "--project", project,
    "--validator-input", join(legacyFixture, "vendor-input.json"),
  ], consumer, /validator-input.*only supported for component/i);
  assert.match(legacyRefusal, /extension:accessibility/);
  const brownfield = runOk(process.execPath, [bin, "help", "brownfield"], consumer);
  assert.match(brownfield, /brownfield/);
  const checks = [
    "local tarball installation", "no workspace links", "installed help", "bare status",
    "init", "status JSON", "skill resources", "extension resources", "craft resources",
    "installed JSON contract component business assertion", "legacy vendor governed refusal",
    "brownfield help",
  ];
  if (hardened) checks.push("interactive spec and approval", "plan and approval", "execute", "ship");
  console.log(JSON.stringify({
    ok: true,
    packages: packed,
    checks,
    ...(hardened ? {} : {
      skipped: `Lifecycle init→spec→plan→execute→ship requires a hardened OS sandbox; installed backend ${config.sandbox.backend} is not hardened`,
    }),
  }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
