import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AssuranceSha256Schema,
  GovernanceEpochsSchema,
  GovernanceFrameSchema,
  GovernanceHeadSchema,
  GovernanceTraceSchema,
  OpaqueIdSchema,
  SCHEMA_VERSION,
  validateGovernanceFrames,
  type GovernanceAction,
  type GovernanceEpochs,
  type GovernanceFrame,
  type GovernanceHead,
  type GovernanceProjection,
  type GovernanceTrace,
  type GovernanceViolation,
} from "@9thlevelsoftware/legion-cli-schema";
import { atomicWriteFile, assertNoLinkInPath } from "./atomic-write.js";
import { canonicalJson } from "./canonical-json.js";
import { PersistError, SymlinkRefusedError } from "./errors.js";
import { parseStrictJson } from "./strict-json.js";
import type { LegionStore } from "./store.js";

export const GOVERNANCE_TRACE_MAX_FRAMES = 100_000;
export type { GovernanceAction, GovernanceEpochs, GovernanceFrame, GovernanceHead, GovernanceProjection, GovernanceTrace, GovernanceViolation } from "@9thlevelsoftware/legion-cli-schema";
const GOVERNANCE_TRACE_MAX_BYTES = 64 * 1024 * 1024;
export const GOVERNANCE_TRACE_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const ROOT = ".legion-cli/audit/governance";
const EPOCHS_PATH = `${ROOT}/epochs.json`;
const EPOCHS_MAX_BYTES = 4 * 1024 * 1024;
const EPOCHS_MAX_ENTRIES = 10_000;
const FRAME_NAME = /^(0|[1-9]\d{0,5})\.json$/;

export type GovernanceLockOwnership = { assertLockOwned: () => void };
/** Test-only crash seams: run after the frame file and after the head file are durable. */
export type GovernanceFaults = { afterFrame?: () => Promise<void>; afterHead?: () => Promise<void> };
export type GovernanceBeginInput = {
  approvalId: string;
  modelDigest: string;
  correlationId: string;
  action: GovernanceAction;
  before: GovernanceProjection;
  recordedAt: string;
  explicitRetry?: boolean;
};
export type GovernanceEndInput = {
  approvalId: string;
  modelDigest: string;
  correlationId: string;
  action: GovernanceAction;
  after: GovernanceProjection;
  outcome: "success" | "failed" | "incomplete" | "refused";
  recordedAt: string;
  explicitRetry?: boolean;
};
export type GovernanceEpoch = GovernanceEpochs["epochs"][number];
export type GovernanceEpochInput = { approvalId: string | null; adopted: boolean; recordedAt: string };

/** The cross-epoch anchor is missing a link, out of order, tampered, or not a strict document. */
export class GovernanceEpochError extends PersistError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GovernanceEpochError";
  }
}

export function governanceTraceDirectory(approvalId: string): string {
  return `${ROOT}/${createHash("sha256").update(approvalId, "utf8").digest("hex")}`;
}

function framePath(approvalId: string, sequence: number): string {
  return join(governanceTraceDirectory(approvalId), `${sequence}.json`);
}
function headPath(approvalId: string): string { return join(governanceTraceDirectory(approvalId), "head.json"); }
function digestFrame(frame: Omit<GovernanceFrame, "digest">): string {
  const bytes = `legion-cli-governance-frame-digest/v1\n${canonicalJson(frame)}`;
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function envelope(approvalId: string, modelDigest: string, headDigest: string | null, frames: GovernanceFrame[], status: "valid" | "incomplete" | "invalid"): GovernanceTrace {
  const candidate = { schemaVersion: SCHEMA_VERSION.governanceTrace, status, approvalId, modelDigest, headDigest, frames };
  const parsed = GovernanceTraceSchema.safeParse(candidate);
  if (!parsed.success) candidate.status = "invalid";
  return deepFreeze(candidate as GovernanceTrace);
}

function validateFrames(approvalId: string, modelDigest: string, frames: GovernanceFrame[]): { ok: boolean; incomplete: boolean } {
  let pending: GovernanceFrame | undefined;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const { digest, ...unsigned } = frame;
    if (!GovernanceFrameSchema.safeParse(frame).success || frame.sequence !== i || frame.approvalId !== approvalId || frame.modelDigest !== modelDigest || frame.previousDigest !== (i ? frames[i - 1]!.digest : null) || digestFrame(unsigned) !== digest) return { ok: false, incomplete: false };
    if (frame.boundary === "begin") {
      if (pending) return { ok: false, incomplete: false };
      pending = frame;
    } else {
      if (!pending || pending.correlationId !== frame.correlationId || pending.action !== frame.action) return { ok: false, incomplete: false };
      pending = undefined;
    }
  }
  return { ok: true, incomplete: Boolean(pending) || frames.some((frame) => frame.boundary === "end" && frame.outcome === "incomplete") };
}

type SegmentState = { trace: GovernanceTrace; head: GovernanceHead | null; frames: GovernanceFrame[]; filesOkay: boolean; violations: GovernanceViolation[] };

async function readSegment(store: LegionStore, approvalId: string, modelDigest: string): Promise<SegmentState> {
  const dirRel = governanceTraceDirectory(approvalId);
  const dirAbs = join(store.projectRoot, dirRel);
  const failed = (head: GovernanceHead | null, frames: GovernanceFrame[]): SegmentState =>
    ({ trace: envelope(approvalId, modelDigest, head?.digest ?? null, frames, "invalid"), head, frames, filesOkay: false, violations: [] });
  try {
    await assertNoLinkInPath(dirAbs, { root: store.projectRoot });
    const entries = await readdir(dirAbs);
    if (entries.length > GOVERNANCE_TRACE_MAX_FRAMES + 1 || !entries.includes("head.json")) return failed(null, []);
    const names = entries.filter((x) => x !== "head.json").sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
    if (names.some((name, i) => !FRAME_NAME.test(name) || name !== `${i}.json`) || names.length > GOVERNANCE_TRACE_MAX_FRAMES) return failed(null, []);
    const headAbs = join(dirAbs, "head.json");
    await assertNoLinkInPath(headAbs, { root: store.projectRoot });
    if ((await stat(headAbs)).size > 16 * 1024) return failed(null, []);
    const rawHead = parseStrictJson(await readFile(headAbs), { maxBytes: 16 * 1024, maxDepth: 8 });
    const parsedHead = GovernanceHeadSchema.safeParse(rawHead);
    if (!parsedHead.success || parsedHead.data.approvalId !== approvalId || parsedHead.data.sequence >= names.length) return failed(null, []);
    const head = parsedHead.data;
    const frames: GovernanceFrame[] = [];
    let totalBytes = 0;
    for (const name of names) {
      const filePath = join(dirAbs, name);
      await assertNoLinkInPath(filePath, { root: store.projectRoot });
      const size = (await stat(filePath)).size;
      totalBytes += size;
      if (size > GOVERNANCE_TRACE_MAX_FRAME_BYTES || totalBytes > GOVERNANCE_TRACE_MAX_BYTES) return failed(head, frames);
      const raw = parseStrictJson(await readFile(filePath), { maxBytes: GOVERNANCE_TRACE_MAX_FRAME_BYTES, maxDepth: 32 });
      const parsed = GovernanceFrameSchema.safeParse(raw);
      if (!parsed.success) return failed(head, frames);
      frames.push(parsed.data);
    }
    const chain = validateFrames(approvalId, modelDigest, frames);
    if (!chain.ok || !frames.length || frames[head.sequence]?.digest !== head.digest || head.sequence !== names.length - 1) return failed(head, frames);
    const status = chain.incomplete ? "incomplete" : "valid";
    if (head.status !== status) return failed(head, frames);
    // A structurally sound segment that breaks a semantic rule is readable evidence, but never valid or appendable.
    const violations = validateGovernanceFrames(frames);
    return { trace: envelope(approvalId, modelDigest, head.digest, frames, violations.length ? "invalid" : status), head, frames, filesOkay: true, violations };
  } catch {
    return failed(null, []);
  }
}

function expectedTail(state: SegmentState, approvalId: string, modelDigest: string): { sequence: number; previousDigest: string | null } {
  const trace = state.trace;
  if (!state.filesOkay || !state.head || trace.status === "invalid" || trace.status === "not-adopted" ||
      trace.approvalId !== approvalId || trace.modelDigest !== modelDigest) {
    throw new Error("Governance trace is not a valid appendable segment");
  }
  return { sequence: state.frames.length, previousDigest: state.frames.at(-1)?.digest ?? null };
}

/** Read-only: chain plus semantic validation of one approval segment. Never rewrites the head. */
export async function inspectGovernanceTrace(store: LegionStore, approvalId: string, modelDigest: string): Promise<{ trace: GovernanceTrace; violations: GovernanceViolation[] }> {
  assertIdentity(approvalId, modelDigest);
  const { trace, violations } = await readSegment(store, approvalId, modelDigest);
  return { trace, violations: deepFreeze(violations) };
}

export async function readGovernanceTrace(store: LegionStore, approvalId: string, modelDigest: string): Promise<GovernanceTrace> {
  return (await inspectGovernanceTrace(store, approvalId, modelDigest)).trace;
}

async function writeFrame(store: LegionStore, frame: Omit<GovernanceFrame, "digest">): Promise<GovernanceFrame> {
  const completed = { ...frame, digest: digestFrame(frame) } as GovernanceFrame;
  const parsed = GovernanceFrameSchema.safeParse(completed);
  if (!parsed.success) throw new Error("Invalid governance frame input");
  const dest = join(store.projectRoot, framePath(frame.approvalId, frame.sequence));
  await assertNoLinkInPath(dest, { root: store.projectRoot });
  await mkdir(dirname(dest), { recursive: true });
  await atomicWriteFile(dest, `${canonicalJson(parsed.data)}\n`, { root: store.projectRoot });
  return parsed.data;
}
async function writeHead(store: LegionStore, head: GovernanceHead): Promise<void> {
  const dest = join(store.projectRoot, headPath(head.approvalId));
  await assertNoLinkInPath(dest, { root: store.projectRoot });
  await mkdir(dirname(dest), { recursive: true });
  const parsed = GovernanceHeadSchema.safeParse(head);
  if (!parsed.success) throw new Error("Invalid governance head input");
  await atomicWriteFile(dest, `${canonicalJson(parsed.data)}\n`, { root: store.projectRoot });
}
function assertOwned(lock: GovernanceLockOwnership): void {
  if (!lock || typeof lock.assertLockOwned !== "function") throw new Error("Governance trace mutation requires lock ownership");
  lock.assertLockOwned();
}
function assertIdentity(approvalId: string, modelDigest: string): void {
  if (!OpaqueIdSchema.safeParse(approvalId).success || !AssuranceSha256Schema.safeParse(modelDigest).success) throw new TypeError("Invalid governance trace identity");
}

export async function appendGovernanceBegin(store: LegionStore, input: GovernanceBeginInput, lock: GovernanceLockOwnership, faults?: GovernanceFaults): Promise<GovernanceFrame> {
  assertIdentity(input.approvalId, input.modelDigest);
  assertOwned(lock);
  const segmentAbs = join(store.projectRoot, governanceTraceDirectory(input.approvalId));
  await assertNoLinkInPath(segmentAbs, { root: store.projectRoot });
  const existingNames = await readdir(segmentAbs).catch(() => []);
  const state = await readSegment(store, input.approvalId, input.modelDigest);
  let sequence = 0;
  let previousDigest: string | null = null;
  if (state.head || state.frames.length) {
    const tail = expectedTail(state, input.approvalId, input.modelDigest);
    if (state.frames.length >= GOVERNANCE_TRACE_MAX_FRAMES - 1) throw new Error("Governance trace frame limit reached");
    if (state.trace.status !== "valid") throw new Error("Cannot begin boundary on incomplete governance trace");
    const last = state.frames.at(-1)!;
    if (last.boundary === "begin") throw new Error("Governance trace already has an unmatched begin");
    sequence = tail.sequence;
    previousDigest = tail.previousDigest;
  } else if (existingNames.length) {
    throw new Error("Governance trace directory contains unexpected files");
  }
  assertOwned(lock);
  const frame = await writeFrame(store, { schemaVersion: SCHEMA_VERSION.governanceFrame, approvalId: input.approvalId, sequence, previousDigest, modelDigest: input.modelDigest, boundary: "begin", action: input.action, correlationId: input.correlationId, before: input.before, after: null, outcome: "pending", explicitRetry: input.explicitRetry ?? false, recordedAt: input.recordedAt });
  await faults?.afterFrame?.();
  assertOwned(lock);
  await writeHead(store, { schemaVersion: SCHEMA_VERSION.governanceHead, approvalId: input.approvalId, sequence, digest: frame.digest, status: "incomplete" });
  await faults?.afterHead?.();
  return frame;
}

export async function appendGovernanceEnd(store: LegionStore, input: GovernanceEndInput, lock: GovernanceLockOwnership, faults?: GovernanceFaults): Promise<GovernanceFrame> {
  assertIdentity(input.approvalId, input.modelDigest);
  assertOwned(lock);
  const state = await readSegment(store, input.approvalId, input.modelDigest);
  const tail = expectedTail(state, input.approvalId, input.modelDigest);
  const pending = state.frames.at(-1);
  if (!pending || pending.boundary !== "begin" || pending.correlationId !== input.correlationId || pending.action !== input.action) throw new Error("No matching governance begin frame");
  assertOwned(lock);
  const frame = await writeFrame(store, { schemaVersion: SCHEMA_VERSION.governanceFrame, approvalId: input.approvalId, sequence: tail.sequence, previousDigest: tail.previousDigest, modelDigest: input.modelDigest, boundary: "end", action: input.action, correlationId: input.correlationId, before: pending.before, after: input.after, outcome: input.outcome, explicitRetry: input.explicitRetry ?? false, recordedAt: input.recordedAt });
  await faults?.afterFrame?.();
  assertOwned(lock);
  await writeHead(store, { schemaVersion: SCHEMA_VERSION.governanceHead, approvalId: input.approvalId, sequence: frame.sequence, digest: frame.digest, status: input.outcome === "incomplete" ? "incomplete" : "valid" });
  await faults?.afterHead?.();
  return frame;
}

export async function reconcileGovernanceTrace(store: LegionStore, approvalId: string, modelDigest: string, lock: GovernanceLockOwnership): Promise<GovernanceTrace> {
  assertIdentity(approvalId, modelDigest);
  assertOwned(lock);
  const dirAbs = join(store.projectRoot, governanceTraceDirectory(approvalId));
  await assertNoLinkInPath(dirAbs, { root: store.projectRoot });
  const entries = await readdir(dirAbs).catch(() => null);
  if (!entries?.includes("head.json")) return envelope(approvalId, modelDigest, null, [], "invalid");
  const names = entries.filter((x) => x !== "head.json");
  const headAbs = join(dirAbs, "head.json");
  await assertNoLinkInPath(headAbs, { root: store.projectRoot });
  if ((await stat(headAbs)).size > 16 * 1024) return envelope(approvalId, modelDigest, null, [], "invalid");
  const rawHead = parseStrictJson(await readFile(headAbs), { maxBytes: 16 * 1024, maxDepth: 8 });
  const parsed = GovernanceHeadSchema.safeParse(rawHead);
  if (!parsed.success || parsed.data.approvalId !== approvalId || names.length > GOVERNANCE_TRACE_MAX_FRAMES || (names.length !== parsed.data.sequence + 1 && names.length !== parsed.data.sequence + 2)) return envelope(approvalId, modelDigest, parsed.success ? parsed.data.digest : null, [], "invalid");
  const state = await readSegment(store, approvalId, modelDigest);
  if (state.filesOkay) return state.trace;
  const sorted = names.sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
  if (sorted.some((n, i) => !FRAME_NAME.test(n) || n !== `${i}.json`) || sorted.at(-1) !== `${parsed.data.sequence + 1}.json`) return envelope(approvalId, modelDigest, parsed.data.digest, [], "invalid");
  const orphanAbs = join(dirAbs, sorted.at(-1)!);
  await assertNoLinkInPath(orphanAbs, { root: store.projectRoot });
  const orphanBytes = (await stat(orphanAbs)).size;
  if (orphanBytes > GOVERNANCE_TRACE_MAX_FRAME_BYTES) return envelope(approvalId, modelDigest, parsed.data.digest, [], "invalid");
  const raw = parseStrictJson(await readFile(orphanAbs), { maxBytes: GOVERNANCE_TRACE_MAX_FRAME_BYTES, maxDepth: 32 });
  const orphan = GovernanceFrameSchema.safeParse(raw);
  if (!orphan.success || orphan.data.sequence !== parsed.data.sequence + 1 || orphan.data.previousDigest !== parsed.data.digest || orphan.data.approvalId !== approvalId || orphan.data.modelDigest !== modelDigest) return envelope(approvalId, modelDigest, parsed.data.digest, [], "invalid");
  const { digest: orphanDigest, ...unsignedOrphan } = orphan.data;
  if (digestFrame(unsignedOrphan) !== orphanDigest) return envelope(approvalId, modelDigest, parsed.data.digest, [], "invalid");
  const base = await readSegmentForReconcile(store, approvalId, modelDigest, sorted.slice(0, -1), GOVERNANCE_TRACE_MAX_BYTES - orphanBytes);
  if (!base) return envelope(approvalId, modelDigest, parsed.data.digest, [], "invalid");
  const frames = [...base, orphan.data];
  const checked = validateFrames(approvalId, modelDigest, frames);
  if (!checked.ok || validateGovernanceFrames(frames).length) return envelope(approvalId, modelDigest, parsed.data.digest, frames, "invalid");
  const status = checked.incomplete ? "incomplete" : "valid";
  assertOwned(lock);
  await writeHead(store, { schemaVersion: SCHEMA_VERSION.governanceHead, approvalId, sequence: orphan.data.sequence, digest: orphan.data.digest, status });
  return envelope(approvalId, modelDigest, orphan.data.digest, frames, status);
}

async function readSegmentForReconcile(store: LegionStore, approvalId: string, modelDigest: string, names: string[], maxBytes: number): Promise<GovernanceFrame[] | null> {
  try {
    const frames: GovernanceFrame[] = [];
    let totalBytes = 0;
    for (let i = 0; i < names.length; i++) {
      if (names[i] !== `${i}.json`) return null;
      const frameAbs = join(store.projectRoot, framePath(approvalId, i));
      await assertNoLinkInPath(frameAbs, { root: store.projectRoot });
      const size = (await stat(frameAbs)).size;
      totalBytes += size;
      if (size > GOVERNANCE_TRACE_MAX_FRAME_BYTES || totalBytes > maxBytes) return null;
      const parsed = GovernanceFrameSchema.safeParse(parseStrictJson(await readFile(frameAbs), { maxBytes: GOVERNANCE_TRACE_MAX_FRAME_BYTES, maxDepth: 32 }));
      if (!parsed.success) return null;
      frames.push(parsed.data);
    }
    const checked = validateFrames(approvalId, modelDigest, frames);
    const head = await readHead(store, approvalId);
    const expectedStatus = checked.incomplete ? "incomplete" : "valid";
    return checked.ok && frames.at(-1)?.digest === head?.digest && head?.status === expectedStatus ? frames : null;
  } catch { return null; }
}
async function readHead(store: LegionStore, approvalId: string): Promise<GovernanceHead | null> {
  try { const parsed = GovernanceHeadSchema.safeParse(parseStrictJson(await readFile(join(store.projectRoot, headPath(approvalId))), { maxBytes: 16 * 1024, maxDepth: 8 })); return parsed.success ? parsed.data : null; } catch { return null; }
}

function digestEpoch(entry: Omit<GovernanceEpoch, "digest">): string {
  return createHash("sha256").update(`legion-cli-governance-epoch/v1\n${canonicalJson(entry)}`, "utf8").digest("hex");
}

/** The cross-epoch anchor, or `null` when no epoch was ever recorded. Any other defect throws {@link GovernanceEpochError}. */
export async function readGovernanceEpochs(store: LegionStore): Promise<GovernanceEpochs | null> {
  const abs = join(store.projectRoot, EPOCHS_PATH);
  let bytes: Buffer;
  try {
    await assertNoLinkInPath(abs, { root: store.projectRoot });
    if ((await stat(abs)).size > EPOCHS_MAX_BYTES) throw new GovernanceEpochError("Governance epoch anchor exceeds its size limit");
    bytes = await readFile(abs);
  } catch (err) {
    if (err instanceof GovernanceEpochError || err instanceof SymlinkRefusedError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new GovernanceEpochError("Governance epoch anchor is unreadable", { cause: err });
  }
  let raw: unknown;
  try {
    raw = parseStrictJson(bytes, { maxBytes: EPOCHS_MAX_BYTES, maxDepth: 8 });
  } catch (err) {
    throw new GovernanceEpochError("Governance epoch anchor is not strict JSON", { cause: err });
  }
  const parsed = GovernanceEpochsSchema.safeParse(raw);
  if (!parsed.success) throw new GovernanceEpochError("Governance epoch anchor is malformed", { cause: parsed.error });
  const epochs = parsed.data.epochs;
  for (let i = 0; i < epochs.length; i++) {
    const { digest, ...unsigned } = epochs[i]!;
    if (unsigned.sequence !== i || unsigned.previousDigest !== (i ? epochs[i - 1]!.digest : null) || digestEpoch(unsigned) !== digest) {
      throw new GovernanceEpochError(`Governance epoch anchor chain is broken at sequence ${i}`);
    }
  }
  return deepFreeze(parsed.data);
}

/** Atomically extends the anchor by one digest-chained epoch record. Refuses to extend a defective anchor. */
export async function appendGovernanceEpoch(store: LegionStore, input: GovernanceEpochInput, lock: GovernanceLockOwnership): Promise<GovernanceEpoch> {
  assertOwned(lock);
  const epochs = (await readGovernanceEpochs(store))?.epochs ?? [];
  if (epochs.length >= EPOCHS_MAX_ENTRIES) throw new GovernanceEpochError("Governance epoch anchor limit reached");
  const unsigned = { sequence: epochs.length, approvalId: input.approvalId, adopted: input.adopted, recordedAt: input.recordedAt, previousDigest: epochs.at(-1)?.digest ?? null };
  const parsed = GovernanceEpochsSchema.safeParse({ schemaVersion: SCHEMA_VERSION.governanceEpochs, epochs: [...epochs, { ...unsigned, digest: digestEpoch(unsigned) }] });
  if (!parsed.success) throw new TypeError("Invalid governance epoch input");
  const dest = join(store.projectRoot, EPOCHS_PATH);
  await assertNoLinkInPath(dest, { root: store.projectRoot });
  await mkdir(dirname(dest), { recursive: true });
  assertOwned(lock);
  await atomicWriteFile(dest, `${canonicalJson(parsed.data)}\n`, { root: store.projectRoot });
  return deepFreeze(parsed.data.epochs.at(-1)!);
}
