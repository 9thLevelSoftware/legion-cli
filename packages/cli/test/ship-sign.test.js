import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, verifyDeliveryBundle } from "@9thlevelsoftware/legion-cli-persist";
import { SCHEMA_VERSION } from "@9thlevelsoftware/legion-cli-schema";
import { runCli, withTempDir } from "./helpers.js";

const hash = "a".repeat(64);
const at = "2026-01-01T00:00:00.000Z";
const token = "00000000-0000-4000-8000-000000000001";
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function makeBundle(dir) {
  const bundle = join(dir, "bundle");
  await mkdir(bundle, { recursive: true });
  const content = {
    "product.json": { scope: "git-index", subjectDigest: hash, entries: [{ kind: "gitlink", path: "module", mode: "160000", oid: "b".repeat(40), scope: "referenced-commit-only" }] },
    "artifacts.json": { artifacts: [] },
    "evidence.json": { approvalId: "approval-1", specId: null, manifestDigest: null, executionFingerprint: hash, environmentFingerprint: hash, mode: "not-adopted", checks: [], acceptance: [], policyDigest: null, modelDigest: null, sourceScope: "whole-working-product" },
    "trace.json": { schemaVersion: SCHEMA_VERSION.governanceTrace, status: "not-adopted", frames: [] },
    "predicate.json": { schemaVersion: SCHEMA_VERSION.deliveryPredicate, confirmation: token, approval: null, spec: null, assuranceManifestDigest: null, subjectDigest: hash, executionDigest: hash, mode: "not-adopted", traceStatus: "not-adopted", modelDigest: null, policyDigest: null, identities: [], checks: [], acceptance: [], preparedAt: at },
  };
  const members = [];
  for (const path of Object.keys(content).sort()) {
    const bytes = Buffer.from(canonicalJson(content[path]));
    await writeFile(join(bundle, path), bytes);
    members.push({ path, sha256: digest(bytes), size: bytes.length });
  }
  await writeFile(join(bundle, "manifest.json"), canonicalJson({
    schemaVersion: SCHEMA_VERSION.deliveryManifest, confirmationId: "confirmation-1", approvalId: "approval-1",
    snapshotDigest: hash, executionFingerprint: hash, environmentFingerprint: hash, subjectDigest: hash,
    deliveredScope: "git-index", createdAt: at, members,
  }));
  return bundle;
}

test("ship sign explicitly signs a prepared bundle with an externally pinned Ed25519 key", async () => {
  await withTempDir(async (dir) => {
    const project = join(dir, "project");
    await mkdir(project);
    const bundle = await makeBundle(project);
    const pair = generateKeyPairSync("ed25519");
    const privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" });
    const keyPath = join(dir, "outside-project-key.pem");
    await writeFile(keyPath, privateKey);
    const result = runCli(["ship", "sign", bundle, "--key", keyPath, "--project", project, "--json"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.signed, true);
    assert.equal(report.signatureCount, 1);
    assert.deepEqual(report.keyIds, [digest(pair.publicKey.export({ format: "der", type: "spki" }))]);
    assert.equal(report.bundle, bundle);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /PRIVATE KEY/);

    const publicKey = pair.publicKey.export({ format: "pem", type: "spki" });
    const verification = await verifyDeliveryBundle(bundle, {
      require: "local-key",
      trustPolicy: { schemaVersion: SCHEMA_VERSION.deliveryTrust, localKeys: [{ spkiPem: publicKey, sha256: digest(pair.publicKey.export({ format: "der", type: "spki" })) }], ci: null },
    });
    assert.equal(verification.passed, true);
    assert.equal(verification.authenticity.status, "verified");
    assert.equal(existsSync(join(project, ".legion-cli")), false);
  });
});

test("ship sign refuses an in-project key without writing a signature", async () => {
  await withTempDir(async (dir) => {
    const project = join(dir, "project");
    await mkdir(project);
    const bundle = await makeBundle(project);
    const pair = generateKeyPairSync("ed25519");
    const keyPath = join(project, "private-key.pem");
    await writeFile(keyPath, pair.privateKey.export({ format: "pem", type: "pkcs8" }));
    const result = runCli(["ship", "sign", bundle, "--key", keyPath, "--project", project]);
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /ship sign refused the bundle or signing key/);
    assert.equal(existsSync(join(bundle, "signature.dsse.json")), false);
  });
});

test("ship sign refuses a wrong key without exposing its contents", async () => {
  await withTempDir(async (dir) => {
    const project = join(dir, "project");
    await mkdir(project);
    const bundle = await makeBundle(project);
    const keyPaths = [
      [join(dir, "wrong-key.pem"), "NOT-A-PRIVATE-KEY-secret-key-material"],
      [join(dir, "encrypted-key.pem"), generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "must-not-leak" })],
    ];
    for (const [keyPath, keyBytes] of keyPaths) {
      await writeFile(keyPath, keyBytes);
      const result = runCli(["ship", "sign", bundle, "--key", keyPath, "--project", project]);
      assert.equal(result.status, 1);
      assert.match(`${result.stdout}\n${result.stderr}`, /ship sign refused the bundle or signing key/);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /secret-key-material|NOT-A-PRIVATE-KEY|must-not-leak|PRIVATE KEY/);
      assert.equal(existsSync(join(bundle, "signature.dsse.json")), false);
      assert.equal((await readFile(keyPath, "utf8")), keyBytes.toString());
    }
  });
});

test("ship sign refuses an encrypted key noninteractively without exposing passphrase details", async () => {
  await withTempDir(async (dir) => {
    const project = join(dir, "project");
    await mkdir(project);
    const bundle = await makeBundle(project);
    const keyPath = join(dir, "encrypted-key.pem");
    const keyBytes = generateKeyPairSync("ed25519").privateKey.export({
      format: "pem",
      type: "pkcs8",
      cipher: "aes-256-cbc",
      passphrase: "must-not-leak",
    });
    await writeFile(keyPath, keyBytes);
    const result = runCli(["ship", "sign", bundle, "--key", keyPath, "--project", project]);
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /ship sign refused the bundle or signing key/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /must-not-leak|PRIVATE KEY|decrypt|bad password/i);
    assert.equal(existsSync(join(bundle, "signature.dsse.json")), false);
  });
});

test("ship sign discovers an enclosing project root when invoked from a nested directory", async () => {
  await withTempDir(async (dir) => {
    const project = join(dir, "project");
    const nested = join(project, "nested");
    const control = join(project, ".legion-cli");
    await mkdir(nested, { recursive: true });
    await mkdir(control);
    const bundle = await makeBundle(project);
    const keyPath = join(control, "private-key.pem");
    await writeFile(keyPath, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
    const result = runCli(["ship", "sign", bundle, "--key", keyPath, "--project", nested]);
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /ship sign refused the bundle or signing key/);
    assert.equal(existsSync(join(bundle, "signature.dsse.json")), false);
  });
});

