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
import { HINT, refuse } from "./errors.js";
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

function gitResetHard(root: string, ref: string): void {
  spawnSync("git", ["reset", "--hard", ref], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
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

async function restoreUndoPreimages(root: string, commandId: string): Promise<void> {
  const command = await readCommandRecord(root, commandId);
  if (!command) return;
  for (const [posix, digest] of Object.entries(command.files)) {
    const bytes = await readBlob(root, digest);
    await writeTextFile(toFsPath(root, posix), bytes.toString("utf8"), { root });
  }
  await closeEngineCommand(root, commandId);
}

async function rollbackUndo(
  root: string,
  commandId: string,
  priorHead: string | null,
  gitReverted: boolean,
): Promise<void> {
  if (gitReverted && priorHead) gitResetHard(root, priorHead);
  await restoreUndoPreimages(root, commandId);
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
      await rollbackUndo(root, commandId, priorHead, gitReverted);
    } catch (rollbackErr) {
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
