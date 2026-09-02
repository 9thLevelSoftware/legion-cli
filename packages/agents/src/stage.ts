import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCachePaths } from "./paths.js";

export type StageSkillOptions = {
  projectRoot: string;
  runId: string;
  skillDir: string;
  craftDir?: string;
};

/** Copy (not symlink) the skill directory into `.legion-cli/cache/skills/<run-id>/`. */
export async function stageSkill(opts: StageSkillOptions): Promise<string> {
  const dest = runCachePaths(opts.projectRoot, opts.runId).skillDir;
  await mkdir(dirname(dest), { recursive: true });
  await cp(opts.skillDir, dest, { recursive: true, dereference: true, force: true });
  if (opts.craftDir) {
    const craftDest = join(dest, "craft");
    await mkdir(craftDest, { recursive: true });
    const names = await readdir(opts.craftDir);
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      await cp(join(opts.craftDir, name), join(craftDest, name), {
        dereference: true,
        force: true,
      });
    }
  }
  return dest;
}
