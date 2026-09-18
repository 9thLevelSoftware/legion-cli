import {
  createLegionEngine,
  type BrownfieldInitResult,
  type BrownfieldStateResult,
} from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

/**
 * `legion-cli brownfield` keeps the books for an audit the orchestrating agent runs.
 * The agent launches specialists, writer, reviewers, and implementers; every
 * subcommand here is deterministic bookkeeping over `.legion-cli/runs/<id>/`.
 */

export type BrownfieldFlags = {
  effort?: string;
  execute?: boolean;
  resume?: string;
  runId?: string;
  context?: string[];
};

function parseEffortFlag(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : Number(trimmed);
}

function emit(opts: CliOpts, json: Record<string, unknown>, lines: string[]): number {
  if (opts.json) {
    writeJson({ ok: true, ...json });
    return 0;
  }
  for (const line of lines) writeOut(line);
  return 0;
}

function initLines(result: BrownfieldInitResult): string[] {
  const size = result.size;
  return [
    `Brownfield run ${result.runId}, effort ${result.effort} (${size.tier}: ${size.lines} code lines, max ${size.maxPrs} PRs); execute: ${result.execute ? "yes" : "no"}`,
    `Wrote ${result.paths.runDir}/ (gitignored; not the durable wiki unless promoted)`,
    ...result.warnings.map((warning) => `Note: ${warning}`),
    `Resume: legion-cli brownfield --resume ${result.runId}`,
    `Next: ${result.next}`,
  ];
}

function stateLines(result: BrownfieldStateResult): string[] {
  const run = result.state;
  const present = Object.entries(result.artifacts)
    .filter(([, exists]) => exists)
    .map(([name]) => name);
  const outputs = Object.entries(result.analysisOutputs).map(([name, status]) => `${name}=${status}`);
  return [
    `Brownfield run ${run.runId}: phase ${run.phase}, effort ${run.effort}, execute: ${run.execute ? "yes" : "no"}`,
    `Artifacts: ${present.length > 0 ? present.join(", ") : "(none yet)"}`,
    ...(outputs.length > 0 ? [`Specialists: ${outputs.join(", ")}`] : []),
    ...(result.dag ? [`DAG: ${result.dag.done ? "done" : `ready ${result.dag.ready.join(", ") || "(none)"}`}`] : []),
    `Next: ${result.next}`,
  ];
}

/** Bare `brownfield [context...]` (init) or `brownfield --resume <id>` (state). */
export async function runBrownfield(opts: CliOpts, flags: BrownfieldFlags): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const result = await engine.brownfield({
    effort: parseEffortFlag(flags.effort),
    execute: Boolean(flags.execute),
    resume: flags.resume,
    runId: flags.runId,
    context: (flags.context ?? []).join(" ").trim(),
  });
  return emit(opts, { ...result }, result.kind === "init" ? initLines(result) : stateLines(result));
}

export async function runBrownfieldState(opts: CliOpts, runId: string, pairs: string[]): Promise<number> {
  const result = await createLegionEngine(opts.project).brownfieldState(runId, pairs);
  return emit(opts, { ...result }, stateLines(result));
}

export async function runBrownfieldRoster(opts: CliOpts, runId: string): Promise<number> {
  const result = await createLegionEngine(opts.project).brownfieldRoster(runId);
  return emit(opts, { ...result }, [
    `Brownfield run ${runId}, effort ${result.effort}: pass 1 [${result.pass1.join(", ")}] → pass 2 [${result.pass2.join(", ")}]`,
    ...(result.addedBySignal.length > 0 ? [`Added by signal: ${result.addedBySignal.join(", ")}`] : []),
    `Doctrine: ${result.injectDoctrine ? "yes" : "no"}; design reviewers: ${result.designReviewers}`,
    ...(result.executeReviewersDefault.length > 0
      ? [`Per-PR reviewers: ${result.executeReviewersDefault.join(", ")}`]
      : []),
    `Next: ${result.next}`,
  ]);
}

export async function runBrownfieldEvidence(opts: CliOpts, runId: string, flags: { skipAudit?: boolean }): Promise<number> {
  const result = await createLegionEngine(opts.project).brownfieldEvidence(runId, { skipAudit: Boolean(flags.skipAudit) });
  return emit(opts, { ...result }, [
    `Evidence for run ${runId}: ${result.testFiles} test files, ${result.coverageGaps}/${result.sourceFiles} sources without a nearby test, ${result.secretFindings} secret-pattern hits, audit ${result.auditRan ? "ran" : "skipped"}`,
    `Wrote ${result.files.tests}`,
    `Wrote ${result.files.security}`,
    `Wrote ${result.files.docs}${result.mapFingerprints ? ` (${result.undocumentedExports} exports without nearby docs)` : " (run legion-cli map for export coverage)"}`,
    "Next: pass these to the tests/security/code/documentation specialists as evidence to verify, not conclusions",
  ]);
}

export async function runBrownfieldMerge(opts: CliOpts, runId: string): Promise<number> {
  const result = await createLegionEngine(opts.project).brownfieldMerge(runId);
  const sev = result.bySeverity;
  return emit(opts, { ...result }, [
    `Analysis merged: ${result.findingsTotal} findings (${sev.critical} critical, ${sev.major} major, ${sev.minor} minor, ${sev.nit} nit), ${result.assumptionsTotal} assumptions, ${result.blockingAssumptions.length} blocking`,
    ...(result.emptySources.length > 0 ? [`No parsable blocks from: ${result.emptySources.join(", ")}`] : []),
    ...(result.ignoredBlocks.length > 0 ? [`Ignored ${result.ignoredBlocks.length} block(s) without required fields`] : []),
    ...result.blockingAssumptions.map((asm) => `  ${asm.id}: ${asm.statement}`),
    `Wrote ${result.files.findings}`,
    `Wrote ${result.files.assumptions}`,
    `Next: ${result.next}`,
  ]);
}

export type ReviewStatusFlags = { previous?: string; strict?: boolean; snapshot?: boolean };

export async function runBrownfieldReviewStatus(
  opts: CliOpts,
  runId: string,
  file: string | undefined,
  flags: ReviewStatusFlags,
): Promise<number> {
  const result = await createLegionEngine(opts.project).brownfieldReviewStatus(runId, {
    file,
    previous: flags.previous,
    strict: Boolean(flags.strict),
    snapshot: Boolean(flags.snapshot),
  });
  const sev = result.openBySeverity;
  const next =
    result.verdict === "revise"
      ? "send the open items to the writer/implementer, snapshot with --snapshot, then re-review"
      : result.verdict === "escalate"
        ? "ask the user (needs-user-input items or reopened wontfix); their answer is final"
        : "done; record leftover minor/nit items as known limitations";
  return emit(opts, { ...result, next }, [
    `Review ${result.file}: ${result.verdict} (${result.open} open: ${sev.critical}/${sev.major}/${sev.minor}/${sev.nit} critical/major/minor/nit)`,
    ...result.needsUserInput.map((item) => `  needs user input: ${item.id} ${item.title}`),
    ...result.stalemates.map((item) => `  reopened wontfix: ${item.id} ${item.title}`),
    ...(result.snapshot ? [`Snapshot: ${result.snapshot}`] : []),
    `Next: ${next}`,
  ]);
}

export async function runBrownfieldPrPlan(opts: CliOpts, runId: string): Promise<number> {
  const result = await createLegionEngine(opts.project).brownfieldPrPlan(runId);
  return emit(opts, { ...result }, [
    `PR plan: ${result.count} PRs in ${result.levels} level(s)`,
    ...result.order.map(
      (node) =>
        `  ${node.id} (level ${node.level}) ${node.title} → ${node.branch}${node.mergeIn.length > 0 ? ` (+ merge ${node.mergeIn.join(", ")})` : ""}`,
    ),
    `Wrote ${result.dagFile}`,
    `Next: ${result.next}`,
  ]);
}

export async function runBrownfieldDag(opts: CliOpts, runId: string, node: string | undefined, pairs: string[]): Promise<number> {
  const result = await createLegionEngine(opts.project).brownfieldDag(runId, node, pairs);
  const counts = Object.entries(result.counts)
    .map(([status, count]) => `${status} ${count}`)
    .join(", ");
  const next = result.done
    ? `verify the combined result, then legion-cli brownfield state ${runId} phase=verify`
    : result.ready.length > 0
      ? `legion-cli brownfield worktree ${runId} ${result.ready[0]}`
      : "wait for in-flight nodes, then re-run dag";
  return emit(opts, { ...result, next }, [
    `DAG ${runId}: ${counts}${result.done ? " (done)" : ""}`,
    ...result.nodes.map((n) => `  ${n.id} ${n.status}${n.error ? ` — ${n.error}` : ""}`),
    `Ready: ${result.ready.join(", ") || "(none)"}`,
    `Next: ${next}`,
  ]);
}

export async function runBrownfieldWorktree(
  opts: CliOpts,
  runId: string,
  node: string,
  flags: { remove?: boolean; force?: boolean },
): Promise<number> {
  const result = await createLegionEngine(opts.project).brownfieldWorktree(runId, node, {
    remove: Boolean(flags.remove),
    force: Boolean(flags.force),
  });
  const lines = flags.remove
    ? [
        `${result.removed ? "Removed" : "No"} worktree for ${node}; branch ${result.branch} kept`,
        `Next: legion-cli brownfield dag ${runId}`,
      ]
    : [
        `Worktree ${result.worktree} on ${result.branch} (base ${result.base})${result.created ? "" : " (already existed)"}`,
        ...(result.mergeIn.length > 0 ? [`Merge in first: git merge --no-edit ${result.mergeIn.join(" ")}`] : []),
        `Next: implement ${node} in that worktree, commit, then legion-cli brownfield dag ${runId} ${node} status=reviewing`,
      ];
  return emit(opts, { ...result }, lines);
}

export async function runBrownfieldPatterns(opts: CliOpts, flags: { add?: string[]; top?: string }): Promise<number> {
  const top = flags.top === undefined ? undefined : Number(flags.top);
  const result = await createLegionEngine(opts.project).brownfieldPatterns({ add: flags.add ?? [], top });
  return emit(opts, { ...result }, [
    ...(result.added.length > 0 ? [`Recorded ${result.added.length} lesson(s) in ${result.file}`] : []),
    ...(result.top.length > 0 ? result.top.map((p) => `  ${p.count}× ${p.pattern}`) : ["(no recorded patterns)"]),
  ]);
}
