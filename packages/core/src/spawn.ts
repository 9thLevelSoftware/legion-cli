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
  ownProcessStartedAt,
  processIdentity,
  sameProcessStart,
  writeTextFile,
  clearLiveRun,
  createLiveRun,
  isPidAlive,
  liveRunFromResume,
  liveRunState,
  openEngineCommand,
  recordLiveRunAgent,
  RestoreRefusedError,
  canonicalJson,
  type LegionReader,
  type LiveRunMarker,
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
  type AssurancePlan,
  type AdapterId,
  type FileContract,
  type LegionConfig,
  type ResumeFile,
  type ResumeStage,
  type SkillId,
} from "@9thlevelsoftware/legion-cli-schema";
import {
  assembleGovernedMcpArguments,
  LegionMcpClientPool,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_POOL_MAX,
  MCP_REMOTE_MAX_RESPONSE_BYTES,
  MCP_TOOL_TIMEOUT_MS,
  stableHash,
} from "@9thlevelsoftware/legion-cli-http";
import type { ApprovedHttpAssuranceContext, HttpToolHost } from "@9thlevelsoftware/legion-cli-http";
import {
  createGovernedHttpCapability,
  governedMcpTransportFingerprint,
  type CreateGovernedHttpCapabilityOptions,
  type CreateGovernedHttpCapabilityResult,
} from "./assurance-flow.js";
import type { LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import type { GovernedMcpDescriptor } from "./assurance-flow.js";
import { buildSessionBrief, renderSessionBrief } from "@9thlevelsoftware/legion-cli-wiki";
import { isAllowedPath, SKILL_CONTRACTS, skillContract } from "./contracts.js";
import { HINT, refuse } from "./errors.js";
import { CHALLENGE_REPOSITORY_READ_ROOTS, challengeReadableFiles } from "./spec-challenge-inputs.js";
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

/**
 * Refuse while any listed run is live (its engine or agent still holds the recorded identity).
 * `ownRunId` is the run this call is finishing: the owning engine's own relock is exempt.
 * `live` comes from `liveRuns()`, which also clears provably dead markers and migrates the legacy file.
 */
function liveRunMarkerRel(runId: string): string {
  return `.legion-cli/cache/live-spawn/${runId}.json`;
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

export function refuseIfLiveRun(
  live: readonly LiveRunMarker[],
  opts?: { ownRunId?: string; ownRunIds?: readonly string[] },
): void {
  const own = new Set([...(opts?.ownRunIds ?? []), ...(opts?.ownRunId ? [opts.ownRunId] : [])]);
  const other = live.find((marker) => !(own.has(marker.runId) && marker.enginePid === process.pid));
  if (!other) return;
  const task = other.taskId ? ` (task ${other.taskId})` : "";
  const where = other.evidence
    ? `This run has no marker; the evidence is ${other.evidence} (check that its pids are a legion agent)`
    : `if a process there is not a legion agent, delete ${liveRunMarkerRel(other.runId)}`;
  refuse(
    `refused while another legion command is running: ${other.skillId} run ${other.runId} is live${task}. ` +
      `Hands off the tree until it finishes. Check with legion-cli status; if it died, legion-cli doctor clears its marker (${where})`,
    HINT.status,
  );
}

/**
 * Treat a resume.json as a run marker: same identity check, keyed on the run's recorded start. Once the command
 * released engine ownership (as `inspectResumeOwner` also honors), only a surviving agent keeps the run live.
 */
export async function resumeAsLiveRun(resume: ResumeFile): Promise<LiveRunMarker | null> {
  const released = "engineOwnershipReleasedAt" in resume && Boolean(resume.engineOwnershipReleasedAt);
  const marker = liveRunFromResume(released ? { ...resume, enginePid: null } : resume);
  return (await liveRunState(marker)).live ? marker : null;
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
  exitCode?: number | null;
  agentErrorMessage?: string;
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
  exitCode?: number;
  omitSummary?: boolean;
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
  /** Test-only resource owned by this spawn; governed MCP uses the same lifecycle slot. */
  resourceCleanup?: () => Promise<void>;
  governed?: Omit<
    CreateGovernedHttpCapabilityOptions,
    | "store"
    | "withLock"
    | "runId"
    | "skillId"
    | "sourceFingerprint"
    | "jailFingerprint"
    | "jailRoot"
    | "allowedWrites"
    | "filesForbidden"
    | "artifactPaths"
    | "resolveCurrentContext"
  > & {
    store: LegionStore;
    withLock: <T>(runId: string, callback: () => Promise<T>) => Promise<T>;
    resolveCurrentContext: (identity: {
      runId: string;
      sourceFingerprint: string;
      jailFingerprint: string;
      jailRoot: string;
      allowedWrites: readonly string[];
      filesForbidden: readonly string[];
      artifactPaths: readonly string[];
      /** MCP tool descriptors this run was started with (listed live at spawn/resume). */
      externalTools: readonly GovernedMcpDescriptor[];
    }) => Promise<ApprovedHttpAssuranceContext>;
  };
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

/** Release adapter-owned resources once even when several recovery/finalization paths converge. */
export async function cleanupStartedSpawnResources(
  started: Extract<StartedSkillSpawn, { spawned: true }>,
): Promise<void> {
  const cleanup = started.resourceCleanup;
  if (!cleanup) return;
  started.resourceCleanup = undefined;
  await cleanup().catch(() => undefined);
}

export type WaitedSkillSpawn = {
  error?: unknown;
  timedOut: boolean;
  durationMs: number;
  usage?: AgentUsage;
  limitReason?: string;
  recovery?: "resume" | "manual" | "none";
  /** Agent exit code; null when killed or never started. */
  exitCode?: number | null;
  /** Spawn failure message (for example ENOENT) when the process never ran. */
  agentErrorMessage?: string;
  aborted?: boolean;
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

type GovernedMcpBridge = {
  externalTools: NonNullable<HttpToolHost["externalTools"]>;
  callExternalTool: NonNullable<HttpToolHost["callExternalTool"]>;
  close: () => Promise<void>;
  configIdentity: string;
  toolContractIdentity: string;
};

async function governedMcpBridge(config: LegionConfig): Promise<GovernedMcpBridge | undefined> {
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
    async callExternalTool(callName, args, signal) {
      const namespaced = byCallName.get(callName);
      if (!namespaced) return `error: unknown governed MCP tool ${callName}`;
      const result = await pool.callGovernedHttpTool(namespaced, args, signal);
      return JSON.stringify(result ?? { isError: true, reason: "unknown-server" });
    },
    close: () => pool.closeAll(),
  };
}
function reviewRunContract(value: unknown, runId: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const contract = value as Record<string, unknown>;
  if (typeof contract.artifact !== "string" || !contract.artifact.includes("<runId>")) return undefined;
  return { ...contract, artifact: contract.artifact.replaceAll("<runId>", runId) };
}

async function governedHttpMcpCapability(
  config: LegionConfig,
  plan: AssurancePlan,
): Promise<{
  externalTools: GovernedMcpDescriptor[];
  assembleMcpArguments: NonNullable<CreateGovernedHttpCapabilityOptions["assembleMcpArguments"]>;
  dispatchMcp: NonNullable<CreateGovernedHttpCapabilityOptions["dispatchMcp"]>;
  close: () => Promise<void>;
}> {
  const grants = plan.security.externalCalls.filter((grant) => grant.effect === "http-mcp");
  if (grants.length === 0) {
    const refuse = () => { throw new Error("policy-denied"); };
    return { externalTools: [], assembleMcpArguments: refuse, dispatchMcp: async () => refuse(), close: async () => undefined };
  }
  const allowlist = config.mcpHttpToolAllowlist;
  const pool = new LegionMcpClientPool(config.mcpServers ?? {}, { governedHttpToolAllowlist: allowlist });
  try {
    const listed = await pool.listAllTools();
    const allowedTools = listed.filter((tool) => tool.readOnly && allowlist.includes(tool.name));
    const schemaFingerprint = governedMcpToolContractIdentity(allowedTools);
    const externalTools: GovernedMcpDescriptor[] = [];
    const toolsByGrant = new Map<string, { name: string; inputSchema: Record<string, unknown>; authority: Readonly<Record<string, unknown>> }>();
    for (const grant of grants) {
      if (!grant.tool || !grant.authority || typeof grant.authority !== "object" || Array.isArray(grant.authority)) {
        throw new Error(`approved MCP grant ${grant.id} has no fixed tool authority`);
      }
      const tool = allowedTools.find((candidate) => candidate.name === grant.tool);
      if (!tool) throw new Error(`approved MCP grant ${grant.id} has no approved read-only HTTP tool`);
      const server = config.mcpServers?.[tool.serverName];
      if (!server || server.transport !== "streamable-http") {
        throw new Error(`approved MCP grant ${grant.id} does not resolve to streamable HTTP`);
      }
      externalTools.push({
        grantId: grant.id,
        tool: grant.tool,
        transport: "streamable-http",
        transportFingerprint: governedMcpTransportFingerprint(server),
        schemaFingerprint,
        fixedAuthority: grant.authority as Readonly<Record<string, unknown>>,
      });
      toolsByGrant.set(grant.id, { name: tool.name, inputSchema: tool.inputSchema, authority: grant.authority as Readonly<Record<string, unknown>> });
    }
    const toolFor = (descriptor: GovernedMcpDescriptor) => {
      const tool = toolsByGrant.get(descriptor.grantId);
      if (!tool) throw new Error("policy-denied");
      if (descriptor.schemaFingerprint !== schemaFingerprint) throw new Error("stale-authority");
      return tool;
    };
    return {
      externalTools,
      assembleMcpArguments(descriptor, data) {
        const tool = toolFor(descriptor);
        if (canonicalJson(descriptor.fixedAuthority) !== canonicalJson(tool.authority)) throw new Error("policy-denied");
        return assembleGovernedMcpArguments(tool.inputSchema, tool.authority, data);
      },
      async dispatchMcp(descriptor, args, signal) {
        const tool = toolFor(descriptor);
        const capture = await pool.callGovernedHttpToolCaptured(tool.name, { ...args }, descriptor.schemaFingerprint, signal);
        if (!capture) throw new Error("transport-failure");
        if (capture.result?.isError) {
          return {
            failureCode: "transport-failure",
            responseBytes: capture.responseBytes,
            responseDigest: capture.responseDigest,
          };
        }
        if (!capture.result) throw new Error("transport-failure");
        return {
          content: new TextEncoder().encode(canonicalJson(capture.result)),
          responseBytes: capture.responseBytes,
          responseDigest: capture.responseDigest,
        };
      },
      close: () => pool.closeAll(),
    };
  } catch (err) {
    await pool.closeAll().catch(() => undefined);
    throw err;
  }
}

/** Live-listed MCP descriptors for the plan's HTTP-MCP grants, for authority checks made outside a running spawn. */
export async function currentGovernedMcpDescriptors(
  config: LegionConfig,
  plan: AssurancePlan,
): Promise<GovernedMcpDescriptor[]> {
  const capability = await governedHttpMcpCapability(config, plan);
  try {
    return capability.externalTools;
  } finally {
    await capability.close();
  }
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

/** Describes a run that did not end with exit code 0, or undefined when it did. A timeout is reported separately. */
export function agentExitProblem(waited: {
  exitCode?: number | null;
  timedOut?: boolean;
  agentErrorMessage?: string;
}): string | undefined {
  if (waited.timedOut || waited.exitCode === undefined || waited.exitCode === 0) return undefined;
  if (waited.exitCode === null) {
    return waited.agentErrorMessage
      ? `agent did not run to completion (${waited.agentErrorMessage})`
      : "agent was killed or did not start (no exit code)";
  }
  return `agent exited with code ${waited.exitCode}`;
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

/**
 * execute, configured skills and the http adapter run jailed. ingest --distill feeds untrusted
 * content to the agent (F-042): engine.ts refuses it without a hardened backend, and it always
 * runs jailed here. The fake test adapter runs no agent, so it is exempt.
 */
export function isJailedSpawn(skillId: SkillId, configuredSkills: readonly string[], adapterId: string): boolean {
  return (
    skillId === "execute" ||
    skillId === "spec-challenge" ||
    configuredSkills.includes(skillId) ||
    adapterId === "http" ||
    (skillId === "ingest" && adapterId !== "fake")
  );
}

export function sandboxReadSet(opts: {
  projectRoot: string;
  runId: string;
  skillId?: SkillId;
  specId?: string;
  taskId?: string;
}): string[] {
  const out = [
    `.legion-cli/cache/skills/${opts.runId}`,
    `.legion-cli/cache/runs/${opts.runId}`,
  ];
  // Distill links existing catalog titles, so the jailed ingest agent reads the wiki.
  if (opts.skillId === "ingest" && existsSync(join(opts.projectRoot, ".legion-cli", "wiki"))) {
    out.push(".legion-cli/wiki");
  }
  if (opts.specId) out.push(`.legion-cli/specs/${opts.specId}`);
  if (existsSync(join(opts.projectRoot, ".legion-cli", "map"))) out.push(".legion-cli/map");
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
  if (opts.contract && opts.skillId !== "spec-challenge") out.push(...opts.contract.filesAllowed, ...opts.contract.expectedArtifacts);
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
  if (opts.skillId === "spec-challenge" &&
      (opts.extraAllowedRoots?.length || opts.fileContract)) {
    refuse("spec-challenge permits only its run-cache output", HINT.spec);
  }
  const runId = `${opts.skillId}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const resolution = resolveAdapterId({
    config: opts.config,
    skillId: opts.skillId,
    taskAdapter: opts.taskAdapter,
    cliAdapter: opts.cliAdapter,
    taskProfile: opts.taskProfile,
    cliProfile: opts.cliProfile,
  });
  if (opts.governed && resolution.id !== "http") {
    refuse(`information-flow execution requires HTTP transport; resolved ${resolution.id}`, HINT.doctor);
  }
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

  if (!opts.governed && !(await isResolvedAdapterSpawnable(effectiveConfig, resolution.id))) {
    if (opts.required) {
      refuse(spawnableAdapterRefuseMessage(opts.skillId, resolution), HINT.doctor);
    }
    return { spawned: false, runId, resolution };
  }

  let skillsDir: string | undefined;
  let skillDir: string | undefined;
  if (!opts.governed) {
    skillsDir = opts.skillsDir ?? findSkillsDir();
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
    skillDir = resolved.skillDir;
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
  }

  const adapter = resolveAdapter(effectiveConfig, {
    id: resolution.id,
    artifacts: opts.fakeArtifacts ?? [],
    throwAfterWrite: opts.throwAfterWrite,
    timedOut: opts.timedOut,
    exitCode: opts.exitCode,
    omitSummary: opts.omitSummary,
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

  let promptPath: string | undefined;
  if (!opts.governed) {
    await stageSkill({
      projectRoot: opts.projectRoot,
      runId,
      skillDir: skillDir!,
      craftDir: existsSync(join(opts.projectRoot, ".legion-cli", "design", "craft"))
        ? join(opts.projectRoot, ".legion-cli", "design", "craft")
        : undefined,
    });
    const assembled = await assembleSpawnPrompt({
      projectRoot: opts.projectRoot,
      runId,
      skillId: opts.skillId,
      skillDir: skillDir!,
      skillsDir,
      promptBody: opts.promptBody.replaceAll("<id>", runId),
      allowedRoots,
      fileContract: opts.fileContract,
      store: opts.store,
    });
    promptPath = await writeRunPrompt({
      projectRoot: opts.projectRoot,
      runId,
      body: assembled.body,
      skipDesignAppend: assembled.skipDesignAppend,
    });
  }
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
  let governedMcp: Awaited<ReturnType<typeof governedHttpMcpCapability>> | undefined;
  let mcpBridge: GovernedMcpBridge | undefined;
  const jailed = isJailedSpawn(opts.skillId, opts.config.sandbox.skills, resolution.id);
  if (opts.governed && !jailed) {
    refuse("information-flow execution requires a sandboxed HTTP jail", HINT.allowNoSandbox);
  }
  let governedCapability: CreateGovernedHttpCapabilityResult | undefined;
  if (jailed) {
    try {
      try {
        assertExecuteSandbox(opts.config, { allowNoSandbox: opts.allowNoSandbox });
      } catch (err) {
        if (err instanceof SandboxError) refuse(err.message, HINT.allowNoSandbox);
        throw err;
      }
      const filtered = filterSpawnEnv(process.env, adapter.id, adapter.binary);
      allowedWrites = opts.governed && opts.skillId === "review"
        ? [`.legion-cli/cache/runs/${runId}/review.md`]
        : await sandboxAllowedWrites({
            projectRoot: opts.projectRoot,
            runId,
            skillId: opts.skillId,
            specId: opts.specId,
            contract: opts.fileContract,
          });
      const governedAllowedWrites = opts.skillId === "review" && opts.governed
        ? allowedWrites
        : [...(opts.fileContract?.filesAllowed ?? [])];
      const readSet = opts.skillId === "spec-challenge"
        ? await challengeReadableFiles(opts.projectRoot, [
            `.legion-cli/cache/skills/${runId}`,
            `.legion-cli/cache/runs/${runId}`,
            ...CHALLENGE_REPOSITORY_READ_ROOTS,
            ".legion-cli/wiki/product",
            ".legion-cli/discuss",
            ".legion-cli/decisions",
            ".legion-cli/map",
            ...(opts.specId ? [`.legion-cli/specs/${opts.specId}`] : []),
          ])
        : sandboxReadSet({
            projectRoot: opts.projectRoot,
            runId,
            skillId: opts.skillId,
            specId: opts.specId,
            taskId: opts.taskId,
          });
      sandbox = await materializeJail({
        projectRoot: opts.projectRoot,
        runId,
        allowedWrites,
        readSet,
        adapterBinary: tmpl.binary.startsWith("(") ? undefined : tmpl.binary,
        backend: opts.config.sandbox.backend,
        allowDegradedCopy:
          Boolean(opts.allowNoSandbox) ||
          opts.config.sandbox.allowCopyJail ||
          !opts.config.sandbox.requireHardened,
        credentialKeys: Object.keys(filtered),
      });
      mcpBridge = resolution.id === "http" && !opts.governed ? await governedMcpBridge(effectiveConfig) : undefined;
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
        ...(!opts.governed && resolution.id === "http"
          ? { checkpointPath: `.legion-cli/cache/runs/${runId}/http-checkpoint.json` }
          : {}),
      };
      if (opts.governed) {
        if (resolution.id !== "http" || !sandbox) {
          refuse("information-flow capability requires a sandboxed HTTP spawn", HINT.allowNoSandbox);
        }
        governedMcp = await governedHttpMcpCapability(effectiveConfig, opts.governed.plan);
        const { store, withLock, resolveCurrentContext, ...governed } = opts.governed;
        const reviewContract = opts.skillId === "review"
          ? reviewRunContract(governed.reviewContract, runId)
          : undefined;
        if (opts.skillId === "review" && !reviewContract) throw new Error("information-flow review requires its fixed run-specific artifact contract");
        const boundGoverned = reviewContract
          ? { ...governed, reviewContract, contractFingerprint: stableHash(reviewContract) }
          : governed;
        const runtimeIdentity = {
          runId,
          sourceFingerprint: sourceIdentity,
          jailFingerprint: sandbox.identity,
          jailRoot: sandbox.jailRoot,
          allowedWrites: governedAllowedWrites,
          filesForbidden: filesForbidden ?? [],
          artifactPaths: opts.fileContract?.expectedArtifacts ?? [],
          externalTools: governedMcp.externalTools,
        };
        governedCapability = await createGovernedHttpCapability({
          ...boundGoverned,
          store,
          withLock: (callback) => withLock(runId, callback),
          resolveCurrentContext: () => resolveCurrentContext(runtimeIdentity),
          externalTools: governedMcp.externalTools,
          assembleMcpArguments: governedMcp.assembleMcpArguments,
          dispatchMcp: governedMcp.dispatchMcp,
          runId,
          skillId: opts.skillId,
          sourceFingerprint: sourceIdentity,
          jailFingerprint: sandbox.identity,
          jailRoot: sandbox.jailRoot,
          allowedWrites: governedAllowedWrites,
          filesForbidden: filesForbidden ?? [],
          artifactPaths: opts.fileContract?.expectedArtifacts ?? [],
        });
      }
    } catch (err) {
      await mcpBridge?.close().catch(() => undefined);
      await governedMcp?.close().catch(() => undefined);
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

  // The marker exists before the agent does, so an engine crash right after spawn still leaves a
  // record; the agent pid is added once known. `wx`: never overwrites another run's marker.
  let liveMarker: LiveRunMarker;
  try {
    liveMarker = await createLiveRun(opts.projectRoot, {
      runId,
      skillId: opts.skillId,
      taskId: opts.taskId ?? null,
    });
  } catch (err) {
    await mcpBridge?.close().catch(() => undefined);
    await governedMcp?.close().catch(() => undefined);
    await sandbox?.destroy().catch(() => undefined);
    throw err;
  }
  let handle: AgentHandle;
  try {
    const spawnOpts = sandbox?.spawnOpts();
    const env: Record<string, string> = spawnOpts
      ? Object.fromEntries(Object.entries(spawnOpts.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
      : filterSpawnEnv(process.env, adapter.id, adapter.binary);
    const commonJob = {
      runId,
      skillId: opts.skillId,
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
    };
    if (governedCapability) {
      handle = await adapter.spawn({
        ...commonJob,
        assuranceContext: governedCapability.assuranceContext,
        effectHost: governedCapability.effectHost,
      });
    } else {
      if (!promptPath) throw new Error("legacy spawn requires a prepared prompt");
      handle = await adapter.spawn({
        ...commonJob,
        promptPath,
        pointerPrompt: buildPointerPrompt(runId, opts.skillId),
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
    }
  } catch (err) {
    await mcpBridge?.close().catch(() => undefined);
    await governedMcp?.close().catch(() => undefined);
    await sandbox?.destroy().catch(() => undefined);
    await updateResumeStage(opts.projectRoot, runId, "interrupted", {
      pid: null,
      pidStartedAt: null,
      engineOwnershipReleasedAt: new Date().toISOString(),
      childTerminationUncertain: false,
      interruptionReason: `spawn start failed: ${err instanceof Error ? err.message : String(err)}`,
      ...(opts.taskId ? { recoveryCommand: `legion-cli task amend ${opts.taskId} --unblock` } : {}),
    });
    await clearLiveRun(opts.projectRoot, runId).catch(() => undefined);
    throw err;
  }
  try {
    resume = {
      ...resume,
      pid: handle.pid,
      pidStartedAt: handle.pid ? await processIdentity(handle.pid) : null,
      stage: "running",
      stageUpdatedAt: new Date().toISOString(),
    };
    await writeResumeRecord(opts.projectRoot, resume);
    if (handle.pid && handle.pid > 0) await recordLiveRunAgent(opts.projectRoot, liveMarker, handle.pid);
    await writeLiveSpawnMarker(opts.projectRoot, opts.skillId, runId);
  } catch (err) {
    // Never leave a running agent no one owns: stop it, drop the jail and the marker, rethrow.
    await handle.abort().catch(() => undefined);
    await sandbox?.destroy().catch(() => undefined);
    await clearLiveRun(opts.projectRoot, runId).catch(() => undefined);
    await clearLiveSpawnMarker(opts.projectRoot, runId).catch(() => undefined);
    await updateResumeStage(opts.projectRoot, runId, "interrupted", {
      pid: null,
      pidStartedAt: null,
      engineOwnershipReleasedAt: new Date().toISOString(),
      childTerminationUncertain: false,
      interruptionReason: `spawn ownership recording failed: ${err instanceof Error ? err.message : String(err)}`,
      ...(opts.taskId ? { recoveryCommand: `legion-cli task amend ${opts.taskId} --unblock` } : {}),
    }).catch(() => undefined);
    throw err;
  }
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
    ...(mcpBridge || governedMcp || opts.resourceCleanup
      ? {
          resourceCleanup: async () => {
            await Promise.all([
              ...(mcpBridge ? [mcpBridge.close()] : []),
              ...(governedMcp ? [governedMcp.close()] : []),
              ...(opts.resourceCleanup ? [opts.resourceCleanup()] : []),
            ]);
          },
        }
      : {}),
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
  await cleanupStartedSpawnResources(started);
  await clearLiveSpawnMarker(started.revertCtx.projectRoot, started.runId);
  await clearLiveRun(started.revertCtx.projectRoot, started.runId).catch(() => undefined);
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
    (opts.governed ? resume.checkpointPath !== undefined : !resume.checkpointPath) ||
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
  const governedAllowedWrites = [...(opts.fileContract?.filesAllowed ?? [])];
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
  let mcpBridge: GovernedMcpBridge | undefined;
  let governedCapability: CreateGovernedHttpCapabilityResult | undefined;
  let governedMcp: Awaited<ReturnType<typeof governedHttpMcpCapability>> | undefined;
  let liveMarker: LiveRunMarker | undefined;
  try {
    mcpBridge = opts.governed ? undefined : await governedMcpBridge(effectiveConfig);
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
    if (opts.governed) {
      governedMcp = await governedHttpMcpCapability(effectiveConfig, opts.governed.plan);
      const { store, withLock, resolveCurrentContext, ...governed } = opts.governed;
      const runtimeIdentity = {
        runId: opts.runId,
        sourceFingerprint: sourceIdentity,
        jailFingerprint: sandbox.identity,
        jailRoot: sandbox.jailRoot,
        allowedWrites: governedAllowedWrites,
        filesForbidden: filesForbidden ?? [],
        artifactPaths: opts.fileContract?.expectedArtifacts ?? [],
        externalTools: governedMcp.externalTools,
      };
      governedCapability = await createGovernedHttpCapability({
        ...governed,
        store,
        withLock: (callback) => withLock(opts.runId, callback),
        resolveCurrentContext: () => resolveCurrentContext(runtimeIdentity),
        externalTools: governedMcp.externalTools,
        assembleMcpArguments: governedMcp.assembleMcpArguments,
        dispatchMcp: governedMcp.dispatchMcp,
        runId: opts.runId,
        skillId: opts.skillId,
        sourceFingerprint: sourceIdentity,
        jailFingerprint: sandbox.identity,
        jailRoot: sandbox.jailRoot,
        allowedWrites: governedAllowedWrites,
        filesForbidden: filesForbidden ?? [],
        artifactPaths: opts.fileContract?.expectedArtifacts ?? [],
      });
    }
    liveMarker = await createLiveRun(opts.projectRoot, {
      runId: opts.runId,
      skillId: opts.skillId,
      taskId: opts.taskId ?? null,
    });
    const commonJob = {
      runId: opts.runId,
      skillId: opts.skillId,
      cwd: spawnOpts.cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      env,
      resume: true,
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
    };
    handle = governedCapability
      ? await adapter.spawn({
          ...commonJob,
          assuranceContext: governedCapability.assuranceContext,
          effectHost: governedCapability.effectHost,
        })
      : await adapter.spawn({
          ...commonJob,
          checkpointRoot: opts.projectRoot,
          promptPath,
          pointerPrompt: buildPointerPrompt(opts.runId, opts.skillId),
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
    await governedMcp?.close().catch(() => undefined);
    if (liveMarker) await clearLiveRun(opts.projectRoot, opts.runId).catch(() => undefined);
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
  try {
    await writeResumeRecord(opts.projectRoot, nextResume);
    if (liveMarker && handle.pid && handle.pid > 0) {
      await recordLiveRunAgent(opts.projectRoot, liveMarker, handle.pid);
    }
    await writeLiveSpawnMarker(opts.projectRoot, opts.skillId, opts.runId);
  } catch (err) {
    await mcpBridge?.close().catch(() => undefined);
    await governedMcp?.close().catch(() => undefined);
    await handle.abort().catch(() => undefined);
    await clearLiveRun(opts.projectRoot, opts.runId).catch(() => undefined);
    await clearLiveSpawnMarker(opts.projectRoot, opts.runId).catch(() => undefined);
    await updateResumeStage(opts.projectRoot, opts.runId, "interrupted", {
      pid: null,
      pidStartedAt: null,
      engineOwnershipReleasedAt: new Date().toISOString(),
      childTerminationUncertain: false,
      interruptionReason: `resume ownership recording failed: ${err instanceof Error ? err.message : String(err)}`,
      recoveryCommand: `legion-cli execute --resume ${opts.runId}`,
    }).catch(() => undefined);
    throw err;
  }
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
    ...(mcpBridge || governedMcp
      ? { resourceCleanup: async () => {
          await Promise.all([
            ...(mcpBridge ? [mcpBridge.close()] : []),
            ...(governedMcp ? [governedMcp.close()] : []),
          ]);
        } }
      : {}),
  };
}

export async function waitStartedSpawn(started: Extract<StartedSkillSpawn, { spawned: true }>): Promise<WaitedSkillSpawn> {
  let error: unknown;
  let timedOut = false;
  let usage: AgentUsage | undefined;
  let limitReason: string | undefined;
  let recovery: WaitedSkillSpawn["recovery"];
  let exitCode: number | null | undefined;
  let agentErrorMessage: string | undefined;
  let aborted = false;
  try {
    const agentResult = await started.handle.wait();
    timedOut = Boolean(agentResult.timedOut);
    exitCode = agentResult.exitCode;
    agentErrorMessage = agentResult.errorMessage;
    aborted = Boolean(agentResult.aborted);
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
    else if (limitReason) error = new AgentError(limitReason);
    else if (agentResult.governedBlock) error = new AgentError(`governed run stopped: ${agentResult.governedBlock}`);
    else if (started.skillId === "spec-challenge" && agentResult.exitCode !== 0) {
      error = new AgentError(`spawn exited ${String(agentResult.exitCode)}`);
    }
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
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(agentErrorMessage ? { agentErrorMessage } : {}),
    ...(aborted ? { aborted } : {}),
  };
}

export async function finishStartedSpawn(
  started: Extract<StartedSkillSpawn, { spawned: true }>,
  opts?: { keepMarker?: boolean },
): Promise<RevertResult> {
  await updateResumeStage(started.revertCtx.projectRoot, started.runId, "integrating");
  let copied: string[] = [];
  let dropped: string[] = [];
  let agentStillAlive = false;
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
    agentStillAlive = agentAlive;
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
    await cleanupStartedSpawnResources(started);
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
    // A surviving agent keeps its marker: the guard must hold while anything can still write.
    if (!agentStillAlive && !opts?.keepMarker) await clearLiveRun(started.revertCtx.projectRoot, started.runId);
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
    exitCode: waited.exitCode,
    agentErrorMessage: waited.agentErrorMessage,
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
