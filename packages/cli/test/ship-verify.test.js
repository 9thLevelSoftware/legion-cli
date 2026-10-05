import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson } from "@9thlevelsoftware/legion-cli-persist";
import { SCHEMA_VERSION } from "@9thlevelsoftware/legion-cli-schema";
import { existsSync } from "node:fs";
import { runCli, withTempDir } from "./helpers.js";
const hash = "a".repeat(64);
const at = "2026-01-01T00:00:00.000Z";
const token = "00000000-0000-4000-8000-000000000001";
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function makeBundle(dir) {
  const bundle = join(dir, "bundle");
  await mkdir(bundle, { recursive: true });
  const content = {
    "product.json": {
      scope: "git-index",
      subjectDigest: hash,
      entries: [{ kind: "gitlink", path: "module", mode: "160000", oid: "b".repeat(40), scope: "referenced-commit-only" }],
    },
    "artifacts.json": { artifacts: [] },
    "evidence.json": {
      approvalId: "approval-1", specId: null, manifestDigest: null,
      executionFingerprint: hash, environmentFingerprint: hash, mode: "not-adopted",
      checks: [], acceptance: [], policyDigest: null, modelDigest: null, sourceScope: "whole-working-product",
    },
    "trace.json": { schemaVersion: SCHEMA_VERSION.governanceTrace, status: "not-adopted", frames: [] },
    "predicate.json": {
      schemaVersion: SCHEMA_VERSION.deliveryPredicate, confirmation: token, approval: null, spec: null,
      assuranceManifestDigest: null, subjectDigest: hash, executionDigest: hash, mode: "not-adopted",
      traceStatus: "not-adopted", modelDigest: null, policyDigest: null, identities: [], checks: [],
      acceptance: [], preparedAt: at,
    },
  };
  const members = [];
  for (const path of Object.keys(content).sort()) {
    const bytes = Buffer.from(canonicalJson(content[path]));
    await writeFile(join(bundle, path), bytes);
    members.push({ path, sha256: digest(bytes), size: bytes.length });
  }
  const manifest = {
    schemaVersion: SCHEMA_VERSION.deliveryManifest, confirmationId: "confirmation-1", approvalId: "approval-1",
    snapshotDigest: hash, executionFingerprint: hash, environmentFingerprint: hash, subjectDigest: hash,
    deliveredScope: "git-index", createdAt: at, members,
  };
  await writeFile(join(bundle, "manifest.json"), canonicalJson(manifest));
  return bundle;
}

test("ship verify reports valid bundle integrity as JSON without project state", async () => {
  await withTempDir(async (dir) => {
    const bundle = await makeBundle(dir);
    const result = runCli(["ship", "verify", bundle, "--json", "--project", dir]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, true);
    assert.equal(report.integrity.status, "valid");
    assert.equal(report.authenticity.status, "unverified");
    assert.equal(report.suppliedContent.status, "not-supplied");
    assert.equal(report.claims.status, "self-reported");
    assert.deepEqual(Object.keys(report).sort(), ["authenticity", "claims", "integrity", "passed", "predicate", "requirement", "suppliedContent"].sort());
    const predicateSha256 = digest(await readFile(join(bundle, "predicate.json")));
    assert.deepEqual(report.predicate, { sha256: predicateSha256 });
    assert.equal(existsSync(join(dir, ".legion-cli")), false);
    const human = runCli(["ship", "verify", bundle]);
    assert.equal(human.status, 0, `${human.stdout}\n${human.stderr}`);
    assert.match(human.stdout, /Bundle integrity: valid/);
    assert.match(human.stdout, /Authenticity: unverified/);
    assert.match(human.stdout, /Supplied content: not-supplied/);
    assert.match(human.stdout, /Self-reported approval claim: self-reported/);
    assert.ok(human.stdout.includes(`Public predicate SHA-256: ${predicateSha256} (predicate.json)`), human.stdout);
  });
});

test("ship verify returns failure for an unmet local-key requirement without state mutation", async () => {
  await withTempDir(async (dir) => {
    const bundle = await makeBundle(dir);
    const result = runCli(["ship", "verify", bundle, "--require", "local-key", "--project", dir, "--json"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, false);
    assert.equal(report.authenticity.status, "unverified");
    assert.equal(existsSync(join(dir, ".legion-cli")), false);
  });
});

test("ship verify refuses malformed external trust JSON", async () => {
  await withTempDir(async (dir) => {
    const bundle = await makeBundle(dir);
    const trust = join(dir, "trust.json");
    await writeFile(trust, '{"schemaVersion":"one","schemaVersion":"two"}', "utf8");
    const result = runCli(["ship", "verify", bundle, "--trust-policy", trust]);
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /external trust file is malformed/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /schemaVersion.*one/);
  });
});

test("ship verify fails an expected approval mismatch", async () => {
  await withTempDir(async (dir) => {
    const bundle = await makeBundle(dir);
    const result = runCli(["ship", "verify", bundle, "--expect-approval", "approval-other", "--json"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.claims.status, "approval-mismatch");
    assert.equal(report.claims.approvalId, "approval-1");
  });
});

