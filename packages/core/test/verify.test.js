import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { detectSandbox } from "@9thlevelsoftware/legion-cli-sandbox";
import { SCHEMA_VERSION, WorkflowEvidenceReceiptSchema } from "@9thlevelsoftware/legion-cli-schema";
import { runVerificationCommands, verificationFailureReason } from "../dist/index.js";
import { quoteArg, withEngine } from "./helpers.js";

test("verification commands inherit DATABASE_URL", async () => {
  await withEngine(async ({ dir }) => {
    const script = join(dir, "print-env.js");
    const out = join(dir, "env-out.txt");
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://fixture";
    try {
      await writeFile(
        script,
        "require('node:fs').writeFileSync('env-out.txt', process.env.DATABASE_URL || '')\n",
      );
      const command = `${quoteArg(process.execPath)} ${quoteArg(script)}`;
      const runs = await runVerificationCommands(dir, [command]);
      assert.equal(runs[0]?.ok, true, JSON.stringify(runs));
      assert.equal(await readFile(out, "utf8"), "postgres://fixture");
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});

test("verification never throws: a missing binary is a failed run that did not start", async () => {
  await withEngine(async ({ dir }) => {
    const runs = await runVerificationCommands(dir, ["legion-no-such-binary-xyz --version", "never-reached"]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ok, false);
    const reason = verificationFailureReason(runs);
    if (runs[0].started) {
      // The isolation wrapper reports the failed exec: bwrap exits 1; sandbox-exec exits EX_OSERR (71).
      const exit = runs[0].trustTier === "hardened-seatbelt" ? 71 : 1;
      assert.match(reason, new RegExp(`^verification command failed with exit ${exit}: legion-no-such-binary-xyz --version`));
    } else {
      assert.match(reason, /^verification command did not start: legion-no-such-binary-xyz --version: /);
    }
  });
});

test("2 MiB of verification output passes and lands in the run log", async () => {
  await withEngine(async ({ dir }) => {
    const command = `${quoteArg(process.execPath)} -e ${quoteArg("process.stdout.write('y'.repeat(2*1024*1024))")}`;
    const runs = await runVerificationCommands(dir, [command], { runId: "big-output" });
    assert.equal(runs[0]?.ok, true, JSON.stringify(runs));
    assert.equal(runs[0].logPath, ".legion-cli/cache/runs/big-output/verify-1.log");
    const log = await readFile(join(dir, ".legion-cli", "cache", "runs", "big-output", "verify-1.log"), "utf8");
    assert.equal(log.length, 2 * 1024 * 1024);
  });
});

test("Linux information-flow verification persists protected logs outside the child view", async (t) => {
  const detected = detectSandbox();
  if (process.platform !== "linux" || detected.backend !== "bwrap" || !detected.hardened) {
    t.skip(`requires Linux with hardened bwrap (detected ${process.platform}/${detected.backend})`);
    return;
  }

  await withEngine(async ({ dir }) => {
    const runId = "information-flow-protected-log-test";
    const runHash = createHash("sha256").update(runId, "utf8").digest("hex");
    const logPath = `.legion-cli/audit/raw-logs/${runHash}/verify-1.log`;
    const protectedLogDirectory = join(dir, ".legion-cli", "audit", "raw-logs", runHash);
    const protectedCanary = join(protectedLogDirectory, "existing-private-log.log");
    const visibilityPath = join(dir, "visibility.json");
    const controlPath = join(dir, ".legion-cli", "STATE.md");
    await mkdir(protectedLogDirectory, { recursive: true });
    await writeFile(protectedCanary, "private verification log");
    await writeFile(controlPath, "private-control");

    const script = [
      "const fs=require('node:fs');",
      "const canRead=(path)=>{try{fs.readFileSync(path,'utf8');return true}catch{return false}};",
      "process.stdout.write('consumer-visible-output\\n');",
      `fs.writeFileSync('visibility.json',JSON.stringify({rawLog:canRead(${JSON.stringify(protectedCanary)}),control:canRead('.legion-cli/STATE.md')}));`,
    ].join("");
    const command = `${quoteArg(process.execPath)} -e ${quoteArg(script)}`;
    const runs = await runVerificationCommands(dir, [command], {
      runId,
      informationFlow: {
        label: { origins: ["file-verification-test"], integrity: "approved", confidentiality: "workspace" },
        installedEnginePaths: [],
        readOnlyEnginePaths: [],
      },
    });

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.ok, true, JSON.stringify(runs));
    assert.equal(runs[0]?.logPath, logPath);
    assert.deepEqual(runs[0]?.informationFlow && {
      origins: runs[0].informationFlow.origins,
      integrity: runs[0].informationFlow.integrity,
      confidentiality: runs[0].informationFlow.confidentiality,
    }, {
      origins: ["file-verification-test"],
      integrity: "approved",
      confidentiality: "workspace",
    });
    assert.equal(await readFile(join(dir, ...logPath.split("/")), "utf8"), "consumer-visible-output\n");
    assert.deepEqual(JSON.parse(await readFile(visibilityPath, "utf8")), { rawLog: false, control: false });
  });
});

test("information-flow verification runs, refused or executed, persist as workflow integration evidence", async () => {
  await withEngine(async ({ dir }) => {
    const runs = await runVerificationCommands(dir, [`${quoteArg(process.execPath)} -e process.exit(0)`], {
      runId: "information-flow-evidence-shape",
      informationFlow: {
        label: { origins: ["file-verification-test"], integrity: "untrusted", confidentiality: "sealed" },
        installedEnginePaths: [],
        readOnlyEnginePaths: [],
      },
    });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].informationFlow?.confidentiality, "sealed", JSON.stringify(runs));
    const receipt = WorkflowEvidenceReceiptSchema.parse({
      schemaVersion: SCHEMA_VERSION.workflowEvidence,
      specId: "spec-checkin",
      planFingerprint: "a".repeat(64),
      approvalId: "approval-1",
      productFingerprint: "b".repeat(64),
      environmentFingerprint: "c".repeat(64),
      status: "running",
      completedTaskIds: ["TSK-0001"],
      integration: runs,
      review: null,
      blocker: null,
      updatedAt: "2026-10-04T00:00:00.000Z",
    });
    assert.deepEqual(receipt.integration[0].informationFlow, runs[0].informationFlow);
  });
});

test("`a && b` is refused as argv-only instead of running `a` with extra arguments", async () => {
  await withEngine(async ({ dir }) => {
    const runs = await runVerificationCommands(dir, [`${quoteArg(process.execPath)} -v && echo hi`]);
    assert.equal(runs[0].ok, false);
    assert.equal(runs[0].started, false);
    assert.equal(runs[0].error, "verificationCommands are argv-only; split it into separate commands");
  });
});
