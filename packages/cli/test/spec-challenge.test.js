import assert from "node:assert/strict";
import test from "node:test";

import { normalize, runCli, withTempDir } from "./helpers.js";

function completeIntentAndDiscuss(dir) {
  const intent = runCli(["intent", "--project", dir, "--done"], {
    input: [
      "Teammates who need a dependable office check-in.",
      "They cannot tell who is available without asking in several places.",
      "A check-in records and confirms in under five seconds.",
      "Do not change authentication or build payroll.",
      "Y",
    ].join("\n") + "\n",
  });
  assert.equal(intent.status, 0, `${intent.stdout}\n${intent.stderr}`);
  const discuss = runCli(["discuss", "--project", dir], { input: "Y\nY\nY\n" });
  assert.equal(discuss.status, 0, `${discuss.stdout}\n${discuss.stderr}`);
}

test("focused spec exposes pending challenge JSON, resumes manual answers, and guides status", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    completeIntentAndDiscuss(dir);

    const drafted = runCli(["spec", "--project", dir]);
    assert.equal(drafted.status, 0, `${drafted.stdout}\n${drafted.stderr}`);

    const jsonPending = runCli(["spec", "--project", dir, "--json"]);
    assert.equal(jsonPending.status, 0, jsonPending.stderr);
    const pending = JSON.parse(jsonPending.stdout);
    assert.equal(pending.challenge.status, "manual_required");
    assert.match(pending.next, /^legion-cli spec --manual-review --project /);
    const premature = runCli(["spec", "approve", "--project", dir]);
    assert.equal(premature.status, 1, `${premature.stdout}\n${premature.stderr}`);
    const stillPending = runCli(["spec", "--project", dir, "--json"]);
    assert.equal(stillPending.status, 0, stillPending.stderr);
    assert.equal(JSON.parse(stillPending.stdout).challenge.status, "manual_required");

    const status = runCli(["--project", dir, "--json"]);
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout);
    assert.match(statusJson.next.run, /^legion-cli spec --project /);

    const interrupted = runCli(["spec", "--project", dir, "--manual-review"], {
      input: "Check-in completion is measured by a persisted confirmation in under five seconds.\n",
    });
    assert.equal(interrupted.status, 0, `${interrupted.stdout}\n${interrupted.stderr}`);
    assert.match(normalize(interrupted.stdout), /Resume: legion-cli spec --manual-review/);
    const savedPartial = runCli(["spec", "--project", dir, "--json"]);
    assert.equal(savedPartial.status, 0, savedPartial.stderr);
    assert.equal(JSON.parse(savedPartial.stdout).challenge.status, "manual_required");
    assert.equal(
      JSON.parse(savedPartial.stdout).challenge.receipt.manualReview.measurableSuccess,
      "Check-in completion is measured by a persisted confirmation in under five seconds.",
    );

    const resumed = runCli(["spec", "--project", dir, "--manual-review"], {
      input: [
        "When unavailable, preserve the check-in attempt and show a retry message.",
        "Keep authentication unchanged and exclude payroll from this increment.",
        "I acknowledge",
      ].join("\n") + "\n",
    });
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);

    const complete = runCli(["spec", "--project", dir, "--json"]);
    assert.equal(complete.status, 0, complete.stderr);
    assert.equal(JSON.parse(complete.stdout).challenge.status, "complete");

    const approved = runCli(["spec", "approve", "--project", dir]);
    assert.equal(approved.status, 0, `${approved.stdout}\n${approved.stderr}`);
    const frozen = runCli(["spec", "--project", dir, "--json"]);
    assert.equal(frozen.status, 0, frozen.stderr);
    const frozenJson = JSON.parse(frozen.stdout);
    assert.equal(frozenJson.phase, "spec_frozen");
    assert.equal(frozenJson.challenge.status, "complete");
  });
});
