import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { filterSpawnEnv, runCachePaths, stageSkill, writeRunPrompt } from "../dist/index.js";

export const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const fixturesDir = join(pkgRoot, "test", "fixtures");

export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-agents-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function writeSkill(dir, body = "# skill\n") {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body, "utf8");
}

export async function setupRun(projectRoot, opts = {}) {
  const runId = opts.runId ?? "run-1";
  const skillId = opts.skillId ?? "plan";
  const skillDir = join(projectRoot, "skill-src");
  await writeSkill(skillDir, opts.skillBody ?? "# skill\n");
  await stageSkill({
    projectRoot,
    runId,
    skillDir,
    craftDir: opts.craftDir,
  });
  const promptPath = await writeRunPrompt({
    projectRoot,
    runId,
    body: opts.promptBody ?? "Do the skill.\n",
  });
  const paths = runCachePaths(projectRoot, runId);
  return {
    runId,
    skillId,
    promptPath,
    paths,
    job: {
      runId,
      skillId,
      promptPath,
      pointerPrompt: opts.pointerPrompt ?? `runId=${runId} skill=${skillId}`,
      cwd: projectRoot,
      timeoutMs: opts.timeoutMs ?? 20_000,
      env: opts.env ?? filterSpawnEnv(),
      expectedArtifacts: opts.expectedArtifacts,
    },
  };
}
