import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { WIREFRAME_PALETTE } from "@9thlevelsoftware/legion-cli-core";
import { IntentAnswersFileSchema, SpecSchema } from "@9thlevelsoftware/legion-cli-schema";
import { parseMarkdownDocument, parseYamlDocument } from "@9thlevelsoftware/legion-cli-persist";
import { normalize, runCli, withTempDir } from "./helpers.js";

function yaml(text) {
  return IntentAnswersFileSchema.parse(parseYamlDocument(text));
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
    assert.equal(noConfirm.status, 1, noConfirm.stdout);
    assert.match(normalize(noConfirm.stderr), /intent confirmation is required/);

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

test("discuss + spec templates freeze without a model", async () => {
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
    assert.equal(discuss.status, 0, `${discuss.stdout}\n${discuss.stderr}`);

    const spec = runCli(["spec", "--project", dir]);
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

    const approve = runCli(["spec", "approve", "--project", dir]);
    assert.equal(approve.status, 0, approve.stderr);
    assert.match(normalize(approve.stdout), /Spec frozen/);
    const frozen = await readFile(join(dir, ".legion-cli", "specs", "spec-checkin", "SPEC.md"), "utf8");
    assert.match(frozen, /status: frozen/);
    SpecSchema.parse(parseMarkdownDocument(frozen).frontmatter);
  });
});

test("spec --skip-wireframes does not write INDEX.html", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    runCli(["intent", "--project", dir, "--done"], {
      input: [
        "Teammates who keep missing who's in the office.",
        "They ping five chat apps every morning.",
        "People can tap in or out on their phone in under five seconds.",
        "No payroll.",
        "Y",
      ].join("\n") + "\n",
    });
    runCli(["discuss", "--project", dir, "--yes"]);
    const spec = runCli(["spec", "--project", dir, "--skip-wireframes"]);
    assert.equal(spec.status, 0, spec.stderr);
    assert.equal(
      existsSync(join(dir, ".legion-cli", "specs", "spec-checkin", "wireframes", "INDEX.html")),
      false,
    );
  });
});
