import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { readdir, mkdir, lstat, open, link, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DeliveryExportSchema,
  DeliveryOutcomeSchema,
  DeliverySnapshotSchema,
  OpaqueIdSchema,
  SCHEMA_VERSION,
  type DeliveryExport,
  type DeliveryOutcome,
  type DeliverySnapshot,
  type GovernanceTrace,
} from "@9thlevelsoftware/legion-cli-schema";
import { assertNoLinkInPath } from "./atomic-write.js";
import { canonicalJson } from "./canonical-json.js";
import { parseStrictJson } from "./strict-json.js";
import type { LegionStore } from "./store.js";
export type { DeliveryExport, DeliveryOutcome, DeliverySnapshot } from "@9thlevelsoftware/legion-cli-schema";

export type DeliverySnapshotLockOwnership = { assertLockOwned: () => void };
export type PreparedDeliverySnapshot = Extract<DeliverySnapshot, { state: "prepared" }>["prepared"];
export const DELIVERY_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
export const DELIVERY_EXPORT_MAX_ATTEMPTS = 1024;
const SNAPSHOT_ROOT = ".legion-cli/audit/delivery";
const EXPORT_ROOT = ".legion-cli/audit/delivery-export";
const FILES: Record<string, true> = { "prepared.json": true, "outcome.yaml": true, "complete.json": true, "aborted.json": true };

export function deliverySnapshotDirectory(confirmationId: string): string {
  assertId(confirmationId, "confirmation ID");
  return `${SNAPSHOT_ROOT}/${hash(confirmationId)}`;
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function digestPrepared(prepared: PreparedDeliverySnapshot): string {
  return createHash("sha256").update("legion-cli/delivery-prepared/v1\0", "utf8").update(canonicalJson(prepared), "utf8").digest("hex");
}
function assertId(value: string, name: string): void {
  if (!OpaqueIdSchema.safeParse(value).success) throw new TypeError(`Invalid ${name}`);
}
function assertOwned(store: LegionStore, lock: DeliverySnapshotLockOwnership): void {
  if (!store.holdsLock()) throw new Error("Delivery snapshot mutation requires the store lock");
  if (!lock || typeof lock.assertLockOwned !== "function") throw new Error("Delivery snapshot mutation requires lock ownership");
  lock.assertLockOwned();
}
function snapshotDir(store: LegionStore, confirmationId: string): string {
  return join(store.projectRoot, deliverySnapshotDirectory(confirmationId));
}
async function dirNames(abs: string): Promise<string[]> {
  try { return await readdir(abs); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function readRecord<T>(root: string, abs: string, maxBytes: number, schema: { safeParse(value: unknown): { success: boolean; data?: T } }, canonical = false): Promise<T | null> {
  await assertNoLinkInPath(abs, { root });
  let handle: FileHandle | undefined;
  let bytes: Buffer;
  try {
    handle = await open(abs, fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0));
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) throw new RangeError("Delivery record exceeds maximum byte length");
    bytes = await handle.readFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
  if (bytes.length > maxBytes) throw new RangeError("Delivery record exceeds maximum byte length");
  const parsed = schema.safeParse(parseStrictJson(bytes, { maxBytes, maxDepth: 32 }));
  if (!parsed.success) throw new Error(`Invalid durable delivery record: ${abs}`);
  if (canonical && !bytes.equals(Buffer.from(`${canonicalJson(parsed.data)}\n`, "utf8"))) throw new Error(`Noncanonical durable delivery record: ${abs}`);
  return parsed.data as T;
}
type SnapshotRecords = { prepared: DeliverySnapshot | null; outcome: DeliveryOutcome | null; complete: DeliverySnapshot | null; aborted: DeliverySnapshot | null };
async function readSnapshotRecords(store: LegionStore, confirmationId: string): Promise<SnapshotRecords> {
  assertId(confirmationId, "confirmation ID");
  const rel = deliverySnapshotDirectory(confirmationId);
  const abs = join(store.projectRoot, rel);
  await assertNoLinkInPath(abs, { root: store.projectRoot });
  const names = await dirNames(abs);
  if (names.some((name) => FILES[name] !== true)) throw new Error("Delivery snapshot directory contains unexpected files");
  const prepared = await readRecord(store.projectRoot, join(abs, "prepared.json"), DELIVERY_SNAPSHOT_MAX_BYTES, DeliverySnapshotSchema);
  const outcome = await readRecord(store.projectRoot, join(abs, "outcome.yaml"), 16 * 1024, DeliveryOutcomeSchema, true);
  const complete = await readRecord(store.projectRoot, join(abs, "complete.json"), DELIVERY_SNAPSHOT_MAX_BYTES, DeliverySnapshotSchema);
  const aborted = await readRecord(store.projectRoot, join(abs, "aborted.json"), DELIVERY_SNAPSHOT_MAX_BYTES, DeliverySnapshotSchema);
  for (const [filename, record, state] of [["prepared.json", prepared, "prepared"], ["complete.json", complete, "complete"], ["aborted.json", aborted, "aborted"]] as const) {
    if ((names.includes(filename)) !== (record !== null)) throw new Error("Delivery snapshot contains an unreadable or ambiguous record");
    if (record && record.state !== state) throw new Error("Delivery snapshot record state mismatch");
    if (record && record.prepared.confirmationId !== confirmationId) throw new Error("Delivery snapshot identity mismatch");
  }
  if ((names.includes("outcome.yaml")) !== (outcome !== null)) throw new Error("Delivery snapshot contains an unreadable or ambiguous record");
  if (outcome && outcome.confirmationId !== confirmationId) throw new Error("Delivery outcome identity mismatch");
  if ((complete && aborted) || (outcome && aborted) || (!!complete !== !!(names.includes("complete.json"))) || (!!aborted !== !!(names.includes("aborted.json")))) throw new Error("Delivery snapshot has ambiguous terminal state");
  if ((outcome || complete || aborted) && !prepared) throw new Error("Delivery snapshot outcome or terminal record has no prepared facts");
  if (prepared && digestPrepared(prepared.prepared) !== prepared.preparedDigest) throw new Error("Immutable prepared delivery facts were modified");
  if (outcome && prepared) {
    if (outcome.preparedDigest !== prepared.preparedDigest || outcome.confirmedSubjectDigest !== prepared.prepared.product.subjectDigest) throw new Error("Delivery outcome does not match immutable prepared facts");
    if (prepared.prepared.captureMode === "adopted" ? outcome.traceEndDigest === undefined : outcome.traceEndDigest !== undefined) throw new Error("Delivery outcome trace does not match snapshot capture mode");
  }
  if (complete?.state === "complete" && (!outcome || canonicalJson(complete.outcome) !== canonicalJson(outcome))) {
    throw new Error("Completed delivery record does not match its durable outcome");
  }
  return { prepared, outcome, complete, aborted };
}
async function writeImmutable(store: LegionStore, abs: string, record: DeliverySnapshot | DeliveryExport | DeliveryOutcome, lock: DeliverySnapshotLockOwnership, maxBytes: number): Promise<void> {
  const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
  if (bytes.length > maxBytes) throw new RangeError("Delivery record exceeds maximum byte length");
  await assertNoLinkInPath(abs, { root: store.projectRoot });
  await mkdir(dirname(abs), { recursive: true });
  await assertNoLinkInPath(abs, { root: store.projectRoot });
  assertOwned(store, lock);
  const temp = join(dirname(abs), `.${randomBytes(8).toString("hex")}.tmp`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
    (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, flags, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertNoLinkInPath(abs, { root: store.projectRoot });
    assertOwned(store, lock);
    try {
      await link(temp, abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Immutable delivery record already exists: ${abs}`);
      throw error;
    }
  } finally {
    await handle?.close();
    await unlink(temp).catch(() => undefined);
  }
}

export async function prepareDeliverySnapshot(store: LegionStore, prepared: PreparedDeliverySnapshot, lock: DeliverySnapshotLockOwnership): Promise<string> {
  assertOwned(store, lock);
  const validated = DeliverySnapshotSchema.parse({ schemaVersion: SCHEMA_VERSION.deliverySnapshot, state: "prepared", prepared, preparedDigest: "0".repeat(64) });
  const candidate = DeliverySnapshotSchema.parse({ ...validated, preparedDigest: digestPrepared(validated.prepared) });
  const confirmationId = candidate.prepared.confirmationId;
  const prior = await readSnapshotRecords(store, confirmationId);
  if (prior.prepared || prior.complete || prior.aborted || prior.outcome) throw new Error("Delivery snapshot already exists and is immutable");
  await writeImmutable(store, join(snapshotDir(store, confirmationId), "prepared.json"), candidate, lock, DELIVERY_SNAPSHOT_MAX_BYTES);
  return candidate.preparedDigest;
}

export async function recordDeliveryOutcome(store: LegionStore, confirmationId: string, outcome: DeliveryOutcome, lock: DeliverySnapshotLockOwnership): Promise<DeliveryOutcome> {
  assertId(confirmationId, "confirmation ID");
  assertOwned(store, lock);
  const validated = DeliveryOutcomeSchema.parse(outcome);
  if (validated.confirmationId !== confirmationId) throw new Error("Delivery outcome identity mismatch");
  const existing = await readSnapshotRecords(store, confirmationId);
  if (!existing.prepared || existing.aborted) throw new Error("Delivery outcome requires a prepared, non-aborted snapshot");
  const prepared = existing.prepared;
  const actualDigest = digestPrepared(prepared.prepared);
  if (prepared.preparedDigest !== actualDigest) throw new Error("Immutable prepared delivery facts were modified");
  if (validated.preparedDigest !== actualDigest || validated.confirmedSubjectDigest !== prepared.prepared.product.subjectDigest) {
    throw new Error("Delivery outcome does not match immutable prepared facts");
  }
  if (existing.outcome) {
    if (canonicalJson(existing.outcome) !== canonicalJson(validated)) throw new Error("Durable delivery outcome is immutable and conflicts with the requested outcome");
    return existing.outcome;
  }
  await writeImmutable(store, join(snapshotDir(store, confirmationId), "outcome.yaml"), validated, lock, 16 * 1024);
  return validated;
}

export async function completeDeliverySnapshot(store: LegionStore, confirmationId: string, outcome: DeliveryOutcome, completedTrace: GovernanceTrace, lock: DeliverySnapshotLockOwnership): Promise<DeliverySnapshot> {
  assertId(confirmationId, "confirmation ID");
  assertOwned(store, lock);
  const existing = await readSnapshotRecords(store, confirmationId);
  if (!existing.prepared || existing.complete || existing.aborted) throw new Error("Delivery snapshot is missing prepared facts or already terminal");
  const prepared = existing.prepared.prepared;
  const preparedDigest = digestPrepared(prepared);
  if (existing.prepared.preparedDigest !== preparedDigest) throw new Error("Immutable prepared delivery facts were modified");
  const validatedOutcome = DeliveryOutcomeSchema.parse(outcome);
  const candidate = DeliverySnapshotSchema.parse({ schemaVersion: SCHEMA_VERSION.deliverySnapshot, state: "complete", prepared, preparedDigest, outcome: validatedOutcome, completedTrace, sealedDigest: hash(canonicalJson({ preparedDigest, outcome: validatedOutcome, completedTrace })) });
  if (candidate.prepared.confirmationId !== confirmationId) throw new Error("Delivery snapshot identity mismatch");
  await recordDeliveryOutcome(store, confirmationId, validatedOutcome, lock);
  await writeImmutable(store, join(snapshotDir(store, confirmationId), "complete.json"), candidate, lock, DELIVERY_SNAPSHOT_MAX_BYTES);
  return candidate;
}

export async function abortDeliverySnapshot(store: LegionStore, confirmationId: string, abortedAt: string, reason: Extract<DeliverySnapshot, { state: "aborted" }>["reason"], survivingCommit: string | null, lock: DeliverySnapshotLockOwnership): Promise<DeliverySnapshot> {
  assertId(confirmationId, "confirmation ID");
  assertOwned(store, lock);
  const existing = await readSnapshotRecords(store, confirmationId);
  if (!existing.prepared || existing.complete || existing.aborted || existing.outcome) throw new Error("Delivery snapshot is missing prepared facts or already terminal");
  const prepared = existing.prepared.prepared;
  const preparedDigest = digestPrepared(prepared);
  if (existing.prepared.preparedDigest !== preparedDigest) throw new Error("Immutable prepared delivery facts were modified");
  const candidate = DeliverySnapshotSchema.parse({ schemaVersion: SCHEMA_VERSION.deliverySnapshot, state: "aborted", prepared, preparedDigest, abortedAt, reason, survivingCommit });
  await writeImmutable(store, join(snapshotDir(store, confirmationId), "aborted.json"), candidate, lock, DELIVERY_SNAPSHOT_MAX_BYTES);
  return candidate;
}
export async function readDeliveryOutcome(store: LegionStore, confirmationId: string): Promise<DeliveryOutcome | null> {
  const { outcome } = await readSnapshotRecords(store, confirmationId);
  return outcome;
}

export async function readDeliverySnapshot(store: LegionStore, confirmationId: string): Promise<DeliverySnapshot> {
  const { prepared, complete, aborted } = await readSnapshotRecords(store, confirmationId);
  if (!prepared) throw new Error("Delivery snapshot prepared record is missing");
  const digest = digestPrepared(prepared.prepared);
  if (digest !== prepared.preparedDigest) throw new Error("Immutable prepared delivery facts were modified");
  const terminal = complete ?? aborted;
  if (!terminal) return prepared;
  if (terminal.preparedDigest !== digest || canonicalJson(terminal.prepared) !== canonicalJson(prepared.prepared)) throw new Error("Terminal delivery record does not match immutable prepared facts");
  if (terminal.state === "complete") {
    const expected = hash(canonicalJson({ preparedDigest: digest, outcome: terminal.outcome, completedTrace: terminal.completedTrace }));
    if (terminal.sealedDigest !== expected) throw new Error("Completed delivery seal is invalid");
  }
  return terminal;
}

export async function recordDeliveryExportAttempt(store: LegionStore, record: DeliveryExport, lock: DeliverySnapshotLockOwnership): Promise<DeliveryExport> {
  assertOwned(store, lock);
  const parsed = DeliveryExportSchema.parse(record);
  assertId(parsed.snapshotId, "snapshot ID");
  assertId(parsed.attemptId, "export attempt ID");
  const dirRel = `${EXPORT_ROOT}/${hash(parsed.snapshotId)}`;
  const dirAbs = join(store.projectRoot, dirRel);
  await assertNoLinkInPath(dirAbs, { root: store.projectRoot });
  const names = await dirNames(dirAbs);
  if (names.length >= DELIVERY_EXPORT_MAX_ATTEMPTS) throw new Error("Delivery export attempt limit reached");
  if (names.some((name) => !/^[a-f0-9]{64}\.json$/.test(name))) throw new Error("Delivery export directory contains unexpected files");
  const filename = `${hash(parsed.attemptId)}.json`;
  if (names.includes(filename)) throw new Error("Delivery export attempt already exists");
  const abs = join(dirAbs, filename);
  await writeImmutable(store, abs, parsed, lock, 16 * 1024);
  return parsed;
}

export async function readDeliveryExportAttempts(store: LegionStore, confirmationId: string): Promise<DeliveryExport[]> {
  assertId(confirmationId, "confirmation ID");
  const dirAbs = join(store.projectRoot, `${EXPORT_ROOT}/${hash(confirmationId)}`);
  await assertNoLinkInPath(dirAbs, { root: store.projectRoot });
  const names = await dirNames(dirAbs);
  if (names.length > DELIVERY_EXPORT_MAX_ATTEMPTS || names.some((name) => !/^[a-f0-9]{64}\.json$/.test(name))) throw new Error("Invalid delivery export attempt directory");
  const records: DeliveryExport[] = [];
  for (const name of names.sort()) {
    const record = await readRecord(store.projectRoot, join(dirAbs, name), 16 * 1024, DeliveryExportSchema);
    if (!record || record.snapshotId !== confirmationId || hash(record.attemptId) !== name.slice(0, -5)) throw new Error("Delivery export attempt identity mismatch");
    records.push(record);
  }
  return records.sort((a, b) => a.attemptedAt.localeCompare(b.attemptedAt) || a.attemptId.localeCompare(b.attemptId));
}
