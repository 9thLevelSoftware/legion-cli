import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Task } from "@9thlevelsoftware/legion-cli-schema";
import {
  closeEngineCommand,
  isGitRepo,
  listTaskFiles,
  openEngineCommand,
  readBlob,
  readCommandRecord,
  shipReceiptPath,
  runGit,
  toFsPath,
  writeTextFile,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";
import { HINT, LegionRefuseError, refuse } from "./errors.js";
import { assertCanTransition, assertCanUndoTransition } from "./phases.js";
import { statusAfterUndoDependency } from "@9thlevelsoftware/legion-cli-schema";
import { assertTaskStatusTransition } from "./tasks.js";
import { SHIP_COMMIT_PREFIX } from "./ship.js";

export type UndoResult = {
  taskId: string | null;
  commitSha: string | null;
  message: string;
};

const UNKNOWN_LEGION_COMMIT = /^(chore|feat|fix)\(legion\):/;

type HeadCommit = { sha: string; message: string };

function readHeadCommit(root: string): HeadCommit | null {
  if (!isGitRepo(root)) return null;
  const gitLog = runGit(root, ["log", "-1", "--format=%H %s"]);
  if (gitLog.status !== 0 || !gitLog.stdout.trim()) return null;
  const [sha, ...msgParts] = gitLog.stdout.trim().split(" ");
  if (!sha) return null;
  return { sha, message: msgParts.join(" ") };
}

function classifyCommit(message: string): "ship" | "unknown-legion" | "other" {
  if (message.startsWith(SHIP_COMMIT_PREFIX)) return "ship";
  if (UNKNOWN_LEGION_COMMIT.test(message)) return "unknown-legion";
  return "other";
}

function git(root: string, args: string[]): { ok: boolean; out: string; stdout: string } {
  const result = runGit(root, args);
  const stdout = (result.stdout ?? "").trimEnd();
  return { ok: result.status === 0, out: (result.stderr || result.stdout || "").trimEnd(), stdout };
}

const STATE_MD_POSIX = ".legion-cli/STATE.md";
const stateMdPath = (root: string): string => join(root, ...STATE_MD_POSIX.split("/"));

/**
 * Refuse, before anything is written, when reverting the ship commit could lose work:
 * - a revert, cherry-pick or sequencer run of the user's is in progress (we must not abort it);
 * - the ship commit is the first to contain `.legion-cli/STATE.md` (the revert would delete it);
 * - ANY tracked file is dirty, including under `.legion-cli/`, except the append-only audit files.
 *   This is what makes the rollback's `git reset --hard` safe: with a clean tracked tree it only
 *   discards the revert and undo's own journaled writes. Untracked files are never touched by reset.
 *   Every command (a refused one included) appends to the audit files, so they are returned instead:
 *   undo snapshots them and puts the bytes back after the revert or a rollback.
 */
function assertShipRevertSafe(root: string, sha: string): string[] {
  for (const ref of ["REVERT_HEAD", "CHERRY_PICK_HEAD"]) {
    if (git(root, ["rev-parse", "-q", "--verify", ref]).ok) {
      refuse(`undo needs a quiet repository: a ${ref.replace("_HEAD", "").toLowerCase().replace("_", "-")} is in progress`, "git status");
    }
  }
  const gitDir = git(root, ["rev-parse", "--git-dir"]).stdout;
  if (gitDir && existsSync(join(resolve(root, gitDir), "sequencer"))) {
    refuse("undo needs a quiet repository: a sequencer operation is in progress", "git status");
  }
  const inShip = git(root, ["cat-file", "-e", `${sha}:${STATE_MD_POSIX}`]).ok;
  const inParent = git(root, ["cat-file", "-e", `${sha}^:${STATE_MD_POSIX}`]).ok;
  if (inShip && !inParent) {
    refuse(
      `undo would remove ${STATE_MD_POSIX}: ship commit ${sha.slice(0, 7)} is the first commit that contains .legion-cli/`,
      "git status",
    );
  }
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  const paths = dirty.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).replaceAll("\\", "/"))
    .filter(Boolean);
  const blocking = paths.filter((path) => !AUDIT_APPEND_ONLY.test(path));
  if (blocking.length > 0) {
    refuse(`undo needs a clean tracked tree; commit or stash: ${blocking.slice(0, 3).join(", ")}`, "git status");
  }
  return paths.filter((path) => AUDIT_APPEND_ONLY.test(path));
}

/**
 * The revert deletes the ship receipt from the tree. Put it back, marked reverted, so the audit
 * trail still says what was shipped and that it was taken back.
 */
/** Only a structured marker is ever appended; never git's own text. */
function withRevertedMarker(receipt: string, sha: string | null): string {
  if (/^- reverted: true$/m.test(receipt)) return receipt.endsWith("\n") ? receipt : `${receipt}\n`;
  return `${receipt}\n- reverted: true\n${sha ? `- revertedCommit: ${sha}\n` : ""}`;
}

/** Ship without a revert commit: mark the receipt that is still on disk. */
async function markShipReceiptReverted(root: string, specId: string | null | undefined): Promise<void> {
  const rel = specId ? shipReceiptPath(specId) : ".legion-cli/audit/ship.md";
  const abs = toFsPath(root, rel);
  if (!existsSync(abs)) return;
  const text = await readFile(abs, "utf8");
  await writeTextFile(abs, withRevertedMarker(text, null), { root });
}

async function keepRevertedReceipts(root: string, sha: string): Promise<void> {
  const added = git(root, ["diff-tree", "--no-commit-id", "--name-only", "--diff-filter=A", "-r", sha]);
  if (!added.ok) return;
  for (const path of added.out.split(/\r?\n/)) {
    if (!/^\.legion-cli\/audit\/ship(-[^/]+)?\.md$/.test(path)) continue;
    const shown = git(root, ["show", `${sha}:${path}`]);
    if (!shown.ok) continue;
    const marked = withRevertedMarker(shown.stdout, sha);
    await writeTextFile(toFsPath(root, path), marked, { root, skipJournal: true });
  }
}

/**
 * The audit log is append-only tamper evidence, so undo never rewinds it. `git revert` of the ship
 * commit would also revert tracked audit files (or delete files the ship commit added); these are
 * the two files the chain check compares, so their pre-undo bytes are put back after the revert or
 * a rollback. Untracked or ignored copies are untouched by git and are rewritten only if changed.
 * The pair is written log first, chain last: a hard crash between the two leaves the chain behind
 * the log (a healable gap) or, if the ship commit had added chain.json, no chain over a multi-line
 * log, which refuses loudly until `doctor --rebaseline-audit`.
 */
const AUDIT_CHAIN_FILES = [".legion-cli/audit/events.jsonl", ".legion-cli/audit/chain.json"] as const;

/** The chain pair plus the dated summaries: appended by every command, never rewound by undo. */
const AUDIT_APPEND_ONLY = /^\.legion-cli\/audit\/(events\.jsonl|chain\.json|\d{4}-\d{2}-\d{2}\.md)$/;

type AuditSnapshot = { posix: string; bytes: Buffer | null };

async function snapshotAuditFiles(root: string, extra: readonly string[] = []): Promise<AuditSnapshot[]> {
  const out: AuditSnapshot[] = [];
  for (const posix of new Set<string>([...AUDIT_CHAIN_FILES, ...extra])) {
    const abs = toFsPath(root, posix);
    out.push({ posix, bytes: existsSync(abs) ? await readFile(abs) : null });
  }
  return out;
}

async function restoreAuditFiles(root: string, snapshot: readonly AuditSnapshot[]): Promise<void> {
  for (const { posix, bytes } of snapshot) {
    const abs = toFsPath(root, posix);
    if (bytes) {
      const current = existsSync(abs) ? await readFile(abs) : null;
      if (!current || !current.equals(bytes)) await writeTextFile(abs, bytes, { root, skipJournal: true });
    } else if (existsSync(abs)) {
      await rm(abs, { force: true });
    }
  }
}

/** Audit files the ship commit changed (the dated summary it appended to, the chain pair). */
function auditPathsIn(root: string, sha: string): string[] {
  const changed = git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  if (!changed.ok) return [];
  return changed.stdout.split(/\r?\n/).filter((path) => AUDIT_APPEND_ONLY.test(path));
}

function trackedAt(root: string, ref: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const listed = git(root, ["ls-tree", "-r", "--name-only", ref, "--", ...paths]);
  return listed.ok ? listed.stdout.split(/\r?\n/).filter(Boolean) : [];
}

/**
 * Finish the `--no-commit` revert with the audit files at their pre-undo bytes, so the revert
 * commit itself never carries a rewound log (a later `git checkout` or stash of the audit files
 * would otherwise silently rewind it). Hooks are skipped, as `git revert` does not run pre-commit.
 */
function commitRevertKeepingAudit(root: string, auditTracked: readonly string[]): void {
  if (!git(root, ["rev-parse", "-q", "--verify", "REVERT_HEAD"]).ok) return;
  if (auditTracked.length > 0) {
    // The audit directory may be ignored after these exact files were tracked.
    // They are derived from the ship commit and filtered by AUDIT_APPEND_ONLY,
    // so force-add only this closed set while preserving ignore policy elsewhere.
    const added = git(root, ["add", "-f", "-A", "--", ...auditTracked]);
    if (!added.ok) refuse(`undo could not stage the audit log: ${added.out.split(/\r?\n/)[0] ?? ""}`, "git status");
  }
  const commit = git(root, ["commit", "--no-edit", "--no-verify", "--allow-empty"]);
  if (!commit.ok) refuse(`git commit of the revert failed: ${commit.out.split(/\r?\n/)[0] ?? ""}`, "git status");
}

function defaultGitRevert(root: string, sha: string): { ok: boolean; out: string } {
  return git(root, ["revert", "--no-commit", sha]);
}

let gitRevertFn: (root: string, sha: string) => { ok: boolean; out: string } = defaultGitRevert;

/** Test seam: run a different revert (e.g. one that really conflicts) in place of `git revert <ship>`. */
export function setUndoGitRevert(fn: ((root: string, sha: string) => { ok: boolean; out: string }) | null): void {
  gitRevertFn = fn ?? defaultGitRevert;
}

function gitRevertNoCommit(root: string, sha: string): void {
  const revert = gitRevertFn(root, sha);
  if (!revert.ok) {
    // assertShipRevertSafe proved no revert was in progress, so a REVERT_HEAD now is ours: abort
    // it (never reset --hard) so no conflict markers or half-done revert are left behind.
    if (git(root, ["rev-parse", "-q", "--verify", "REVERT_HEAD"]).ok) git(root, ["revert", "--abort"]);
    refuse(`git revert failed and was aborted: ${revert.out.split(/\r?\n/)[0] ?? ""}`, "git status");
  }
}

function defaultGitResetHard(root: string, ref: string): void {
  const result = runGit(root, ["reset", "--hard", ref]);
  if (result.status !== 0) {
    refuse(`git reset failed during undo rollback: ${(result.stderr || result.stdout).trim()}`, "git status");
  }
}

let gitResetHardFn: (root: string, ref: string) => void = defaultGitResetHard;

/** Test seam: inject a failing `git reset --hard` without depending on OS file locks. */
export function setUndoGitResetHard(fn: ((root: string, ref: string) => void) | null): void {
  gitResetHardFn = fn ?? defaultGitResetHard;
}

function appendNote(notes: string, line: string): string {
  return `${notes ? `${notes}\n` : ""}${line}`;
}

async function writeTaskStatus(
  store: LegionStore,
  doc: { data: Task; body: string },
  to: Task["status"],
  note: string,
): Promise<void> {
  assertTaskStatusTransition(doc.data.status, to);
  await store.writeTask(
    {
      ...doc.data,
      status: to,
      notes: appendNote(doc.data.notes, note),
    },
    doc.body,
  );
}

type UndoPreimage = { posix: string; bytes: Buffer };

async function loadUndoPreimages(root: string, commandId: string): Promise<UndoPreimage[]> {
  const command = await readCommandRecord(root, commandId);
  if (!command) {
    refuse("undo rollback: command journal missing", HINT.undo);
  }
  const out: UndoPreimage[] = [];
  for (const [posix, digest] of Object.entries(command.files)) {
    out.push({ posix, bytes: await readBlob(root, digest) });
  }
  return out;
}

async function restoreUndoPreimages(root: string, preimages: readonly UndoPreimage[]): Promise<void> {
  for (const { posix, bytes } of preimages) {
    await writeTextFile(toFsPath(root, posix), bytes, { root, skipJournal: true });
  }
}

async function rollbackUndo(
  root: string,
  commandId: string,
  priorHead: string | null,
  gitReverted: boolean,
  preimages: readonly UndoPreimage[],
  audit: readonly AuditSnapshot[],
): Promise<void> {
  let rollbackErr: unknown;
  try {
    if (gitReverted && priorHead) gitResetHardFn(root, priorHead);
    await restoreUndoPreimages(root, preimages);
    await restoreAuditFiles(root, audit);
  } catch (err) {
    rollbackErr = err;
  }
  try {
    await closeEngineCommand(root, commandId);
  } catch (closeErr) {
    rollbackErr ??= closeErr;
  }
  if (!rollbackErr) return;
  if (rollbackErr instanceof LegionRefuseError) throw rollbackErr;
  refuse(`undo rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`, HINT.undo);
}

/**
 * After an undo the phase must agree with the tasks. `shipped -> executing` is legal only here
 * (assertCanUndoTransition); it also drops the review and QA that certified the work, and marks
 * the ship receipt reverted when the ship is what is being taken back.
 */
async function rewindPhase(
  store: LegionStore,
  root: string,
  revert?: { specId: string | null },
): Promise<void> {
  if (!existsSync(stateMdPath(root))) return;
  const stateDoc = await store.readState();
  const phase = stateDoc.data.phase;
  if (phase !== "ready_to_ship" && phase !== "shipped") return;
  if (revert) {
    // After a git revert, STATE is whatever the ship commit's parent recorded. When that is an
    // earlier ship of another spec, that ship still stands: leave its phase and receipt alone.
    const active = stateDoc.data.activeSpecId ?? null;
    if (revert.specId !== null && active !== null && active !== revert.specId) return;
  }
  if (phase === "shipped") assertCanUndoTransition(phase, "executing");
  else assertCanTransition(phase, "executing");
  await store.writeState(
    {
      ...stateDoc.data,
      phase: "executing",
      lastReview: null,
      lastQaId: null,
      ...(phase === "ready_to_ship" ? { lastReadiness: null } : {}),
    },
    stateDoc.body,
  );
  // A reverted ship commit's receipt is re-added and marked by keepRevertedReceipts.
  if (phase === "shipped" && !revert) await markShipReceiptReverted(root, stateDoc.data.activeSpecId);
}

/** The spec a ship commit shipped, from its message (`shipCommitMessage`); null when it names none. */
function shippedSpecOf(message: string): string | null {
  const spec = message.slice(SHIP_COMMIT_PREFIX.length).trim();
  return spec && spec !== "spec" ? spec : null;
}

async function undoLastTaskLocked(opts: {
  projectRoot: string;
  store: LegionStore;
  taskId?: string;
}): Promise<UndoResult> {
  const root = resolve(opts.projectRoot);
  const head = readHeadCommit(root);
  if (head && classifyCommit(head.message) === "unknown-legion") {
    refuse(`unknown-type commit cannot be undone: ${head.message}`, HINT.undo);
  }
  const shipCommit = head && classifyCommit(head.message) === "ship" ? head : null;

  // Limitation: only the highest-id done task goes back to todo; the spec's other done tasks stay done.
  let target: { data: Task; body: string } | null = null;
  if (opts.taskId) {
    try {
      target = await opts.store.readTask(opts.taskId);
    } catch {
      refuse(`unknown task ${opts.taskId}`, HINT.undo);
    }
    if (target.data.status !== "done") {
      refuse(`cannot undo task ${opts.taskId} from ${target.data.status}`, HINT.undo);
    }
  } else {
    const entries = await listTaskFiles(root);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry) continue;
      if (!entry.ok) {
        refuse(`task ${entry.id} is not valid: ${entry.error}`, HINT.undo);
      }
      if (entry.task.status === "done") {
        target = await opts.store.readTask(entry.task.id);
        break;
      }
    }
  }

  if (!target && !shipCommit) {
    refuse("no task or commit found to undo", HINT.status);
  }

  const dirtyAudit = shipCommit ? assertShipRevertSafe(root, shipCommit.sha) : [];
  const revertInfo = shipCommit ? { specId: shippedSpecOf(shipCommit.message) } : undefined;

  const commandId = `undo-${randomBytes(8).toString("hex")}`;
  await openEngineCommand(root, commandId);
  const preimages = await loadUndoPreimages(root, commandId);
  const priorHead = head?.sha ?? null;
  let auditSnapshot: AuditSnapshot[] = [];
  let gitReverted = false;

  try {
    try {
      auditSnapshot = await snapshotAuditFiles(root, shipCommit ? [...dirtyAudit, ...auditPathsIn(root, shipCommit.sha)] : []);
    } catch (err) {
      refuse(`undo could not read the audit log, nothing was changed: ${err instanceof Error ? err.message : String(err)}`, HINT.undo);
    }
    let commitSha: string | null = null;
    if (shipCommit) {
      // Pending audit appends would make git refuse to revert over them; the snapshot holds them.
      if (dirtyAudit.length > 0) {
        const reset = git(root, ["checkout", "--", ...dirtyAudit]);
        if (!reset.ok) refuse(`undo could not set the audit log aside: ${reset.out.split(/\r?\n/)[0] ?? ""}`, "git status");
      }
      gitRevertNoCommit(root, shipCommit.sha);
      gitReverted = true;
      commitSha = shipCommit.sha;
      await restoreAuditFiles(root, auditSnapshot);
      commitRevertKeepingAudit(root, trackedAt(root, shipCommit.sha, auditSnapshot.map((s) => s.posix)));
      if (!existsSync(stateMdPath(root))) {
        refuse(`undo removed ${STATE_MD_POSIX}; the revert was rolled back`, "git status");
      }
      await keepRevertedReceipts(root, shipCommit.sha);
    }

    if (target) {
      const undoneId = target.data.id;
      let current: { data: Task; body: string } | null = target;
      if (shipCommit) {
        // The revert may have restored an older snapshot of this task; act on what is on disk now.
        current = await opts.store.readTask(undoneId).catch(() => null);
      }
      if (current && current.data.status === "done") {
        await writeTaskStatus(opts.store, current, "todo", "[undo]: reverted to todo");
      }

      await rewindPhase(opts.store, root, revertInfo);

      const entries = await listTaskFiles(root);
      for (const entry of entries) {
        if (!entry.ok) {
          refuse(`task ${entry.id} is not valid: ${entry.error}`, HINT.undo);
        }
        if (entry.task.id === undoneId) continue;
        if (!entry.task.blockedBy.includes(undoneId)) continue;
        const cascadeTo = statusAfterUndoDependency(entry.task.status);
        if (!cascadeTo) continue;
        const other = await opts.store.readTask(entry.task.id);
        await writeTaskStatus(
          opts.store,
          other,
          cascadeTo,
          `[undo]: dependency ${undoneId} undone, reverted to ${cascadeTo}`,
        );
      }

      await closeEngineCommand(root, commandId);
      // After a revert the task may be gone or restored to an older status: say what is on disk.
      const status = (await opts.store.readTask(undoneId).catch(() => null))?.data.status;
      const message =
        status === "todo"
          ? `Reverted task ${undoneId} to todo${commitSha ? ` (reverted commit ${commitSha.slice(0, 7)})` : ""}. ` +
            "Only the highest-id done task goes back to todo; the spec's other done tasks stay done."
          : `Reverted commit ${commitSha?.slice(0, 7) ?? ""}; task ${undoneId} ` +
            (status ? `is ${status} after the revert.` : "was removed by the revert.");
      return { taskId: undoneId, commitSha, message };
    }

    if (shipCommit) await rewindPhase(opts.store, root, revertInfo);
    await closeEngineCommand(root, commandId);
    return {
      taskId: null,
      commitSha,
      message: `Reverted last Legion commit ${commitSha?.slice(0, 7) ?? ""}`.trim(),
    };
  } catch (err) {
    try {
      await rollbackUndo(root, commandId, priorHead, gitReverted, preimages, auditSnapshot);
    } catch (rollbackErr) {
      if (rollbackErr instanceof LegionRefuseError) throw rollbackErr;
      if (err instanceof Error) err.cause = rollbackErr;
    }
    throw err;
  }
}

export async function undoLastTask(opts: {
  projectRoot: string;
  store: LegionStore;
  taskId?: string;
}): Promise<UndoResult> {
  if (opts.store.holdsLock()) return undoLastTaskLocked(opts);
  return opts.store.withLock(() => undoLastTaskLocked(opts));
}
