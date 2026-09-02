import { createLegionEngine, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import { formatQaScore, QA_NO_BROWSER_CAP } from "@9thlevelsoftware/legion-cli-qa";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { nextCommand } from "./next.js";
import { isNo, isYes, readLine } from "./prompt.js";

export type QaFlags = {
  mode?: string;
};

export type QaChecklistFlags = {
  tick?: string[];
};

function parseMode(raw: string | undefined): "full" | "no-browser" | undefined {
  if (!raw) return undefined;
  if (raw === "full" || raw === "no-browser") return raw;
  refuse("qa.mode must be full or no-browser (off is forbidden)", HINT.qa);
}

export async function runQa(opts: CliOpts, flags: QaFlags): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const score = await engine.qa({ mode: parseMode(flags.mode) });
  const state = await engine.getState();
  const slice = await engine.listSliceTasks();
  const next = nextCommand(state, slice);
  const config = await engine.store.readConfig();
  const viewer = `http://${config.dashboard.bind}:${config.dashboard.port}`;
  const line = formatQaScore(score);

  if (opts.json) {
    writeJson({
      ok: score.pass,
      score,
      line,
      phase: state.phase,
      next: score.pass ? "legion-cli ship" : score.mode === "no-browser" ? HINT.degradedQa : next.run,
      viewer,
    });
    return score.pass ? 0 : 1;
  }

  writeOut(line);
  if (score.pass) {
    writeOut("PASS. Next: legion-cli ship");
  } else if (score.mode === "no-browser") {
    writeOut(`FAIL (no-browser, cap ${QA_NO_BROWSER_CAP}). Next: ${HINT.degradedQa}`);
  } else {
    writeOut("FAIL. Next: legion-cli qa");
  }
  writeOut(`Dashboard: ${viewer}`);
  return score.pass ? 0 : 1;
}

export async function runQaChecklist(opts: CliOpts, flags: QaChecklistFlags): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const state = await engine.getState();
  const specId = state.activeSpecId;
  if (!specId) {
    refuse("qa checklist requires an active spec", HINT.spec);
  }
  const spec = (await engine.store.readSpec(specId)).data;
  let ticks = flags.tick?.filter(Boolean) ?? [];
  if (ticks.length === 0) {
    if (!process.stdin.isTTY && !process.stdin.readable) {
      refuse("qa checklist requires a TTY or --tick", HINT.qaChecklist);
    }
    const answers: string[] = [];
    for (const ac of spec.acceptance) {
      writeOut(`${ac.id} (${ac.priority}): ${ac.statement}`);
      const ans = await readLine("Met? [Y/n] ");
      if (isNo(ans)) continue;
      if (ans === "" || isYes(ans)) answers.push(ac.id);
    }
    ticks = answers;
  }

  await engine.qaChecklist(ticks);
  if (opts.json) {
    writeJson({ ok: true, specId, ticks, next: "legion-cli qa --mode no-browser" });
    return 0;
  }
  writeOut(`Checklist saved (${ticks.length}/${spec.acceptance.length} ticked).`);
  writeOut("Next: legion-cli qa --mode no-browser");
  return 0;
}
