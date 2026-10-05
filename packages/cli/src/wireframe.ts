import type { Dirent } from "node:fs";

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createLegionEngine, findSkillsDir, refuse } from "@9thlevelsoftware/legion-cli-core";
import { fakeArtifactsFromEnv } from "./fake-artifacts.js";
import { assertNoLinkInPath, atomicWriteFile } from "@9thlevelsoftware/legion-cli-persist";
import { parseAdapterFlag } from "./adapter-route.js";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { nextCommand } from "./next.js";

export type WireframeFlags = {
  restyle?: boolean;
  spawn?: boolean;
  adapter?: string;
  profile?: string;
};

async function readAuthoredHeadings(wireframes: string, projectRoot: string, specId: string): Promise<Map<string, string>> {
  const headings = new Map<string, string>();
  await assertNoLinkInPath(wireframes, { root: projectRoot });
  let files: Dirent[];
  try {
    files = await readdir(wireframes, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return headings;
    throw err;
  }
  for (const file of files) {
    if (!file.isFile() || !file.name.toLowerCase().endsWith(".html")) continue;
    const path = join(wireframes, file.name);
    await assertNoLinkInPath(path, { root: projectRoot });
    const html = await readFile(path, "utf8");
    await assertNoLinkInPath(path, { root: projectRoot });
    const heading = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i)?.[0];
    if (heading) headings.set(join(projectRoot, ".legion-cli", "specs", specId, "wireframes", file.name), heading);
  }
  return headings;
}

async function restoreAuthoredHeadings(headings: Map<string, string>, projectRoot: string): Promise<void> {
  for (const [path, heading] of headings) {
    await assertNoLinkInPath(path, { root: projectRoot });
    const html = await readFile(path, "utf8");
    const restyled = html.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, heading);
    if (restyled !== html) await atomicWriteFile(path, restyled, { root: projectRoot });
  }
}


export async function runWireframe(opts: CliOpts, flags: WireframeFlags): Promise<number> {
  if (flags.adapter && flags.profile) refuse("wireframe --adapter and --profile are mutually exclusive", "legion-cli wireframe --profile <name>");
  const adapter = parseAdapterFlag(flags.adapter);
  const engine = createLegionEngine(opts.project, {
    skillsDir: findSkillsDir(),
    fakeArtifacts: fakeArtifactsFromEnv(),
  });
  const restyleState = flags.restyle ? await engine.getState() : null;
  const authoredHeadings = flags.restyle && restyleState?.activeSpecId
    ? await readAuthoredHeadings(
        join(engine.store.paths.specsDir, restyleState.activeSpecId, "wireframes"),
        opts.project,
        restyleState.activeSpecId,
      )
    : new Map<string, string>();
  const result = await engine.wireframe({
    restyle: Boolean(flags.restyle),
    spawn: Boolean(flags.spawn),
    ...(adapter ? { adapter } : {}),
    ...(flags.profile ? { profile: flags.profile } : {}),
  });
  if (result.restyled) await restoreAuthoredHeadings(authoredHeadings, opts.project);
  const state = await engine.getState();
  const slice = await engine.listSliceTasks();
  const next = nextCommand(state, slice);
  const nextRun = result.status === "draft" ? "legion-cli spec approve" : next.run;

  if (opts.json) {
    writeJson({
      ok: true,
      specId: result.specId,
      status: result.status,
      index: result.index,
      pages: result.pages,
      restyled: result.restyled,
      next: nextRun,
    });
    return 0;
  }

  if (result.restyled) {
    writeOut(`Restyled ${result.index}`);
  } else {
    writeOut(`Wrote ${result.index}`);
  }
  writeOut(`${result.pages.length} screens.`);
  writeOut(`Next: ${nextRun}`);
  return 0;
}
