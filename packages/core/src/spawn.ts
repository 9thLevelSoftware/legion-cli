import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { glob, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  controlDirPath,
  controlProjectDirPath,
  ensureControlDir,
  isPidAlive,
  ownProcessStartedAt,
  tryGitHead,
  type LegionReader,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  assertExecuteSandbox,
  materializeJail,
  SandboxError,
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
import {
  admitsNewTasks,
  hasGitSegment,
  isAllowedPath,
  NEW_TASK_FILE_PATTERN,
  SKILL_CONTRACTS,
  skillContract,
} from "./contracts.js";
import { HINT, refuse } from "./errors.js";
import { createHttpToolHost } from "./http-host.js";
import {
  claimControlDir,
  endOwnedSpawn,
  liveMarkerFor,
  releaseControlDir,
  registerOwnedSpawn,
  rememberLiveMarker,
  RESUME_BASENAME,
  writeLiveMarker,
} from "./live-spawn.js";
import {
  restoreProtected,
  serializeProtectedSnapshot,
  snapshotProtected,
  type ProtectedRestoreResult,
  type ProtectedSnapshot,
} from "./protected.js";
import { Quarantine } from "./quarantine.js";
import {
  dropBackups,
  GIT_CLASSIFY_FAILED_MESSAGE,
  recordPreSpawnRef,
  reclaimOldBackups,
  revertTree,
  snapshotTree,
  type RevertResult,
  type TreeSnapshot,
} from "./revert.js";

export { findSkillsDir };

export async function resolveSkillDir(opts: {
  projectRoot: string;
  skillId: SkillId;
  packagedSkillsDir?: string;
}): Promise<ResolvedSkillDir> {
  return resolveOverlaySkillDir(opts);
}

/** SkillContract roots a jail may copy `.legion-cli` paths out to (R-3), plus new task files (R-2). */
function sandboxContractRoots(skillId: SkillId, allowedRoots: readonly string[]): string[] {
  const roots = allowedRoots.filter((root) => root.toLowerCase().startsWith(".legion-cli/"));
  if (admitsNewTasks(skillId)) roots.push(NEW_TASK_FILE_PATTERN);
  return roots;
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
  /** Engine writes that belong to this spawn, run just before the protected-set snapshot (KD-15). */
  beforeSnapshot?: (ctx: { sandbox?: SandboxHandle; runId: string; taskId?: string }) => Promise<void>;
  /** Engine audit sink for finish events (`protected_restored`, `quarantine_created`). */
  audit?: SpawnAudit;
  /** Called after a restore that changed protected files, so the engine can drop stale caches. */
  onRestored?: (result: ProtectedRestoreResult) => Promise<void>;
  /** Called with the agent's commit shas, after the P restore, so STATE can record them (R-20). */
  onQuarantinedCommits?: (shas: readonly string[]) => Promise<void>;
  /** Called after the control dir is torn down, so the engine can drop STATE.activeRun. */
  onFinished?: (ctx: { runId: string }) => Promise<void>;
};

export type SpawnAudit = (type: string, data: Record<string, unknown>) => Promise<void>;

type SpawnRevertCtx = {
  projectRoot: string;
  runId: string;
  skillId: SkillId;
  preSpawnRef: string | null;
  allowedRoots: string[];
  filesForbidden: readonly string[] | undefined;
  /** The stat-first pre-spawn tree snapshot and its backups (KD-16), held in memory. */
  treeSnapshot: TreeSnapshot;
  controlDir: string;
  jailed: boolean;
  /** P, held in memory: the finish path never trusts disk (KD-2). */
  protectedSnapshot: ProtectedSnapshot;
  audit?: SpawnAudit;
  onRestored?: (result: ProtectedRestoreResult) => Promise<void>;
  onQuarantinedCommits?: (shas: readonly string[]) => Promise<void>;
  onFinished?: (ctx: { runId: string }) => Promise<void>;
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
  "src",
  "packages",
  "lib",
  "app",
  "test",
  "tests",
  "skills",
  "scripts",
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

async function sandboxAllowedWrites(opts: {
  projectRoot: string;
  runId: string;
  skillId: SkillId;
  specId?: string;
  contract?: FileContract;
}): Promise<string[]> {
  const out: string[] = [];
  for (const root of SKILL_CONTRACTS[opts.skillId]) {
    const pattern = root
      .replaceAll("<id>", opts.runId)
      .replaceAll("<activeSpecId>", opts.specId ?? "active");
    const trimmed = pattern.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
    if (isConcretePosixRepoRelativePath(trimmed)) out.push(trimmed);
    else if (pattern.includes("*")) {
      out.push(pattern);
      try {
        for await (const hit of glob(pattern, { cwd: opts.projectRoot })) {
          const posix = String(hit).replaceAll("\\", "/");
          if (isConcretePosixRepoRelativePath(posix)) out.push(posix);
        }
      } catch {
        // glob optional; copy-out still matches the pattern
      }
    }
  }
  if (admitsNewTasks(opts.skillId) && !SKILL_CONTRACTS[opts.skillId].includes(".legion-cli/tasks/**")) {
    // New fix-task files may be copied out; the finish admits or quarantines them (R-2).
    out.push(NEW_TASK_FILE_PATTERN);
  }
  if (opts.contract) out.push(...opts.contract.filesAllowed, ...opts.contract.expectedArtifacts);
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

export const GIT_REPO_REQUIRED_MESSAGE =
  "Legion needs a git repository with at least one commit to protect your files during agent runs";

/** KD-3: every agent spawn needs a repo with a commit (non-git and unborn repos are refused). */
export function assertSpawnGitRepo(projectRoot: string): void {
  if (tryGitHead(projectRoot) === null) refuse(GIT_REPO_REQUIRED_MESSAGE, HINT.spawnGitRepo);
}

export async function startSkillSpawn(opts: SkillSpawnOpts): Promise<StartedSkillSpawn> {
  // Random suffix: two spawns of one skill in the same millisecond must not share a control dir,
  // a quarantine prefix or a finish token (R-23).
  // 64 bits of suffix (R-34): the run id names the agent's own cache root, so a guessable one
  // would let an agent pre-plant `cache/runs/<guess>/extra.json` for a later run to adopt.
  const runId = `${opts.skillId}-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
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

  // Checked once a spawn would really happen: an optional skill with no spawnable adapter
  // still skips quietly, but no agent ever runs outside a repo with a commit.
  assertSpawnGitRepo(opts.projectRoot);

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
  const argvSummary =
    resolution.id === "http"
      ? `POST /chat/completions model=${opts.config.adapter.http?.model ?? ""}`
      : argvSummarySafe(tmpl.argv);

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
  // Control records live outside the project (KD-2, R-15): the agent's own run cache holds
  // nothing the engine trusts.
  const controlDir = await ensureControlDir(opts.projectRoot, runId, { exclusive: true });
  claimControlDir(controlDir);
  /** A run that never reached its live marker leaves no record behind to freeze other processes. */
  const abandonControlDir = async () => {
    releaseControlDir(controlDir);
    await rm(controlDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  };
  const startedAt = new Date().toISOString();

  const writeResume = async (pid: number | null, agentPidStartedAt?: number) => {
    await writeFile(
      join(controlDir, RESUME_BASENAME),
      `${JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION.resume,
          runId,
          taskId: opts.taskId ?? null,
          skillId: opts.skillId,
          preSpawnRef: preSpawnRef ?? "UNBORN",
          startedAt,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          pid,
          ...(agentPidStartedAt !== undefined ? { agentPidStartedAt } : {}),
          enginePid: process.pid,
          engineStartedAt: ownProcessStartedAt(),
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
  let allowedWrites: string[] = [];
  const jailed =
    opts.skillId === "execute" ||
    opts.config.sandbox.skills.includes(opts.skillId) ||
    resolution.id === "http";
  if (jailed) {
    try {
      assertExecuteSandbox(opts.config, { allowNoSandbox: opts.allowNoSandbox });
    } catch (err) {
      await abandonControlDir();
      if (err instanceof SandboxError) refuse(err.message, HINT.allowNoSandbox);
      throw err;
    }
    const filtered = filterSpawnEnv(process.env, adapter.id, adapter.binary);
    allowedWrites = await sandboxAllowedWrites({
      projectRoot: opts.projectRoot,
      runId,
      skillId: opts.skillId,
      specId: opts.specId,
      contract: opts.fileContract,
    });
    sandbox = await materializeJail({
      projectRoot: opts.projectRoot,
      runId,
      allowedWrites,
      readSet: sandboxReadSet({
        projectRoot: opts.projectRoot,
        runId,
        specId: opts.specId,
        taskId: opts.taskId,
      }),
      adapterBinary: tmpl.binary.startsWith("(") ? undefined : tmpl.binary,
      backend: opts.config.sandbox.backend,
      allowDegradedCopy:
        Boolean(opts.allowNoSandbox) ||
        opts.config.sandbox.allowCopyJail ||
        !opts.config.sandbox.requireHardened,
      credentialKeys: Object.keys(filtered),
      contractRoots: sandboxContractRoots(opts.skillId, allowedRoots),
    });
  }

  // KD-15: every spawn-related engine write (e.g. execute's sandbox_start audit, which needs the
  // backend chosen above) happens before the protected-set snapshot.
  try {
    await opts.beforeSnapshot?.({ sandbox, runId, ...(opts.taskId ? { taskId: opts.taskId } : {}) });
  } catch (err) {
    await sandbox?.destroy().catch(() => undefined);
    await abandonControlDir();
    throw err;
  }

  // From here until the finish restores P, engine writes are frozen (KD-2) and this process's
  // audit events are buffered (KD-15). The snapshot is the last step before the spawn.
  registerOwnedSpawn({ projectRoot: opts.projectRoot, runId, skillId: opts.skillId, controlDir });
  let protectedSnapshot: ProtectedSnapshot;
  let treeSnapshot: TreeSnapshot;
  let handle: AgentHandle;
  let started: LiveStarted | undefined;
  try {
    const marker = liveMarkerFor(runId, opts.skillId, DEFAULT_TIMEOUT_MS);
    rememberLiveMarker(opts.projectRoot, marker);
    await writeLiveMarker(controlDir, marker);
    // KD-16: the stat-first tree snapshot and its backups, then P, are the last steps before
    // the spawn. Both live in the same control dir, outside the project.
    await reclaimOldBackups(controlProjectDirPath(opts.projectRoot)).catch(() => undefined);
    treeSnapshot = await snapshotTree({ projectRoot: opts.projectRoot, runId, preSpawnRef, controlDir });
    // R-17: if git cannot classify the tree, nothing was protected. Refuse rather than spawn into
    // a run that is certain to be blocked with a working tree we cannot put back.
    if (treeSnapshot.gitUnavailable) refuse(GIT_CLASSIFY_FAILED_MESSAGE, HINT.spawnGitRepo);
    protectedSnapshot = await snapshotProtected(opts.projectRoot);
    await writeFile(join(controlDir, "protected-snapshot.json"), serializeProtectedSnapshot(protectedSnapshot), {
      encoding: "utf8",
      mode: 0o600,
    });
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
      ...(sandbox && resolution.id === "http"
        ? {
            httpHost: createHttpToolHost({
              jailRoot: sandbox.jailRoot,
              allowedWrites,
              filesForbidden,
              hardened: sandbox.hardened,
              spawnOpts: spawnOpts ?? { cwd: sandbox.jailRoot, env },
            }),
          }
        : {}),
    });
    // Registered before any further await: from here the run can always be settled, so a later
    // throw can never strand a running agent behind a permanent freeze (R-8).
    started = {
      spawned: true,
      runId,
      handle,
      started: Date.now(),
      revertCtx: {
        projectRoot: opts.projectRoot,
        runId,
        skillId: opts.skillId,
        preSpawnRef,
        allowedRoots,
        filesForbidden,
        treeSnapshot,
        controlDir,
        jailed: Boolean(sandbox),
        protectedSnapshot,
        audit: opts.audit,
        onRestored: opts.onRestored,
        onQuarantinedCommits: opts.onQuarantinedCommits,
        onFinished: opts.onFinished,
      },
      resolution,
      binary: tmpl.binary,
      argvSummary,
      sandbox,
    };
    unfinished.set(runId, started);
    // The agent's PID *and* the moment it started (PR 6): crash replay only kills a recorded
    // tree whose start time still matches, so a PID reused since is never killed. `Date.now()`
    // at the spawn is on the same clock `processIdentity` reports, well inside its tolerance.
    await writeResume(handle.pid, Date.now());
  } catch (err) {
    if (started) {
      // The agent is already running: finish it (kill, restore P, unfreeze) instead of leaking it.
      await finishStartedSpawn(started).catch(() => undefined);
    } else {
      await endOwnedSpawn(opts.projectRoot, runId).catch(() => undefined);
      await abandonControlDir();
    }
    await sandbox?.destroy().catch(() => undefined);
    throw err;
  }
  return started;
}

/** Lines of the agent's stderr carried into the blocked task's reason (KD-6). */
export const AGENT_STDERR_TAIL_LINES = 20;

/** A spawn that ended with a non-zero (or unknown) exit code. Gates treat it as failure (KD-6). */
export class AgentExitError extends AgentError {
  readonly exitCode: number | null;
  constructor(message: string, exitCode: number | null) {
    super(message);
    this.name = "AgentExitError";
    this.exitCode = exitCode;
  }
}

async function stderrTail(path: string | undefined): Promise<string[]> {
  if (!path) return [];
  try {
    const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.slice(-AGENT_STDERR_TAIL_LINES);
  } catch {
    return [];
  }
}

export async function agentExitError(result: {
  exitCode: number | null;
  stderrPath?: string;
}): Promise<AgentExitError> {
  const tail = await stderrTail(result.stderrPath);
  const head = `agent exited ${result.exitCode === null ? "without an exit code" : result.exitCode}`;
  return new AgentExitError(tail.length > 0 ? `${head}: ${tail.join(" | ")}` : head, result.exitCode);
}

export async function waitStartedSpawn(started: Extract<StartedSkillSpawn, { spawned: true }>): Promise<WaitedSkillSpawn> {
  let error: unknown;
  let timedOut = false;
  try {
    const agentResult = await started.handle.wait();
    timedOut = Boolean(agentResult.timedOut);
    if (timedOut) error = new AgentError("spawn timed out");
    // KD-6: positive evidence only. A non-zero exit — or none at all, without a timeout — is a
    // failed run, whatever the agent left on disk.
    else if (agentResult.exitCode !== 0) error = await agentExitError(agentResult);
  } catch (err) {
    error = err;
  }
  return { error, timedOut, durationMs: Date.now() - started.started };
}

type LiveStarted = Extract<StartedSkillSpawn, { spawned: true }>;

/** Started spawns not finished yet, and each finish's single result (finish runs exactly once). */
const unfinished = new Map<string, LiveStarted>();
const finishes = new WeakMap<LiveStarted, Promise<RevertResult>>();

/**
 * Finish a spawn: copy-out, protected-set restore, revert, unfreeze. Idempotent: a second call
 * returns the first call's result.
 */
export function finishStartedSpawn(started: LiveStarted): Promise<RevertResult> {
  let pending = finishes.get(started);
  if (!pending) {
    pending = finishOnce(started).finally(() => unfinished.delete(started.runId));
    finishes.set(started, pending);
  }
  return pending;
}

/**
 * Make sure a started spawn is finished even when the verb's post-wait section refused or could
 * not take the lock: otherwise P would stay unrestored and the freeze would never lift.
 */
export async function settleStartedSpawn(runId: string): Promise<void> {
  const started = unfinished.get(runId);
  if (started) await finishStartedSpawn(started).catch(() => undefined);
}

/** Run ids this process has started and not finished yet (for the interrupt handler, PR 6). */
export function unfinishedSpawnIds(): string[] {
  return [...unfinished.keys()];
}

/**
 * Is this run one this process started and has not finished? Liveness of our own runs comes from
 * memory, never from disk (KD-2): a record whose `enginePid` is us but which is not in this map
 * belongs to a run that has already settled, so recovery may act on it without waiting for the
 * process to exit.
 */
export function isOwnedUnfinishedRun(runId: string): boolean {
  return unfinished.has(runId);
}

/**
 * Ctrl-C (PR 6): kill every agent this process started — the POSIX process group, or the Windows
 * process tree — and then run each spawn's normal finish, so P is restored, the tree is reverted
 * and the freeze lifts before the CLI exits. Never throws.
 */
export async function abortStartedSpawns(): Promise<string[]> {
  const live = [...unfinished.values()];
  for (const started of live) {
    await started.handle.abort().catch(() => undefined);
  }
  for (const started of live) {
    await finishStartedSpawn(started).catch(() => undefined);
  }
  return live.map((started) => started.runId);
}

async function finishOnce(started: LiveStarted): Promise<RevertResult> {
  const ctx = started.revertCtx;
  let copied: string[] = [];
  let dropped: string[] = [];
  let protectedResult: ProtectedRestoreResult | undefined;
  let copyOutError: string | undefined;
  let quarantine: Quarantine | undefined;
  let incidentForCleanup = true;
  try {
    // R-20: tear the agent's process tree down on every finish path, not just on timeout, so a
    // detached grandchild cannot write after the compare. PR 6 still owns interrupt handling.
    await started.handle.abort().catch(() => undefined);
    if (started.sandbox) {
      // R-1: a throwing copy-out must never skip the restore. Record it and carry on.
      try {
        const out = await started.sandbox.copyOut();
        copied = out.copied;
        dropped = out.dropped;
      } catch (err) {
        copyOutError = err instanceof Error ? err.message : String(err);
      }
    }
    // One quarantine folder per run: P and the tree revert share it, and it is finalized once.
    quarantine = new Quarantine(ctx.projectRoot, ctx.runId);
    // KD-1: P is compared and restored before any engine git call, from the in-memory snapshot.
    try {
      protectedResult = await restoreProtected(ctx.protectedSnapshot, {
        runId: ctx.runId,
        allowedRoots: ctx.allowedRoots,
        admitNewTasks: admitsNewTasks(ctx.skillId),
        quarantine,
      });
    } catch (err) {
      // Fail closed: an unexpected error is an incident, never a silent pass.
      protectedResult = {
        changed: [],
        unrestorable: [`protected set (${err instanceof Error ? err.message : String(err)})`],
        admittedTaskIds: [],
        rewrittenTaskIds: [],
        rejectedTaskFiles: [],
        incident: true,
        quarantine: null,
      };
    }
    if (copyOutError) {
      protectedResult.incident = true;
      protectedResult.unrestorable.push(`jail copy-out failed (${copyOutError})`);
    }
    // KD-16: the stat-first content revert over the rest of the tree, after the P restore.
    let tree: Awaited<ReturnType<typeof revertTree>>;
    try {
      tree = await revertTree({
        snapshot: ctx.treeSnapshot,
        runId: ctx.runId,
        allowedRoots: ctx.allowedRoots,
        filesForbidden: ctx.filesForbidden,
        quarantine,
        controlDir: ctx.controlDir,
      });
    } catch (err) {
      tree = {
        reverted: [],
        restoredIgnored: [],
        warnings: [],
        unrestorable: [`the tree revert failed (${err instanceof Error ? err.message : String(err)})`],
        incident: true,
        agentCommits: { headMoved: false, branchMoved: false, commits: [], lostRefs: [], pinned: false },
      };
    }
    const extrasReverted = new Set(tree.reverted);
    let otherIncident = tree.incident;
    if (started.sandbox) {
      for (const rel of dropped) {
        if (hasGitSegment(rel)) otherIncident = true;
        if (isAllowedPath(rel, ctx.allowedRoots)) continue;
        extrasReverted.add(rel);
      }
    }
    let quarantineDir: string | null = null;
    try {
      const finalized = await quarantine.finalize();
      if (finalized) {
        quarantineDir = finalized.dir;
        protectedResult.quarantine = { ...finalized, entries: quarantine.entries.length };
      }
    } catch (err) {
      otherIncident = true;
      tree.unrestorable.push(`quarantine manifest (${err instanceof Error ? err.message : String(err)})`);
    }
    const incident = otherIncident || protectedResult.incident;
    incidentForCleanup = incident;
    const warnings = [...tree.warnings];
    // R-10: a pre-existing ignored file the agent's own build touched is restored, but it is not
    // scope creep, so it is reported rather than pushed through the contract-fail gate.
    if (tree.restoredIgnored.length > 0) {
      warnings.push(`ignored files restored from backup: ${tree.restoredIgnored.join(", ")}`);
    }
    if (tree.agentCommits.lostRefs.length > 0) {
      warnings.push(`refs moved or deleted during the run: ${tree.agentCommits.lostRefs.join(", ")}`);
    }
    if (quarantineDir) warnings.push(`the previous versions are in quarantine at ${quarantineDir}`);
    if (ctx.onQuarantinedCommits && tree.agentCommits.commits.length > 0) {
      // R-48: recorded from the one path every spawn goes through, not per verb.
      await ctx.onQuarantinedCommits(tree.agentCommits.commits).catch(() => undefined);
    }
    return {
      runId: ctx.runId,
      extrasReverted: [...extrasReverted],
      incident,
      otherIncident,
      headMoved: tree.agentCommits.headMoved,
      branchMoved: tree.agentCommits.branchMoved,
      quarantinedCommits: tree.agentCommits.commits,
      commitsPinned: tree.agentCommits.pinned,
      ...(tree.agentCommits.recovery ? { commitRecovery: tree.agentCommits.recovery } : {}),
      preSpawnRef: ctx.preSpawnRef,
      ...(started.sandbox ? { outsideJail: tree.reverted } : {}),
      warnings,
      unrestorable: tree.unrestorable,
      quarantineDir,
      protected: protectedResult,
      sandboxCopied: copied,
      sandboxDropped: dropped,
    };
  } finally {
    await started.sandbox?.destroy().catch(() => undefined);
    // The restore writes bytes straight to disk, so anything the index covers is now stale (R-14).
    if (protectedResult && protectedResult.changed.length > 0 && ctx.onRestored) {
      await ctx.onRestored(protectedResult).catch(() => undefined);
    }
    // After the restore: unfreeze, then flush buffered and deferred audit events (KD-15, R-41).
    // R-8: a clean finish keeps nothing — `endOwnedSpawn` removes the whole control dir. An
    // incident run keeps it, because the quarantine manifest references its pre-spawn backups
    // and PR 6's replay needs them.
    await endOwnedSpawn(ctx.projectRoot, ctx.runId, { keepRecords: incidentForCleanup }).catch(() => undefined);
    await rm(join(controlDirPath(ctx.projectRoot, ctx.runId), "protected-snapshot.json"), { force: true }).catch(
      () => undefined,
    );
    if (!incidentForCleanup) await dropBackups(ctx.controlDir).catch(() => undefined);
    if (ctx.onFinished) await ctx.onFinished({ runId: ctx.runId }).catch(() => undefined);
    if (protectedResult && ctx.audit) {
      if (protectedResult.quarantine) {
        await ctx
          .audit("quarantine_created", {
            runId: ctx.runId,
            dir: protectedResult.quarantine.dir,
            manifestSha256: protectedResult.quarantine.manifestSha256,
            entries: protectedResult.quarantine.entries,
          })
          .catch(() => undefined);
      }
      if (protectedResult.changed.length > 0 || protectedResult.unrestorable.length > 0 || protectedResult.rejectedTaskFiles.length > 0) {
        await ctx
          .audit("protected_restored", {
            runId: ctx.runId,
            skillId: ctx.skillId,
            changed: protectedResult.changed,
            unrestorable: protectedResult.unrestorable,
            rejectedTaskFiles: protectedResult.rejectedTaskFiles,
            incident: protectedResult.incident,
            quarantine: protectedResult.quarantine?.dir ?? null,
          })
          .catch(() => undefined);
      }
    }
  }
}

/** One-line incident description for refusals and task notes. */
export function protectedIncidentMessage(
  revert: Pick<
    RevertResult,
    | "protected"
    | "incident"
    | "unrestorable"
    | "quarantinedCommits"
    | "commitRecovery"
    | "branchMoved"
    | "quarantineDir"
    | "runId"
    | "commitsPinned"
  >,
): string {
  const parts: string[] = [];
  const prot = revert.protected;
  if (prot && (prot.changed.length > 0 || prot.unrestorable.length > 0)) {
    parts.push(`the agent changed protected files (${prot.changed.join(", ") || "none"})`);
    if (prot.unrestorable.length > 0) parts.push(`NOT restored: ${prot.unrestorable.join("; ")}`);
    else parts.push("they were restored");
    // Any `.legion-cli/` change made while the run was live is treated the same way, including a
    // person's own editor save (R-13), and the task needs reopening afterwards (R-12).
    parts.push(
      "any change to .legion-cli/ made while the run was live — including your own edits — is quarantined and reverted",
    );
  }
  if (revert.unrestorable && revert.unrestorable.length > 0) {
    parts.push(`NOT restored: ${revert.unrestorable.join("; ")}`);
  }
  const commits = revert.quarantinedCommits ?? [];
  if (commits.length > 0 || revert.branchMoved) {
    // R-20/R-22: the working tree is already back; only the refs still hold work from the run.
    const ref = revert.runId ? `refs/legion-quarantine/${revert.runId}` : "refs/legion-quarantine/<runId>";
    parts.push(
      commits.length === 0
        ? "the checked-out branch changed during the run"
        : revert.commitsPinned === false
          ? // R-22: never claim reachability we failed to establish.
            `commits were made during the run (${commits.map((sha) => sha.slice(0, 8)).join(", ")}); they are listed in STATE.quarantinedCommits, but ${ref} could NOT be created, so they are only reachable until the next git gc`
          : `commits were made during the run (${commits.map((sha) => sha.slice(0, 8)).join(", ")}); they are listed in STATE.quarantinedCommits and kept at ${ref} (git log ${ref})`,
    );
    if (revert.commitRecovery) {
      parts.push(
        `the working tree is already reverted; \`${revert.commitRecovery}\` undoes the ref movement, and discards every commit made during the run — including any you made yourself`,
      );
    }
  }
  // R-15: the quarantine path is the whole point of this PR; print it whenever there is one.
  const dir = revert.quarantineDir ?? prot?.quarantine?.dir ?? null;
  if (dir) parts.push(`the displaced versions are in quarantine at ${dir}`);
  if (parts.length === 0) {
    return "the run could not be verified as clean; nothing was left unrestored, but treat its output as suspect";
  }
  // R-23: name commands that exist today.
  parts.push(
    dir
      ? "inspect the quarantine, then reopen the task (legion-cli task amend / legion-cli doctor lists retained quarantines)"
      : "see legion-cli doctor for retained quarantines, then reopen the task (legion-cli task amend)",
  );
  return parts.join("; ");
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

/** Resume records from the project's control dir (`<userStateDir>/control/<projectHash>/`, KD-2). */
export async function listControlResumes(projectRoot: string): Promise<ResumeFile[]> {
  const runsDir = controlProjectDirPath(projectRoot);
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
      const raw = await readFile(join(runsDir, name, RESUME_BASENAME), "utf8");
      const parsed = ResumeFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // missing or invalid resume
    }
  }
  return out;
}

export async function findLatestTaskResume(projectRoot: string, taskId: string): Promise<ResumeFile | null> {
  const matches = (await listControlResumes(projectRoot)).filter((resume) => resume.taskId === taskId);
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return matches[matches.length - 1] ?? null;
}
