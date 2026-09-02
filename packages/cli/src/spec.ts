import { createLegionEngine, findSkillsDir, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import { specPath } from "@9thlevelsoftware/legion-cli-persist";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export type SpecFlags = {
  skipWireframes?: boolean;
  message?: string;
};

export async function runSpecDraft(opts: CliOpts, flags: SpecFlags): Promise<number> {
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  const spec = await engine.draftSpec({ skipWireframes: flags.skipWireframes });
  const specFile = specPath(spec.id);
  const wire = flags.skipWireframes
    ? null
    : `.legion-cli/specs/${spec.id}/wireframes/INDEX.html`;
  if (opts.json) {
    writeJson({
      ok: true,
      specId: spec.id,
      path: specFile,
      wireframes: wire,
      skipWireframes: Boolean(flags.skipWireframes),
      next: "legion-cli spec approve",
    });
    return 0;
  }
  writeOut(`Wrote ${specFile}`);
  if (wire) {
    writeOut(`Wireframes: ${wire}`);
    writeOut("Open in the dashboard (viewer) or a browser, then:  legion-cli spec approve");
  } else {
    writeOut("Wireframes skipped (pre-approve). Next: legion-cli spec approve");
  }
  return 0;
}

export async function runSpecShow(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const state = await engine.getState();
  const specId = state.activeSpecId;
  if (!specId) {
    refuse("no active spec", HINT.spec);
  }
  const path = specPath(specId);
  if (opts.json) {
    writeJson({ specId, path });
    return 0;
  }
  writeOut(path);
  return 0;
}

export async function runSpecApprove(opts: CliOpts, flags: SpecFlags): Promise<number> {
  if (flags.skipWireframes || process.argv.includes("--skip-wireframes")) {
    refuse("--skip-wireframes is pre-approve only", HINT.skipWireframes);
  }
  const engine = createLegionEngine(opts.project, { skillsDir: findSkillsDir() });
  const state = await engine.getState();
  const specId = state.activeSpecId;
  if (!specId) {
    refuse("no active spec to approve", HINT.spec);
  }
  await engine.approveSpec(specId, { id: "user" });
  if (flags.message) {
    const doc = await engine.store.readSpec(specId);
    await engine.store.writeSpec(doc.data, `${doc.body.trim()}\n\nApproved: ${flags.message}\n`);
  }
  if (opts.json) {
    writeJson({ ok: true, specId, phase: "spec_frozen", next: "legion-cli plan" });
    return 0;
  }
  writeOut("Spec frozen. Next: legion-cli plan");
  return 0;
}

export async function runSpecNew(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  await engine.newSpec();
  if (opts.json) {
    writeJson({ ok: true, phase: "intent_draft", next: "legion-cli intent" });
    return 0;
  }
  writeOut("Previous spec superseded. Next: legion-cli intent");
  return 0;
}
