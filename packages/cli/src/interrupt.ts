import { abortStartedSpawns, unfinishedSpawnIds } from "@9thlevelsoftware/legion-cli-core";
import { writeErr } from "./io.js";

/** POSIX convention for "killed by SIGINT". `ship`/`execute` callers read it as "interrupted". */
export const INTERRUPTED_EXIT_CODE = 130;

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

let installed = 0;
let interrupting = false;

/**
 * Two-stage interrupt for the verbs that spawn an agent (execute, review, plan, chat).
 *
 * Without this, Ctrl-C kills the engine and leaves the run half-done: the agent keeps running,
 * the protected set is never restored and the control record freezes every later command until it
 * ages out. So the **first** signal kills the agent — the POSIX process group, or the Windows
 * process tree — and then runs each started spawn's normal finish (restore P, revert the tree,
 * lift the freeze) before exiting 130. The **second** signal gives up and exits immediately: a
 * finish that is itself wedged must never trap the user.
 *
 * It coexists with the SIGINT forwarder `agents/run-command.ts` installs around a verification
 * child: that one only re-raises the signal when nothing else is listening, and while this is
 * installed something is, so the child is killed and the finish still gets to run.
 *
 * Honest limit: a process the agent deliberately detached from its own group survives both the
 * abort and the replay, and can write after the restore. The guarantee is as of the finish.
 */
export async function withInterruptHandling<T>(fn: () => Promise<T>): Promise<T> {
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupting) {
      // Second press: stop waiting for the finish.
      writeErr(`\n${signal} again: exiting now. Run legion-cli doctor to see what the run left behind.`);
      process.exit(INTERRUPTED_EXIT_CODE);
    }
    interrupting = true;
    const runs = unfinishedSpawnIds();
    writeErr(
      runs.length > 0
        ? `\n${signal}: stopping the agent and putting your files back (press ${signal === "SIGINT" ? "Ctrl-C" : signal} again to exit now)...`
        : `\n${signal}: stopping.`,
    );
    void abortStartedSpawns()
      .catch(() => undefined)
      .then(() => {
        process.exit(INTERRUPTED_EXIT_CODE);
      });
  };
  const handlers = SIGNALS.map((signal) => {
    const handler = (): void => onSignal(signal);
    process.on(signal, handler);
    return { signal, handler };
  });
  installed += 1;
  try {
    return await fn();
  } finally {
    installed -= 1;
    for (const { signal, handler } of handlers) process.removeListener(signal, handler);
    if (installed === 0) interrupting = false;
  }
}
