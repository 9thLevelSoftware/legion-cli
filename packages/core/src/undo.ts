import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Task } from "@9thlevelsoftware/legion-cli-schema";
import { legionPaths, type LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { refuse } from "./errors.js";

export type UndoResult = {
  taskId: string | null;
  commitSha: string | null;
  message: string;
};

export async function undoLastTask(opts: {
  projectRoot: string;
  store: LegionStore;
  taskId?: string;
}): Promise<UndoResult> {
  const root = resolve(opts.projectRoot);
  const gitLog = spawnSync("git", ["log", "-1", "--format=%H %s"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });

  let commitSha: string | null = null;
  if (gitLog.status === 0 && gitLog.stdout.trim()) {
    const [sha, ...msgParts] = gitLog.stdout.trim().split(" ");
    const msg = msgParts.join(" ");
    if (
      msg.startsWith("chore(legion):") ||
      msg.startsWith("feat(legion):") ||
      msg.startsWith("fix(legion):")
    ) {
      commitSha = sha;
      const revert = spawnSync("git", ["revert", "--no-edit", sha], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      });
      if (revert.status !== 0) {
        refuse(`git revert failed: ${revert.stderr.trim()}`, "git status");
      }
    }
  }

  let targetTaskDoc: { data: Task; body: string } | null = null;
  if (opts.taskId) {
    try {
      targetTaskDoc = await opts.store.readTask(opts.taskId);
    } catch {
      // task not found
    }
  } else {
    try {
      const dir = legionPaths(root).tasksDir;
      const names = await readdir(dir);
      const taskFiles = names.filter((n) => /^TSK-\d+\.md$/i.test(n)).sort();
      for (let i = taskFiles.length - 1; i >= 0; i--) {
        const id = taskFiles[i].replace(/\.md$/i, "");
        const doc = await opts.store.readTask(id);
        if (doc.data.status === "done") {
          targetTaskDoc = doc;
          break;
        }
      }
    } catch {
      // directory reading or parse error
    }
  }

  if (targetTaskDoc && targetTaskDoc.data.status === "done") {
    const undoneId = targetTaskDoc.data.id;
    await opts.store.writeTask(
      {
        ...targetTaskDoc.data,
        status: "todo",
        notes: `${targetTaskDoc.data.notes ? targetTaskDoc.data.notes + "\n" : ""}[undo]: reverted to todo`,
      },
      targetTaskDoc.body,
    );

    // 1. Rewind state phase if the slice was previously terminal / ready to ship
    try {
      const stateDoc = await opts.store.readState();
      if (stateDoc.data.phase === "ready_to_ship") {
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
    } catch {
      // state file may be absent
    }

    // 2. Cascade revert any dependent tasks unblocked by this task
    try {
      const dir = legionPaths(root).tasksDir;
      const names = await readdir(dir);
      const taskFiles = names.filter((n) => /^TSK-\d+\.md$/i.test(n));
      for (const file of taskFiles) {
        const id = file.replace(/\.md$/i, "");
        if (id === undoneId) continue;
        try {
          const other = await opts.store.readTask(id);
          if (
            other.data.blockedBy.includes(undoneId) &&
            (other.data.status === "ready" || other.data.status === "in_progress")
          ) {
            await opts.store.writeTask(
              {
                ...other.data,
                status: "todo",
                notes: `${other.data.notes ? other.data.notes + "\n" : ""}[undo]: dependency ${undoneId} undone, reverted to todo`,
              },
              other.body,
            );
          }
        } catch {
          // ignore individual task read/write errors
        }
      }
    } catch {
      // ignore directory iteration errors
    }

    return {
      taskId: targetTaskDoc.data.id,
      commitSha,
      message: `Reverted task ${targetTaskDoc.data.id} to todo${commitSha ? ` (reverted commit ${commitSha.slice(0, 7)})` : ""}`,
    };
  }

  if (commitSha) {
    return {
      taskId: null,
      commitSha,
      message: `Reverted last Legion commit ${commitSha.slice(0, 7)}`,
    };
  }

  refuse("no task or commit found to undo", "legion-cli status");
}
