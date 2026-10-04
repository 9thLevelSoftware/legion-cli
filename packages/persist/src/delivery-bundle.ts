import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import {
  DELIVERY_PREDICATE_TYPE,
  DeliveryArtifactsSchema,
  DeliveryEvidenceSchema,
  DeliveryManifestSchema,
  DeliveryPredicateSchema,
  DeliveryProductSchema,
  DeliverySnapshotSchema,
  DeliveryStatementSchema,
  GovernanceTraceSchema,
  SCHEMA_VERSION,
  type DeliverySnapshot,
} from "@9thlevelsoftware/legion-cli-schema";
import { canonicalJson } from "./canonical-json.js";

const MEMBER_MAX_BYTES = 64 * 1024 * 1024;
const BUNDLE_MAX_BYTES = 256 * 1024 * 1024;
const MEMBER_SCHEMAS = {
  "artifacts.json": DeliveryArtifactsSchema,
  "evidence.json": DeliveryEvidenceSchema,
  "predicate.json": DeliveryPredicateSchema,
  "product.json": DeliveryProductSchema,
  "trace.json": GovernanceTraceSchema,
} as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function assertCompleteSnapshot(snapshot: DeliverySnapshot): Extract<DeliverySnapshot, { state: "complete" }> {
  const parsed = DeliverySnapshotSchema.parse(snapshot);
  if (parsed.state !== "complete") throw new TypeError("Only complete delivery snapshots can be exported");
  const preparedDigest = sha256(Buffer.from(`legion-cli/delivery-prepared/v1\0${canonicalJson(parsed.prepared)}`, "utf8"));
  if (preparedDigest !== parsed.preparedDigest) throw new TypeError("Delivery snapshot prepared digest is inconsistent");
  const sealedDigest = sha256(Buffer.from(canonicalJson({ preparedDigest, outcome: parsed.outcome, completedTrace: parsed.completedTrace }), "utf8"));
  if (sealedDigest !== parsed.sealedDigest) throw new TypeError("Delivery snapshot seal is inconsistent");
  if (parsed.prepared.captureMode === "adopted") {
    const trace = parsed.completedTrace;
    if (trace.status !== "valid") throw new TypeError("Completed delivery trace must contain successful ship-confirm and ship-complete actions");
    const confirmIndex = trace.frames.findIndex((frame) =>
      frame.action === "ship-confirm" && frame.boundary === "end" && frame.outcome === "success" && frame.after !== null &&
      frame.after.ship.confirmationId === parsed.prepared.confirmationId && frame.after.ship.confirmed,
    );
    const completeIndex = trace.frames.findIndex((frame, index) =>
      index > confirmIndex && frame.action === "ship-complete" && frame.boundary === "end" && frame.outcome === "success" && frame.after !== null &&
      frame.after.ship.confirmationId === parsed.prepared.confirmationId && frame.after.ship.confirmed && frame.after.ship.status === "complete",
    );
    if (confirmIndex < 0 || completeIndex < 0) {
      throw new TypeError("Completed delivery trace must bind successful ship-confirm and ship-complete actions to this confirmation");
    }
  } else {
    const trace = parsed.completedTrace;
    if (trace.status !== "not-adopted" || trace.frames.length !== 0) {
      throw new TypeError("Legacy delivery trace must be not-adopted with no frames");
    }
  }
  return parsed;
}

async function assertNoLinkedPath(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || (cursor !== absolute && !stat.isDirectory())) throw new TypeError("Bundle path traverses a link or non-directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

/**
 * Canonicalize the deepest existing ancestor of `path` (resolving system aliases such as macOS
 * /var → /private/var) and append the components still to be created. Links at or beneath the
 * returned path, including the parents created for publication, remain refused by assertNoLinkedPath.
 */
async function canonicalPublicationPath(path: string): Promise<string> {
  const missing: string[] = [];
  let cursor = resolve(path);
  for (;;) {
    try {
      await lstat(cursor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
  let existing: string;
  try {
    existing = await realpath(cursor);
  } catch {
    throw new TypeError("Bundle path traverses a link or non-directory");
  }
  return join(existing, ...missing);
}

async function writeNewFile(directory: string, name: string, bytes: Buffer): Promise<void> {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
    (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
  const handle = await open(join(directory, name), flags, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type DeliveryBundleExport = { manifestSha256: string; snapshotDigest: string; predicateSha256: string };

/** Export the immutable facts in a completed snapshot without consulting mutable project files. */
export async function exportDeliveryBundle(
  snapshot: DeliverySnapshot,
  directory: string,
): Promise<DeliveryBundleExport> {
  const completed = assertCompleteSnapshot(snapshot);
  const prepared = completed.prepared;
  const docs = {
    "artifacts.json": prepared.artifacts,
    "evidence.json": prepared.evidence,
    "predicate.json": prepared.predicate,
    "product.json": prepared.product,
    "trace.json": completed.completedTrace,
  } as const;
  const memberBytes = new Map<string, Buffer>();
  const members = Object.keys(MEMBER_SCHEMAS).sort().map((path) => {
    const name = path as keyof typeof MEMBER_SCHEMAS;
    const document = MEMBER_SCHEMAS[name].parse(docs[name]);
    const bytes = canonicalBytes(document);
    if (bytes.length > MEMBER_MAX_BYTES) throw new RangeError(`Bundle member exceeds 64 MiB: ${name}`);
    memberBytes.set(name, bytes);
    return { path: name, sha256: sha256(bytes), size: bytes.length };
  });
  const manifest = DeliveryManifestSchema.parse({
    schemaVersion: SCHEMA_VERSION.deliveryManifest,
    confirmationId: prepared.confirmationId,
    approvalId: prepared.approvalId,
    snapshotDigest: completed.sealedDigest,
    executionFingerprint: prepared.executionFingerprint,
    environmentFingerprint: prepared.environmentFingerprint,
    subjectDigest: prepared.product.subjectDigest,
    deliveredScope: prepared.product.scope,
    createdAt: completed.outcome.recordedAt,
    members,
  });
  const manifestBytes = canonicalBytes(manifest);
  if (manifestBytes.length > 1024 * 1024) throw new RangeError("Bundle manifest exceeds 1 MiB");
  const bundleBytes = manifestBytes.length + members.reduce((total, member) => total + member.size, 0);
  if (bundleBytes > BUNDLE_MAX_BYTES) throw new RangeError("Bundle exceeds 256 MiB");

  // Statements are embedded in the optional DSSE signature envelope, never standalone bundle members.
  const statement = DeliveryStatementSchema.parse({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "manifest.json", digest: { sha256: sha256(manifestBytes) } }],
    predicateType: DELIVERY_PREDICATE_TYPE,
    predicate: prepared.predicate,
  });
  canonicalBytes(statement);

  const requested = resolve(directory);
  const parent = await canonicalPublicationPath(dirname(requested));
  const target = join(parent, basename(requested));
  const publicationLock = join(parent, `.${basename(target)}.publish-lock`);
  await assertNoLinkedPath(parent);
  await mkdir(parent, { recursive: true });
  await assertNoLinkedPath(parent);
  await assertNoLinkedPath(target);
  const staging = await mkdtemp(join(parent, `.${basename(target)}.tmp-`));
  let lockIdentity: string | undefined;
  try {
    await assertNoLinkedPath(target);
    for (const [name, bytes] of memberBytes) await writeNewFile(staging, name, bytes);
    await writeNewFile(staging, "manifest.json", manifestBytes);
    try {
      await mkdir(publicationLock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Bundle destination is already being published");
      throw error;
    }
    const lock = await lstat(publicationLock, { bigint: true });
    if (!lock.isDirectory() || lock.isSymbolicLink()) throw new TypeError("Bundle publication lock is not a regular directory");
    lockIdentity = `${lock.dev}:${lock.ino}`;
    try {
      await lstat(target);
      throw new Error("Bundle destination already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staging, target);
  } finally {
    if (lockIdentity !== undefined) {
      try {
        const current = await lstat(publicationLock, { bigint: true });
        if (current.isDirectory() && `${current.dev}:${current.ino}` === lockIdentity) await rm(publicationLock, { recursive: true });
      } catch {
        // Keep any publication lock that no longer matches our exclusive reservation.
      }
    }
    await rm(staging, { recursive: true, force: true });
  }
  return {
    manifestSha256: sha256(manifestBytes),
    snapshotDigest: completed.sealedDigest,
    predicateSha256: sha256(memberBytes.get("predicate.json")!),
  };
}
