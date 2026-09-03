import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentError,
  buildPointerPrompt,
  DEFAULT_TIMEOUT_MS,
  filterSpawnEnv,
  findSkillsDir,
  isRequiredSkillId,
  isResolvedAdapterSpawnable,
  listLevel3Resources,
  listSkillCatalog,
  parseSkillFrontmatter,
  resolveAdapter,
  resolveAdapterId,
  stageSkill,
  templateArgv,
  writeRunPrompt,
  type AdapterResolution,
  type FakeArtifact,
} from "@9thlevelsoftware/legion-cli-agents";
import { composeDesignContext, readActive } from "@9thlevelsoftware/legion-cli-design-system";
import type { LegionReader } from "@9thlevelsoftware/legion-cli-persist";
import {
  SCHEMA_VERSION,
  type AdapterId,
  type FileContract,
  type LegionConfig,
  type SkillId,
} from "@9thlevelsoftware/legion-cli-schema";
import { buildSessionBrief, renderSessionBrief } from "@9thlevelsoftware/legion-cli-wiki";
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

export { findSkillsDir };

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
      if (arg.includes("{{pointer}}")) return "{{pointer}}";
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

function formatLevel3(level3: { scripts: string[]; references: string[]; assets: string[] }): string[] {
  const files = [...level3.scripts, ...level3.references, ...level3.assets];
  if (files.length === 0) return ["- (none)"];
  return files.map((path) => `- ${path}`);
}

function renderFileContractSection(contract: FileContract): string[] {
  return [
    "## FileContract",
    "filesAllowed:",
    ...contract.filesAllowed.map((path) => `- ${path}`),
    "expectedArtifacts:",
    ...contract.expectedArtifacts.map((path) => `- ${path}`),
    "verificationCommands:",
    ...contract.verificationCommands.map((cmd) => `- ${cmd}`),
    "filesForbidden:",
    ...contract.filesForbidden.map((path) => `- ${path}`),
    `maxFilesTouched: ${contract.maxFilesTouched}`,
  ];
}

async function assembleSpawnPrompt(opts: {
  projectRoot: string;
  runId: string;
  skillId: SkillId;
  skillDir: string;
  skillsDir: string;
  promptBody: string;
  allowedRoots: readonly string[];
  fileContract?: FileContract;
  store?: LegionReader;
}): Promise<{ body: string; skipDesignAppend: boolean }> {
  const catalogResult = listSkillCatalog(opts.skillsDir);
  const skills = catalogResult.catalog.skills.map((skill) => ({
    skillId: skill.skillId,
    name: skill.name,
    description: skill.description,
    active: skill.skillId === opts.skillId,
  }));
  const brief = opts.store ? await buildSessionBrief(opts.store, { skills }) : null;

  const level3 = listLevel3Resources(opts.skillDir);

  const active = await readActive(opts.projectRoot);
  let designBlock = "";
  let skipDesignAppend = false;
  if (active?.packageId) {
    const composed = await composeDesignContext({
      projectRoot: opts.projectRoot,
      skillBody: opts.promptBody,
    });
    designBlock = composed.text;
    skipDesignAppend = true;
  } else {
    designBlock = opts.promptBody;
    skipDesignAppend = false;
  }

  const body = [
    "## SessionBrief",
    brief ? renderSessionBrief(brief).trimEnd() : "(no store; test-only spawn)",
    "",
    "## Active skill",
    `skillId: ${opts.skillId}`,
    `Level 2 body is at .legion-cli/cache/skills/${opts.runId}/SKILL.md`,
    "Level 3 files (read only if the skill body names them):",
    ...formatLevel3(level3),
    "",
    "## SkillContract",
    `skillId: ${opts.skillId}`,
    "allowedRoots:",
    ...opts.allowedRoots.map((root) => `- ${root}`),
    "",
    "Do not write files outside allowedRoots. Do not git add or git commit.",
    "",
    ...(opts.fileContract ? renderFileContractSection(opts.fileContract) : []),
    "",
    designBlock.trimEnd(),
  ].join("\n");

  return { body, skipDesignAppend };
}

export async function optionalSkillSpawn(opts: {
  projectRoot: string;
  config: LegionConfig;
  skillId: SkillId;
  specId?: string;
  taskId?: string;
  promptBody: string;
  fileContract?: FileContract;
  extraAllowedRoots?: readonly string[];
  filesForbidden?: readonly string[];
  skillsDir?: string;
  fakeArtifacts?: FakeArtifact[];
  throwAfterWrite?: boolean;
  timedOut?: boolean;
  required?: boolean;
  cliAdapter?: AdapterId;
  taskAdapter?: AdapterId;
  store?: LegionReader;
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
  const skillMd = skillDir ? join(skillDir, "SKILL.md") : undefined;
  const required = Boolean(opts.required) || isRequiredSkillId(opts.skillId);
  if (!skillsDir || !skillDir || !skillMd || !existsSync(skillMd)) {
    if (required) {
      refuse(`${opts.skillId} requires skills/${opts.skillId}/SKILL.md`, skillMissingHint(opts.skillId));
    }
    return { spawned: false, runId, revert: null, resolution };
  }
  let skillRaw: string;
  try {
    skillRaw = await readFile(skillMd, "utf8");
  } catch {
    if (required) {
      refuse(`${opts.skillId} requires skills/${opts.skillId}/SKILL.md`, skillMissingHint(opts.skillId));
    }
    return { spawned: false, runId, revert: null, resolution };
  }
  const parsed = parseSkillFrontmatter(skillRaw, `skills/${opts.skillId}/SKILL.md`);
  if (!parsed.ok) {
    if (required) {
      refuse(
        `${opts.skillId} requires valid skills/${opts.skillId}/SKILL.md frontmatter (${parsed.reason})`,
        skillMissingHint(opts.skillId),
      );
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
  const extraAllowedRoots =
    opts.extraAllowedRoots ??
    (opts.fileContract ? [...opts.fileContract.filesAllowed, ...opts.fileContract.expectedArtifacts] : []);
  const filesForbidden = opts.filesForbidden ?? opts.fileContract?.filesForbidden;
  const allowedRoots = [...contract.allowedRoots, ...extraAllowedRoots];

  await stageSkill({
    projectRoot: opts.projectRoot,
    runId,
    skillDir,
    craftDir: existsSync(join(opts.projectRoot, ".legion-cli", "design", "craft"))
      ? join(opts.projectRoot, ".legion-cli", "design", "craft")
      : undefined,
  });
  const assembled = await assembleSpawnPrompt({
    projectRoot: opts.projectRoot,
    runId,
    skillId: opts.skillId,
    skillDir,
    skillsDir,
    promptBody: opts.promptBody,
    allowedRoots,
    fileContract: opts.fileContract,
    store: opts.store,
  });
  const promptPath = await writeRunPrompt({
    projectRoot: opts.projectRoot,
    runId,
    body: assembled.body,
    skipDesignAppend: assembled.skipDesignAppend,
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
      filesForbidden,
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
