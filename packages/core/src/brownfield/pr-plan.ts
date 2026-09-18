import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { SCHEMA_VERSION, type BrownfieldDag, type BrownfieldDagNode } from "@9thlevelsoftware/legion-cli-schema";
import { HINT, refuse } from "../errors.js";
import type { BrownfieldPrPlanResult } from "../types.js";
import { writeDag } from "./dag.js";
import { section, splitBlocks } from "./markdown.js";
import { runAbs, runArtifactPaths } from "./paths.js";
import { assertBrownfieldReady, readRun, writeRun } from "./state.js";

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "unnamed";
}

export type PrPlanParse = { ok: true; nodes: BrownfieldDagNode[]; levels: number } | { ok: false; error: string };

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/,\s*/)
    .map((item) => item.trim().replace(/^`+|`+$/g, "").trim())
    .filter((item) => item.length > 0 && !/^(none|n\/a|-)$/i.test(item));
}

/**
 * Parse `## PR Plan` → DAG nodes. Roots are based on `rootBase` (the audited commit);
 * a dependent is based on its first dependency's branch and merges the others in.
 */
export function parsePrPlan(designMarkdown: string, runId: string, rootBase: string): PrPlanParse {
  const body = section(designMarkdown, "PR Plan");
  if (!body.trim()) return { ok: false, error: "design.md has no '## PR Plan' section" };

  const nodes = new Map<number, BrownfieldDagNode>();
  for (const block of splitBlocks(body)) {
    const match = /^PR[ -]?(\d+)\s*[:.\-]\s*(.+)$/i.exec(block.heading);
    if (!match) continue;
    const number = Number(match[1]);
    if (number < 1) return { ok: false, error: `PR numbers start at 1 (got PR ${match[1]})` };
    if (nodes.has(number)) return { ok: false, error: `duplicate PR ${number} in the PR Plan` };
    const deps = [
      ...new Set(
        [...(block.fields["depends on"] ?? block.fields.dependencies ?? "none").matchAll(/PR[ -]?(\d+)/gi)].map((m) =>
          Number(m[1]),
        ),
      ),
    ].sort((a, b) => a - b);
    const title = match[2].trim();
    nodes.set(number, {
      id: `pr-${number}`,
      number,
      title,
      branch: `brownfield/${runId}/pr-${number}-${slugify(title)}`,
      dependsOn: deps.map((dep) => `pr-${dep}`),
      files: splitList(block.fields.files),
      tracesTo: block.fields["traces to"] ?? "",
      risk: block.fields.risk ?? "",
      spec: block.raw,
      status: "pending",
      level: 0,
      base: rootBase,
      mergeIn: [],
      commit: null,
      worktree: null,
      agentId: null,
      reviewRounds: 0,
      error: null,
    });
  }
  if (nodes.size === 0) return { ok: false, error: "no '### PR N: Title' entries under '## PR Plan'" };

  const missing: string[] = [];
  for (const node of nodes.values()) {
    for (const dep of node.dependsOn) {
      if (!nodes.has(Number(dep.slice(3)))) missing.push(`${node.id} depends on missing ${dep}`);
    }
  }
  if (missing.length > 0) return { ok: false, error: missing.join("; ") };

  const level = new Map<number, number>();
  const visiting = new Set<number>();
  let cycle: string | null = null;
  const visit = (n: number): number => {
    const known = level.get(n);
    if (known !== undefined) return known;
    if (visiting.has(n)) {
      cycle ??= `dependency cycle involving pr-${n}`;
      return 0;
    }
    visiting.add(n);
    const deps = nodes.get(n)!.dependsOn.map((dep) => Number(dep.slice(3)));
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(visit));
    visiting.delete(n);
    level.set(n, value);
    return value;
  };
  for (const n of nodes.keys()) visit(n);
  if (cycle) return { ok: false, error: cycle };

  const order = [...nodes.keys()].sort((a, b) => level.get(a)! - level.get(b)! || a - b);
  const out: BrownfieldDagNode[] = [];
  for (const n of order) {
    const node = nodes.get(n)!;
    const deps = node.dependsOn.map((dep) => nodes.get(Number(dep.slice(3)))!);
    node.level = level.get(n)!;
    node.base = deps.length > 0 ? deps[0].branch : rootBase;
    node.mergeIn = deps.slice(1).map((dep) => dep.branch);
    out.push(node);
  }
  return { ok: true, nodes: out, levels: Math.max(...out.map((node) => node.level)) + 1 };
}

export async function prPlanRun(store: LegionStore, runId: string): Promise<BrownfieldPrPlanResult> {
  await assertBrownfieldReady(store);
  const run = await readRun(store, runId);
  const designAbs = runAbs(store.projectRoot, runId, "design.md");
  if (!existsSync(designAbs)) {
    refuse(`brownfield run ${runId} has no design.md`, HINT.brownfieldDesign(runId));
  }
  if (!/^[0-9a-f]{7,40}$/i.test(run.preSpawnRef)) {
    refuse("brownfield pr-plan requires the run to have started on a commit (HEAD was unborn)", HINT.gitRepo);
  }
  const parsed = parsePrPlan(await readFile(designAbs, "utf8"), runId, run.preSpawnRef);
  if (!parsed.ok) {
    refuse(`brownfield pr-plan: ${parsed.error}`, HINT.brownfieldDesign(runId));
  }
  const dag: BrownfieldDag = { schemaVersion: SCHEMA_VERSION.dag, runId, nodes: parsed.nodes };
  await writeDag(store.projectRoot, runId, dag);
  await writeRun(store.projectRoot, { ...run, phase: "execute" });
  return {
    runId,
    count: parsed.nodes.length,
    levels: parsed.levels,
    order: parsed.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      level: node.level,
      base: node.base,
      mergeIn: node.mergeIn,
      branch: node.branch,
    })),
    dagFile: runArtifactPaths(runId).dag,
    next: `legion-cli brownfield dag ${runId} (ready nodes), then legion-cli brownfield worktree ${runId} <node>`,
  };
}
