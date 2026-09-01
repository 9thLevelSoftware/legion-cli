import {
  createLegionEngine,
  findSkillsDir,
  HINT,
  refuse,
  type IntentState,
} from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { closePrompt, isYes, readLine, slurpStdin } from "./prompt.js";

export type IntentFlags = {
  resume?: boolean;
  done?: boolean;
};

function printQuestions(state: IntentState, intro: boolean): void {
  if (intro) {
    writeOut("I'll ask two questions at a time. Answer in your own words.");
    writeOut("");
  } else {
    writeOut("Recorded. Two more:");
    writeOut("");
  }
  state.nextQuestions.forEach((question, i) => {
    writeOut(`${i + 1}. ${question}`);
  });
  writeOut("");
}

export async function runIntent(opts: CliOpts, flags: IntentFlags): Promise<number> {
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  try {
    await slurpStdin();
    let state = await engine.beginIntent();
    void flags.resume;

    let intro = state.answers.rounds.length === 0;
    while (state.nextQuestions.length > 0) {
      if (flags.done && state.canFinishEarly && state.answers.rounds.length > 0) break;
      if (!opts.json) printQuestions(state, intro);
      intro = false;
      const answers: string[] = [];
      for (let i = 0; i < state.nextQuestions.length; i++) {
        const line = await readLine("> ");
        if (!line) {
          refuse("intent requires answers", HINT.intent);
        }
        answers.push(line);
      }
      state = await engine.intentTurn(answers);
      if (flags.done && state.canFinishEarly) break;
    }

    if (flags.done && !state.canFinishEarly && !state.readyToConfirm) {
      refuse("--done is allowed after round 2", HINT.intent);
    }

    if (!opts.json) {
      writeOut("");
      writeOut(state.brief);
      writeOut("Confirm this is what must be true when we are done? [Y/n]");
    }
    const confirm = await readLine("> ");
    if (!isYes(confirm)) {
      refuse("intent confirmation is required", HINT.intentConfirm);
    }
    await engine.confirmIntent({ id: "user" }, { done: flags.done });

    if (opts.json) {
      const after = await engine.getIntentState();
      writeJson({
        ok: true,
        phase: after.phase,
        mapped: after.mapped,
        next: "legion-cli discuss",
      });
      return 0;
    }
    writeOut("");
    writeOut("Next: legion-cli discuss    (or type legion-cli)");
    return 0;
  } finally {
    closePrompt();
  }
}
