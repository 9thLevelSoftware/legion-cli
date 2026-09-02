import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPointerPrompt,
  DEFAULT_TIMEOUT_MS,
  filterSpawnEnv,
  isSpawnable,
  resolveAdapter,
  stageSkill,
  writeRunPrompt,
  type FakeArtifact,
} from "@9thlevelsoftware/legion-cli-agents";
import { SCHEMA_VERSION, type LegionConfig, type SkillId } from "@9thlevelsoftware/legion-cli-schema";
import { skillContract } from "./contracts.js";
import { recordPreSpawnRef, revertExtras, snapshotPaths, type RevertResult } from "./revert.js";

export type OptionalSpawnResult = {
  spawned: boolean;
  runId: string;
  revert: RevertResult | null;
};

export function findSkillsDir(from = process.cwd()): string | undefined {
  const env = process.env.LEGION_CLI_SKILLS_DIR?.trim();
  if (env) return env;
  const starts = [from];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // ignore
  }
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, "skills");
      if (existsSync(join(candidate, "interview", "SKILL.md"))) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

export async function optionalSkillSpawn(opts: {
  projectRoot: string;
  config: LegionConfig;
  skillId: SkillId;
  specId?: string;
  promptBody: string;
  skillsDir?: string;
  fakeArtifacts?: FakeArtifact[];
  throwAfterWrite?: boolean;
}): Promise<OptionalSpawnResult> {
  const runId = `${opts.skillId}-${Date.now().toString(36)}`;
  const adapter = resolveAdapter(opts.config, {
    artifacts: opts.fakeArtifacts ?? [],
    throwAfterWrite: opts.throwAfterWrite,
  });
  if (!(await isSpawnable(adapter))) {
    return { spawned: false, runId, revert: null };
  }

  const skillsDir = opts.skillsDir ?? findSkillsDir();
  const skillDir = skillsDir ? join(skillsDir, opts.skillId) : undefined;
  if (!skillDir || !existsSync(join(skillDir, "SKILL.md"))) {
    return { spawned: false, runId, revert: null };
  }

  const contract = skillContract(opts.skillId, { runId, specId: opts.specId });
  const prompt = [
    opts.promptBody.trim(),
    "",
    "## SkillContract",
    `skillId: ${contract.skillId}`,
    "allowedRoots:",
    ...contract.allowedRoots.map((root) => `- ${root}`),
    "",
    "Do not write files outside allowedRoots. Do not git add or git commit.",
  ].join("\n");

  await stageSkill({
    projectRoot: opts.projectRoot,
    runId,
    skillDir,
    craftDir: existsSync(join(opts.projectRoot, ".legion-cli", "design", "craft"))
      ? join(opts.projectRoot, ".legion-cli", "design", "craft")
      : undefined,
  });
  const promptPath = await writeRunPrompt({ projectRoot: opts.projectRoot, runId, body: prompt });
  const preSpawnRef = recordPreSpawnRef(opts.projectRoot);
  const snapshot = preSpawnRef ? undefined : await snapshotPaths(opts.projectRoot);
  const resumeDir = join(opts.projectRoot, ".legion-cli", "cache", "runs", runId);
  await mkdir(resumeDir, { recursive: true });
  await writeFile(
    join(resumeDir, "resume.json"),
    `${JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION.resume,
        runId,
        skillId: opts.skillId,
        preSpawnRef: preSpawnRef ?? "UNBORN",
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const handle = await adapter.spawn({
    runId,
    skillId: opts.skillId,
    promptPath,
    pointerPrompt: buildPointerPrompt(runId, opts.skillId),
    cwd: opts.projectRoot,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    env: filterSpawnEnv(),
    expectedArtifacts: opts.fakeArtifacts,
  });
  let revert: RevertResult | null = null;
  try {
    await handle.wait();
  } finally {
    revert = await revertExtras({
      projectRoot: opts.projectRoot,
      preSpawnRef,
      allowedRoots: contract.allowedRoots,
      snapshot,
    });
  }
  return { spawned: true, runId, revert };
}
