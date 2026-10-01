import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { glob, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentError,
  applyProfileArgs,
  applyUsagePricing,
  assertProfileRuntimeSupport,
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
  usageLimitReason,
  exportUsageTelemetry,
  writeRunPrompt,
  type AdapterResolution,
  type AgentHandle,
  type AgentUsage,
  type FakeArtifact,
  type FakeHoldWait,
  type ResolvedSkillDir,
} from "@9thlevelsoftware/legion-cli-agents";
import { composeDesignContext, readActive } from "@9thlevelsoftware/legion-cli-design-system";
import {
  AuditTamperError,
  appendAuditEvent,
  createLegionStore,
  isPidAlive,
  openEngineCommand,
  ownProcessStartedAt,
  processIdentity,
  RestoreRefusedError,
  sameProcessStart,
  writeTextFile,
  type LegionReader,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  assertExecuteSandbox,
  materializeJail,
  reopenJail,
  SandboxError,
  type SandboxHandle,
} from "@9thlevelsoftware/legion-cli-sandbox";
import {
  isConcretePosixRepoRelativePath,
  ResumeFileSchema,
  SCHEMA_VERSION,
  type CurrentResumeFile,
  type AdapterId,
  type FileContract,
  type LegionConfig,
  type ResumeFile,
  type ResumeStage,
  type SkillId,
} from "@9thlevelsoftware/legion-cli-schema";
import {
  LegionMcpClientPool,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_POOL_MAX,
  MCP_REMOTE_MAX_RESPONSE_BYTES,
  MCP_TOOL_TIMEOUT_MS,
  stableHash,
} from "@9thlevelsoftware/legion-cli-http";
import { buildSessionBrief, renderSessionBrief } from "@9thlevelsoftware/legion-cli-wiki";
import { isAllowedPath, SKILL_CONTRACTS, skillContract } from "./contracts.js";
import { HINT, refuse } from "./errors.js";
import { createHttpToolHost, httpAllowedWrites } from "./http-host.js";
import { projectSourceIdentity } from "./qa-evidence.js";
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

/** Copy-jail hatch is win32+http only. Linux http keeps the closed spawn-CLI default. */
export function defaultAllowCopyJail(
  adapter: AdapterId,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return adapter === "http" && platform === "win32";
}

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

function liveSpawnsDir(projectRoot: string): string {
  return join(projectRoot, ".legion-cli", "cache", "live-spawns");
}

function liveSpawnRunPath(projectRoot: string, runId: string): string {
  return join(liveSpawnsDir(projectRoot), `${runId}.json`);
}

export async function writeLiveSpawnMarker(
  projectRoot: string,
  skillId: SkillId,
  runId: string,
): Promise<void> {
  await mkdir(join(projectRoot, ".legion-cli", "cache"), { recursive: true });
  await mkdir(liveSpawnsDir(projectRoot), { recursive: true });
  const body = `${JSON.stringify({ enginePid: process.pid, skillId, runId })}\n`;
  await writeFile(liveSpawnRunPath(projectRoot, runId), body, "utf8");
  const primary = await readLiveSpawnMarker(projectRoot);
  if (!primary || !isPidAlive(primary.enginePid)) {
    await writeFile(liveSpawnPath(projectRoot), body, "utf8");
  }
}

export async function clearLiveSpawnMarker(projectRoot: string, runId?: string): Promise<void> {
  if (runId) {
    await unlink(liveSpawnRunPath(projectRoot, runId)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
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
  if (runId) {
    const remaining = await readLiveSpawnMarkers(projectRoot, false);
    const next = remaining[0];
    if (next) {
      await writeFile(liveSpawnPath(projectRoot), `${JSON.stringify(next)}\n`, "utf8");
    }
  } else {
    let names: string[] = [];
    try {
      names = await readdir(liveSpawnsDir(projectRoot));
    } catch {
      names = [];
    }
    await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => unlink(join(liveSpawnsDir(projectRoot), name)).catch(() => undefined)),
    );
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

async function readLiveSpawnMarkers(projectRoot: string, includePrimary = true): Promise<LiveSpawnMarker[]> {
  const found = new Map<string, LiveSpawnMarker>();
  if (includePrimary) {
    const primary = await readLiveSpawnMarker(projectRoot);
    if (primary) found.set(primary.runId, primary);
  }
  let names: string[] = [];
  try {
    names = await readdir(liveSpawnsDir(projectRoot));
  } catch {
    names = [];
  }
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const marker = JSON.parse(await readFile(join(liveSpawnsDir(projectRoot), name), "utf8")) as LiveSpawnMarker;
      if (typeof marker.enginePid === "number" && typeof marker.skillId === "string" && typeof marker.runId === "string") {
        found.set(marker.runId, marker);
      }
    } catch {
      // Ignore malformed marker; resume recovery remains authoritative.
    }
  }
  return [...found.values()];
}

export async function refuseIfLiveSkillSpawn(projectRoot: string, action: string): Promise<void> {
  for (const live of await readLiveSpawnMarkers(projectRoot)) {
    if (!isPidAlive(live.enginePid)) {
      await clearLiveSpawnMarker(projectRoot, live.runId);
      continue;
    }
    refuse(`${action} is refused while ${live.skillId} is running`, HINT.status);
  }
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
  cliProfile?: string;
  taskProfile?: string;
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
  commandId: string;
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
      skillId: SkillId;
      telemetryEndpoint?: string;
      completionMetadata?: { outcome: "complete" | "failed"; usage?: AgentUsage; limitReason?: string };
      started: number;
      revertCtx: SpawnRevertCtx;
      resolution: AdapterResolution;
      binary: string;
      argvSummary: string;
      sandbox?: SandboxHandle;
      resourceCleanup?: () => Promise<void>;
    };

export type WaitedSkillSpawn = {
  error?: unknown;
  timedOut: boolean;
  durationMs: number;
  usage?: AgentUsage;
  limitReason?: string;
  recovery?: "resume" | "manual" | "none";
};

export function governedMcpConfigIdentity(config: LegionConfig): string | null {
  const allowlist = config.mcpHttpToolAllowlist;
  if (!config.mcpServers || allowlist.length === 0) return null;
  const selectedServers = new Set(allowlist.map((name) => name.slice(0, name.indexOf(":"))));
  const normalizedServers = Object.entries(config.mcpServers)
    .filter(([name]) => selectedServers.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, server]) => server.transport === "stdio"
      ? {
          name,
          transport: "stdio" as const,
          command: server.command,
          args: server.args,
          envNames: Object.keys(server.env ?? {}).sort(),
        }
      : {
          name,
          transport: server.transport,
          url: server.url,
          authTokenEnv: server.authTokenEnv,
          allowLoopback: server.allowLoopback,
        });
  return stableHash({
    version: "governed-mcp-v1",
    allowlist: [...allowlist].sort(),
    servers: normalizedServers,
    limits: {
      pool: MCP_POOL_MAX,
      connectTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
      toolTimeoutMs: MCP_TOOL_TIMEOUT_MS,
      responseBytes: MCP_REMOTE_MAX_RESPONSE_BYTES,
    },
  });
}

export function governedMcpToolContractIdentity(
  tools: ReadonlyArray<{ name: string; inputSchema: Record<string, unknown>; readOnly: boolean }>,
): string {
  return stableHash([...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema, readOnly: tool.readOnly })));
}

async function governedMcpBridge(config: LegionConfig): Promise<{
  externalTools: NonNullable<import("@9thlevelsoftware/legion-cli-http").HttpToolHost["externalTools"]>;
  callExternalTool: NonNullable<import("@9thlevelsoftware/legion-cli-http").HttpToolHost["callExternalTool"]>;
  close: () => Promise<void>;
  configIdentity: string;
  toolContractIdentity: string;
} | undefined> {
  const allowlist = config.mcpHttpToolAllowlist;
  if (!config.mcpServers || allowlist.length === 0) return undefined;
  const allowed = new Set(allowlist);
  const configIdentity = governedMcpConfigIdentity(config);
  if (!configIdentity) return undefined;
  const pool = new LegionMcpClientPool(config.mcpServers, { governedHttpToolAllowlist: allowlist });
  let listed: Awaited<ReturnType<LegionMcpClientPool["listAllTools"]>>;
  try {
    listed = (await pool.listAllTools()).filter((tool) => tool.readOnly && allowed.has(tool.name));
  } catch (err) {
    await pool.closeAll().catch(() => undefined);
    throw err;
  }
  listed.sort((a, b) => a.name.localeCompare(b.name));
  const toolContractIdentity = governedMcpToolContractIdentity(listed);
  const byCallName = new Map<string, string>();
  const externalTools = listed.map((tool) => {
    const callName = `mcp_${stableHash(tool.name).slice(0, 20)}`;
    byCallName.set(callName, tool.name);
    return {
      callName,
      namespacedName: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
    };
  });
  return {
    externalTools,
    configIdentity,
    toolContractIdentity,
    async callExternalTool(callName, args) {
      const namespaced = byCallName.get(callName);
      if (!namespaced) return `error: unknown governed MCP tool ${callName}`;
      const result = await pool.callGovernedHttpTool(namespaced, args);
      return JSON.stringify(result ?? { isError: true, reason: "unknown-server" });
    },
    close: () => pool.closeAll(),
  };
}

export type ResumeOwnerStatus = "live" | "stale" | "unknown" | "terminal";
export type RunRecoveryStatus = {
  runId: string;
  taskId: string | null;
  stage: ResumeStage | "legacy";
  ownerStatus: ResumeOwnerStatus;
  logs: { stdout: string; stderr: string; verification?: string[] };
  interruptionReason: string | null;
  recoveryCommand: string | null;
  startedAt: string;
};

const TERMINAL_RESUME_STAGES = new Set<ResumeStage>(["completed"]);

function runResumePath(projectRoot: string, runId: string): string {
  return join(projectRoot, ".legion-cli", "cache", "runs", runId, "resume.json");
}

async function writeResumeRecord(projectRoot: string, resume: CurrentResumeFile): Promise<void> {
  const parsed = ResumeFileSchema.parse(resume);
  await writeTextFile(runResumePath(projectRoot, resume.runId), `${JSON.stringify(parsed, null, 2)}\n`, {
    root: projectRoot,
  });
}

export async function updateResumeStage(
  projectRoot: string,
  runId: string,
  stage: ResumeStage,
  patch: Partial<
    Pick<
      CurrentResumeFile,
      | "pid"
      | "pidStartedAt"
      | "logs"
      | "interruptionReason"
      | "recoveryCommand"
      | "checkpointPath"
      | "usage"
      | "engineOwnershipReleasedAt"
      | "childTerminationUncertain"
    >
  > = {},
): Promise<CurrentResumeFile | null> {
  let raw: string;
  try {
    raw = await readFile(runResumePath(projectRoot, runId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = ResumeFileSchema.parse(JSON.parse(raw));
  if (parsed.schemaVersion !== SCHEMA_VERSION.resume) return null;
  const next = {
    ...parsed,
    ...patch,
    stage,
    stageUpdatedAt: new Date().toISOString(),
  } satisfies CurrentResumeFile;
  await writeResumeRecord(projectRoot, next);
  return next;
}

export async function inspectResumeOwner(
  resume: ResumeFile,
  identify: (pid: number) => Promise<number | null> = processIdentity,
): Promise<ResumeOwnerStatus> {
  if (resume.schemaVersion === "legion-cli-resume/v2" && TERMINAL_RESUME_STAGES.has(resume.stage)) {
    return "terminal";
  }
  if (resume.schemaVersion === "legion-cli-resume/v1") {
    return resumeRunIsLive(resume) ? "live" : "stale";
  }

  const owners = [
    ...(resume.engineOwnershipReleasedAt
      ? []
      : [{ pid: resume.enginePid, startedAt: resume.enginePidStartedAt }]),
    { pid: resume.pid ?? undefined, startedAt: resume.pidStartedAt ?? undefined },
  ].filter((owner): owner is { pid: number; startedAt: number | undefined } => typeof owner.pid === "number");
  if (owners.length === 0) return resume.childTerminationUncertain ? "unknown" : "stale";

  let unknown = false;
  for (const owner of owners) {
    if (owner.startedAt === undefined) {
      if (isPidAlive(owner.pid)) unknown = true;
      continue;
    }
    const actual = await identify(owner.pid);
    if (actual !== null && sameProcessStart(actual, owner.startedAt)) return "live";
    if (actual === null && isPidAlive(owner.pid)) unknown = true;
  }
  return unknown ? "unknown" : "stale";
}

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
  const out = [
    `.legion-cli/cache/skills/${opts.runId}`,
    `.legion-cli/cache/runs/${opts.runId}`,
    // Generated map artifacts are engine-owned context and remain read-only in the jail.
    ".legion-cli/map",
  ];
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

export async function startSkillSpawn(opts: SkillSpawnOpts): Promise<StartedSkillSpawn> {
  const runId = `${opts.skillId}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const resolution = resolveAdapterId({
    config: opts.config,
    skillId: opts.skillId,
    taskAdapter: opts.taskAdapter,
    cliAdapter: opts.cliAdapter,
    taskProfile: opts.taskProfile,
    cliProfile: opts.cliProfile,
  });
  const effectiveConfig = resolution.profileConfig ? applyProfileArgs(opts.config, {
    adapterId: resolution.id,
    source: resolution.source,
    ...(resolution.profile ? { profile: resolution.profile } : {}),
    config: resolution.profileConfig,
  }) : opts.config;
  assertProfileRuntimeSupport({
    adapterId: resolution.id,
    source: resolution.source,
    ...(resolution.profile ? { profile: resolution.profile } : {}),
    ...(resolution.profileConfig ? { config: resolution.profileConfig } : {}),
  });

  if (!(await isResolvedAdapterSpawnable(effectiveConfig, resolution.id))) {
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

  const adapter = resolveAdapter(effectiveConfig, {
    id: resolution.id,
    artifacts: opts.fakeArtifacts ?? [],
    throwAfterWrite: opts.throwAfterWrite,
    timedOut: opts.timedOut,
    holdWait: opts.holdWait,
    onWait: opts.onWait,
    handlePid: opts.handlePid,
  });
  const tmpl = templateArgv(resolution.id, effectiveConfig);
  const argvSummary =
    resolution.id === "http"
      ? `POST /chat/completions model=${effectiveConfig.adapter.http?.model ?? ""}`
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
  const extraRoots = allowedRoots.filter((root) => root.startsWith(".legion-cli/"));
  await openEngineCommand(opts.projectRoot, runId, { extraRoots });
  // Always snapshot the worktree, even when preSpawnRef is set. Gitignored
  // extras are invisible to `git status --exclude-standard`; KD-11 forbids
  // unioning raw `git status --ignored` (that would revert pre-existing ignored files).
  const snapshot = await snapshotPaths(opts.projectRoot);
  const dirtyAtStart = snapshotDirtyPaths(opts.projectRoot, preSpawnRef);
  const sourceIdentity = await projectSourceIdentity(opts.projectRoot, [
    ...(opts.fileContract?.filesAllowed ?? []),
    ...(opts.fileContract?.expectedArtifacts ?? []),
  ]);
  const gitPolicy = await snapshotGitPolicy(opts.projectRoot);
  const chatSessions = await snapshotChatSessions(opts.projectRoot);
  const resumeDir = join(opts.projectRoot, ".legion-cli", "cache", "runs", runId);
  await mkdir(resumeDir, { recursive: true });
  const startedAt = new Date().toISOString();
  let resume: CurrentResumeFile = {
    schemaVersion: SCHEMA_VERSION.resume,
    runId,
    taskId: opts.taskId ?? null,
    skillId: opts.skillId,
    preSpawnRef: preSpawnRef ?? "UNBORN",
    startedAt,
    stage: "starting",
    stageUpdatedAt: startedAt,
    pid: null,
    enginePid: process.pid,
    enginePidStartedAt: ownProcessStartedAt(),
    adapterId: resolution.id,
    binary: tmpl.binary,
    argvSummary,
    resolutionSource: resolution.source,
    logs: {
      stdout: `.legion-cli/cache/runs/${runId}/stdout.log`,
      stderr: `.legion-cli/cache/runs/${runId}/stderr.log`,
    },
    sourceIdentity,
    contractIdentity: stableHash({
      skillId: opts.skillId,
      fileContract: opts.fileContract ?? null,
      filesForbidden: opts.filesForbidden ?? [],
    }),
  };
  await writeResumeRecord(opts.projectRoot, resume);

  let sandbox: SandboxHandle | undefined;
  let allowedWrites: string[] = [];
  let mcpBridge: Awaited<ReturnType<typeof governedMcpBridge>>;
  const jailed =
    opts.skillId === "execute" ||
    opts.config.sandbox.skills.includes(opts.skillId) ||
    resolution.id === "http";
  if (jailed) {
    try {
      try {
        assertExecuteSandbox(opts.config, { allowNoSandbox: opts.allowNoSandbox });
      } catch (err) {
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
      });
      mcpBridge = resolution.id === "http" ? await governedMcpBridge(effectiveConfig) : undefined;
      resume = {
        ...resume,
        jailIdentity: sandbox.identity,
        contractIdentity: stableHash({
          skillId: opts.skillId,
          allowedWrites,
          filesForbidden: filesForbidden ?? [],
          toolSurface: resolution.id === "http" ? "governed-http-v1" : "spawn-cli",
          governedMcpConfig: mcpBridge?.configIdentity ?? null,
          governedMcpTools: mcpBridge?.toolContractIdentity ?? null,
        }),
        ...(resolution.id === "http"
          ? { checkpointPath: `.legion-cli/cache/runs/${runId}/http-checkpoint.json` }
          : {}),
      };
      await writeResumeRecord(opts.projectRoot, resume);
    } catch (err) {
      await mcpBridge?.close().catch(() => undefined);
      await sandbox?.destroy().catch(() => undefined);
      await updateResumeStage(opts.projectRoot, runId, "interrupted", {
        pid: null,
        pidStartedAt: null,
        engineOwnershipReleasedAt: new Date().toISOString(),
        childTerminationUncertain: false,
        interruptionReason: `spawn start failed: ${err instanceof Error ? err.message : String(err)}`,
        ...(opts.taskId ? { recoveryCommand: `legion-cli task amend ${opts.taskId} --unblock` } : {}),
      });
      throw err;
    }
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
      ...(resolution.id === "http"
        ? {
            checkpointRoot: opts.projectRoot,
            sourceIdentity: resume.sourceIdentity,
            contractIdentity: resume.contractIdentity,
            ...(mcpBridge ? { externalConfigIdentity: mcpBridge.configIdentity } : {}),
            jailIdentity: resume.jailIdentity,
            ...(resolution.profile ? { profile: resolution.profile } : {}),
            ...(resolution.profileConfig?.outputLimit ? { outputLimit: resolution.profileConfig.outputLimit } : {}),
            ...(resolution.profileConfig?.limits?.maxRequests
              ? { maxRequests: resolution.profileConfig.limits.maxRequests }
              : {}),
            ...(resolution.profileConfig?.limits?.maxToolRounds
              ? { maxToolRounds: resolution.profileConfig.limits.maxToolRounds }
              : {}),
            ...(resolution.profileConfig?.limits?.maxReportedTokens
              ? { maxReportedTokens: resolution.profileConfig.limits.maxReportedTokens }
              : {}),
            ...(resolution.profileConfig?.limits?.maxEstimatedCostUsd !== undefined
              ? { maxEstimatedCostUsd: resolution.profileConfig.limits.maxEstimatedCostUsd }
              : {}),
            ...(resolution.profileConfig?.pricing ? { pricing: resolution.profileConfig.pricing } : {}),
          }
        : {}),
      expectedArtifacts: opts.fakeArtifacts,
      ...(spawnOpts?.wrapper ? { wrapper: spawnOpts.wrapper } : {}),
      ...(sandbox && resolution.id === "http"
        ? {
            httpHost: createHttpToolHost({
              jailRoot: sandbox.jailRoot,
              allowedWrites: httpAllowedWrites(allowedWrites),
              filesForbidden,
              hardened: sandbox.hardened,
              spawnOpts: spawnOpts ?? { cwd: sandbox.jailRoot, env },
              ...(mcpBridge
                ? { externalTools: mcpBridge.externalTools, callExternalTool: mcpBridge.callExternalTool }
                : {}),
            }),
          }
        : {}),
    });
  } catch (err) {
    await mcpBridge?.close().catch(() => undefined);
    await sandbox?.destroy().catch(() => undefined);
    await updateResumeStage(opts.projectRoot, runId, "interrupted", {
      pid: null,
      pidStartedAt: null,
      engineOwnershipReleasedAt: new Date().toISOString(),
      childTerminationUncertain: false,
      interruptionReason: `spawn start failed: ${err instanceof Error ? err.message : String(err)}`,
      ...(opts.taskId ? { recoveryCommand: `legion-cli task amend ${opts.taskId} --unblock` } : {}),
    });
    throw err;
  }
  resume = {
    ...resume,
    pid: handle.pid,
    pidStartedAt: handle.pid ? await processIdentity(handle.pid) : null,
    stage: "running",
    stageUpdatedAt: new Date().toISOString(),
  };
  await writeResumeRecord(opts.projectRoot, resume);
  await writeLiveSpawnMarker(opts.projectRoot, opts.skillId, runId);
  return {
    spawned: true,
    runId,
    handle,
    skillId: opts.skillId,
    ...(opts.config.telemetry.otlpEndpoint ? { telemetryEndpoint: opts.config.telemetry.otlpEndpoint } : {}),
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
      commandId: runId,
    },
    resolution,
    binary: tmpl.binary,
    argvSummary,
    sandbox,
    ...(mcpBridge ? { resourceCleanup: mcpBridge.close } : {}),
  };
}

/** Preserve an interrupted HTTP jail/checkpoint for an explicit, identity-checked resume. */
export async function preserveStartedHttpSpawnForRecovery(
  started: Extract<StartedSkillSpawn, { spawned: true }>,
  reason: string,
  recoveryCommand = `legion-cli execute --resume ${started.runId}`,
): Promise<void> {
  if (started.resolution.id !== "http" || !started.sandbox) {
    throw new Error("only sandboxed HTTP runs can be checkpoint-resumed");
  }
  await updateResumeStage(started.revertCtx.projectRoot, started.runId, "interrupted", {
    pid: null,
    pidStartedAt: null,
    interruptionReason: reason,
    recoveryCommand,
    engineOwnershipReleasedAt: new Date().toISOString(),
    childTerminationUncertain: false,
  });
  await started.resourceCleanup?.().catch(() => undefined);
  await clearLiveSpawnMarker(started.revertCtx.projectRoot, started.runId);
}

/** Reopen the retained jail and continue an engine-owned HTTP checkpoint without replaying completed tools. */
export async function resumeHttpSkillSpawn(
  opts: SkillSpawnOpts & { runId: string },
): Promise<Extract<StartedSkillSpawn, { spawned: true }>> {
  const raw = await readFile(runResumePath(opts.projectRoot, opts.runId), "utf8").catch(() => "");
  let resumeJson: unknown = null;
  try {
    resumeJson = raw ? JSON.parse(raw) : null;
  } catch {
    resumeJson = null;
  }
  const parsed = ResumeFileSchema.safeParse(resumeJson);
  if (!parsed.success || parsed.data.schemaVersion !== SCHEMA_VERSION.resume) {
    refuse(`execute resume ${opts.runId} has no compatible resume record`, HINT.execute);
  }
  const resume = parsed.data;
  if (
    resume.skillId !== "execute" ||
    resume.adapterId !== "http" ||
    resume.taskId !== opts.taskId ||
    !resume.checkpointPath ||
    !resume.sourceIdentity ||
    !resume.contractIdentity ||
    !resume.jailIdentity ||
    !["interrupted", "agent-complete"].includes(resume.stage)
  ) {
    refuse(`execute resume ${opts.runId} is not a recoverable HTTP run`, HINT.execute);
  }
  if ((await inspectResumeOwner(resume)) !== "stale") {
    refuse(`execute resume ${opts.runId} still has a live or uncertain owner`, HINT.status);
  }
  const resolution = resolveAdapterId({
    config: opts.config,
    skillId: opts.skillId,
    taskAdapter: opts.taskAdapter,
    cliAdapter: opts.cliAdapter,
    taskProfile: opts.taskProfile,
    cliProfile: opts.cliProfile,
  });
  if (resolution.id !== "http") refuse(`execute resume ${opts.runId} no longer resolves to http`, HINT.doctor);
  const effectiveConfig = resolution.profileConfig ? applyProfileArgs(opts.config, {
    adapterId: resolution.id,
    source: resolution.source,
    ...(resolution.profile ? { profile: resolution.profile } : {}),
    config: resolution.profileConfig,
  }) : opts.config;
  const sourceIdentity = await projectSourceIdentity(opts.projectRoot, [
    ...(opts.fileContract?.filesAllowed ?? []),
    ...(opts.fileContract?.expectedArtifacts ?? []),
  ]);
  if (sourceIdentity !== resume.sourceIdentity) {
    refuse(`execute resume ${opts.runId} refused because project source changed`, HINT.status);
  }
  const contract = skillContract(opts.skillId, { runId: opts.runId, specId: opts.specId });
  const extraAllowedRoots = opts.extraAllowedRoots ?? [
    ...(opts.fileContract?.filesAllowed ?? []),
    ...(opts.fileContract?.expectedArtifacts ?? []),
  ];
  const allowedRoots = [...contract.allowedRoots, ...extraAllowedRoots];
  const filesForbidden = opts.filesForbidden ?? opts.fileContract?.filesForbidden;
  const allowedWrites = await sandboxAllowedWrites({
    projectRoot: opts.projectRoot,
    runId: opts.runId,
    skillId: opts.skillId,
    specId: opts.specId,
    contract: opts.fileContract,
  });
  const adapter = resolveAdapter(effectiveConfig, { id: "http" });
  const tmpl = templateArgv("http", effectiveConfig);
  const filtered = filterSpawnEnv(process.env, adapter.id, adapter.binary);
  const sandbox = await reopenJail({
    projectRoot: opts.projectRoot,
    runId: opts.runId,
    allowedWrites,
    readSet: [],
    adapterBinary: undefined,
    backend: effectiveConfig.sandbox.backend,
    allowDegradedCopy: Boolean(opts.allowNoSandbox) || effectiveConfig.sandbox.allowCopyJail || !effectiveConfig.sandbox.requireHardened,
    credentialKeys: Object.keys(filtered),
    expectedIdentity: resume.jailIdentity,
  });
  const jailIdentity = sandbox.identity;
  if (jailIdentity !== resume.jailIdentity) {
    await sandbox.destroy().catch(() => undefined);
    refuse(`execute resume ${opts.runId} refused because the retained jail changed`, HINT.status);
  }
  const spawnOpts = sandbox.spawnOpts();
  const env = Object.fromEntries(Object.entries(spawnOpts.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const promptPath = join(opts.projectRoot, ".legion-cli", "cache", "runs", opts.runId, "prompt.md");
  const snapshot = await snapshotPaths(opts.projectRoot);
  const dirtyAtStart = snapshotDirtyPaths(opts.projectRoot, resume.preSpawnRef === "UNBORN" ? null : resume.preSpawnRef);
  const gitPolicy = await snapshotGitPolicy(opts.projectRoot);
  const chatSessions = await snapshotChatSessions(opts.projectRoot);
  let handle: AgentHandle;
  let mcpBridge: Awaited<ReturnType<typeof governedMcpBridge>>;
  try {
    mcpBridge = await governedMcpBridge(effectiveConfig);
    const contractIdentity = stableHash({
      skillId: opts.skillId,
      allowedWrites,
      filesForbidden: filesForbidden ?? [],
      toolSurface: "governed-http-v1",
      governedMcpConfig: mcpBridge?.configIdentity ?? null,
      governedMcpTools: mcpBridge?.toolContractIdentity ?? null,
    });
    if (contractIdentity !== resume.contractIdentity) {
      refuse(`execute resume ${opts.runId} refused because the task or governed MCP contract changed`, HINT.status);
    }
    handle = await adapter.spawn({
      runId: opts.runId,
      skillId: opts.skillId,
      promptPath,
      pointerPrompt: buildPointerPrompt(opts.runId, opts.skillId),
      cwd: spawnOpts.cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      env,
      resume: true,
      checkpointRoot: opts.projectRoot,
      sourceIdentity,
      contractIdentity,
      ...(mcpBridge ? { externalConfigIdentity: mcpBridge.configIdentity } : {}),
      jailIdentity,
      ...(resolution.profile ? { profile: resolution.profile } : {}),
      ...(resolution.profileConfig?.outputLimit ? { outputLimit: resolution.profileConfig.outputLimit } : {}),
      ...(resolution.profileConfig?.limits?.maxRequests ? { maxRequests: resolution.profileConfig.limits.maxRequests } : {}),
      ...(resolution.profileConfig?.limits?.maxToolRounds ? { maxToolRounds: resolution.profileConfig.limits.maxToolRounds } : {}),
      ...(resolution.profileConfig?.limits?.maxReportedTokens ? { maxReportedTokens: resolution.profileConfig.limits.maxReportedTokens } : {}),
      ...(resolution.profileConfig?.limits?.maxEstimatedCostUsd !== undefined
        ? { maxEstimatedCostUsd: resolution.profileConfig.limits.maxEstimatedCostUsd }
        : {}),
      ...(resolution.profileConfig?.pricing ? { pricing: resolution.profileConfig.pricing } : {}),
      httpHost: createHttpToolHost({
        jailRoot: sandbox.jailRoot,
        allowedWrites: httpAllowedWrites(allowedWrites),
        filesForbidden,
        hardened: sandbox.hardened,
        spawnOpts,
        ...(mcpBridge
          ? { externalTools: mcpBridge.externalTools, callExternalTool: mcpBridge.callExternalTool }
          : {}),
      }),
    });
  } catch (err) {
    await mcpBridge?.close().catch(() => undefined);
    // The retained jail remains available after a failed resume attempt.
    throw err;
  }
  const nextResume: CurrentResumeFile = {
    ...resume,
    stage: "running",
    stageUpdatedAt: new Date().toISOString(),
    pid: handle.pid,
    pidStartedAt: handle.pid ? await processIdentity(handle.pid) : null,
    enginePid: process.pid,
    enginePidStartedAt: ownProcessStartedAt(),
    engineOwnershipReleasedAt: undefined,
    childTerminationUncertain: false,
    interruptionReason: undefined,
    recoveryCommand: `legion-cli execute --resume ${opts.runId}`,
  };
  await writeResumeRecord(opts.projectRoot, nextResume);
  await writeLiveSpawnMarker(opts.projectRoot, opts.skillId, opts.runId);
  return {
    spawned: true,
    runId: opts.runId,
    handle,
    skillId: opts.skillId,
    ...(opts.config.telemetry.otlpEndpoint ? { telemetryEndpoint: opts.config.telemetry.otlpEndpoint } : {}),
    started: Date.now(),
    revertCtx: {
      projectRoot: opts.projectRoot,
      preSpawnRef: resume.preSpawnRef === "UNBORN" ? null : resume.preSpawnRef,
      allowedRoots,
      filesForbidden,
      snapshot,
      gitPolicy,
      dirtyAtStart,
      chatSessions,
      commandId: opts.runId,
    },
    resolution,
    binary: tmpl.binary,
    argvSummary: `POST /chat/completions model=${effectiveConfig.adapter.http?.model ?? ""}`,
    sandbox,
    ...(mcpBridge ? { resourceCleanup: mcpBridge.close } : {}),
  };
}

export async function waitStartedSpawn(started: Extract<StartedSkillSpawn, { spawned: true }>): Promise<WaitedSkillSpawn> {
  let error: unknown;
  let timedOut = false;
  let usage: AgentUsage | undefined;
  let limitReason: string | undefined;
  let recovery: WaitedSkillSpawn["recovery"];
  try {
    const agentResult = await started.handle.wait();
    timedOut = Boolean(agentResult.timedOut);
    recovery = agentResult.recovery;
    usage = agentResult.usage
      ? applyUsagePricing(
          { ...agentResult.usage, ...(started.resolution.profile ? { profile: started.resolution.profile } : {}) },
          started.resolution.profileConfig?.pricing,
        )
      : undefined;
    limitReason = usageLimitReason(usage ?? {}, started.resolution.profileConfig?.limits) ?? undefined;
    if (timedOut) error = new AgentError("spawn timed out");
    else if (agentResult.aborted) error = new AgentError("spawn aborted");
    else if (agentResult.exitCode !== 0) error = new AgentError(`spawn exited ${agentResult.exitCode ?? "without a code"}`);
    else if (limitReason) error = new AgentError(limitReason);
  } catch (err) {
    error = err;
  }
  await updateResumeStage(started.revertCtx.projectRoot, started.runId, "agent-complete", {
    ...(error
      ? { interruptionReason: error instanceof Error ? error.message : String(error) }
      : {}),
    ...(usage ? { usage } : {}),
  });
  const outcome = error ? "failed" : "complete";
  started.completionMetadata = {
    outcome,
    ...(usage ? { usage } : {}),
    ...(limitReason ? { limitReason } : {}),
  };
  await exportUsageTelemetry({
    endpoint: started.telemetryEndpoint,
    adapter: started.resolution.id,
    profile: started.resolution.profile,
    skill: started.skillId,
    outcome,
    usage,
  }).catch(() => undefined);
  return {
    error,
    timedOut,
    durationMs: Date.now() - started.started,
    ...(usage ? { usage } : {}),
    ...(limitReason ? { limitReason } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

export async function finishStartedSpawn(
  started: Extract<StartedSkillSpawn, { spawned: true }>,
): Promise<RevertResult> {
  await updateResumeStage(started.revertCtx.projectRoot, started.runId, "integrating");
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
  let completed = false;
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
    let jailWritable = false;
    if (started.sandbox) {
      try {
        await started.sandbox.destroy();
      } catch {
        jailWritable = true;
      }
    }
    const childPid = started.handle.pid;
    const agentAlive = Boolean(childPid && childPid !== process.pid && isPidAlive(childPid));
    let revert;
    try {
      revert = await revertExtras({
        ...started.revertCtx,
        commandId: started.revertCtx.commandId,
        extraRoots: started.revertCtx.allowedRoots.filter((root) => root.startsWith(".legion-cli/")),
        agentAlive,
        jailWritable,
      });
    } catch (err) {
      if (err instanceof RestoreRefusedError || err instanceof AuditTamperError) refuse(err.message, HINT.status);
      throw err;
    }
    const extrasReverted = new Set(revert.extrasReverted);
    let incident = revert.incident;
    if (started.sandbox) {
      for (const rel of dropped) {
        if (rel === ".git" || rel.startsWith(".git/")) incident = true;
        if (isAllowedPath(rel, started.revertCtx.allowedRoots)) continue;
        extrasReverted.add(rel);
      }
    }
    completed = true;
    return {
      ...revert,
      extrasReverted: [...extrasReverted],
      incident,
      sandboxCopied: copied,
      sandboxDropped: dropped,
    };
  } finally {
    const executeContinues = completed && started.skillId === "execute";
    if (resumeRaw !== undefined) {
      await writeTextFile(resumePath, resumeRaw, { root: started.revertCtx.projectRoot }).catch(() => undefined);
    }
    await updateResumeStage(
      started.revertCtx.projectRoot,
      started.runId,
      completed ? (started.skillId === "execute" ? "integrating" : "completed") : "interrupted",
      {
        pid: null,
        pidStartedAt: null,
        childTerminationUncertain: false,
        ...(!executeContinues ? { engineOwnershipReleasedAt: new Date().toISOString() } : {}),
        ...(completed ? {} : { interruptionReason: "integration interrupted" }),
      },
    );
    await started.sandbox?.destroy().catch(() => undefined);
    await started.resourceCleanup?.().catch(() => undefined);
    if (!executeContinues) {
      await clearLiveSpawnMarker(started.revertCtx.projectRoot, started.runId);
    }
    const metadata = started.completionMetadata;
    if (metadata) {
      try {
        const phase = (await createLegionStore(started.revertCtx.projectRoot).readState()).data.phase;
        await appendAuditEvent(started.revertCtx.projectRoot, {
          ts: new Date().toISOString(),
          type: "agent_run",
          phase,
          actor: "agent",
          data: {
            skillId: started.skillId,
            adapterId: started.resolution.id,
            profile: started.resolution.profile ?? null,
            outcome: metadata.outcome,
            runId: started.runId,
            usage: metadata.usage ?? null,
            limitReason: metadata.limitReason ?? null,
          },
        });
      } catch {
        // Completion remains authoritative; metrics are best-effort metadata.
      }
    }
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

export let listCacheResumesCalls = 0;

export function resetListCacheResumesCalls(): void {
  listCacheResumesCalls = 0;
}

export async function listCacheResumes(projectRoot: string): Promise<ResumeFile[]> {
  listCacheResumesCalls += 1;
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

export async function listRunRecoveryStatuses(projectRoot: string): Promise<RunRecoveryStatus[]> {
  const resumes = await listCacheResumes(projectRoot);
  const statuses = await Promise.all(
    resumes.map(async (resume): Promise<RunRecoveryStatus> => {
      const ownerStatus = await inspectResumeOwner(resume);
      const taskId = resume.taskId ?? null;
      const legacyLogs = {
        stdout: `.legion-cli/cache/runs/${resume.runId}/stdout.log`,
        stderr: `.legion-cli/cache/runs/${resume.runId}/stderr.log`,
      };
      if (resume.schemaVersion === "legion-cli-resume/v1") {
        return {
          runId: resume.runId,
          taskId,
          stage: "legacy",
          ownerStatus,
          logs: legacyLogs,
          interruptionReason: ownerStatus === "stale" ? "legacy run owner is no longer live" : null,
          recoveryCommand: ownerStatus === "stale" && taskId ? `legion-cli task amend ${taskId} --recover` : null,
          startedAt: resume.startedAt,
        };
      }
      const recoveryCommand =
        resume.recoveryCommand ??
        (ownerStatus === "stale" && taskId
          ? `legion-cli task amend ${taskId} ${resume.stage === "verifying" ? "--recover" : "--unblock"}`
          : null);
      return {
        runId: resume.runId,
        taskId,
        stage: resume.stage,
        ownerStatus,
        logs: resume.logs,
        interruptionReason: resume.interruptionReason ?? null,
        recoveryCommand,
        startedAt: resume.startedAt,
      };
    }),
  );
  return statuses.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.runId.localeCompare(b.runId));
}
