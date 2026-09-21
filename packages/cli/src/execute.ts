import { createLegionEngine, findSkillsDir, HINT, isSliceTerminal, refuse } from "@9thlevelsoftware/legion-cli-core";
import { parseAdapterFlag } from "./adapter-route.js";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { withInterruptHandling } from "./interrupt.js";
import { nextCommand } from "./next.js";
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
  writeOut("Copy jail is not OS isolation. Continue without a hardened sandbox? [Y/n]");
  const answer = await readLine("> ");
  if (!process.stdin.isTTY && answer.length === 0) {
    refuse(`${verb} --allow-no-sandbox requires a TTY`, HINT.allowNoSandbox);
  }
  if (isNo(answer)) {
    refuse(`${verb} --allow-no-sandbox declined`, HINT.allowNoSandbox);
  }
  if (!(answer === "" || isYes(answer))) {
    refuse(`${verb} --allow-no-sandbox needs Y or n`, HINT.allowNoSandbox);
  }
}

export async function runExecute(
  opts: CliOpts,
  flags: { id?: string; untilBlocked?: boolean; fix?: boolean; adapter?: string; allowNoSandbox?: boolean },
): Promise<number> {
  const adapter = parseAdapterFlag(flags.adapter);
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  try {
    if (flags.allowNoSandbox) {
      await slurpStdin();
      await confirmAllowNoSandbox("execute");
    }
  // Ctrl-C during a run kills the agent and finishes the spawn (restore P, revert, unfreeze)
  // before exiting, so an interrupted execute leaves the same state a crash replay would.
  const result = await withInterruptHandling(() =>
    engine.execute(flags.id ?? "auto", {
      untilBlocked: Boolean(flags.untilBlocked),
      fix: Boolean(flags.fix),
      allowNoSandbox: Boolean(flags.allowNoSandbox),
      ...(adapter ? { adapter } : {}),
    }),
  );
  const state = await engine.getState();
  const slice = await engine.listSliceTasks();
  const next = nextCommand(state, slice);
  const config = await engine.store.readConfig();
  const viewer = `http://${config.dashboard.bind}:${config.dashboard.port}`;
  const last = result.tasks.at(-1);
  const blocked = result.status === "blocked";
  const nextRun = last?.ticketId ? HINT.ticket(last.taskId) : next.run;

  if (opts.json) {
    writeJson({
      ok: !blocked,
      taskId: result.taskId,
      phase: result.phase,
      status: result.status,
      tasks: result.tasks,
      warnings: result.warnings,
      extrasReverted: last?.extrasReverted ?? [],
      incident: Boolean(last?.incident),
      next: nextRun,
      viewer,
    });
    return blocked ? 1 : 0;
  }

  for (const outcome of result.tasks) {
    const task = slice.find((item) => item.id === outcome.taskId);
    writeOut(startingTaskLine(outcome.taskId, task?.title, outcome.adapterId));
    // R-15: the incident reason says what actually happened and where the quarantine is; the old
    // hard-coded "inspect .git" was wrong for every incident that did not touch `.git`.
    if (outcome.extrasReverted.length > 0) {
      writeOut(
        outcome.quarantineDir
          ? `FileContract extras reverted: ${outcome.extrasReverted.join(", ")} (the previous versions are at ${outcome.quarantineDir})`
          : `FileContract extras reverted: ${outcome.extrasReverted.join(", ")}`,
      );
    }
    // R-14: ignored-path warnings and "LOST:" lines are the user's only notice; print them.
    for (const warning of outcome.warnings ?? []) writeOut(warning);
    if (outcome.ticketId) {
      writeOut(
        outcome.extrasReverted.length > 0
          ? `Filed ${outcome.ticketId} (type: scope).`
          : `Filed ${outcome.ticketId}.`,
      );
    }
    if (outcome.status === "done") {
      writeOut(`Verification PASS. ${outcome.taskId} done.`);
    } else {
      writeOut(outcome.reason ? `${outcome.taskId} blocked: ${outcome.reason}` : `${outcome.taskId} blocked.`);
    }
  }
  for (const warning of result.warnings) writeOut(warning);
  if (flags.untilBlocked && isSliceTerminal(slice) && !blocked) {
    writeOut(`Slice complete. Next: ${nextRun}`);
  } else {
    writeOut(`Next: ${nextRun}`);
  }
  writeOut(`Dashboard: ${viewer}`);
  return blocked ? 1 : 0;
  } finally {
    closePrompt();
  }
}
