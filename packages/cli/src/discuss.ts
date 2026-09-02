import { createLegionEngine, findSkillsDir, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { closePrompt, isNo, readLine, slurpStdin } from "./prompt.js";

export async function runDiscuss(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  try {
    await slurpStdin();
    let proposed = await engine.startDiscuss();
    if (opts.json && proposed.length === 0) {
      writeJson({ ok: true, remaining: [], next: "legion-cli spec" });
      return 0;
    }

    while (proposed.length > 0) {
      const batch = proposed.slice(0, 2);
      if (opts.yes) {
        proposed = await engine.discuss(batch.map((item) => ({ id: item.id, status: "accepted" })));
        continue;
      }
      const decisions: Array<{ id: string; status: "accepted" | "rejected" }> = [];
      for (const item of batch) {
        writeOut(`Decision ${item.id}: ${item.statement} Accept?  [Y/n]`);
        const answer = await readLine("> ");
        if (isNo(answer)) {
          decisions.push({ id: item.id, status: "rejected" });
        } else if (answer.length === 0 || /^(y|yes)$/i.test(answer)) {
          decisions.push({ id: item.id, status: "accepted" });
        } else {
          refuse("discuss needs Y or n", HINT.discuss);
        }
      }
      proposed = await engine.discuss(decisions);
    }

    if (opts.json) {
      writeJson({ ok: true, remaining: [], next: "legion-cli spec" });
      return 0;
    }
    writeOut("Decisions recorded. Next: legion-cli spec");
    return 0;
  } finally {
    closePrompt();
  }
}
