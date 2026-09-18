import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import {
  BrownfieldDagNodeStatusSchema,
  BrownfieldDagSchema,
  type BrownfieldDag,
  type BrownfieldDagNode,
} from "@9thlevelsoftware/legion-cli-schema";
import { HINT, refuse } from "../errors.js";
import type { BrownfieldDagResult } from "../types.js";
import { DAG_FILE, runAbs } from "./paths.js";
import { assertBrownfieldReady, parseKeyValuePairs, readRun } from "./state.js";

const TERMINAL = new Set(["completed", "failed", "skipped"]);
const SETTABLE_NODE_KEYS = new Set(["status", "commit", "worktree", "agentId", "reviewRounds", "error"]);

export async function readDag(projectRoot: string, runId: string): Promise<BrownfieldDag> {
  const abs = runAbs(projectRoot, runId, DAG_FILE);
  if (!existsSync(abs)) {
    refuse(`brownfield run ${runId} has no dag.json`, HINT.brownfieldPrPlan(runId));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(abs, "utf8"));
  } catch {
    refuse(`brownfield run ${runId}: dag.json is not valid JSON`, HINT.brownfieldPrPlan(runId));
  }
  const parsed = BrownfieldDagSchema.safeParse(raw);
  if (!parsed.success || parsed.data.runId !== runId) {
    refuse(`brownfield run ${runId}: dag.json failed schema validation`, HINT.brownfieldPrPlan(runId));
  }
  return parsed.data;
}

export async function writeDag(projectRoot: string, runId: string, dag: BrownfieldDag): Promise<void> {
  const valid = BrownfieldDagSchema.parse(dag);
  const abs = runAbs(projectRoot, runId, DAG_FILE);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
}

export function applyNodeSet(dag: BrownfieldDag, nodeId: string, pairs: [string, unknown][], hint: string): BrownfieldDag {
  const node = dag.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    refuse(`brownfield dag: unknown node ${nodeId} (have ${dag.nodes.map((n) => n.id).join(", ")})`, hint);
  }
  const next: BrownfieldDagNode = { ...node };
  for (const [key, value] of pairs) {
    if (!SETTABLE_NODE_KEYS.has(key)) {
      refuse(`brownfield dag: ${key} is not settable (use ${[...SETTABLE_NODE_KEYS].join(", ")})`, hint);
    }
    if (key === "status") {
      const status = BrownfieldDagNodeStatusSchema.safeParse(value);
      if (!status.success) {
        refuse(`brownfield dag: status must be one of ${BrownfieldDagNodeStatusSchema.options.join("|")}`, hint);
      }
      next.status = status.data;
      continue;
    }
    if (key === "reviewRounds") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) refuse("brownfield dag: reviewRounds must be a non-negative integer", hint);
      next.reviewRounds = n;
      continue;
    }
    const text = value === null ? null : String(value);
    (next as Record<string, unknown>)[key] = key === "error" ? text : text && text.length > 0 ? text : null;
  }
  return { ...dag, nodes: dag.nodes.map((candidate) => (candidate.id === nodeId ? next : candidate)) };
}

/** Anything depending (transitively) on a failed/skipped node is skipped. */
export function cascadeSkip(dag: BrownfieldDag): BrownfieldDag {
  const nodes = dag.nodes.map((node) => ({ ...node }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (TERMINAL.has(node.status)) continue;
      const bad = node.dependsOn.find((dep) => ["failed", "skipped"].includes(byId.get(dep)?.status ?? ""));
      if (bad) {
        node.status = "skipped";
        node.error = `Skipped: dependency ${bad} did not complete`;
        changed = true;
      }
    }
  }
  return { ...dag, nodes };
}

export function summarizeDag(dag: BrownfieldDag): Omit<BrownfieldDagResult, "runId"> {
  const byId = new Map(dag.nodes.map((node) => [node.id, node]));
  const counts: Record<string, number> = {};
  for (const node of dag.nodes) counts[node.status] = (counts[node.status] ?? 0) + 1;
  return {
    counts,
    ready: dag.nodes
      .filter((node) => node.status === "pending" && node.dependsOn.every((dep) => byId.get(dep)?.status === "completed"))
      .map((node) => node.id),
    inFlight: dag.nodes.filter((node) => !TERMINAL.has(node.status) && node.status !== "pending").map((node) => node.id),
    done: dag.nodes.every((node) => TERMINAL.has(node.status)),
    nodes: dag.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      status: node.status,
      branch: node.branch,
      base: node.base,
      mergeIn: node.mergeIn,
      commit: node.commit,
      worktree: node.worktree,
      agentId: node.agentId,
      reviewRounds: node.reviewRounds,
      error: node.error,
    })),
  };
}

export async function dagRun(
  store: LegionStore,
  runId: string,
  nodeId?: string,
  pairs: readonly string[] = [],
): Promise<BrownfieldDagResult> {
  await assertBrownfieldReady(store);
  await readRun(store, runId);
  const hint = HINT.brownfieldDag(runId);
  const original = await readDag(store.projectRoot, runId);
  let dag = original;
  if (nodeId) {
    dag = applyNodeSet(dag, nodeId, parseKeyValuePairs(pairs, hint), hint);
  } else if (pairs.length > 0) {
    refuse("brownfield dag: key=value updates need a node id first", hint);
  }
  dag = cascadeSkip(dag);
  if (JSON.stringify(dag) !== JSON.stringify(original)) {
    await writeDag(store.projectRoot, runId, dag);
  }
  return { runId, ...summarizeDag(dag) };
}
