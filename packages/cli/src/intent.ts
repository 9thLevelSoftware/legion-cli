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
  done?: boolean;
  quiet?: boolean;
  keepPrompt?: boolean;
  guidance?: "guided" | "balanced" | "direct";
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
    if (flags.guidance) await engine.setGuidance(flags.guidance);
    const assistance = await engine.getAssistance();
    if (assistance?.paused) await engine.resumeAssistance();
    await slurpStdin();
    let state = await engine.beginIntent();

    let intro = state.answers.rounds.length === 0;
    let skipRest = Boolean(flags.done);
    for (;;) {
      while (state.nextQuestions.length > 0) {
        if (skipRest && state.canFinishEarly && state.answers.rounds.length > 0) break;
        if (!opts.json) {
          if (assistance) {
            if (intro && assistance.guidance !== "direct") writeOut("Answer one decision at a time. Use explain, recommend, edit, unsure, or pause when needed.");
            writeOut(state.nextQuestions[0]);
          } else printQuestions(state, intro);
        }
        intro = false;
        const answers: string[] = [];
        for (let i = 0; i < (assistance ? 1 : state.nextQuestions.length); i++) {
          let line = await readLine(assistance ? "> [explain/recommend/edit/unsure/pause] " : "> ");
          while (assistance && ["explain", "recommend", "edit", "unsure"].includes(line.toLowerCase())) {
            if (line.toLowerCase() === "explain") writeOut(`This answer defines the intent for approval: ${state.nextQuestions[i]}`);
            else if (line.toLowerCase() === "recommend") {
              const recommendation = await engine.proposeIntentRecommendation(state.nextQuestions[i]!);
              writeOut(`Suggested answer: ${recommendation.answer}`);
              writeOut(`Reason: ${recommendation.rationale}`);
              writeOut(`Consequence: ${recommendation.consequence}`);
              const use = await readLine("Use this answer? [y/N]: ");
              if (isYes(use)) {
                line = recommendation.answer;
                break;
              }
              writeOut("Enter your own answer, edit the suggestion, or pause.");
            }
            else if (line.toLowerCase() === "unsure") writeOut("You can describe your uncertainty as an open decision or pause to investigate.");
            else writeOut("Enter the revised answer to the current question.");
            line = await readLine("> [pause] ");
          }
          if (assistance && (!line || line.toLowerCase() === "pause")) {
            await engine.pauseAssistance();
            if (opts.json && !flags.quiet) writeJson({ ok: true, paused: true, next: "legion-cli spec" });
            else writeOut("Progress saved. Intent is not approved. Resume: legion-cli spec");
            return 0;
          }
          if (!line) {
            refuse("intent requires answers", HINT.intent);
          }
          answers.push(line);
        }
        state = await engine.intentTurn(answers);
        if (skipRest && state.canFinishEarly) break;
      }

      if (skipRest && !state.canFinishEarly && !state.readyToConfirm) {
        refuse("--done is allowed after round 2", HINT.intent);
      }

      if (!opts.json) {
        writeOut("");
        writeOut(state.brief);
        writeOut("Confirm this is what must be true when we are done? [Y/n]");
      }
      const confirm = await readLine("> ");
      if (isYes(confirm)) {
        await engine.confirmIntent({ id: "user" }, { done: skipRest });
        break;
      }
      skipRest = false;
      if (state.nextQuestions.length === 0) {
        if (!opts.json) writeOut("Not confirmed. Run legion-cli intent when ready.");
        return 0;
      }
    }

    if (opts.json && !flags.quiet) {
      const after = await engine.getIntentState();
      writeJson({
        ok: true,
        phase: after.phase,
        mapped: after.mapped,
        next: "legion-cli discuss",
      });
      return 0;
    }
    if (!flags.quiet) {
      writeOut("");
      writeOut("Next: legion-cli discuss    (or type legion-cli)");
    }
    return 0;
  } finally {
    if (!flags.keepPrompt) closePrompt();
  }
}
