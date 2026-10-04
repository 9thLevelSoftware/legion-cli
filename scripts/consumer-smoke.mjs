import assert from "node:assert/strict";
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
    "export { persist, sandbox };",
    "",
  ].join("\n"), "utf8");
  const { persist, sandbox } = await import(pathToFileURL(packageProbe).href);
  const store = persist.createLegionStore(project);
  const config = await store.readConfig();
  const hardened = sandbox.hardenedSandboxAvailable(config.sandbox);
  let activeSpecId;
  if (hardened) {
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
    runOk(process.execPath, [bin, "spec", "--project", project], consumer, specAnswers);
    const state = await store.readState();
    activeSpecId = state.data.activeSpecId;
    assert.ok(activeSpecId, "spec command must set the active spec through the public store");
    const spec = await store.readSpec(activeSpecId);
    assert.ok(spec.data.acceptance.length > 0, "active spec must provide acceptance criteria");
    const acceptanceId = spec.data.acceptance[0].id;
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

    const taskId = "consumer-smoke-task";
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
    await initGitRepo(project);
    const plan = JSON.parse(runOk(process.execPath, [bin, "plan", "--project", project, "--json"], consumer));
    assert.notEqual(plan.readiness, "FAIL", JSON.stringify(plan));
    runOk(process.execPath, [
      bin, "plan", "approve", "--project", project, "--check", 'node -e "process.exit(0)"',
    ], consumer);
    const execution = JSON.parse(runOk(process.execPath, [bin, "execute", "--step", "--project", project, "--json"], consumer));
    assert.equal(execution.ok, true, JSON.stringify(execution));
    assert.equal(execution.completedTaskIds.includes(taskId), true);
    runOk(process.execPath, [bin, "review", "--project", project], consumer);
    runOk(process.execPath, [bin, "qa", "checklist", "--tick", acceptanceId, "--project", project], consumer);
    runOk(process.execPath, [bin, "qa", "--mode", "no-browser", "--project", project], consumer);
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
