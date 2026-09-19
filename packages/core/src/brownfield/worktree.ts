import { resolve } from "node:path";
import {
  gitBranchExists,
  gitRevParse,
  gitStatusPorcelain,
  gitWorktreeAdd,
  gitWorktreeRemove,
  listGitWorktrees,
  PersistError,
  worktreeNodeStorePath,
  worktreeStorePath,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";
import { HINT, refuse } from "../errors.js";
import type { BrownfieldWorktreeOptions, BrownfieldWorktreeResult } from "../types.js";
import { readDag, writeDag } from "./dag.js";
import { storeAbs } from "./paths.js";
import { assertBrownfieldReady, readRun } from "./state.js";

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return left === right || left.toLowerCase() === right.toLowerCase();
}

/**
 * Per-PR isolated checkout: `.legion-cli/worktrees/<runId>/<nodeId>` on the node's branch.
 * The branch is created at the node's base (the audited commit for roots, the first
 * dependency's branch for dependents). The main checkout is never switched.
 */
export async function worktreeRun(
  store: LegionStore,
  runId: string,
  nodeId: string,
  opts: BrownfieldWorktreeOptions = {},
): Promise<BrownfieldWorktreeResult> {
  await assertBrownfieldReady(store);
  await readRun(store, runId);
  const hint = HINT.brownfieldDag(runId);
  const dag = await readDag(store.projectRoot, runId);
  const node = dag.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    refuse(`brownfield worktree: unknown node ${nodeId} (have ${dag.nodes.map((n) => n.id).join(", ")})`, hint);
  }
  const root = store.projectRoot;
  // Always derived: a stored `worktree` (hand-edited dag.json) is never trusted as a path.
  const storePath = worktreeNodeStorePath(runId, node.id);
  const abs = storeAbs(root, storePath);
  const registered = () => listGitWorktrees(root).some((wt) => samePath(wt.path, abs));
  let mainCheckoutDirty = false;
  try {
    mainCheckoutDirty = gitStatusPorcelain(root).trim().length > 0;
  } catch {
    mainCheckoutDirty = false;
  }

  if (opts.remove) {
    let removed = false;
    try {
      removed = gitWorktreeRemove(root, abs, { force: opts.force });
    } catch (err) {
      if (err instanceof PersistError) {
        refuse(`${err.message} (commit or discard the worktree's changes, or pass --force)`, hint);
      }
      throw err;
    }
    await writeDag(root, runId, {
      ...dag,
      nodes: dag.nodes.map((candidate) => (candidate.id === node.id ? { ...candidate, worktree: null } : candidate)),
    });
    return {
      runId,
      nodeId: node.id,
      branch: node.branch,
      base: node.base,
      mergeIn: node.mergeIn,
      worktree: null,
      created: false,
      removed,
      mainCheckoutDirty,
    };
  }

  const legacyAbs = storeAbs(root, worktreeStorePath(runId));
  if (listGitWorktrees(root).some((wt) => samePath(wt.path, legacyAbs))) {
    refuse(
      `brownfield run ${runId} has a legacy single worktree at ${worktreeStorePath(runId)}; per-PR worktrees would nest inside it`,
      `git worktree remove ${worktreeStorePath(runId)}`,
    );
  }
  if (!gitRevParse(root, node.base)) {
    const dep = node.dependsOn[0];
    refuse(
      `brownfield worktree: base ${node.base} does not exist yet${dep ? ` (create ${dep}'s worktree and commit first)` : ""}`,
      hint,
    );
  }
  for (const branch of node.mergeIn) {
    if (!gitBranchExists(root, branch)) {
      refuse(`brownfield worktree: merge-in branch ${branch} does not exist yet`, hint);
    }
  }

  const existed = registered();
  try {
    gitWorktreeAdd(root, abs, node.branch, node.base);
  } catch (err) {
    if (err instanceof PersistError) refuse(err.message, hint);
    throw err;
  }
  await writeDag(root, runId, {
    ...dag,
    nodes: dag.nodes.map((candidate) => (candidate.id === node.id ? { ...candidate, worktree: storePath } : candidate)),
  });
  return {
    runId,
    nodeId: node.id,
    branch: node.branch,
    base: node.base,
    mergeIn: node.mergeIn,
    worktree: storePath,
    created: !existed,
    removed: false,
    mainCheckoutDirty,
  };
}
