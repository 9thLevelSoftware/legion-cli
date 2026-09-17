import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
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
  listResolvedSkillCatalog,
  parseSkillFrontmatter,
  resolveAdapter,
  resolveAdapterId,
  resolveSkillDir as resolveOverlaySkillDir,
  skillCatalogPath,
  stageSkill,
  templateArgv,
  writeRunPrompt,
  type AdapterResolution,
  type AgentHandle,
  type FakeArtifact,
  type FakeHoldWait,
  type ResolvedSkillDir,
} from "@9thlevelsoftware/legion-cli-agents";
import { composeDesignContext, readActive } from "@9thlevelsoftware/legion-cli-design-system";
import { isPidAlive, type LegionReader } from "@9thlevelsoftware/legion-cli-persist";
import {
  materializeJail,
  type SandboxHandle,
} from "@9thlevelsoftware/legion-cli-sandbox";
import {
  isConcretePosixRepoRelativePath,
  ResumeFileSchema,
  SCHEMA_VERSION,
  type AdapterId,
  type FileContract,
  type LegionConfig,
  type ResumeFile,
  type SkillId,
} from "@9thlevelsoftware/legion-cli-schema";
import { buildSessionBrief, renderSessionBrief } from "@9thlevelsoftware/legion-cli-wiki";
import { isAllowedPath, SKILL_CONTRACTS, skillContract } from "./contracts.js";
import { HINT, refuse } from "./errors.js";
import {
  recordPreSpawnRef,
  revertExtras,
  snapshotDirtyPaths,
  snapshotGitPolicy,
  snapshotChatSessions,
  snapshotPaths,
  type RevertResult,
} from "./revert.js";

export { findSkillsDir };

export async function resolveSkillDir(opts: {
  projectRoot: string;
  skillId: SkillId;
  packagedSkillsDir?: string;
}): Promise<ResolvedSkillDir> {
  return resolveOverlaySkillDir(opts);
}

type LiveSpawnMarker = { enginePid: number; skillId: SkillId; runId: string };

function liveSpawnPath(projectRoot: string): string {
  return join(projectRoot, ".legion-cli", "cache", "live-spawn.json");
}

export async function writeLiveSpawnMarker(
  projectRoot: string,
  skillId: SkillId,
  runId: string,
): Promise<void> {
  await mkdir(join(projectRoot, ".legion-cli", "cache"), { recursive: true });
  await writeFile(
    liveSpawnPath(projectRoot),
    `${JSON.stringify({ enginePid: process.pid, skillId, runId })}\n`,
    "utf8",
  );
}

export async function clearLiveSpawnMarker(projectRoot: string, runId?: string): Promise<void> {
  try {
    if (runId) {
      const raw = await readFile(liveSpawnPath(projectRoot), "utf8");
      const parsed = JSON.parse(raw) as LiveSpawnMarker;
      if (parsed.runId !== runId) return;
    }
    await unlink(liveSpawnPath(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function readLiveSpawnMarker(projectRoot: string): Promise<LiveSpawnMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(liveSpawnPath(projectRoot), "utf8")) as LiveSpawnMarker;
    if (typeof parsed?.enginePid !== "number" || typeof parsed.skillId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function refuseIfLiveSkillSpawn(projectRoot: string, action: string): Promise<void> {
  const live = await readLiveSpawnMarker(projectRoot);
  if (!live) return;
  if (!isPidAlive(live.enginePid)) {
    await clearLiveSpawnMarker(projectRoot);
    return;
  }
  refuse(`${action} is refused while ${live.skillId} is running`, HINT.status);
}

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

export type SkillSpawnOpts = {
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
  holdWait?: FakeHoldWait;
  onWait?: () => Promise<void>;
  handlePid?: number;
  allowNoSandbox?: boolean;
};

type SpawnRevertCtx = {
  projectRoot: string;
  preSpawnRef: string | null;
  allowedRoots: string[];
  filesForbidden: readonly string[] | undefined;
  snapshot: Awaited<ReturnType<typeof snapshotPaths>> | undefined;
  gitPolicy: Awaited<ReturnType<typeof snapshotGitPolicy>>;
  dirtyAtStart: ReturnType<typeof snapshotDirtyPaths>;
  chatSessions: Awaited<ReturnType<typeof snapshotChatSessions>>;
};

export type StartedSkillSpawn =
  | {
      spawned: false;
      runId: string;
      resolution?: AdapterResolution;
    }
  | {
      spawned: true;
      runId: string;
      handle: AgentHandle;
      started: number;
      revertCtx: SpawnRevertCtx;
      resolution: AdapterResolution;
      binary: string;
      argvSummary: string;
      sandbox?: SandboxHandle;
    };

export type WaitedSkillSpawn = {
  error?: unknown;
  timedOut: boolean;
  durationMs: number;
};

const CONFIG_READ_SET = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "tsconfig.json",
  "jsconfig.json",
] as const;

function sandboxReadSet(opts: {
  projectRoot: string;
  runId: string;
  specId?: string;
  taskId?: string;
}): string[] {
  const out = [`.legion-cli/cache/skills/${opts.runId}`, `.legion-cli/cache/runs/${opts.runId}`];
  if (opts.specId) out.push(`.legion-cli/specs/${opts.specId}`);
  if (opts.taskId) out.push(`.legion-cli/tasks/${opts.taskId}.md`);
  for (const name of CONFIG_READ_SET) {
    if (existsSync(join(opts.projectRoot, name))) out.push(name);
  }
  return out;
}

function sandboxAllowedWrites(
  runId: string,
  skillId: SkillId,
  specId?: string,
  contract?: FileContract,
): string[] {
  const out: string[] = [];
  for (const root of SKILL_CONTRACTS[skillId]) {
    const concrete = root
      .replaceAll("<id>", runId)
      .replaceAll("<activeSpecId>", specId ?? "active")
      .replace(/\/\*\*$/, "")
      .replace(/\/\*$/, "");
    if (isConcretePosixRepoRelativePath(concrete)) out.push(concrete);
  }
  if (contract) out.push(...contract.filesAllowed, ...contract.expectedArtifacts);
  return out;
}

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
  skillsDir?: string;
  promptBody: string;
  allowedRoots: readonly string[];
  fileContract?: FileContract;
  store?: LegionReader;
}): Promise<{ body: string; skipDesignAppend: boolean }> {
  const catalogResult = await listResolvedSkillCatalog({
    projectRoot: opts.projectRoot,
    packagedSkillsDir: opts.skillsDir,
  });
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

export async function startSkillSpawn(opts: SkillSpawnOpts): Promise<StartedSkillSpawn> {
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
    return { spawned: false, runId, resolution };
  }

  const skillsDir = opts.skillsDir ?? findSkillsDir();
  const required = Boolean(opts.required) || isRequiredSkillId(opts.skillId);
  const resolved = await resolveSkillDir({
    projectRoot: opts.projectRoot,
    skillId: opts.skillId,
    packagedSkillsDir: skillsDir,
  });
  if (!resolved.ok) {
    if (required || resolved.pinned) {
      refuse(resolved.reason, skillMissingHint(opts.skillId));
    }
    return { spawned: false, runId, resolution };
  }
  const skillDir = resolved.skillDir;
  const skillMd = join(skillDir, "SKILL.md");
  let skillRaw: string;
  try {
    skillRaw = await readFile(skillMd, "utf8");
  } catch {
    if (required || resolved.source === "overlay") {
      refuse(
        resolved.source === "overlay"
          ? `${opts.skillId} overlay is missing SKILL.md`
          : `${opts.skillId} requires skills/${opts.skillId}/SKILL.md`,
        skillMissingHint(opts.skillId),
      );
    }
    return { spawned: false, runId, resolution };
  }
  const parsed = parseSkillFrontmatter(skillRaw, skillCatalogPath(opts.skillId, resolved.source));
  if (!parsed.ok) {
    if (required || resolved.source === "overlay") {
      refuse(
        `${opts.skillId} requires valid ${skillCatalogPath(opts.skillId, resolved.source)} frontmatter (${parsed.reason})`,
        skillMissingHint(opts.skillId),
      );
    }
    return { spawned: false, runId, resolution };
  }

  const adapter = resolveAdapter(opts.config, {
    id: resolution.id,
    artifacts: opts.fakeArtifacts ?? [],
    throwAfterWrite: opts.throwAfterWrite,
    timedOut: opts.timedOut,
    holdWait: opts.holdWait,
    onWait: opts.onWait,
    handlePid: opts.handlePid,
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
  // Always snapshot the worktree, even when preSpawnRef is set. Gitignored
  // extras are invisible to `git status --exclude-standard`; KD-11 forbids
  // unioning raw `git status --ignored` (that would revert pre-existing ignored files).
  const snapshot = await snapshotPaths(opts.projectRoot);
  const dirtyAtStart = snapshotDirtyPaths(opts.projectRoot, preSpawnRef);
  const gitPolicy = await snapshotGitPolicy(opts.projectRoot);
  const chatSessions = await snapshotChatSessions(opts.projectRoot);
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
          enginePid: process.pid,
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

  let sandbox: SandboxHandle | undefined;
  const jailed = opts.skillId === "execute" || opts.config.sandbox.skills.includes(opts.skillId);
  if (jailed) {
    const filtered = filterSpawnEnv(process.env, adapter.id, adapter.binary);
    sandbox = await materializeJail({
      projectRoot: opts.projectRoot,
      runId,
      allowedWrites: sandboxAllowedWrites(runId, opts.skillId, opts.specId, opts.fileContract),
      readSet: sandboxReadSet({
        projectRoot: opts.projectRoot,
        runId,
        specId: opts.specId,
        taskId: opts.taskId,
      }),
      adapterBinary: tmpl.binary.startsWith("(") ? undefined : tmpl.binary,
      backend: opts.config.sandbox.backend,
      allowDegradedCopy:
        opts.skillId !== "execute" ||
        Boolean(opts.allowNoSandbox) ||
        opts.config.sandbox.allowCopyJail ||
        !opts.config.sandbox.requireHardened,
      credentialKeys: Object.keys(filtered),
    });
  }

  let handle: AgentHandle;
  try {
    const spawnOpts = sandbox?.spawnOpts();
    const env: Record<string, string> = spawnOpts
      ? Object.fromEntries(Object.entries(spawnOpts.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
      : filterSpawnEnv(process.env, adapter.id, adapter.binary);
    handle = await adapter.spawn({
      runId,
      skillId: opts.skillId,
      promptPath,
      pointerPrompt: buildPointerPrompt(runId, opts.skillId),
      cwd: spawnOpts?.cwd ?? opts.projectRoot,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      env,
      expectedArtifacts: opts.fakeArtifacts,
      ...(spawnOpts?.wrapper ? { wrapper: spawnOpts.wrapper } : {}),
    });
  } catch (err) {
    await sandbox?.destroy().catch(() => undefined);
    throw err;
  }
  await writeResume(handle.pid);
  await writeLiveSpawnMarker(opts.projectRoot, opts.skillId, runId);
  return {
    spawned: true,
    runId,
    handle,
    started: Date.now(),
    revertCtx: {
      projectRoot: opts.projectRoot,
      preSpawnRef,
      allowedRoots,
      filesForbidden,
      snapshot,
      gitPolicy,
      dirtyAtStart,
      chatSessions,
    },
    resolution,
    binary: tmpl.binary,
    argvSummary,
    sandbox,
  };
}

export async function waitStartedSpawn(started: Extract<StartedSkillSpawn, { spawned: true }>): Promise<WaitedSkillSpawn> {
  let error: unknown;
  let timedOut = false;
  try {
    const agentResult = await started.handle.wait();
    timedOut = Boolean(agentResult.timedOut);
    if (timedOut) error = new AgentError("spawn timed out");
  } catch (err) {
    error = err;
  }
  return { error, timedOut, durationMs: Date.now() - started.started };
}

export async function finishStartedSpawn(
  started: Extract<StartedSkillSpawn, { spawned: true }>,
): Promise<RevertResult> {
  let copied: string[] = [];
  let dropped: string[] = [];
  const resumePath = join(
    started.revertCtx.projectRoot,
    ".legion-cli",
    "cache",
    "runs",
    started.runId,
    "resume.json",
  );
  let resumeRaw: string | undefined;
  try {
    if (started.sandbox) {
      try {
        resumeRaw = await readFile(resumePath, "utf8");
      } catch {
        resumeRaw = undefined;
      }
      const out = await started.sandbox.copyOut();
      copied = out.copied;
      dropped = out.dropped;
    }
    const revert = await revertExtras(started.revertCtx);
    const extrasReverted = new Set(revert.extrasReverted);
    let incident = revert.incident;
    if (started.sandbox) {
      for (const rel of dropped) {
        if (rel === ".git" || rel.startsWith(".git/")) incident = true;
        if (isAllowedPath(rel, started.revertCtx.allowedRoots)) continue;
        extrasReverted.add(rel);
      }
    }
    return {
      ...revert,
      extrasReverted: [...extrasReverted],
      incident,
      sandboxCopied: copied,
      sandboxDropped: dropped,
    };
  } finally {
    if (resumeRaw !== undefined) {
      await writeFile(resumePath, resumeRaw, "utf8").catch(() => undefined);
    }
    await started.sandbox?.destroy().catch(() => undefined);
    await clearLiveSpawnMarker(started.revertCtx.projectRoot, started.runId);
  }
}

export async function optionalSkillSpawn(opts: SkillSpawnOpts): Promise<OptionalSpawnResult> {
  const started = await startSkillSpawn(opts);
  if (!started.spawned) {
    return { spawned: false, runId: started.runId, revert: null, resolution: started.resolution };
  }
  const waited = await waitStartedSpawn(started);
  const revert = await finishStartedSpawn(started);
  return {
    spawned: true,
    runId: started.runId,
    revert,
    error: waited.error,
    timedOut: waited.timedOut,
    durationMs: waited.durationMs,
    resolution: started.resolution,
    binary: started.binary,
    argvSummary: started.argvSummary,
  };
}

export function resumePidIsLive(resume: Pick<ResumeFile, "pid">): boolean {
  if (typeof resume.pid !== "number" || !Number.isInteger(resume.pid) || resume.pid <= 0) return false;
  return isPidAlive(resume.pid);
}

/** Orchestrator process still running this run (healthy wait or post-wait). */
export function resumeEngineIsLive(resume: Pick<ResumeFile, "enginePid" | "startedAt">): boolean {
  const enginePid = resume.enginePid;
  if (typeof enginePid !== "number" || !Number.isInteger(enginePid) || enginePid <= 0) return false;
  if (!isPidAlive(enginePid)) return false;
  if (enginePid !== process.pid) return true;
  const started = Date.parse(resume.startedAt);
  if (!Number.isFinite(started)) return true;
  const processStartMs = Date.now() - process.uptime() * 1000;
  return started + 1000 >= processStartMs;
}

/** Child still running, or this engine has not crashed after wait(). */
export function resumeRunIsLive(resume: Pick<ResumeFile, "pid" | "enginePid" | "startedAt">): boolean {
  return resumePidIsLive(resume) || resumeEngineIsLive(resume);
}

export async function listCacheResumes(projectRoot: string): Promise<ResumeFile[]> {
  const runsDir = join(projectRoot, ".legion-cli", "cache", "runs");
  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: ResumeFile[] = [];
  for (const name of names) {
    try {
      const raw = await readFile(join(runsDir, name, "resume.json"), "utf8");
      const parsed = ResumeFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // missing or invalid resume
    }
  }
  return out;
}

export async function findLatestTaskResume(projectRoot: string, taskId: string): Promise<ResumeFile | null> {
  const matches = (await listCacheResumes(projectRoot)).filter((resume) => resume.taskId === taskId);
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return matches[matches.length - 1] ?? null;
}
