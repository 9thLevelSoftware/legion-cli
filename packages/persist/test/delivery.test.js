import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertDeliverySigningKeyOutsideRoots, canonicalJson, signDeliveryBundle, signDeliveryDsse, verifyDeliveryBundle } from "../dist/index.js";
import { SCHEMA_VERSION, DELIVERY_PREDICATE_TYPE } from "@9thlevelsoftware/legion-cli-schema";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const at = "2026-01-01T00:00:00.000Z";
const token = "00000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);

function docs() {
  const sourceBytes = Buffer.from("source body");
  const product = { scope: "git-index", subjectDigest: hash, entries: [{ kind: "gitlink", path: "module", mode: "160000", oid: "b".repeat(40), scope: "referenced-commit-only" }, { kind: "blob", path: "src.txt", mode: "100644", sha256: digest(sourceBytes), size: sourceBytes.length }] };
  const artifacts = { artifacts: [] };
  const evidence = { approvalId: "approval-1", specId: null, manifestDigest: null, executionFingerprint: hash, environmentFingerprint: hash, mode: "not-adopted", checks: [], acceptance: [], policyDigest: null, modelDigest: null, sourceScope: "whole-working-product" };
  const predicate = { schemaVersion: SCHEMA_VERSION.deliveryPredicate, confirmation: token, approval: null, spec: null, assuranceManifestDigest: null, subjectDigest: hash, executionDigest: hash, mode: "not-adopted", traceStatus: "not-adopted", modelDigest: null, policyDigest: null, identities: [], checks: [], acceptance: [], preparedAt: at };
  const trace = { schemaVersion: SCHEMA_VERSION.governanceTrace, status: "not-adopted", frames: [] };
  return { "product.json": product, "artifacts.json": artifacts, "evidence.json": evidence, "trace.json": trace, "predicate.json": predicate };
}
async function bundle(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), "delivery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const members = [];
  const content = docs();
  const deliveredScope = opts.nativeFile ? "host-native-product" : "git-index";
  if (opts.nativeFile) {
    const target = Buffer.from(opts.nativeFile.target);
    content["product.json"] = { scope: deliveredScope, subjectDigest: hash, entries: [{ kind: "native-file", path: opts.nativeFile.path, mode: "native:0777", sha256: digest(target), size: target.length }] };
  }
  for (const path of Object.keys(content).sort()) {
    const body = Buffer.from(canonicalJson(content[path]));
    await writeFile(join(dir, path), body);
    members.push({ path, sha256: digest(body), size: body.length });
  }
  const manifest = { schemaVersion: SCHEMA_VERSION.deliveryManifest, confirmationId: "confirmation-1", approvalId: "approval-1", snapshotDigest: hash, executionFingerprint: hash, environmentFingerprint: hash, subjectDigest: hash, deliveredScope, createdAt: at, members };
  await writeFile(join(dir, "manifest.json"), canonicalJson(manifest));
  if (opts.signature) {
    const manifestBytes = await readFile(join(dir, "manifest.json"));
    const statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: "manifest.json", digest: { sha256: digest(manifestBytes) } }], predicateType: DELIVERY_PREDICATE_TYPE, predicate: content["predicate.json"] };
    const pair = opts.keyPair ?? generateKeyPairSync("ed25519");
    const payload = Buffer.from(canonicalJson(statement));
    const envelope = signDeliveryDsse(payload, pair.privateKey.export({ format: "pem", type: "pkcs8" }));
    await writeFile(join(dir, "signature.dsse.json"), canonicalJson(envelope));
    const pub = pair.publicKey.export({ format: "pem", type: "spki" });
    opts.trust = { schemaVersion: SCHEMA_VERSION.deliveryTrust, localKeys: [{ spkiPem: pub, sha256: digest(pair.publicKey.export({ format: "der", type: "spki" })) }], ci: null };
  }
  return { dir, opts };
}

test("offline local Ed25519 verification uses externally pinned SPKI and exact DSSE bytes", async (t) => {
  const item = await bundle(t, { signature: true });
  const result = await verifyDeliveryBundle(item.dir, { require: "local-key", trustPolicy: item.opts.trust });
  assert.equal(result.integrity.status, "valid");
  assert.equal(result.authenticity.status, "verified");
  assert.equal(result.passed, true);
});

test("verification reports the SHA-256 of the exact predicate.json bytes and null when that member is invalid", async (t) => {
  const item = await bundle(t);
  const result = await verifyDeliveryBundle(item.dir);
  assert.equal(result.integrity.status, "valid");
  assert.deepEqual(result.predicate, { sha256: digest(await readFile(join(item.dir, "predicate.json"))) });

  const tampered = await bundle(t);
  const original = await readFile(join(tampered.dir, "predicate.json"));
  await writeFile(join(tampered.dir, "predicate.json"), Buffer.concat([original, Buffer.from(" ")]));
  const invalid = await verifyDeliveryBundle(tampered.dir);
  assert.equal(invalid.integrity.status, "invalid");
  assert.equal(invalid.predicate, null);
});

test("integrity detects tampered, missing, extra, duplicate-key, and linked files", async (t) => {
  const tampered = await bundle(t);
  await writeFile(join(tampered.dir, "product.json"), "{}");
  assert.equal((await verifyDeliveryBundle(tampered.dir)).integrity.status, "invalid");

  const missing = await bundle(t);
  await rm(join(missing.dir, "trace.json"));
  assert.equal((await verifyDeliveryBundle(missing.dir)).integrity.status, "invalid");

  const extra = await bundle(t);
  await writeFile(join(extra.dir, "surprise.txt"), "x");
  assert.equal((await verifyDeliveryBundle(extra.dir)).integrity.status, "invalid");

  const duplicate = await bundle(t);
  await writeFile(join(duplicate.dir, "manifest.json"), '{"schemaVersion":"legion-cli-delivery-manifest/v1","schemaVersion":"legion-cli-delivery-manifest/v1"}');
  assert.equal((await verifyDeliveryBundle(duplicate.dir)).integrity.status, "invalid");

  const linked = await bundle(t);
  const targetDir = await mkdtemp(join(tmpdir(), "delivery-link-target-"));
  t.after(() => rm(targetDir, { recursive: true, force: true }));
  const elsewhere = join(targetDir, "product-original");
  await writeFile(elsewhere, await readFile(join(linked.dir, "product.json")));
  await rm(join(linked.dir, "product.json"));
  try { await symlink(elsewhere, join(linked.dir, "product.json")); }
  catch { t.skip("platform does not permit creating test symlinks"); return; }
  assert.equal((await verifyDeliveryBundle(linked.dir)).integrity.status, "invalid");
});

test("wrong key, wrong approval, and conflicting second signatures fail closed", async (t) => {
  const item = await bundle(t, { signature: true });
  const { publicKey } = generateKeyPairSync("ed25519");
  const wrongTrust = { ...item.opts.trust, localKeys: [{ spkiPem: publicKey.export({ format: "pem", type: "spki" }), sha256: digest(publicKey.export({ format: "der", type: "spki" })) }] };
  const wrongKey = await verifyDeliveryBundle(item.dir, { require: "local-key", trustPolicy: wrongTrust });
  assert.equal(wrongKey.integrity.status, "valid");
  assert.equal(wrongKey.authenticity.status, "unverified");
  assert.equal(wrongKey.passed, false);
  const approval = await verifyDeliveryBundle(item.dir, { expectedApproval: "different" });
  assert.equal(approval.claims.status, "approval-mismatch");
  assert.equal(approval.passed, false);
  const conflicting = await bundle(t, { signature: true });
  const envelope = JSON.parse(await readFile(join(conflicting.dir, "signature.dsse.json"), "utf8"));
  envelope.payload = Buffer.from("{}").toString("base64");
  await writeFile(join(conflicting.dir, "signature.dsse.json"), canonicalJson(envelope));
  const conflictResult = await verifyDeliveryBundle(conflicting.dir, { require: "local-key", trustPolicy: conflicting.opts.trust });
  assert.equal(conflictResult.integrity.status, "valid");
  assert.equal(conflictResult.authenticity.status, "invalid");

  await writeFile(join(item.dir, "ci.sigstore.json"), "{}");
  const secondSignature = await verifyDeliveryBundle(item.dir);
  assert.equal(secondSignature.integrity.status, "valid");
  assert.equal(secondSignature.authenticity.status, "invalid");
  const ciConflict = await bundle(t);
  await writeFile(join(ciConflict.dir, "signature.dsse.json"), "{}");
  await writeFile(join(ciConflict.dir, "ci.sigstore.json"), "{}");
  const secondMechanism = await verifyDeliveryBundle(ciConflict.dir);
  assert.equal(secondMechanism.integrity.status, "valid");
  assert.equal(secondMechanism.authenticity.status, "invalid");
});

test("supplied source reports unavailable gitlink content separately from bundle integrity", async (t) => {
  const item = await bundle(t);
  const source = await mkdtemp(join(tmpdir(), "delivery-source-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(join(source, "src.txt"), "source body");
  const result = await verifyDeliveryBundle(item.dir, { sourceRoot: source });
  assert.equal(result.integrity.status, "valid");
  assert.equal(result.suppliedContent.status, "unavailable");
  assert.deepEqual(result.suppliedContent.unavailableGitlinks, [`module@${"b".repeat(40)}`]);
});
test("supplied regular content mismatches are separate from bundle integrity", async (t) => {
  const item = await bundle(t);
  const source = await mkdtemp(join(tmpdir(), "delivery-source-mismatch-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(join(source, "src.txt"), "changed");
  const result = await verifyDeliveryBundle(item.dir, { sourceRoot: source });
  assert.equal(result.integrity.status, "valid");
  assert.equal(result.suppliedContent.status, "mismatch");
  assert.equal(result.passed, false);
});

test("host-native source verification hashes a leaf symlink target without following it", async (t) => {
  const target = "missing-native-target";
  const path = "native-link";
  const item = await bundle(t, { nativeFile: { path, target } });
  const source = await mkdtemp(join(tmpdir(), "delivery-native-source-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  try { await symlink(target, join(source, path)); }
  catch { t.skip("platform does not permit creating test symlinks"); return; }
  const result = await verifyDeliveryBundle(item.dir, { sourceRoot: source });
  assert.equal(result.integrity.status, "valid");
  assert.equal(result.suppliedContent.source, "verified");
  assert.equal(result.suppliedContent.status, "verified");
  assert.equal(result.passed, true);
});

test("bundle signing requires project-root context and refuses keys inside the project", async (t) => {
  const item = await bundle(t);
  const keyDir = await mkdtemp(join(tmpdir(), "delivery-key-"));
  const projectDir = await mkdtemp(join(tmpdir(), "delivery-project-"));
  t.after(() => rm(keyDir, { recursive: true, force: true }));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519");
  const keyBytes = pair.privateKey.export({ format: "pem", type: "pkcs8" });
  const keyPath = join(keyDir, "delivery-key.pem");
  const projectKeyPath = join(projectDir, "in-project-key.pem");
  await writeFile(keyPath, keyBytes);
  await writeFile(projectKeyPath, keyBytes);
  await assert.rejects(signDeliveryBundle(item.dir, projectKeyPath, { projectRoot: projectDir }));
  await assert.rejects(assertDeliverySigningKeyOutsideRoots(keyPath, item.dir, [keyDir]));
  await signDeliveryBundle(item.dir, keyPath, { projectRoot: projectDir });
  const publicKey = pair.publicKey.export({ format: "pem", type: "spki" });
  const trustPolicy = { schemaVersion: SCHEMA_VERSION.deliveryTrust, localKeys: [{ spkiPem: publicKey, sha256: digest(pair.publicKey.export({ format: "der", type: "spki" })) }], ci: null };
  const result = await verifyDeliveryBundle(item.dir, { require: "local-key", trustPolicy });
  assert.equal(result.authenticity.status, "verified");
  assert.equal(result.passed, true);
});

test("bundle signing supports encrypted external PKCS8 keys with an in-memory passphrase", async (t) => {
  const item = await bundle(t);
  const keyDir = await mkdtemp(join(tmpdir(), "delivery-encrypted-key-"));
  t.after(() => rm(keyDir, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519");
  const passphrase = "local signing secret";
  const keyPath = join(keyDir, "encrypted-key.pem");
  await writeFile(keyPath, pair.privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase }));
  const envelope = await signDeliveryBundle(item.dir, keyPath, { projectRoot: item.dir, passphrase });
  assert.equal(envelope.signatures.length, 1);
  const publicKey = pair.publicKey.export({ format: "pem", type: "spki" });
  const trustPolicy = { schemaVersion: SCHEMA_VERSION.deliveryTrust, localKeys: [{ spkiPem: publicKey, sha256: digest(pair.publicKey.export({ format: "der", type: "spki" })) }], ci: null };
  const result = await verifyDeliveryBundle(item.dir, { require: "local-key", trustPolicy });
  assert.equal(result.authenticity.status, "verified");
});

test("encrypted signing keys refuse missing and wrong passphrases generically", async (t) => {
  const item = await bundle(t);
  const keyDir = await mkdtemp(join(tmpdir(), "delivery-encrypted-key-"));
  t.after(() => rm(keyDir, { recursive: true, force: true }));
  const keyPath = join(keyDir, "encrypted-key.pem");
  const keyBytes = generateKeyPairSync("ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8",
    cipher: "aes-256-cbc",
    passphrase: "correct passphrase",
  });
  await writeFile(keyPath, keyBytes);
  await assert.rejects(
    signDeliveryBundle(item.dir, keyPath, { projectRoot: item.dir }),
    (error) => error.name === "EncryptedDeliveryKeyError",
  );
  await assert.rejects(
    signDeliveryBundle(item.dir, keyPath, { projectRoot: item.dir, passphrase: "wrong passphrase" }),
    (error) => error.name === "DeliveryRefusalError" &&
      !/openssl|decrypt|bad password|correct passphrase|wrong passphrase/i.test(error.message),
  );
  await assert.rejects(
    signDeliveryBundle(item.dir, keyPath, { projectRoot: item.dir, passphrase: "x".repeat(4097) }),
    (error) => error.name === "DeliveryRefusalError" && /supported input limit/.test(error.message),
  );
  assert.equal((await readdir(item.dir)).includes("signature.dsse.json"), false);
});

test("CI-OIDC verification rejects an external trusted-root digest mismatch before invoking gh", async (t) => {
  const item = await bundle(t);
  await writeFile(join(item.dir, "ci.sigstore.json"), "{}");
  const rootDir = await mkdtemp(join(tmpdir(), "delivery-root-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const rootPath = join(rootDir, "trusted-root.jsonl");
  const rootBytes = Buffer.from('{"trustedRoot":true}\n');
  await writeFile(rootPath, rootBytes);
  const trustPolicy = {
    schemaVersion: SCHEMA_VERSION.deliveryTrust,
    localKeys: [],
    ci: {
      repository: "owner/repo",
      certificateSan: "https://github.com/owner/repo/.github/workflows/delivery.yml@refs/heads/main",
      issuer: "https://token.actions.githubusercontent.com",
      signerWorkflow: "owner/repo/.github/workflows/delivery.yml",
      signerDigest: "a".repeat(40),
      sourceDigest: "b".repeat(40),
      trustedRootPath: rootPath,
      trustedRootSha256: "c".repeat(64),
      trustedRootCapturedAt: new Date().toISOString(),
    },
  };
  const result = await verifyDeliveryBundle(item.dir, { require: "ci-oidc", trustPolicy });
  assert.equal(result.passed, false);
  assert.equal(result.authenticity.status, "invalid");
  assert.match(result.authenticity.reason, /trusted-root digest/i);
});

test("CI-OIDC verification rejects an expired trusted-root snapshot before invoking gh", async (t) => {
  const item = await bundle(t);
  await writeFile(join(item.dir, "ci.sigstore.json"), "{}");
  const rootDir = await mkdtemp(join(tmpdir(), "delivery-root-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const rootPath = join(rootDir, "trusted-root.jsonl");
  const rootBytes = Buffer.from('{"trustedRoot":true}\n');
  await writeFile(rootPath, rootBytes);
  const trustPolicy = {
    schemaVersion: SCHEMA_VERSION.deliveryTrust,
    localKeys: [],
    ci: {
      repository: "owner/repo",
      certificateSan: "https://github.com/owner/repo/.github/workflows/delivery.yml@refs/heads/main",
      issuer: "https://token.actions.githubusercontent.com",
      signerWorkflow: "owner/repo/.github/workflows/delivery.yml",
      signerDigest: "a".repeat(40),
      sourceDigest: "b".repeat(40),
      trustedRootPath: rootPath,
      trustedRootSha256: digest(rootBytes),
      trustedRootCapturedAt: "2020-01-01T00:00:00.000Z",
    },
  };
  const result = await verifyDeliveryBundle(item.dir, { require: "ci-oidc", trustPolicy });
  assert.equal(result.passed, false);
  assert.equal(result.authenticity.status, "invalid");
  assert.match(result.authenticity.reason, /older than 90 days/i);
});

async function ciFixture(t) {
  const item = await bundle(t);
  await writeFile(join(item.dir, "ci.sigstore.json"), "{}");
  const rootDir = await mkdtemp(join(tmpdir(), "delivery-root-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const rootPath = join(rootDir, "trusted-root.jsonl");
  const rootBytes = Buffer.from('{"trustedRoot":true}\n');
  await writeFile(rootPath, rootBytes);
  const trustPolicy = {
    schemaVersion: SCHEMA_VERSION.deliveryTrust,
    localKeys: [],
    ci: {
      repository: "owner/repo",
      certificateSan: "https://github.com/owner/repo/.github/workflows/delivery.yml@refs/heads/main",
      issuer: "https://token.actions.githubusercontent.com",
      signerWorkflow: "owner/repo/.github/workflows/delivery.yml",
      signerDigest: "a".repeat(40),
      sourceDigest: "b".repeat(40),
      trustedRootPath: rootPath,
      trustedRootSha256: digest(rootBytes),
      trustedRootCapturedAt: new Date().toISOString(),
    },
  };
  return { item, trustPolicy };
}

async function withPathAndCwd(value, cwd, run) {
  const keys = Object.keys(process.env).filter((key) => key.toUpperCase() === "PATH");
  const saved = keys.map((key) => [key, process.env[key]]);
  const savedCwd = process.cwd();
  for (const key of keys) delete process.env[key];
  process.env[process.platform === "win32" ? "Path" : "PATH"] = value;
  process.chdir(cwd);
  try {
    return await run();
  } finally {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env).filter((k) => k.toUpperCase() === "PATH")) delete process.env[key];
    for (const [key, savedValue] of saved) process.env[key] = savedValue;
  }
}

async function plantGh(dir, marker) {
  if (process.platform === "win32") await writeFile(join(dir, "gh.exe"), "not a real executable");
  else await writeFile(join(dir, "gh"), `#!/bin/sh\necho planted > '${marker}'\n`, { mode: 0o755 });
}

test("CI-OIDC verification never executes a gh reached through cwd or empty/relative PATH entries", async (t) => {
  const { item, trustPolicy } = await ciFixture(t);
  const plantDir = await mkdtemp(join(tmpdir(), "delivery-planted-gh-"));
  const emptyDir = await mkdtemp(join(tmpdir(), "delivery-empty-path-"));
  t.after(() => Promise.all([rm(plantDir, { recursive: true, force: true }), rm(emptyDir, { recursive: true, force: true })]));
  const marker = join(emptyDir, "planted-ran");
  await plantGh(plantDir, marker);
  const separator = process.platform === "win32" ? ";" : ":";
  const result = await withPathAndCwd(["", ".", emptyDir].join(separator), plantDir, () => verifyDeliveryBundle(item.dir, { require: "ci-oidc", trustPolicy }));
  assert.equal(result.passed, false);
  assert.equal(result.authenticity.status, "invalid");
  assert.match(result.authenticity.reason, /no gh executable on an absolute PATH entry/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("CI-OIDC verification runs the absolute PATH gh with the private config directory as cwd", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake gh requires a POSIX shell script; Windows resolution is covered by the shim refusal test");
    return;
  }
  const { item, trustPolicy } = await ciFixture(t);
  const binDir = await mkdtemp(join(tmpdir(), "delivery-gh-bin-"));
  const plantDir = await mkdtemp(join(tmpdir(), "delivery-planted-gh-"));
  t.after(() => Promise.all([rm(binDir, { recursive: true, force: true }), rm(plantDir, { recursive: true, force: true })]));
  const marker = join(binDir, "trusted-ran");
  await writeFile(join(binDir, "gh"), `#!/bin/sh\npwd > '${marker}'\nexit 3\n`, { mode: 0o755 });
  await plantGh(plantDir, join(binDir, "planted-ran"));
  const result = await withPathAndCwd([".", binDir].join(":"), plantDir, () => verifyDeliveryBundle(item.dir, { require: "ci-oidc", trustPolicy }));
  assert.equal(result.authenticity.status, "invalid");
  assert.match(result.authenticity.reason, /refused \(exit 3\)/);
  assert.match((await readFile(marker, "utf8")).trim(), /delivery-gh-config-/);
  await assert.rejects(readFile(join(binDir, "planted-ran")), { code: "ENOENT" });
});

test("CI-OIDC verification refuses a Windows gh script shim instead of running it through a shell", async (t) => {
  if (process.platform !== "win32") {
    t.skip("script shims are a Windows PATHEXT concern");
    return;
  }
  const { item, trustPolicy } = await ciFixture(t);
  const binDir = await mkdtemp(join(tmpdir(), "delivery-gh-shim-"));
  t.after(() => rm(binDir, { recursive: true, force: true }));
  const marker = join(binDir, "shim-ran");
  await writeFile(join(binDir, "gh.cmd"), `@echo ran> "${marker}"\r\n`);
  const result = await withPathAndCwd(binDir, process.cwd(), () => verifyDeliveryBundle(item.dir, { require: "ci-oidc", trustPolicy }));
  assert.equal(result.authenticity.status, "invalid");
  assert.match(result.authenticity.reason, /only a script shim was found/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});
