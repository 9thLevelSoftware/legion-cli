import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
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

function gitRevertNoEdit(root: string, sha: string): void {
  const revert = spawnSync("git", ["revert", "--no-edit", sha], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (revert.status !== 0) {
    refuse(`git revert failed: ${(revert.stderr || revert.stdout).trim()}`, "git status");
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
      gitRevertNoEdit(root, shipCommit.sha);
      gitReverted = true;
      commitSha = shipCommit.sha;
    }

    if (target) {
      const undoneId = target.data.id;
      await writeTaskStatus(opts.store, target, "todo", "[undo]: reverted to todo");

      const stateDoc = await opts.store.readState();
      if (stateDoc.data.phase === "ready_to_ship") {
        assertCanTransition(stateDoc.data.phase, "executing");
        await opts.store.writeState(
          {
            ...stateDoc.data,
            phase: "executing",
            lastReview: null,
            lastReadiness: null,
          },
          stateDoc.body,
        );
      }

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
