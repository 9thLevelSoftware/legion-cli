import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applySpecChallengeChanges,
  parseSpecChallengeAnalysis,
  validateManualAnswer,
} from "../dist/spec-challenge.js";
import { makeSpec } from "./helpers.js";

function concern(disposition, response) {
  return {
    id: "C-01",
    question: "What happens when the API is unavailable?",
    whyItMatters: "Failure handling must be explicit.",
    evidence: [{ kind: "assumption", claim: "No behavior is specified." }],
    resolution: {
      disposition,
      response,
      recordedAt: "2026-10-02T12:00:00.000Z",
      recordedBy: "owner",
    },
  };
}

test("synthesis accepts exact answered and risk-accepted text but rejects dismissal and appended scope", () => {
  const response = "Preserve the pending action and show a retry message.";
  for (const disposition of ["answered", "risk_accepted"]) {
    const applied = applySpecChallengeChanges(makeSpec(), [concern(disposition, response)], [{
      section: "failureCases",
      statement: response,
      rationale: "Records the human response.",
      concernIds: ["C-01"],
    }]);
    assert.deepEqual(applied.spec.failureCases, [response]);
  }
  assert.throws(
    () => applySpecChallengeChanges(makeSpec(), [concern("dismissed", response)], [{
      section: "failureCases",
      statement: response,
      rationale: "Should not be applied.",
      concernIds: ["C-01"],
    }]),
    /dismissed concern/,
  );
  assert.throws(
    () => applySpecChallengeChanges(makeSpec(), [concern("answered", response)], [{
      section: "failureCases",
      statement: `${response} Add payroll export.`,
      rationale: "Unrelated expansion sharing challenge vocabulary.",
      concernIds: ["C-01"],
    }]),
    /recorded human response/,
  );
  assert.throws(
    () => applySpecChallengeChanges(makeSpec(), [concern("answered", "Retries must be <= 3")], [{
      section: "failureCases",
      statement: "Retries must be > 3",
      rationale: "Reverses the authorized comparison.",
      concernIds: ["C-01"],
    }]),
    /recorded human response/,
  );
  assert.throws(
    () => applySpecChallengeChanges(makeSpec(), [concern("answered", "Keep Unicode label café")], [{
      section: "mustBeTrue",
      statement: "Keep Unicode label cafe",
      rationale: "Drops an authorized Unicode distinction.",
      concernIds: ["C-01"],
    }]),
    /recorded human response/,
  );
});

test("duplicate synthesis additions do not fabricate changes or diff lines", () => {
  const response = "People can tap in or out on their phone in under five seconds";
  const applied = applySpecChallengeChanges(makeSpec(), [concern("answered", response)], [{
    section: "mustBeTrue",
    statement: response,
    rationale: "Already captured.",
    concernIds: ["C-01"],
  }]);
  assert.deepEqual(applied.changes, []);
  assert.equal(applied.draftDiff, "(no draft changes)\n");
});

test("manual acknowledgement requires the exact I acknowledge token", () => {
  assert.equal(
    validateManualAnswer("acknowledgement", "  I acknowledge  "),
    "I acknowledge",
  );
  assert.throws(() => validateManualAnswer("acknowledgement", "I do not acknowledge manual review."), /exactly/);
  assert.throws(() => validateManualAnswer("acknowledgement", "Manual review is bad and automation failed."), /exactly|substantive/);
  assert.throws(() => validateManualAnswer("acknowledgement", "I acknowledge nothing; automation review is rejected."), /exactly/);
  assert.throws(() => validateManualAnswer("acknowledgement", "I acknowledge, yet I have not reviewed automation."), /exactly/);
});

test("analysis rejects whitespace-only concern fields", async () => {
  await assert.rejects(
    () => parseSpecChallengeAnalysis(process.cwd(), JSON.stringify({
      schemaVersion: "legion-cli-spec-challenge-analysis/v1",
      concerns: [{ question: "   ", why: "matters", evidence: [{ kind: "assumption", claim: "unknown" }] }],
    }), "spec-checkin"),
    /invalid spec challenge analysis/,
  );
});

test("citation validation downgrades mismatched quotes, env paths, symlinks, and inactive specs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-challenge-validation-"));
  const outside = await mkdtemp(join(tmpdir(), "legion-challenge-outside-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, ".legion-cli", "specs", "other"), { recursive: true });
    await writeFile(join(dir, "src", "safe.ts"), "export const safe = true;\n", "utf8");
    await writeFile(join(dir, "src", ".env.local"), "SECRET=value\n", "utf8");
    await writeFile(join(outside, "outside.ts"), "export const outside = true;\n", "utf8");
    let symlinkCreated = true;
    try {
      await symlink(join(outside, "outside.ts"), join(dir, "src", "linked.ts"));
    } catch (err) {
      if (err.code !== "EPERM") throw err;
      symlinkCreated = false;
    }
    await writeFile(join(dir, ".legion-cli", "specs", "other", "SPEC.md"), "other spec\n", "utf8");
    const raw = JSON.stringify({
      schemaVersion: "legion-cli-spec-challenge-analysis/v1",
      concerns: [{
        question: "Is the evidence supported?",
        why: "Citations must be trustworthy.",
        evidence: [
          { kind: "repository", path: "src/safe.ts", line: 1, quote: "missing", claim: "bad quote" },
          { kind: "repository", path: "src/.env.local", line: 1, quote: "SECRET", claim: "secret" },
          ...(symlinkCreated
            ? [{ kind: "repository", path: "src/linked.ts", line: 1, quote: "outside", claim: "outside" }]
            : []),
          { kind: "repository", path: ".legion-cli/specs/other/SPEC.md", line: 1, quote: "other", claim: "inactive" },
        ],
      }],
    });
    const parsed = await parseSpecChallengeAnalysis(dir, raw, "active");
    assert.deepEqual(parsed[0].evidence.map((item) => item.kind),
      Array.from({ length: symlinkCreated ? 4 : 3 }, () => "assumption"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
