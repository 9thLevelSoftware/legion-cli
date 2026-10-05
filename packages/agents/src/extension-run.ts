import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertAgentPathAllowed, assertNoLinkInPath, atomicWriteFile, canonicalJson, overlapsEngineProtectedPath, parseStrictJson } from "@9thlevelsoftware/legion-cli-persist";
import { materializeJail, runComponentValidator, snapshotComponentFiles, type ComponentValidationResult } from "@9thlevelsoftware/legion-cli-sandbox";
import { ComponentInputSchema, ComponentInvocationSchema, JsonContractConfigurationSchema, jsonContractFiles, validateComponentInvocation, type AdapterProfile, type ComponentInput, type ComponentInvocation, type LegionConfig } from "@9thlevelsoftware/legion-cli-schema";
import type { HttpToolHost } from "@9thlevelsoftware/legion-cli-http";
import { AgentError } from "./errors.js";
import { filterSpawnEnv } from "./env.js";
import { validateExtensionResources, type ExtensionManifest } from "./extensions.js";
import { runCachePaths, writeRunPrompt } from "./paths.js";
import { applyProfileArgs, applyUsagePricing, assertProfileRuntimeSupport, resolveAgentProfile, usageLimitReason, type AgentUsage } from "./profiles.js";
import { resolveAdapter } from "./resolve.js";
import { stageSkill } from "./stage.js";
import type { AdapterCreateOptions, FakeArtifact } from "./types.js";
import { isSpawnableBinary } from "./which.js";

export type ExtensionCheck = {
  id: string;
  status: "passed" | "failed" | "unavailable";
  detail: string;
  artifact?: string;
};

export type ExtensionEvidence = {
  schemaVersion: "legion-cli-extension-evidence/v1";
  extension: `extension:${string}`;
  checks: ExtensionCheck[];
};

export type ExtensionRecommendation = {
  title: string;
  priority?: "P0" | "P1" | "P2";
  type?: "feature" | "fix" | "bug";
  detail?: string;
};

export type GovernedExtensionResult = {
  runId: string;
  status: "complete" | "failed";
  adapterId: string;
  profile?: string;
  backend: string;
  evidencePath: string;
  evidence: ExtensionEvidence;
  recommendations: ExtensionRecommendation[];
  copied: string[];
  dropped: string[];
  usage?: AgentUsage;
  limitReason?: string;
  stdoutPath: string;
  stderrPath: string;
  summaryPath?: string;
  componentResults?: { projectCheckId: string; result: ComponentValidationResult }[];
};

export function createExtensionRunId(extensionId: string, now = Date.now(), uuid = randomUUID()): string {
  return `extension-${extensionId}-${now.toString(36)}-${uuid.slice(0, 12)}`;
}

const CREDENTIALS: Partial<Record<string, readonly string[]>> = {
  claude: ["CLAUDE_API_KEY"],
  grok: ["GROK_API_KEY", "XAI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
};

function readRoot(pattern: string): string | undefined {
  const posix = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!posix || /[?*\[]/.test(posix) || posix.startsWith("/") || /^[A-Za-z]:/.test(posix) || posix.split("/").includes("..")) return undefined;
  const root = posix.replace(/\/+$/, "");
  if (!root || root === "." || root === ".git" || root.startsWith(".git/") || root === ".env" || root.startsWith(".env.")) return undefined;
  if (overlapsEngineProtectedPath(root)) return undefined;
  return root;
}

function parseEvidence(
  raw: string,
  ref: string,
  requiredChecks: readonly string[],
  unavailableTools: readonly string[],
): ExtensionEvidence {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AgentError("extension evidence.json is not valid JSON");
  }
  const value = json as Partial<ExtensionEvidence>;
  if (value.schemaVersion !== "legion-cli-extension-evidence/v1" || value.extension !== ref || !Array.isArray(value.checks)) {
    throw new AgentError("extension evidence.json has an invalid envelope");
  }
  const checks: ExtensionCheck[] = value.checks.map((entry, index) => {
    const row = entry as Partial<ExtensionCheck>;
    if (
      typeof row.id !== "string" ||
      !row.id.trim() ||
      (row.status !== "passed" && row.status !== "failed" && row.status !== "unavailable") ||
      typeof row.detail !== "string" ||
      !row.detail.trim()
    ) {
      throw new AgentError(`extension evidence check ${index + 1} is invalid`);
    }
    return {
      id: row.id,
      status: row.status,
      detail: row.detail,
      ...(typeof row.artifact === "string" ? { artifact: row.artifact } : {}),
    };
  });
  if (checks.length === 0) throw new AgentError("extension evidence must contain at least one check");
  const ids = new Set<string>();
  for (const check of checks) {
    if (ids.has(check.id)) throw new AgentError(`extension evidence contains duplicate check '${check.id}'`);
    ids.add(check.id);
  }
  const missing = requiredChecks.filter((id) => !ids.has(id));
  if (missing.length > 0) throw new AgentError(`extension evidence is missing required checks: ${missing.join(", ")}`);
  for (const tool of unavailableTools) {
    const id = `tool:${tool}`;
    if (!ids.has(id)) checks.push({ id, status: "unavailable", detail: tool === "command-execution"
      ? "declared extension commands cannot run: this sandbox backend provides no command wrapper"
      : `${tool} is not available on PATH` });
  }
  return { schemaVersion: value.schemaVersion, extension: value.extension, checks };
}

function parseRecommendations(raw: string | undefined): ExtensionRecommendation[] {
  if (!raw) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AgentError("extension recommendations.json is not valid JSON");
  }
  const rows = (json as { recommendations?: unknown }).recommendations;
  if (!Array.isArray(rows)) throw new AgentError("extension recommendations.json requires recommendations[]");
  return rows.map((entry, index) => {
    const row = entry as Partial<ExtensionRecommendation>;
    if (typeof row.title !== "string" || !row.title.trim()) throw new AgentError(`extension recommendation ${index + 1} requires a title`);
    if (row.priority !== undefined && !["P0", "P1", "P2"].includes(row.priority)) throw new AgentError(`extension recommendation ${index + 1} has invalid priority`);
    if (row.type !== undefined && !["feature", "fix", "bug"].includes(row.type)) throw new AgentError(`extension recommendation ${index + 1} has invalid type`);
    return {
      title: row.title.trim(),
      ...(row.priority ? { priority: row.priority } : {}),
      ...(row.type ? { type: row.type } : {}),
      ...(typeof row.detail === "string" && row.detail.trim() ? { detail: row.detail.trim() } : {}),
    };
  });
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function extensionPointer(runId: string, manifest: ExtensionManifest): string {
  return [
    `You are running a governed Legion CLI extension job (runId=${runId}, extension=${manifest.ref}).`,
    `Read .legion-cli/cache/runs/${runId}/prompt.md and .legion-cli/cache/skills/${runId}/SKILL.md.`,
    `Write evidence only under .legion-cli/extensions/runs/${runId}/.`,
    "Do not change product files. Recommendations belong in recommendations.json and become normal tickets after this job.",
    "Unavailable checks must use status=unavailable; absence is never passing.",
    `Write the required evidence envelope to .legion-cli/extensions/runs/${runId}/evidence.json.`,
  ].join("\n");
}

export function extensionCommandSpawnOpts(
  backend: string,
  spawnOpts: { cwd: string; env: NodeJS.ProcessEnv; wrapper?: { bin: string; argvPrefix: string[] } },
): typeof spawnOpts {
  const wrapper = spawnOpts.wrapper;
  const withoutWrapper = (): typeof spawnOpts => ({ cwd: spawnOpts.cwd, env: spawnOpts.env });
  if (!wrapper) return withoutWrapper();
  if (backend === "docker") {
    const network = wrapper.argvPrefix.indexOf("--network");
    return network >= 0 && wrapper.argvPrefix[network + 1] === "none" ? spawnOpts : withoutWrapper();
  }
  if (backend === "bwrap") {
    const argvPrefix = [...wrapper.argvPrefix];
    const separator = argvPrefix.indexOf("--");
    if (separator < 0) return withoutWrapper();
    argvPrefix.splice(separator, 0, "--unshare-net");
    return { ...spawnOpts, wrapper: { ...wrapper, argvPrefix } };
  }
  // Seatbelt's shared profile permits provider traffic, so it is never reused for extension commands.
  return withoutWrapper();
}

export function extensionReadSet(manifest: ExtensionManifest, runId: string): string[] {
  const readSet = new Set<string>([
    `.legion-cli/cache/skills/${runId}`,
    `.legion-cli/cache/runs/${runId}`,
  ]);
  for (const permission of manifest.permissions.read) {
    const root = readRoot(permission);
    if (!root) throw new AgentError(`extension read permission is unsafe: ${permission}`);
    readSet.add(root);
  }
  return [...readSet];
}

export async function readComponentInvocation(path: string): Promise<ComponentInvocation> {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile()) throw new AgentError("validator input must be a regular JSON file");
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 1024 * 1024) throw new AgentError("validator input exceeds 1 MiB");
    return ComponentInvocationSchema.parse(parseStrictJson(bytes.subarray(0, length), { maxBytes: 1024 * 1024, maxDepth: 32 }));
  } finally {
    await file.close();
  }
}

async function runComponentExtension(opts: {
  projectRoot: string;
  extensionDir: string;
  manifest: ExtensionManifest;
  profile?: string;
  componentInvocation?: ComponentInvocation;
  approvedComponentInputs?: readonly ComponentInput[];
}): Promise<GovernedExtensionResult> {
  const runtime = opts.manifest.runtime!;
  if (opts.profile !== undefined) throw new AgentError("--profile is not supported for component runtimes");
  if (opts.manifest.permissions.commands.length || opts.manifest.requiredTools.length ||
      opts.manifest.allowedTools.some((tool) => tool !== "Read") ||
      opts.manifest.permissions.write.some((path) => path !== ".legion-cli/extensions/runs/**")) {
    throw new AgentError("component runtimes cannot declare commands, host tools, or product writes");
  }
  if (opts.componentInvocation && opts.approvedComponentInputs) {
    throw new AgentError("standalone invocation and approved component inputs are mutually exclusive");
  }
  if (!opts.componentInvocation && !opts.approvedComponentInputs) {
    throw new AgentError("component runtimes require --validator-input");
  }
  const roots = opts.manifest.permissions.read.map((permission) => {
    const root = readRoot(permission);
    if (!root) throw new AgentError(`extension read permission is unsafe: ${permission}`);
    return root;
  });
  const inputs: ComponentInput[] = [];
  if (opts.componentInvocation) {
    const invocation = ComponentInvocationSchema.parse(opts.componentInvocation);
    validateComponentInvocation(invocation, opts.manifest.requiredChecks);
    for (const id of opts.manifest.requiredChecks) {
      const check = invocation.checks.find((entry) => entry.id === id)!;
      for (const path of check.files) {
        if (!roots.some((root) => path === root || path.startsWith(`${root}/`))) {
          throw new AgentError(`component input is outside permissions.read: ${path}`);
        }
        await assertAgentPathAllowed(opts.projectRoot, path);
      }
      inputs.push(ComponentInputSchema.parse({
        abi: runtime.abi, projectCheckId: id, extensionCheckId: id, acceptanceIds: [], unitIds: [],
        configuration: check.configuration, files: await snapshotComponentFiles(opts.projectRoot, check.files), units: [],
      }));
    }
  } else {
    if (!opts.approvedComponentInputs!.length || opts.approvedComponentInputs!.length > 256) {
      throw new AgentError("approved component inputs require 1–256 selected checks");
    }
    for (const packet of opts.approvedComponentInputs!) inputs.push(ComponentInputSchema.parse(packet));
  }
  const selected = new Set<string>();
  const selectedExtensionChecks = new Set<string>();
  for (const input of inputs) {
    if (!opts.manifest.requiredChecks.includes(input.extensionCheckId) || selected.has(input.projectCheckId) || selectedExtensionChecks.has(input.extensionCheckId)) {
      throw new AgentError("component inputs require declared checks and distinct project and extension check IDs");
    }
    selected.add(input.projectCheckId);
    selectedExtensionChecks.add(input.extensionCheckId);
    for (const record of [...input.files, ...input.units]) {
      if (!roots.some((root) => record.path === root || record.path.startsWith(`${root}/`))) {
        throw new AgentError(`component input is outside permissions.read: ${record.path}`);
      }
      await assertAgentPathAllowed(opts.projectRoot, record.path);
      await assertNoLinkInPath(join(opts.projectRoot, ...record.path.split("/")), { root: opts.projectRoot });
    }
    if (opts.manifest.extensionId === "json-contract") {
      const configuration = JsonContractConfigurationSchema.parse(input.configuration);
      const declared = new Set(input.files.map((file) => file.path));
      for (const assertion of configuration.assertions) {
        for (const path of jsonContractFiles(assertion.predicate)) {
          if (!declared.has(path)) throw new AgentError(`JSON-contract predicate references undeclared raw input: ${path}`);
        }
      }
    }
  }
  const runId = createExtensionRunId(opts.manifest.extensionId);
  const evidenceRoot = `.legion-cli/extensions/runs/${runId}`;
  const directory = join(opts.projectRoot, ...evidenceRoot.split("/"));
  await assertNoLinkInPath(directory, { root: opts.projectRoot });
  await mkdir(directory, { recursive: true });
  await assertNoLinkInPath(directory, { root: opts.projectRoot });
  const checks: ExtensionCheck[] = [];
  const recommendations: ExtensionRecommendation[] = [];
  const componentResults: { projectCheckId: string; result: ComponentValidationResult }[] = [];
  for (const input of inputs) {
    const result = await runComponentValidator(input, {
      componentPath: join(opts.extensionDir, ...runtime.component.split("/")),
      componentSha256: runtime.sha256,
    });
    componentResults.push({ projectCheckId: input.projectCheckId, result });
    checks.push({
      id: input.extensionCheckId, status: result.status,
      detail: result.output ? canonicalJson(result.output.observations) : result.reason ?? "Component runtime unavailable",
    });
    if (result.output?.recommendations) recommendations.push(...result.output.recommendations);
  }
  const evidence = parseEvidence(canonicalJson({ schemaVersion: "legion-cli-extension-evidence/v1", extension: opts.manifest.ref, checks }), opts.manifest.ref, inputs.map((input) => input.extensionCheckId), []);
  const evidencePath = `${evidenceRoot}/evidence.json`;
  await atomicWriteFile(join(directory, "evidence.json"), canonicalJson(evidence), { root: opts.projectRoot });
  const boundedRecommendations = recommendations.slice(0, 32);
  const copied = [evidencePath];
  if (boundedRecommendations.length) {
    await atomicWriteFile(join(directory, "recommendations.json"), canonicalJson({ recommendations: boundedRecommendations }), { root: opts.projectRoot });
    copied.push(`${evidenceRoot}/recommendations.json`);
  }
  await atomicWriteFile(join(directory, "stdout.log"), canonicalJson(componentResults.map((entry) => entry.result.output)), { root: opts.projectRoot });
  await atomicWriteFile(join(directory, "stderr.log"), canonicalJson(componentResults.map((entry) => entry.result.reason)), { root: opts.projectRoot });
  return {
    runId, status: checks.every((check) => check.status === "passed") ? "complete" : "failed",
    adapterId: "wasi-component", backend: "wasi-component", evidencePath, evidence,
    recommendations: boundedRecommendations, componentResults, copied, dropped: [],
    stdoutPath: `${evidenceRoot}/stdout.log`, stderrPath: `${evidenceRoot}/stderr.log`,
  };
}

export async function runGovernedExtension(opts: {
  projectRoot: string;
  extensionDir: string;
  manifest: ExtensionManifest;
  config: Pick<LegionConfig, "adapter" | "sandbox">;
  profile?: string;
  componentInvocation?: ComponentInvocation;
  approvedComponentInputs?: readonly ComponentInput[];
  fakeArtifacts?: FakeArtifact[];
  adapterOptions?: Omit<AdapterCreateOptions, "artifacts">;
  createHttpToolHost?: (opts: {
    jailRoot: string;
    allowedWrites: readonly string[];
    hardened: boolean;
    commandPrefixes: readonly (readonly string[])[];
    spawnOpts: { cwd: string; env: NodeJS.ProcessEnv; wrapper?: { bin: string; argvPrefix: string[] } };
  }) => HttpToolHost;
}): Promise<GovernedExtensionResult> {
  await validateExtensionResources(opts.extensionDir, opts.manifest);
  if (opts.manifest.runtime) return runComponentExtension(opts);
  if (opts.componentInvocation || opts.approvedComponentInputs) {
    throw new AgentError("--validator-input and approved component inputs are only supported for component runtimes");
  }
  const runId = createExtensionRunId(opts.manifest.extensionId);
  for (const root of extensionReadSet(opts.manifest, runId)) {
    await assertAgentPathAllowed(opts.projectRoot, root);
  }
  const selected = resolveAgentProfile(opts.config, {
    skillId: "execute",
    ...(opts.profile ? { cliProfile: opts.profile } : {}),
  });
  assertProfileRuntimeSupport(selected);
  const profileConfig = selected.config as AdapterProfile | undefined;
  const effective = selected.config
    ? applyProfileArgs(opts.config, selected)
    : opts.config;
  const adapter = resolveAdapter(effective, {
    id: selected.adapterId,
    artifacts: opts.fakeArtifacts,
    ...opts.adapterOptions,
  });
  if (adapter.id !== "http" && adapter.id !== "fake") {
    throw new AgentError(
      `governed extension jobs require adapter http (resolved ${adapter.id}); spawn CLI adapters cannot enforce the extension tool allowlist`,
    );
  }
  const allowedToolNames = new Set(opts.manifest.allowedTools.map((tool) => tool.split("(")[0]?.trim().toLowerCase()));
  if (!allowedToolNames.has("read") || !allowedToolNames.has("write")) {
    throw new AgentError("extension allowed-tools must declare Read and Write for governed evidence jobs");
  }
  if (opts.manifest.permissions.commands.length > 0 && !allowedToolNames.has("bash")) {
    throw new AgentError("extension command permissions require an allowed-tools Bash declaration");
  }
  if (adapter.id === "http" && !opts.createHttpToolHost) {
    throw new AgentError("governed extension HTTP jobs require the extension tool host");
  }

  await stageSkill({ projectRoot: opts.projectRoot, runId, skillDir: opts.extensionDir });
  const paths = runCachePaths(opts.projectRoot, runId);
  try {
    await access(paths.skillMd);
  } catch {
    const alternate = join(paths.skillDir, "EXTENSION.md");
    const raw = await readFile(alternate, "utf8");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(paths.skillMd, raw, "utf8");
  }
  const unavailableTools = opts.manifest.requiredTools.filter((tool) => !isSpawnableBinary(tool));
  await writeRunPrompt({
    projectRoot: opts.projectRoot,
    runId,
    skipDesignAppend: true,
    body: [
      `# Governed extension ${opts.manifest.ref}`,
      "",
      `Evidence root: .legion-cli/extensions/runs/${runId}/`,
      `Unavailable required tools: ${unavailableTools.length > 0 ? unavailableTools.join(", ") : "(none)"}`,
      "",
      "Required evidence.json schema:",
      '`{"schemaVersion":"legion-cli-extension-evidence/v1","extension":"extension:<id>","checks":[{"id":"...","status":"passed|failed|unavailable","detail":"...","artifact":"optional"}]}`',
      "",
      "Optional recommendations.json schema:",
      '`{"recommendations":[{"title":"...","priority":"P0|P1|P2","type":"feature|fix|bug","detail":"optional"}]}`',
    ].join("\n"),
  });

  const evidenceRoot = `.legion-cli/extensions/runs/${runId}`;
  const readSet = extensionReadSet(opts.manifest, runId);
  const sandbox = await materializeJail({
    projectRoot: opts.projectRoot,
    runId,
    allowedWrites: [evidenceRoot, `.legion-cli/cache/runs/${runId}`],
    readSet,
    // In-process adapters (`(http)`, `(in-process)`) have no executable to bind, as in core's skill spawn.
    adapterBinary: adapter.binary.startsWith("(") ? undefined : adapter.binary,
    backend: opts.config.sandbox.backend,
    allowDegradedCopy: opts.config.sandbox.allowCopyJail,
    credentialKeys: CREDENTIALS[adapter.id] ?? [],
  });
  const spawnOpts = sandbox.spawnOpts();
  const commandSpawnOpts = extensionCommandSpawnOpts(sandbox.backend, spawnOpts);
  if (opts.manifest.permissions.commands.length > 0 && !commandSpawnOpts.wrapper) {
    unavailableTools.push("command-execution");
  }
  const commandPrefixes = opts.manifest.permissions.commands.map((command) => command.trim().split(/\s+/).filter(Boolean));
  const httpHost = adapter.id === "http"
    ? opts.createHttpToolHost?.({
        jailRoot: sandbox.jailRoot,
        allowedWrites: [evidenceRoot, `.legion-cli/cache/runs/${runId}`],
        hardened: sandbox.hardened,
        commandPrefixes,
        spawnOpts: commandSpawnOpts,
      })
    : undefined;
  let copied: string[] = [];
  let dropped: string[] = [];
  try {
    const env = Object.fromEntries(
      Object.entries(spawnOpts.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const handle = await adapter.spawn({
      runId,
      skillId: opts.manifest.ref,
      promptPath: paths.promptPath,
      pointerPrompt: extensionPointer(runId, opts.manifest),
      cwd: spawnOpts.cwd,
      timeoutMs: 20 * 60 * 1000,
      env: Object.keys(env).length > 0 ? env : filterSpawnEnv(process.env, adapter.id, adapter.binary),
      expectedArtifacts: opts.fakeArtifacts,
      ...(httpHost ? { httpHost } : {}),
      checkpointRoot: opts.projectRoot,
      ...(selected.profile ? { profile: selected.profile } : {}),
      ...(profileConfig?.outputLimit ? { outputLimit: profileConfig.outputLimit } : {}),
      ...(profileConfig?.limits?.maxRequests ? { maxRequests: profileConfig.limits.maxRequests } : {}),
      ...(profileConfig?.limits?.maxToolRounds ? { maxToolRounds: profileConfig.limits.maxToolRounds } : {}),
      ...(profileConfig?.limits?.maxReportedTokens ? { maxReportedTokens: profileConfig.limits.maxReportedTokens } : {}),
      ...(profileConfig?.limits?.maxEstimatedCostUsd !== undefined
        ? { maxEstimatedCostUsd: profileConfig.limits.maxEstimatedCostUsd }
        : {}),
      ...(profileConfig?.pricing ? { pricing: profileConfig.pricing } : {}),
      ...(spawnOpts.wrapper ? { wrapper: spawnOpts.wrapper } : {}),
    });
    const result = await handle.wait();
    if (result.exitCode !== 0 || result.timedOut || result.aborted) {
      throw new AgentError(`extension job failed (exit=${result.exitCode ?? "none"}, timedOut=${result.timedOut}, aborted=${result.aborted})`);
    }
    ({ copied, dropped } = await sandbox.copyOut());
    const evidencePath = join(opts.projectRoot, ...`${evidenceRoot}/evidence.json`.split("/"));
    const evidence = parseEvidence(
      await readFile(evidencePath, "utf8"),
      opts.manifest.ref,
      opts.manifest.requiredChecks,
      unavailableTools,
    );
    const recommendations = parseRecommendations(
      await optionalFile(join(opts.projectRoot, ...`${evidenceRoot}/recommendations.json`.split("/"))),
    );
    const usage = result.usage
      ? applyUsagePricing({ ...result.usage, ...(selected.profile ? { profile: selected.profile } : {}) }, profileConfig?.pricing)
      : undefined;
    const limitReason = usageLimitReason(usage ?? {}, profileConfig?.limits) ?? undefined;
    return {
      runId,
      status: limitReason ? "failed" : "complete",
      adapterId: adapter.id,
      ...(selected.profile ? { profile: selected.profile } : {}),
      backend: sandbox.backend,
      evidencePath: `${evidenceRoot}/evidence.json`,
      evidence,
      recommendations,
      copied,
      dropped,
      ...(usage ? { usage } : {}),
      ...(limitReason ? { limitReason } : {}),
      stdoutPath: result.stdoutPath,
      stderrPath: result.stderrPath,
      ...(result.summaryPath ? { summaryPath: result.summaryPath } : {}),
    };
  } finally {
    await sandbox.destroy();
  }
}
