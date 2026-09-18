import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createLegionEngine, WIREFRAME_PALETTE } from "@9thlevelsoftware/legion-cli-core";
import { normalize, runCli, withTempDir } from "./helpers.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const legionFixture = join(repoRoot, "design-systems", "_fixture-neutral");

function acceptDiscuss(dir) {
  return runCli(["discuss", "--project", dir], { input: "Y\nY\nY\n" });
}

function seedDraft(dir) {
  runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
  const intent = runCli(["intent", "--project", dir, "--done"], {
    input:
      [
        "Teammates who keep missing who's in the office.",
        "They ping five chat apps every morning.",
        "People can tap in or out on their phone in under five seconds.",
        "No payroll.",
        "Y",
      ].join("\n") + "\n",
  });
  assert.equal(intent.status, 0, intent.stderr);
  const discuss = acceptDiscuss(dir);
  assert.equal(discuss.status, 0, `${discuss.stdout}\n${discuss.stderr}`);
  const spec = runCli(["spec", "--project", dir]);
  assert.equal(spec.status, 0, `${spec.stdout}\n${spec.stderr}`);
}

test("help --all lists wireframe in shipped adjacent, not later", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /Shipped adjacent[\s\S]*\bwireframe\b/);
  assert.match(out, /--restyle, --spawn, --adapter/);
  assert.doesNotMatch(out, /Later, not this series:\n {2}.*wireframe/);
  assert.doesNotMatch(out, /Later, not this series:\n {2}skills list\|install/);
  assert.match(out, /Not in this product:\n {2}HTTP model router, bin legion/);
  assert.doesNotMatch(out, /Not in this product:\n {2}chat,/);
});

test("wireframe refuses uninitialized and --skip-palette-check", async () => {
  await withTempDir(async (dir) => {
    const missing = runCli(["wireframe", "--project", dir]);
    assert.equal(missing.status, 1);
    assert.match(normalize(missing.stderr), /no active spec/);
    assert.match(normalize(missing.stderr), /Next: legion-cli spec/);

    seedDraft(dir);
    const skip = runCli(["wireframe", "--project", dir, "--skip-palette-check"]);
    assert.equal(skip.status, 1);
    assert.match(normalize(skip.stderr), /palettePresent stays hard/);
    assert.match(normalize(skip.stderr), /Next: legion-cli wireframe/);
  });
});

test("draft regenerate writes two screens after renaming intent answers", async () => {
  await withTempDir(async (dir) => {
    seedDraft(dir);
    const engine = createLegionEngine(dir);
    const answers = await engine.store.readIntentAnswers();
    await engine.store.writeIntentAnswers({
      ...answers,
      mapped: { ...answers.mapped, screens: ["board", "settings"] },
    });

    const result = runCli(["wireframe", "--project", dir]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(normalize(result.stdout), /Wrote .legion-cli\/specs\/spec-checkin\/wireframes\/INDEX.html/);
    assert.match(normalize(result.stdout), /2 screens/);
    assert.match(normalize(result.stdout), /Next: legion-cli spec approve/);

    const wf = join(dir, ".legion-cli", "specs", "spec-checkin", "wireframes");
    assert.equal(existsSync(join(wf, "INDEX.html")), true);
    assert.equal(existsSync(join(wf, "board.html")), true);
    assert.equal(existsSync(join(wf, "settings.html")), true);
    const index = await readFile(join(wf, "INDEX.html"), "utf8");
    assert.match(index, new RegExp(WIREFRAME_PALETTE.accent));
    assert.equal(existsSync(join(wf, "home.html")), false);
  });
});

test("frozen without --restyle refuses; --restyle with fixture keeps h1", async () => {
  await withTempDir(async (dir) => {
    seedDraft(dir);
    const page = join(dir, ".legion-cli", "specs", "spec-checkin", "wireframes", "home.html");
    const before = await readFile(page, "utf8");
    await writeFile(page, before.replace("<h1>home</h1>", "<h1>Keep Me</h1>"), "utf8");
    const approve = runCli(["spec", "approve", "--project", dir]);
    assert.equal(approve.status, 0, approve.stderr);

    const frozen = runCli(["wireframe", "--project", dir]);
    assert.equal(frozen.status, 1);
    assert.match(normalize(frozen.stderr), /CSS-only/);
    assert.match(normalize(frozen.stderr), /Next: legion-cli wireframe --restyle/);

    const installed = runCli(["design-system", "install", legionFixture, "--project", dir]);
    assert.equal(installed.status, 0, installed.stderr);
    const restyle = runCli(["wireframe", "--restyle", "--project", dir]);
    assert.equal(restyle.status, 0, `${restyle.stdout}\n${restyle.stderr}`);
    assert.match(normalize(restyle.stdout), /Restyled/);
    const after = await readFile(page, "utf8");
    assert.match(after, /<h1>Keep Me<\/h1>/);
    assert.match(after, /#0b6e4f/);
    assert.match(after, /html, body \{/);
    assert.match(after, /--bg:/);
  });
});

test("spawn writing outside wireframes reverts; deny-list HTML is restored", async () => {
  await withTempDir(async (dir) => {
    seedDraft(dir);
    const extras = JSON.stringify([{ path: "src/secret.ts", content: "nope\n" }]);
    const extra = runCli(["wireframe", "--spawn", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake", LEGION_CLI_FAKE_ARTIFACTS: extras },
    });
    assert.equal(extra.status, 1, `${extra.stdout}\n${extra.stderr}`);
    assert.match(normalize(extra.stderr), /SkillContract/);
    assert.equal(existsSync(join(dir, "src", "secret.ts")), false);

    const page = join(dir, ".legion-cli", "specs", "spec-checkin", "wireframes", "home.html");
    const before = await readFile(page, "utf8");
    const bad = JSON.stringify([
      {
        path: ".legion-cli/specs/spec-checkin/wireframes/home.html",
        content: `${before}<script>alert(1)</script>`,
      },
    ]);
    const denied = runCli(["wireframe", "--spawn", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake", LEGION_CLI_FAKE_ARTIFACTS: bad },
    });
    assert.equal(denied.status, 1, `${denied.stdout}\n${denied.stderr}`);
    assert.match(normalize(denied.stderr), /<script>/);
    assert.equal(await readFile(page, "utf8"), before);
  });
});
