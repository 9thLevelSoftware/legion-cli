import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentError,
  buildPointerPrompt,
  DEFAULT_TIMEOUT_MS,
  filterSpawnEnv,
  isSpawnable,
  resolveAdapter,
  stageSkill,
  writeRunPrompt,
  type FakeArtifact,
} from "@9thlevelsoftware/legion-cli-agents";
import { composeDesignContext, readActive } from "@9thlevelsoftware/legion-cli-design-system";
import { SCHEMA_VERSION, type LegionConfig, type SkillId } from "@9thlevelsoftware/legion-cli-schema";
import { skillContract } from "./contracts.js";
import { HINT, refuse } from "./errors.js";
import {
  recordPreSpawnRef,
  revertExtras,
  snapshotDirtyPaths,
  snapshotGitPolicy,
  snapshotPaths,
  type RevertResult,
} from "./revert.js";

function skillMissingHint(skillId: SkillId): string {
  if (skillId === "execute") return HINT.execute;
  if (skillId === "review") return HINT.review;
  if (skillId === "verify") return HINT.verify;
  return HINT.plan;
}

export type OptionalSpawnResult = {
  spawned: boolean;
  runId: string;
  revert: RevertResult | null;
  error?: unknown;
  timedOut?: boolean;
  durationMs?: number;
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
      if (
        existsSync(join(candidate, "interview", "SKILL.md")) ||
        existsSync(join(candidate, "plan", "SKILL.md")) ||
        existsSync(join(candidate, "execute", "SKILL.md"))
      ) {
        return candidate;
      }
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
  taskId?: string;
  promptBody: string;
  extraAllowedRoots?: readonly string[];
  filesForbidden?: readonly string[];
  skillsDir?: string;
  fakeArtifacts?: FakeArtifact[];
  throwAfterWrite?: boolean;
  timedOut?: boolean;
  required?: boolean;
}): Promise<OptionalSpawnResult> {
  const runId = `${opts.skillId}-${Date.now().toString(36)}`;
  const adapter = resolveAdapter(opts.config, {
    artifacts: opts.fakeArtifacts ?? [],
    throwAfterWrite: opts.throwAfterWrite,
    timedOut: opts.timedOut,
  });
  if (!(await isSpawnable(adapter))) {
    if (opts.required) {
      refuse(`${opts.skillId} needs a spawnable adapter (run legion-cli doctor)`, HINT.doctor);
    }
    return { spawned: false, runId, revert: null };
  }

  const skillsDir = opts.skillsDir ?? findSkillsDir();
  const skillDir = skillsDir ? join(skillsDir, opts.skillId) : undefined;
  if (!skillDir || !existsSync(join(skillDir, "SKILL.md"))) {
    if (opts.required) {
      refuse(`${opts.skillId} requires skills/${opts.skillId}/SKILL.md`, skillMissingHint(opts.skillId));
    }
    return { spawned: false, runId, revert: null };
  }

  const contract = skillContract(opts.skillId, { runId, specId: opts.specId });
  const allowedRoots = [...contract.allowedRoots, ...(opts.extraAllowedRoots ?? [])];
  const prompt = [
    opts.promptBody.trim(),
    "",
    "## SkillContract",
    `skillId: ${contract.skillId}`,
    "allowedRoots:",
    ...allowedRoots.map((root) => `- ${root}`),
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
  const active = await readActive(opts.projectRoot);
  let promptBody = prompt;
  let skipDesignAppend = false;
  if (active?.packageId) {
    const composed = await composeDesignContext({ projectRoot: opts.projectRoot, skillBody: prompt });
    promptBody = composed.text;
    skipDesignAppend = true;
  }
  const promptPath = await writeRunPrompt({
    projectRoot: opts.projectRoot,
    runId,
    body: promptBody,
    skipDesignAppend,
  });
  const preSpawnRef = recordPreSpawnRef(opts.projectRoot);
  const snapshot = preSpawnRef ? undefined : await snapshotPaths(opts.projectRoot);
  const dirtyAtStart = snapshotDirtyPaths(opts.projectRoot, preSpawnRef);
  const gitPolicy = await snapshotGitPolicy(opts.projectRoot);
  const resumeDir = join(opts.projectRoot, ".legion-cli", "cache", "runs", runId);
  await mkdir(resumeDir, { recursive: true });

  const writeResume = async (pid: number | null) => {
    await writeFile(
      join(resumeDir, "resume.json"),
      `${JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION.resume,
          runId,
          taskId: opts.taskId ?? null,
          skillId: opts.skillId,
          preSpawnRef: preSpawnRef ?? "UNBORN",
          startedAt: new Date().toISOString(),
          pid,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  };
  await writeResume(null);

  const handle = await adapter.spawn({
    runId,
    skillId: opts.skillId,
    promptPath,
    pointerPrompt: buildPointerPrompt(runId, opts.skillId),
    cwd: opts.projectRoot,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    env: filterSpawnEnv(process.env, adapter.id, adapter.binary),
    expectedArtifacts: opts.fakeArtifacts,
  });
  await writeResume(handle.pid);
  let revert: RevertResult | null = null;
  let error: unknown;
  let timedOut = false;
  const started = Date.now();
  try {
    const agentResult = await handle.wait();
    timedOut = Boolean(agentResult.timedOut);
    if (timedOut) error = new AgentError("spawn timed out");
  } catch (err) {
    error = err;
  } finally {
    revert = await revertExtras({
      projectRoot: opts.projectRoot,
      preSpawnRef,
      allowedRoots,
      filesForbidden: opts.filesForbidden,
      snapshot,
      gitPolicy,
      dirtyAtStart,
    });
  }
  return { spawned: true, runId, revert, error, timedOut, durationMs: Date.now() - started };
}
