import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Task } from "@9thlevelsoftware/legion-cli-schema";
import {
  closeEngineCommand,
  isGitRepo,
  listTaskFiles,
  openEngineCommand,
  readBlob,
  readCommandRecord,
  toFsPath,
  writeTextFile,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";
import { HINT, LegionRefuseError, refuse } from "./errors.js";
import { assertCanTransition } from "./phases.js";
import { SHIP_COMMIT_PREFIX } from "./ship.js";
import { assertTaskStatusTransition, statusAfterUndoDependency } from "./tasks.js";

export type UndoResult = {
  taskId: string | null;
  commitSha: string | null;
  message: string;
};

const UNKNOWN_LEGION_COMMIT = /^(chore|feat|fix)\(legion\):/;

type HeadCommit = { sha: string; message: string };

function readHeadCommit(root: string): HeadCommit | null {
  if (!isGitRepo(root)) return null;
  const gitLog = spawnSync("git", ["log", "-1", "--format=%H %s"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
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

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, out: (result.stderr || result.stdout || "").trimEnd() };
}

const STATE_MD_POSIX = ".legion-cli/STATE.md";
const stateMdPath = (root: string): string => join(root, ...STATE_MD_POSIX.split("/"));

/**
 * Refuse before touching git when reverting would delete STATE.md (the ship commit was the first
 * to contain `.legion-cli/`), or when tracked edits outside `.legion-cli/` could be lost by the
 * rollback's `git reset --hard`.
 */
function assertShipRevertSafe(root: string, sha: string): void {
  const inShip = git(root, ["cat-file", "-e", `${sha}:${STATE_MD_POSIX}`]).ok;
  const inParent = git(root, ["cat-file", "-e", `${sha}^:${STATE_MD_POSIX}`]).ok;
  if (inShip && !inParent) {
    refuse(
      `undo would remove ${STATE_MD_POSIX}: ship commit ${sha.slice(0, 7)} is the first commit that contains .legion-cli/`,
      "git status",
    );
  }
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  const outside = dirty.out
    .split(/\r?\n/)
    .map((line) => line.slice(3).replaceAll("\\", "/"))
    .filter((path) => path && !path.startsWith(".legion-cli/"));
  if (outside.length > 0) {
    refuse(`undo needs a clean tracked tree; commit or stash: ${outside.slice(0, 3).join(", ")}`, "git status");
  }
}

/**
 * The revert deletes the ship receipt from the tree. Put it back, marked reverted, so the audit
 * trail still says what was shipped and that it was taken back.
 */
async function keepRevertedReceipts(root: string, sha: string): Promise<void> {
  const added = git(root, ["diff-tree", "--no-commit-id", "--name-only", "--diff-filter=A", "-r", sha]);
  if (!added.ok) return;
  for (const path of added.out.split(/\r?\n/)) {
    if (!/^\.legion-cli\/audit\/ship(-[^/]+)?\.md$/.test(path)) continue;
    const shown = git(root, ["show", `${sha}:${path}`]);
    if (!shown.ok) continue;
    const marked = `${shown.out}\n- reverted: true\n- revertedCommit: ${sha}\n`;
    await writeTextFile(toFsPath(root, path), marked, { root, skipJournal: true });
  }
}

function gitRevertNoEdit(root: string, sha: string): void {
  const revert = git(root, ["revert", "--no-edit", sha]);
  if (!revert.ok) {
    // A conflicting revert leaves REVERT_HEAD and conflict markers: abort it, never reset --hard.
    git(root, ["revert", "--abort"]);
    refuse(`git revert failed: ${revert.out}`, "git status");
  }
}

function defaultGitResetHard(root: string, ref: string): void {
  const result = spawnSync("git", ["reset", "--hard", ref], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
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
): Promise<void> {
  let rollbackErr: unknown;
  try {
    if (gitReverted && priorHead) gitResetHardFn(root, priorHead);
    await restoreUndoPreimages(root, preimages);
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
 * After an undo the phase must agree with the tasks. `shipped -> executing` is the one legal edge
 * that only undo uses; it also drops the review and QA that certified the work.
 */
async function rewindPhase(store: LegionStore, root: string): Promise<void> {
  if (!existsSync(stateMdPath(root))) return;
  const stateDoc = await store.readState();
  const phase = stateDoc.data.phase;
  if (phase !== "ready_to_ship" && phase !== "shipped") return;
  assertCanTransition(phase, "executing");
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

  const commandId = `undo-${randomBytes(8).toString("hex")}`;
  await openEngineCommand(root, commandId);
  const preimages = await loadUndoPreimages(root, commandId);
  const priorHead = head?.sha ?? null;
  let gitReverted = false;

  try {
    let commitSha: string | null = null;
    if (shipCommit) {
      assertShipRevertSafe(root, shipCommit.sha);
      gitRevertNoEdit(root, shipCommit.sha);
      gitReverted = true;
      commitSha = shipCommit.sha;
      if (!existsSync(stateMdPath(root))) {
        refuse(`undo removed ${STATE_MD_POSIX}; the revert was rolled back`, "git status");
      }
      await keepRevertedReceipts(root, shipCommit.sha);
    }

    if (target) {
      const undoneId = target.data.id;
      await writeTaskStatus(opts.store, target, "todo", "[undo]: reverted to todo");

      await rewindPhase(opts.store, root);

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
      return {
        taskId: undoneId,
        commitSha,
        message: `Reverted task ${undoneId} to todo${commitSha ? ` (reverted commit ${commitSha.slice(0, 7)})` : ""}`,
      };
    }

    if (shipCommit) await rewindPhase(opts.store, root);
    await closeEngineCommand(root, commandId);
    return {
      taskId: null,
      commitSha,
      message: `Reverted last Legion commit ${commitSha?.slice(0, 7) ?? ""}`.trim(),
    };
  } catch (err) {
    try {
      await rollbackUndo(root, commandId, priorHead, gitReverted, preimages);
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
