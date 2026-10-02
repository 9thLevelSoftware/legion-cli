import { createLegionEngine, findSkillsDir, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import { parseAdapterFlag } from "./adapter-route.js";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
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
  writeOut("Copy jail is not OS isolation. Continue without a hardened sandbox? [Y/n]");
  const answer = await readLine("> ");
  if (isNo(answer)) {
    refuse(`${verb} --allow-no-sandbox declined`, HINT.allowNoSandbox);
  }
  if (!(answer === "" || isYes(answer))) {
    refuse(`${verb} --allow-no-sandbox needs Y or n`, HINT.allowNoSandbox);
  }
}

export async function runExecute(
  opts: CliOpts,
  flags: { id?: string; step?: boolean; retry?: boolean; untilBlocked?: boolean; fix?: boolean; adapter?: string; allowNoSandbox?: boolean },
): Promise<number> {
  const adapter = parseAdapterFlag(flags.adapter);
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  try {
    if (flags.allowNoSandbox) {
      await slurpStdin();
      await confirmAllowNoSandbox("execute");
    }
  const result = await engine.executeWorkflow({
    ...(flags.id ? { taskId: flags.id } : {}),
    step: Boolean(flags.step || flags.id),
    retry: Boolean(flags.retry),
    fix: Boolean(flags.fix),
    allowNoSandbox: Boolean(flags.allowNoSandbox),
    ...(adapter ? { adapter } : {}),
  });
  const blocked = result.status === "blocked";

  if (opts.json) {
    writeJson({
      ok: !blocked,
      taskId: result.taskId ?? null,
      status: result.status,
      retry: Boolean(flags.retry),
      completedTaskIds: result.completedTaskIds,
      blocker: result.blocker,
      next: result.next,
      tasks: result.tasks ?? [],
      warnings: result.warnings ?? [],
    });
    return blocked ? 1 : 0;
  }

  for (const outcome of result.tasks ?? []) {
    if (outcome.incident) writeOut("Sandbox or file-contract incident: inspect .git before continuing.");
    if (outcome.extrasReverted?.length) writeOut(`FileContract extras reverted: ${outcome.extrasReverted.join(", ")}`);
    if (outcome.ticketId) writeOut(`Filed ${outcome.ticketId}${outcome.extrasReverted?.length ? " (scope)" : ""}.`);
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
