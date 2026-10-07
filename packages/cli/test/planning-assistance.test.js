import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { normalize, runCli, withTempDir } from "./helpers.js";

test("assistance help describes controls on existing commands", () => {
  const spec = runCli(["spec", "--help"]);
  assert.equal(spec.status, 0, spec.stderr);
  assert.match(spec.stdout, /--from/);
  assert.match(spec.stdout, /--explore/);
  assert.match(spec.stdout, /--guidance/);
  assert.match(spec.stdout, /--input/);
  const plan = runCli(["plan", "--help"]);
  assert.equal(plan.status, 0, plan.stderr);
  for (const flag of ["--compare", "--strategy", "--rationale", "--granularity", "--input"]) assert.ok(plan.stdout.includes(flag));
});

test("invalid guidance and strategy refuse before a project mutation", async () => {
  await withTempDir(async (dir) => {
    const guidance = runCli(["spec", "--project", dir, "--guidance", "automatic"]);
    assert.notEqual(guidance.status, 0);
    assert.match(guidance.stderr, /allowed choices|guided/);
    const strategy = runCli(["plan", "--project", dir, "--strategy", "automatic"]);
    assert.notEqual(strategy.status, 0);
    assert.match(strategy.stderr, /allowed choices|outcomes/);
    assert.equal((await createLegionEngine(dir).getState()).phase, "uninitialized");
  });
});

test("custom planning strategy requires an explicit human rationale", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["plan", "--project", dir, "--strategy", "custom", "--json"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /custom strategy requires a human rationale/);
    assert.equal((await createLegionEngine(dir).getState()).phase, "uninitialized");
  });
});

test("unsupported local brief returns an actionable JSON refusal without a prompt", async () => {
  await withTempDir(async (dir) => {
    assert.equal(runCli(["init", "--project", dir, "--name", "Brief", "--adapter", "fake"]).status, 0);
    await writeFile(join(dir, "brief.pdf"), "not a supported text brief");
    const result = runCli(["spec", "--project", dir, "--from", "brief.pdf", "--json"], { input: "" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /unsupported brief format|Markdown|.txt/);
    assert.doesNotMatch(result.stdout, /Confirm this|Answer or option/);
    assert.notEqual((await createLegionEngine(dir).getState()).phase, "spec_frozen");
  });
});

test("closed stdin pauses guidance and never confirms intent", async () => {
  await withTempDir(async (dir) => {
    assert.equal(runCli(["init", "--project", dir, "--name", "Guided", "--adapter", "fake"]).status, 0);
    const result = runCli(["spec", "--project", dir, "--guidance", "guided"], { input: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(normalize(result.stdout), /Progress saved|Resume/);
    const engine = createLegionEngine(dir);
    assert.equal((await engine.getState()).phase, "intent_draft");
    const session = await engine.getAssistance();
    assert.equal(session.paused, true);
    assert.equal(session.guidance, "guided");
  });
});

test("guidance pause preserves an answer from a partial interview round", async () => {
  await withTempDir(async (dir) => {
    assert.equal(runCli(["init", "--project", dir, "--name", "Guided", "--adapter", "fake"]).status, 0);
    const first = runCli(["spec", "--project", dir, "--guidance", "guided"], {
      input: "Maintainers who need reliable releases.\npause\n",
    });
    assert.equal(first.status, 0, first.stderr);
    const engine = createLegionEngine(dir);
    const progress = await engine.getIntentState();
    assert.ok(progress.answers.mapped.personas.includes("Maintainers who need reliable releases."));
    assert.equal(progress.answers.rounds.length, 1);
    const resumed = runCli(["spec", "--project", dir], { input: "pause\n" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.doesNotMatch(resumed.stdout, /Who is this for/);
    assert.equal((await engine.getState()).phase, "intent_draft");
  });
});
