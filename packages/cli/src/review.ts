import { createLegionEngine, findSkillsDir } from "@9thlevelsoftware/legion-cli-core";
import type { FakeArtifact } from "@9thlevelsoftware/legion-cli-agents";
import { parseAdapterFlag } from "./adapter-route.js";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { nextCommand } from "./next.js";

/** Test seam: fake adapter artifacts when LEGION_CLI_ADAPTER=fake. */
function reviewFakeArtifacts(): FakeArtifact[] | undefined {
  if (process.env.LEGION_CLI_ADAPTER !== "fake") return undefined;
  const raw = process.env.LEGION_CLI_FAKE_ARTIFACTS?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as FakeArtifact[]) : undefined;
  } catch {
    return undefined;
  }
}

export async function runReview(opts: CliOpts, flags: { adapter?: string } = {}): Promise<number> {
  const adapter = parseAdapterFlag(flags.adapter);
  const engine = createLegionEngine(opts.project, {
    skillsDir: findSkillsDir(),
    fakeArtifacts: reviewFakeArtifacts(),
  });
  const result = await engine.review(adapter ? { adapter } : undefined);
  const state = await engine.getState();
  const slice = await engine.listSliceTasks();
  const next = nextCommand(state, slice);
  const config = await engine.store.readConfig();
  const viewer = `http://${config.dashboard.bind}:${config.dashboard.port}`;
  const passed = result.verdict === "PASS";

  if (opts.json) {
    writeJson({
      ok: passed,
      verdict: result.verdict,
      createdTaskIds: result.createdTaskIds,
      rewrittenExistingTaskIds: result.rewrittenExistingTaskIds,
      extrasReverted: result.extrasReverted,
      phase: state.phase,
      lastReview: state.lastReview ?? null,
      next: next.run,
      viewer,
    });
    return passed ? 0 : 1;
  }

  if (passed) {
    writeOut("Review PASS.");
  } else if (result.createdTaskIds.length > 0) {
    writeOut(`Review FAIL. Spawn created ${result.createdTaskIds.join(", ")}.`);
  } else if (result.rewrittenExistingTaskIds.length > 0) {
    writeOut(`Review FAIL. Existing tasks were rewritten: ${result.rewrittenExistingTaskIds.join(", ")}.`);
  } else {
    writeOut("Review FAIL.");
  }
  writeOut(`Next: ${next.run}`);
  writeOut(`Dashboard: ${viewer}`);
  return passed ? 0 : 1;
}
