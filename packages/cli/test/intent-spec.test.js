import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

import { WIREFRAME_PALETTE } from "@9thlevelsoftware/legion-cli-core";
import { IntentAnswersFileSchema, SpecSchema } from "@9thlevelsoftware/legion-cli-schema";
import { parseMarkdownDocument, parseYamlDocument } from "@9thlevelsoftware/legion-cli-persist";
import { allowCopyJailIn, normalize, runCli, withTempDir } from "./helpers.js";

function yaml(text) {
  return IntentAnswersFileSchema.parse(parseYamlDocument(text));
}

function acceptDiscuss(dir) {
  return runCli(["discuss", "--project", dir], { input: "Y\nY\nY\n" });
}

async function readSpecDocuments(dir) {
  const paths = existsSync(dir)
    ? (await readdir(dir, { recursive: true })).filter((path) => basename(path) === "SPEC.md").sort()
    : [];
  return Promise.all(paths.map(async (path) => [path, await readFile(join(dir, path), "utf8")]));
}

test("intent --done writes IntentAnswersFile and requires confirm", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const noConfirm = runCli(["intent", "--project", dir, "--done"], {
      input: [
        "Teammates who keep missing who's in the office.",
        "They ping five chat apps every morning.",
        "People can tap in or out on their phone in under five seconds.",
        "No payroll, no badges, no calendar sync in v0.",
        "n",
      ].join("\n") + "\n",
    });
    assert.equal(noConfirm.status, 1, `${noConfirm.stdout}\n${noConfirm.stderr}`);
    assert.match(normalize(noConfirm.stderr + noConfirm.stdout), /intent requires answers|Confirm this is what must be true/);

    const ok = runCli(["intent", "--project", dir, "--done"], {
      input: "Y\n",
    });
    assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
    const answers = yaml(await readFile(join(dir, ".legion-cli", "wiki", "product", "intent-answers.yaml"), "utf8"));
    assert.equal(answers.schemaVersion, "legion-cli-intent-answers/v1");
    assert.equal(answers.mapped.personas[0], "Teammates who keep missing who's in the office.");
    assert.match(normalize(ok.stdout), /legion-cli discuss/);
  });
});

test("spec composes a visible greenfield conversation and defaults wireframes off", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    const result = runCli(["spec", "--project", dir], {
      preparationAcceptanceIds: ["AC-P0-01", "AC-P1-01"],
      input: [
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
      ].join("\n") + "\n",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(normalize(result.stdout), /Who is this for/);
    assert.match(normalize(result.stdout), /What are they stuck doing today/);
    assert.match(normalize(result.stdout), /Confirm this is what must be true/);
    assert.match(normalize(result.stdout), /Decision D-001/);
    assert.match(normalize(result.stdout), /SPEC\.md/);
    assert.equal(existsSync(join(dir, ".legion-cli", "specs", "spec-checkin", "wireframes", "INDEX.html")), false);
  });
});

test("brownfield spec writes bounded orientation before the same conversation", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "legacy.ts"), "export const legacy = true;\n", "utf8");
    runCli([
      "init", "--project", dir, "--name", "Legacy", "--adapter", "fake",
      "--mode", "brownfield", "--brownfield-goal", "change",
    ]);
    const result = runCli(["spec", "--project", dir], { input: "" });
    assert.notEqual(result.status, 0);
    assert.match(normalize(result.stdout), /Brownfield orientation: .legion-cli\/map\/DISCOVERY\.md/);
    assert.equal(existsSync(join(dir, ".legion-cli", "map", "DISCOVERY.md")), true);
  });
});

test("brownfield audit refuses to draft without a bounded remediation selection", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "legacy.ts"), "export const legacy = true;\n", "utf8");
    runCli([
      "init", "--project", dir, "--name", "Legacy", "--adapter", "fake",
      "--mode", "brownfield", "--brownfield-goal", "audit",
    ]);
    const result = runCli(["spec", "--project", dir], { input: "\n\n" });
    assert.notEqual(result.status, 0);
    assert.match(normalize(`${result.stdout}\n${result.stderr}`), /requires a bounded remediation goal and affected area/);
  });
});

test("brownfield audit records one selection and reuses it when the spec resumes", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "legacy.ts"), "export const legacy = true;\n", "utf8");
    runCli([
      "init", "--project", dir, "--name", "Legacy", "--adapter", "fake",
      "--mode", "brownfield", "--brownfield-goal", "audit",
    ]);
    const selected = runCli(["spec", "--project", dir], {
      input: "Fix authorization check\nlegacy.ts\n",
    });
    assert.notEqual(selected.status, 0, `${selected.stdout}\n${selected.stderr}`);
    assert.match(normalize(selected.stdout), /Selected remediation: Fix authorization check \(legacy\.ts\)/);
    const resumed = runCli(["spec", "--project", dir], { input: "" });
    assert.notEqual(resumed.status, 0);
    assert.match(normalize(resumed.stdout), /Selected remediation: Fix authorization check \(legacy\.ts\)/);
    assert.doesNotMatch(normalize(resumed.stdout), /Remediation goal:/);
  });
});

test("discuss + spec templates freeze without a model", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    const intent = runCli(["intent", "--project", dir, "--done"], {
      input: [
        "Teammates who keep missing who's in the office.",
        "They ping five chat apps every morning.",
        "People can tap in or out on their phone in under five seconds.",
        "Do not change auth. We will not build payroll, badges, or calendar sync.",
        "Y",
      ].join("\n") + "\n",
    });
    assert.equal(intent.status, 0, intent.stderr);

    const discuss = acceptDiscuss(dir);
    assert.equal(discuss.status, 0, `${discuss.stdout}\n${discuss.stderr}`);

    const spec = runCli(["spec", "--project", dir, "--wireframes"]);
    assert.equal(spec.status, 0, `${spec.stdout}\n${spec.stderr}`);
    assert.match(normalize(spec.stdout), /SPEC\.md/);
    assert.match(normalize(spec.stdout), /wireframes\/INDEX\.html/);

    const specMd = await readFile(join(dir, ".legion-cli", "specs", "spec-checkin", "SPEC.md"), "utf8");
    assert.match(specMd, /schemaVersion: legion-cli-spec\/v1/);
    assert.match(specMd, /status: draft/);
    const index = await readFile(
      join(dir, ".legion-cli", "specs", "spec-checkin", "wireframes", "INDEX.html"),
      "utf8",
    );
    assert.match(index, new RegExp(WIREFRAME_PALETTE.background));
    assert.match(index, new RegExp(WIREFRAME_PALETTE.accent));

    const show = runCli(["spec", "show", "--project", dir]);
    assert.equal(show.status, 0, show.stderr);
    assert.match(normalize(show.stdout), /spec-checkin\/SPEC\.md/);

    const skipAfter = runCli(["spec", "approve", "--project", dir, "--skip-wireframes"]);
    assert.equal(skipAfter.status, 1);
    assert.match(normalize(skipAfter.stderr), /pre-approve/);

    const manualChallenge = runCli(["spec", "--project", dir, "--manual-review"], {
      input: [
        "A check-in is recorded in under five seconds and confirmed to the teammate.",
        "When unavailable, preserve the attempted check-in and show a clear retry message.",
        "Do not change authentication or add payroll, badge, or calendar scope.",
        "I acknowledge",
      ].join("\n") + "\n",
    });
    assert.equal(manualChallenge.status, 0, `${manualChallenge.stdout}\n${manualChallenge.stderr}`);

    const approve = runCli(["spec", "approve", "--project", dir, "--message", "ship it"]);
    assert.equal(approve.status, 0, approve.stderr);
    const frozen = await readFile(join(dir, ".legion-cli", "specs", "spec-checkin", "SPEC.md"), "utf8");
    const frozenSpec = SpecSchema.parse(parseMarkdownDocument(frozen).frontmatter);
    assert.equal(frozenSpec.status, "frozen");
    const state = parseMarkdownDocument(await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8")).frontmatter;
    assert.equal(state.phase, "spec_frozen");
    assert.equal(state.activeSpecId, frozenSpec.id);
  });
});

test("spec does not write wireframes unless explicitly requested", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    runCli(["intent", "--project", dir, "--done"], {
      input: [
        "Teammates who keep missing who's in the office.",
        "They ping five chat apps every morning.",
        "People can tap in or out on their phone in under five seconds.",
        "No payroll.",
        "Y",
      ].join("\n") + "\n",
    });
    const discuss = acceptDiscuss(dir);
    assert.equal(discuss.status, 0, `${discuss.stdout}\n${discuss.stderr}`);
    const spec = runCli(["spec", "--project", dir]);
    assert.equal(spec.status, 0, spec.stderr);
    assert.equal(
      existsSync(join(dir, ".legion-cli", "specs", "spec-checkin", "wireframes", "INDEX.html")),
      false,
    );
  });
});

test("intent --yes does not confirm", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["intent", "--project", dir, "--done", "--yes"], {
      input:
        [
          "Teammates who keep missing who's in the office.",
          "They ping five chat apps every morning.",
          "People can tap in or out on their phone in under five seconds.",
          "No payroll, no badges, no calendar sync in v0.",
          "n",
        ].join("\n") + "\n",
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(normalize(result.stdout), /Next: legion-cli discuss/);
    const state = await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8");
    assert.match(state, /phase: intent_draft/);
    assert.doesNotMatch(state, /intent_ready/);
  });
});

test("discuss --yes cannot skip product decisions", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const intent = runCli(["intent", "--project", dir, "--done"], {
      input: [
        "Teammates who keep missing who's in the office.",
        "They ping five chat apps every morning.",
        "People can tap in or out on their phone in under five seconds.",
        "Do not change auth. We will not build payroll, badges, or calendar sync.",
        "Y",
      ].join("\n") + "\n",
    });
    assert.equal(intent.status, 0, intent.stderr);

    const discuss = runCli(["discuss", "--project", dir, "--yes"]);
    assert.equal(discuss.status, 1, `${discuss.stdout}\n${discuss.stderr}`);
    assert.match(normalize(discuss.stderr), /cannot skip product decisions/);
    assert.match(normalize(discuss.stderr), /Next: legion-cli discuss/);
    assert.doesNotMatch(normalize(discuss.stderr), /intent_ready/);
    const state = await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8");
    assert.match(state, /phase: intent_ready/);
    const discussMd = await readFile(join(dir, ".legion-cli", "discuss", "DISCUSS.md"), "utf8");
    assert.doesNotMatch(discussMd, /D-001/);
    assert.doesNotMatch(discussMd, /status: proposed/);
  });
});

test("discuss empty stdin cannot skip product decisions", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const intent = runCli(["intent", "--project", dir, "--done"], {
      input: [
        "Teammates who keep missing who's in the office.",
        "They ping five chat apps every morning.",
        "People can tap in or out on their phone in under five seconds.",
        "Do not change auth. We will not build payroll, badges, or calendar sync.",
        "Y",
      ].join("\n") + "\n",
    });
    assert.equal(intent.status, 0, intent.stderr);

    const discuss = runCli(["discuss", "--project", dir], { input: "" });
    assert.equal(discuss.status, 1, `${discuss.stdout}\n${discuss.stderr}`);
    assert.match(normalize(discuss.stderr), /needs an explicit Y or n/);
    assert.match(normalize(discuss.stderr), /Next: legion-cli discuss/);
    const discussMd = await readFile(join(dir, ".legion-cli", "discuss", "DISCUSS.md"), "utf8");
    assert.match(discussMd, /status: proposed/);
    assert.doesNotMatch(discussMd, /status: accepted/);
  });
});

test("discuss --yes refuses before startDiscuss with no remaining decisions", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const discuss = runCli(["discuss", "--project", dir, "--yes"]);
    assert.equal(discuss.status, 1, `${discuss.stdout}\n${discuss.stderr}`);
    assert.match(normalize(discuss.stderr), /cannot skip product decisions/);
    assert.match(normalize(discuss.stderr), /Next: legion-cli discuss/);
    assert.doesNotMatch(normalize(discuss.stderr), /intent_ready/);
    const state = await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8");
    assert.match(state, /phase: initialized/);
    const discussMd = await readFile(join(dir, ".legion-cli", "discuss", "DISCUSS.md"), "utf8");
    assert.doesNotMatch(discussMd, /D-001/);
    assert.doesNotMatch(discussMd, /status: proposed/);
  });
});

test("intent discuss spec do not accept --adapter", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    for (const args of [
      ["intent", "--adapter", "grok", "--project", dir],
      ["discuss", "--adapter", "grok", "--project", dir],
      ["spec", "--adapter", "grok", "--project", dir],
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 1, args.join(" "));
      assert.match(normalize(`${result.stdout}\n${result.stderr}`), /unknown option|--adapter/);
    }
    const intentHelp = runCli(["help", "intent"]);
    assert.doesNotMatch(normalize(intentHelp.stdout), /--adapter/);
    const discussHelp = runCli(["help", "discuss"]);
    assert.doesNotMatch(normalize(discussHelp.stdout), /--adapter/);
  });
});

const INTENT_INPUT =
  [
    "Teammates who keep missing who's in the office.",
    "They ping five chat apps every morning.",
    "People can tap in or out on their phone in under five seconds.",
    "Do not change auth. We will not build payroll, badges, or calendar sync.",
    "Y",
  ].join("\n") + "\n";

test("intent, discuss and spec stop with a doctor hint when no agent is available", async () => {
  await withTempDir(async (dir) => {
    const noAgent = { noAgent: true, env: { LEGION_CLI_ADAPTER: "" } };
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);

    // intent confirmation is the step that spawns; the refusal must leave the phase and files alone.
    const intent = runCli(["intent", "--project", dir, "--done"], { ...noAgent, input: INTENT_INPUT });
    assert.notEqual(intent.status, 0);
    assert.match(normalize(intent.stderr + intent.stdout), /no agent available for interview/);
    assert.match(normalize(intent.stderr + intent.stdout), /legion-cli doctor/);
    assert.match(await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8"), /phase: intent_draft/);
    const specsDir = join(dir, ".legion-cli", "specs");
    assert.equal(existsSync(specsDir) ? (await readdir(specsDir)).length : 0, 0);

    // the refused run already saved the answers; with an agent only the confirmation is left
    const ok = runCli(["intent", "--project", dir, "--done"], { input: "Y\n" });
    assert.equal(ok.status, 0, ok.stderr);
    const discuss = runCli(["discuss", "--project", dir], { ...noAgent, input: "Y\nY\nY\n" });
    assert.notEqual(discuss.status, 0);
    assert.match(normalize(discuss.stderr + discuss.stdout), /no agent available for discuss/);
    assert.match(normalize(discuss.stderr + discuss.stdout), /legion-cli doctor/);
    assert.match(await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8"), /phase: intent_ready/);

    const accepted = acceptDiscuss(dir);
    assert.equal(accepted.status, 0, accepted.stderr);
    const beforeSpec = parseMarkdownDocument(await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8")).frontmatter;
    const beforeSpecDocuments = await readSpecDocuments(specsDir);
    const spec = runCli(["spec", "--project", dir], noAgent);
    assert.notEqual(spec.status, 0);
    assert.match(normalize(spec.stderr + spec.stdout), /no agent available/);
    assert.match(normalize(spec.stderr + spec.stdout), /legion-cli doctor/);
    const afterSpec = parseMarkdownDocument(await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8")).frontmatter;
    assert.equal(afterSpec.phase, beforeSpec.phase);
    assert.equal(afterSpec.activeSpecId, beforeSpec.activeSpecId);
    assert.deepEqual(await readSpecDocuments(specsDir), beforeSpecDocuments);
  });
});
