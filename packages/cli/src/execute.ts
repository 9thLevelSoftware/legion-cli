import { createLegionEngine, findSkillsDir, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import { parseAdapterFlag } from "./adapter-route.js";
import { fakeArtifactsFromEnv } from "./fake-artifacts.js";
import type { CliOpts } from "./io.js";
import { ticketVerificationLine, writeErr, writeJson, writeOut } from "./io.js";
import { closePrompt, isNo, isYes, readLine, slurpStdin } from "./prompt.js";

export function startingTaskLine(
  taskId: string,
  title: string | undefined,
  adapterId: string | undefined,
): string {
  const titleBit = title ? ` (${title})` : "";
  const viaBit = adapterId ? ` via ${adapterId}` : "";
  return `Starting ${taskId}${titleBit}${viaBit}.`;
}

export async function confirmAllowNoSandbox(verb: "execute" | "fix"): Promise<void> {
  if (!process.stdin.isTTY) {
    refuse(`${verb} --allow-no-sandbox requires a TTY`, HINT.allowNoSandbox);
  }
  writeErr("Copy jail is not OS isolation. Continue without a hardened sandbox? [y/n] (an explicit y is required)");
  const answer = await readLine("> ");
  if (isNo(answer)) {
    refuse(`${verb} --allow-no-sandbox declined`, HINT.allowNoSandbox);
  }
  if (!isYes(answer)) {
    refuse(`${verb} --allow-no-sandbox needs an explicit y or n (empty is not approval)`, HINT.allowNoSandbox);
  }
}

export async function runExecute(
  opts: CliOpts,
  flags: { id?: string; step?: boolean; retry?: boolean; resume?: string; untilBlocked?: boolean; jobs?: string; fix?: boolean; adapter?: string; profile?: string; allowNoSandbox?: boolean },
): Promise<number> {
  if (flags.adapter && flags.profile) {
    refuse("execute --adapter and --profile are mutually exclusive", "legion-cli execute --profile <name>");
  }
  const adapter = parseAdapterFlag(flags.adapter);
  const jobs = flags.jobs === undefined ? undefined : Number(flags.jobs);
  if (jobs !== undefined && (!Number.isInteger(jobs) || jobs < 1 || jobs > 4)) {
    refuse("execute --jobs must be an integer from 1 to 4", "legion-cli execute --until-blocked --jobs 1");
  }
  if (jobs !== undefined && !flags.untilBlocked) {
    refuse("execute --jobs requires --until-blocked", "legion-cli execute --until-blocked --jobs 1");
  }
  if (jobs !== undefined && (flags.id || flags.step)) {
    refuse("execute --jobs is only for automatic execution", "legion-cli execute --until-blocked --jobs 1");
  }
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir(), fakeArtifacts: fakeArtifactsFromEnv() });
  try {
    if (flags.allowNoSandbox) {
      await slurpStdin();
      await confirmAllowNoSandbox("execute");
    }
  const result = await engine.executeWorkflow({
    ...(flags.id ? { taskId: flags.id } : {}),
    step: Boolean(flags.step || flags.id),
    retry: Boolean(flags.retry),
    ...(flags.resume ? { resume: flags.resume } : {}),
    untilBlocked: Boolean(flags.untilBlocked),
    ...(jobs !== undefined ? { jobs } : {}),
    onProgress: (progress) => {
      const elapsed = (progress.elapsedMs / 1000).toFixed(1);
      const log = progress.logPath ? ` log=${progress.logPath}` : "";
      writeErr(`[${progress.taskId}] ${progress.stage} elapsed=${elapsed}s${log}`);
    },
    fix: Boolean(flags.fix),
    allowNoSandbox: Boolean(flags.allowNoSandbox),
    ...(adapter ? { adapter } : {}),
    ...(flags.profile ? { profile: flags.profile } : {}),
  });
  const blocked = result.status === "blocked";
  const slice = opts.json ? [] : await engine.listSliceTasks();

  if (opts.json) {
    const state = await engine.getState();
    const last = result.tasks?.at(-1);
    writeJson({
      ok: !blocked,
      taskId: result.taskId ?? null,
      phase: state.phase,
      status: result.status,
      retry: Boolean(flags.retry),
      completedTaskIds: result.completedTaskIds,
      blocker: result.blocker,
      next: result.next,
      tasks: result.tasks ?? [],
      warnings: result.warnings ?? [],
      extrasReverted: last?.extrasReverted ?? [],
      incident: Boolean(last?.incident),
    });
    return blocked ? 1 : 0;
  }

  for (const outcome of result.tasks ?? []) {
    const task = slice.find((item) => item.id === outcome.taskId);
    writeOut(startingTaskLine(outcome.taskId, task?.title, outcome.adapterId));
    if (outcome.profile) writeOut(`Profile: ${outcome.profile}`);
    if (outcome.usage) {
      const cost = outcome.usage.estimatedCostUsd === undefined
        ? ""
        : ` estimatedCostUsd=${outcome.usage.estimatedCostUsd}${outcome.usage.costEstimated ? " (estimate)" : ""}`;
      writeOut(`Usage: requests=${outcome.usage.requests ?? "unknown"} toolCalls=${outcome.usage.toolCalls ?? "unknown"} tokens=${outcome.usage.totalTokens ?? "unknown"}${cost}`);
    }
    if (outcome.incident) writeOut("Sandbox or file-contract incident: inspect .git before continuing.");
    if (outcome.extrasReverted?.length) writeOut(`FileContract extras reverted: ${outcome.extrasReverted.join(", ")}`);
    if (outcome.ticketId) writeOut(`Filed ${outcome.ticketId}${outcome.extrasReverted?.length ? " (type: scope)" : ""}.`);
    for (const filed of outcome.filedTickets ?? []) {
      writeOut(ticketVerificationLine(filed));
    }
    if (outcome.status === "done") {
      writeOut(`Verification PASS. ${outcome.taskId} done.`);
    } else {
      writeOut(outcome.reason ? `${outcome.taskId} blocked: ${outcome.reason}` : `${outcome.taskId} blocked.`);
    }
    if (outcome.trustTierNote) writeOut(outcome.trustTierNote);
  }
  for (const warning of result.warnings ?? []) writeOut(warning);
  if (result.completedTaskIds.length > 0) writeOut(`Completed: ${result.completedTaskIds.join(", ")}`);
  if (result.blocker) writeOut(`Blocked: ${result.blocker}`);
  writeOut(`Next: ${result.next}`);
  return blocked ? 1 : 0;
  } finally {
    closePrompt();
  }
}

export async function runApproveAction(
  opts: CliOpts,
  request: { runId: string; actionId: string; valueDigest: string; sinkId: string },
  reason: string,
): Promise<number> {
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  const approval = await engine.approveAction({
    ...request,
    operatorId: "user",
    reason,
  });
  if (opts.json) writeJson({ ok: true, approval });
  else writeOut(`Approved exact governed action ${approval.actionId} for sink ${approval.sinkId}.`);
  return 0;
}
