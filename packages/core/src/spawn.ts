import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentError,
  buildPointerPrompt,
  DEFAULT_TIMEOUT_MS,
  filterSpawnEnv,
  isResolvedAdapterSpawnable,
  resolveAdapter,
  resolveAdapterId,
  stageSkill,
  templateArgv,
  writeRunPrompt,
  type AdapterResolution,
  type FakeArtifact,
} from "@9thlevelsoftware/legion-cli-agents";
import { composeDesignContext, readActive } from "@9thlevelsoftware/legion-cli-design-system";
import {
  SCHEMA_VERSION,
  type AdapterId,
  type LegionConfig,
  type SkillId,
} from "@9thlevelsoftware/legion-cli-schema";
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

export function spawnableAdapterRefuseMessage(skillId: SkillId, resolution: AdapterResolution): string {
  return `${skillId} needs a spawnable adapter (${resolution.id}, via ${resolution.source})`;
}

/** Persist flag names and {{pointer}} only — never raw argv values (credentials). */
export function argvSummarySafe(argv: readonly string[]): string {
  return argv
    .map((arg) => {
      if (arg.includes("{{pointer}}")) return arg;
      if (/^--[A-Za-z][\w-]*$/.test(arg) || /^-[A-Za-z]$/.test(arg)) return arg;
      const attached = /^(--[A-Za-z][\w-]*)=(.*)$/.exec(arg);
      if (attached) return `${attached[1]}=<redacted>`;
      return "<redacted>";
    })
    .join(" ")
    .slice(0, 240);
}

export type OptionalSpawnResult = {
  spawned: boolean;
  runId: string;
  revert: RevertResult | null;
  error?: unknown;
  timedOut?: boolean;
  durationMs?: number;
  resolution?: AdapterResolution;
  binary?: string;
  argvSummary?: string;
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
  cliAdapter?: AdapterId;
  taskAdapter?: AdapterId;
}): Promise<OptionalSpawnResult> {
  const runId = `${opts.skillId}-${Date.now().toString(36)}`;
  const resolution = resolveAdapterId({
    config: opts.config,
    skillId: opts.skillId,
    taskAdapter: opts.taskAdapter,
    cliAdapter: opts.cliAdapter,
  });

  if (!(await isResolvedAdapterSpawnable(opts.config, resolution.id))) {
    if (opts.required) {
      refuse(spawnableAdapterRefuseMessage(opts.skillId, resolution), HINT.doctor);
    }
    return { spawned: false, runId, revert: null, resolution };
  }

  const skillsDir = opts.skillsDir ?? findSkillsDir();
  const skillDir = skillsDir ? join(skillsDir, opts.skillId) : undefined;
  if (!skillDir || !existsSync(join(skillDir, "SKILL.md"))) {
    if (opts.required) {
      refuse(`${opts.skillId} requires skills/${opts.skillId}/SKILL.md`, skillMissingHint(opts.skillId));
    }
    return { spawned: false, runId, revert: null, resolution };
  }

  const adapter = resolveAdapter(opts.config, {
    id: resolution.id,
    artifacts: opts.fakeArtifacts ?? [],
    throwAfterWrite: opts.throwAfterWrite,
    timedOut: opts.timedOut,
  });
  const tmpl = templateArgv(resolution.id, opts.config);
  const argvSummary = argvSummarySafe(tmpl.argv);

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
          adapterId: resolution.id,
          binary: tmpl.binary,
          argvSummary,
          resolutionSource: resolution.source,
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
  return {
    spawned: true,
    runId,
    revert,
    error,
    timedOut,
    durationMs: Date.now() - started,
    resolution,
    binary: tmpl.binary,
    argvSummary,
  };
}
