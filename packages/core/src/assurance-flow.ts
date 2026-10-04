import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AssuranceApprovalSchema,
  AssurancePlanSchema,
  ProvenanceLabelSchema,
  validateAssuranceAdoption,
  type ActionApproval,
  type AssurancePlan,
  type LegionConfig,
  type Spec,
  type Task,
  type ProvenanceLabel,
  normalizePathKey,
  type AssuranceApproval,
} from "@9thlevelsoftware/legion-cli-schema";
import { matchesGlob } from "./contracts.js";
import { canonicalJson, type LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { stableHash, type ApprovedHttpAssuranceContext, type GovernedEffectHost, type GovernedIdentities, type GovernedState } from "@9thlevelsoftware/legion-cli-http";
import { namespacedOrigin, sha256 } from "./assurance-flow-labels.js";
import { loadAssurance } from "./assurance.js";
import {
  createDurableGovernedHost,
  deriveBootstrapFingerprint,
  inspectProtectedGovernedRun,
  readProtectedActionApproval,
  persistProtectedActionApproval,
  newApproval,
  recordGovernedFileProvenance,
  recordOpaqueVerificationFileProvenance,
} from "./assurance-flow-host.js";

export type GovernedMcpDescriptor = Readonly<{
  grantId: string;
  tool: string;
  transport: "sse" | "streamable-http";
  transportFingerprint: string;
  schemaFingerprint: string;
  fixedAuthority: Readonly<Record<string, unknown>>;
}>;

export type GovernedMcpDispatchResult =
  | Readonly<{ content: Uint8Array; responseBytes: number; responseDigest: string }>
  | Readonly<{ failureCode: "transport-failure"; responseBytes: number; responseDigest: string }>;

export type CreateGovernedHttpCapabilityOptions = Readonly<{
  store: LegionStore;
  withLock: <T>(callback: () => Promise<T>) => Promise<T>;
  plan: AssurancePlan;
  approval: AssuranceApproval;
  spec: Spec;
  task: Task | null;
  runId: string;
  skillId: string;
  config: LegionConfig;
  profile: string;
  provider: GovernedIdentities["provider"];
  promptFingerprint: string;
  configurationFingerprint: string;
  contractFingerprint: string;
  sourceFingerprint: string;
  jailFingerprint: string;
  jailRoot: string;
  manifestDigest: string;
  allowedWrites: readonly string[];
  filesForbidden: readonly string[];
  artifactPaths: readonly string[];
  reviewContract?: Readonly<Record<string, unknown>>;
  resolveCurrentContext: () => Promise<ApprovedHttpAssuranceContext>;
  externalTools?: readonly GovernedMcpDescriptor[];
  /** Builds the exact final tool arguments: fixed authority plus data at declared pointers, validated against the tool input schema. */
  assembleMcpArguments?: (
    descriptor: GovernedMcpDescriptor,
    data: readonly { pointer: string; content: Uint8Array }[],
  ) => Record<string, unknown>;
  /** Sends exactly the arguments the host assembled and bound into the approved request digest. */
  dispatchMcp?: (
    descriptor: GovernedMcpDescriptor,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) => Promise<GovernedMcpDispatchResult>;
}>;

export type CreateGovernedHttpCapabilityResult = Readonly<{
  assuranceContext: ApprovedHttpAssuranceContext;
  effectHost: GovernedEffectHost;
}>;

export type ApproveGovernedActionOptions = Readonly<{
  store: LegionStore;
  withLock: <T>(callback: () => Promise<T>) => Promise<T>;
  resolveCurrentContext: () => Promise<ApprovedHttpAssuranceContext>;
  runId: string;
  actionId: string;
  valueDigest: string;
  sinkId: string;
  operatorId: string;
  reason: string;
}>;

export type InspectGovernedRunOptions = Readonly<{
  store: LegionStore;
  runId: string;
  manifestDigest?: string;
}>;

export type RecordAppliedFileProvenanceOptions = Readonly<{
  store: LegionStore;
  withLock: <T>(callback: () => Promise<T>) => Promise<T>;
  approvalId: string;
  runId: string;
  actionId: string;
  projectRelativePath: string;
  bytes: Uint8Array;
}>;

const RUN_ROOT = ".legion-cli/audit/http-governed";
const HOST_ARTIFACT = fileURLToPath(import.meta.url);
const HOST_IMPL_ARTIFACT = fileURLToPath(new URL("./assurance-flow-host.js", import.meta.url));
const LABELS_IMPL_ARTIFACT = fileURLToPath(new URL("./assurance-flow-labels.js", import.meta.url));
const sha256Pattern = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function checkedSha(label: string, value: string): string {
  if (!sha256Pattern.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function checkedIdentity(value: GovernedIdentities, manifestDigest: string, config: LegionConfig): GovernedIdentities {
  checkedSha("promptFingerprint", value.promptFingerprint);
  checkedSha("configurationFingerprint", value.configurationFingerprint);
  checkedSha("contractFingerprint", value.contractFingerprint);
  checkedSha("sourceFingerprint", value.sourceFingerprint);
  checkedSha("jailFingerprint", value.jailFingerprint);
  checkedSha("hostFingerprint", value.hostFingerprint);
  checkedSha("policyFingerprint", value.policyFingerprint);
  checkedSha("manifestDigest", manifestDigest);
  if (!value.approvalId || !value.provider.endpoint || !value.provider.model || !value.provider.profile) {
    throw new Error("governed authority identity is incomplete");
  }
  const endpoint = new URL(value.provider.endpoint);
  if (endpoint.username || endpoint.password) throw new Error("governed provider endpoint cannot include URL credentials");
  if (endpoint.protocol !== "https:") {
    const adapter = config.adapter.http;
    const host = endpoint.hostname;
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    const configured = adapter ? new URL(adapter.baseUrl) : null;
    if (endpoint.protocol !== "http:" || !loopback || adapter?.allowLoopback !== true || !configured ||
        endpoint.href.replace(/\/$/, "") !== configured.href.replace(/\/$/, "")) {
      throw new Error("governed provider endpoint must use HTTPS unless it is the configured loopback HTTP endpoint");
    }
  }
  return value;
}

function installedPackageRoot(name: string, searchPaths: readonly string[]): string | null {
  const packageParts = name.split("/");
  for (const searchPath of searchPaths) {
    let directory = resolve(searchPath);
    while (true) {
      const candidate = resolve(directory, "node_modules", ...packageParts);
      try {
        const manifest = JSON.parse(readFileSync(resolve(candidate, "package.json"), "utf8")) as { name?: string };
        if (manifest.name === name) return realpathSync(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return null;
}

async function installedHostFingerprint(): Promise<string> {
  const controllerRoot = installedPackageRoot("@9thlevelsoftware/legion-cli-http", [dirname(HOST_ARTIFACT)]);
  if (!controllerRoot) throw new Error("cannot resolve installed HTTP controller runtime");
  const controllerDir = resolve(controllerRoot, "dist");
  const artifactPaths = [
    HOST_ARTIFACT,
    HOST_IMPL_ARTIFACT,
    LABELS_IMPL_ARTIFACT,
    resolve(dirname(HOST_ARTIFACT), "http-host.js"),
    resolve(controllerDir, "governed.js"),
    resolve(controllerDir, "adapter.js"),
    resolve(controllerDir, "client.js"),
    resolve(controllerDir, "mcp-client.js"),
  ];
  const hash = createHash("sha256").update("legion-cli-governed-installed-host/v1\0");
  for (const path of artifactPaths) {
    const bytes = await readFile(path);
    hash.update(path.split(/[\\/]/).at(-1) ?? "artifact");
    hash.update(Buffer.from([0]));
    hash.update(String(bytes.byteLength));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function approvedMetadata(spec: Spec, task: Task | null, policy: Record<string, unknown>, plan: AssurancePlan): Record<string, unknown> {
  const criteria = spec.acceptance.map((criterion) => ({ id: criterion.id, description: criterion.statement, kind: criterion.kind }));
  const common = {
    spec: { id: spec.id, title: spec.title, goal: spec.problem ?? "", acceptance: criteria },
    assurance: {
      configuredProvider: policy.configuredProvider,
      sources: policy.sources,
      sinks: policy.sinks,
      transformations: policy.transformations,
      externalCalls: policy.externalCalls,
    },
  };
  if (task === null) return common;
  if (task.specId !== spec.id) throw new Error("governed task belongs to a different approved spec");
  if (task.contract.expectedArtifacts.some((path) => !task.contract.filesAllowed.some((allowed) => matchesGlob(allowed, path)))) {
    throw new Error("approved artifact path is outside the task write contract");
  }
  const scopedUnits = plan.knowledge.filter((unit) => unit.taskIds.includes(task.id));
  const scopedUnitIds = new Set(scopedUnits.map((unit) => unit.id));
  const acceptanceIds = new Set(scopedUnits.flatMap((unit) => unit.acceptanceIds));
  for (const validator of plan.validators) {
    if (!validator.inputUnitIds.some((id) => scopedUnitIds.has(id))) continue;
    if (validator.acceptanceIds.some((id) => !scopedUnits.some((unit) => unit.acceptanceIds.includes(id)))) {
      throw new Error("approved task validator acceptance scope is inconsistent");
    }
    validator.acceptanceIds.forEach((id) => acceptanceIds.add(id));
  }
  const criteriaById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  if (!plan.taskIds.includes(task.id) || acceptanceIds.size === 0 ||
      [...acceptanceIds].some((id) => !criteriaById.has(id))) throw new Error("approved task has no consistent assurance acceptance scope");
  const taskCriteria = criteria.filter((criterion) => acceptanceIds.has(criterion.id));
  if (taskCriteria.length !== acceptanceIds.size) throw new Error("approved task acceptance scope does not map to the spec");
  return {
    ...common,
    spec: { ...common.spec, acceptance: taskCriteria },
    task: {
      id: task.id,
      title: task.title,
      type: task.type,
      priority: task.priority,
      contract: {
        filesAllowed: [...task.contract.filesAllowed],
        filesForbidden: [...task.contract.filesForbidden],
        expectedArtifacts: [...task.contract.expectedArtifacts],
        maxFilesTouched: task.contract.maxFilesTouched,
        verificationCommands: [...task.contract.verificationCommands],
      },
      acceptanceIds: taskCriteria.map((criterion) => criterion.id),
    },
  };
}

export type VerificationInformationFlow = Readonly<{
  label: ProvenanceLabel;
  installedEnginePaths: readonly string[];
  /** Realpaths of the engine's transitive runtime module closure; the sandbox makes project-local ones read-only. */
  readOnlyEnginePaths: readonly string[];
}>;

const VERIFICATION_RUNTIME_PACKAGES = [
  "@9thlevelsoftware/legion-cli",
  "@9thlevelsoftware/legion-cli-agents",
  "@9thlevelsoftware/legion-cli-core",
  "@9thlevelsoftware/legion-cli-dashboard",
  "@9thlevelsoftware/legion-cli-design-system",
  "@9thlevelsoftware/legion-cli-graph",
  "@9thlevelsoftware/legion-cli-http",
  "@9thlevelsoftware/legion-cli-map",
  "@9thlevelsoftware/legion-cli-mcp",
  "@9thlevelsoftware/legion-cli-persist",
  "@9thlevelsoftware/legion-cli-qa",
  "@9thlevelsoftware/legion-cli-sandbox",
  "@9thlevelsoftware/legion-cli-schema",
  "@9thlevelsoftware/legion-cli-wiki",
  "@agentclientprotocol/sdk",
  "@modelcontextprotocol/sdk",
  "@noble/ed25519",
  "@noble/hashes",
  "ajv",
  "better-sqlite3",
  "commander",
  "undici",
  "yaml",
  "yauzl",
  "zod",
] as const;

function installedVerificationPackageRoots(): string[] {
  const roots = new Map<string, string>();
  const searchPaths = [dirname(HOST_ARTIFACT)];
  const pending = new Set<string>(VERIFICATION_RUNTIME_PACKAGES);
  while (pending.size > 0) {
    let resolvedAny = false;
    for (const name of pending) {
      const root = installedPackageRoot(name, searchPaths);
      if (!root) continue;
      roots.set(name, root);
      searchPaths.push(root);
      pending.delete(name);
      resolvedAny = true;
    }
    if (!resolvedAny) throw new Error(`cannot resolve installed verification runtime packages: ${[...pending].join(", ")}`);
  }
  return VERIFICATION_RUNTIME_PACKAGES.map((name) => roots.get(name)!);
}

export type RuntimeClosureLimits = Readonly<{ maxPackages: number; maxDepth: number }>;

const RUNTIME_CLOSURE_LIMITS: RuntimeClosureLimits = { maxPackages: 4096, maxDepth: 128 };
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

type RuntimeManifest = { name: string; dependencies: Record<string, string>; optional: Set<string> };

function runtimeManifest(root: string): RuntimeManifest {
  const parsed = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`engine runtime package manifest is malformed: ${root}`);
  const manifest = parsed as Record<string, unknown>;
  const field = (key: "dependencies" | "optionalDependencies"): Record<string, string> => {
    const value = manifest[key];
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.values(value).some((entry) => typeof entry !== "string")) {
      throw new Error(`engine runtime package ${key} are malformed: ${root}`);
    }
    return value as Record<string, string>;
  };
  const optionalDependencies = field("optionalDependencies");
  return {
    name: typeof manifest.name === "string" ? manifest.name : root,
    dependencies: { ...field("dependencies"), ...optionalDependencies },
    optional: new Set(Object.keys(optionalDependencies)),
  };
}

/** Node's node_modules lookup from a dependent package directory; returns the dependency's realpath. */
function resolveDependencyRoot(name: string, dependentRoot: string): string | null {
  const parts = name.split("/");
  let directory = dependentRoot;
  while (true) {
    if (basename(directory) !== "node_modules") {
      const candidate = resolve(directory, "node_modules", ...parts);
      try {
        readFileSync(resolve(candidate, "package.json"));
        return realpathSync(candidate);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Realpaths of every package the engine can load at runtime: the given package roots plus their
 * `dependencies` and `optionalDependencies`, transitively, resolved from each dependent's directory as Node does.
 * A missing optional dependency is skipped; a missing required one, or exceeding the bounds, refuses.
 */
export function verificationRuntimeClosure(startRoots: readonly string[], limits: RuntimeClosureLimits = RUNTIME_CLOSURE_LIMITS): string[] {
  const seen = new Set<string>();
  const pending: Array<{ root: string; depth: number }> = [];
  const enqueue = (root: string, depth: number) => {
    if (seen.has(root)) return;
    if (depth > limits.maxDepth) throw new Error(`engine runtime module closure exceeds its depth bound of ${limits.maxDepth}`);
    if (seen.size >= limits.maxPackages) throw new Error(`engine runtime module closure exceeds its bound of ${limits.maxPackages} packages`);
    seen.add(root);
    pending.push({ root, depth });
  };
  for (const root of startRoots) enqueue(realpathSync(root), 0);
  for (let index = 0; index < pending.length; index += 1) {
    const { root, depth } = pending[index]!;
    const manifest = runtimeManifest(root);
    for (const name of Object.keys(manifest.dependencies).sort()) {
      if (!PACKAGE_NAME.test(name)) throw new Error(`engine runtime package ${manifest.name} declares an invalid dependency name: ${JSON.stringify(name)}`);
      const dependency = resolveDependencyRoot(name, root);
      if (dependency) enqueue(dependency, depth + 1);
      else if (!manifest.optional.has(name)) {
        throw new Error(`cannot resolve required engine runtime dependency ${name} of ${manifest.name} (${root}); information-flow verification cannot protect it`);
      }
    }
  }
  return [...seen].sort();
}


function verificationLabel(plan: AssurancePlan, task: Task | null): ProvenanceLabel {
  if (task) {
    if (task.specId !== plan.specId || !plan.taskIds.includes(task.id)) throw new Error("verification task is outside the approved assurance scope");
    if (!plan.security.tasks.some((entry) => entry.taskId === task.id)) throw new Error("verification task has no approved read scope");
  }
  const origins = new Set<string>();
  for (const source of plan.security.sources) {
    origins.add(namespacedOrigin("file", { sourceId: source.id, path: source.path }));
  }
  origins.add(namespacedOrigin("file", { sourceId: "unclassified-readable", path: "." }));
  return {
    origins: [...origins].sort(),
    integrity: "untrusted",
    confidentiality: "sealed",
  };
}

export function buildVerificationInformationFlow(
  planInput: AssurancePlan,
  approvalInput: AssuranceApproval,
  task: Task | null = null,
): VerificationInformationFlow {
  const plan = AssurancePlanSchema.parse(planInput);
  const approval = AssuranceApprovalSchema.parse(approvalInput);
  validateAssuranceAdoption(plan, approval);
  if (plan.security.mode !== "information-flow") throw new Error("verification information flow requires an adopted information-flow plan");
  const label = verificationLabel(plan, task);
  const installedEnginePaths = installedVerificationPackageRoots();
  const readOnlyEnginePaths = verificationRuntimeClosure(installedEnginePaths);
  return Object.freeze({
    label: Object.freeze(label),
    installedEnginePaths: Object.freeze([...new Set(installedEnginePaths)].sort()),
    readOnlyEnginePaths: Object.freeze(readOnlyEnginePaths),
  });
}

export async function recordOpaqueVerificationOutputProvenance(options: {
  store: LegionStore;
  withLock: <T>(callback: () => Promise<T>) => Promise<T>;
  runId: string;
  approvalId: string;
  taskId: string;
  checkId: string;
  commandFingerprint: string;
  label: ProvenanceLabel;
  inventory: { path: string; beforeDigest: string | null; afterDigest: string };
}): Promise<void> {
  await options.withLock(async () => {
    const state = await inspectProtectedGovernedRun(options.store, options.runId, undefined, options.taskId);
    const assurance = await loadAssurance(options.store);
    if (!state || state.checkpoint.phase !== "program" || state.checkpoint.status !== "complete" ||
        state.checkpoint.identities.approvalId !== options.approvalId ||
        assurance.status?.status !== "valid" || assurance.manifest?.security.mode !== "information-flow" ||
        assurance.approval?.approvalId !== options.approvalId) throw new Error("stale-authority");
    const plan = AssurancePlanSchema.parse(assurance.manifest);
    const task = (await options.store.readTask(options.taskId))?.data ?? null;
    if (!task || task.specId !== plan.specId || !plan.taskIds.includes(task.id) ||
        stableHash(task.contract) !== state.checkpoint.identities.contractFingerprint) throw new Error("stale-authority");
    const outputPath = options.inventory.path;
    if (!task.contract.expectedArtifacts.includes(outputPath) ||
        !task.contract.filesAllowed.some((pattern) => matchesGlob(pattern, outputPath)) ||
        task.contract.filesForbidden.some((pattern) => matchesGlob(pattern, outputPath))) throw new Error("policy-denied");
    const index = task.contract.verificationCommands.findIndex((command, commandIndex) =>
      stableHash({ taskId: task.id, index: commandIndex, command }) === options.commandFingerprint &&
      options.checkId === `verify-${options.commandFingerprint.slice(0, 32)}`);
    if (index < 0 || !/^[a-f0-9]{64}$/.test(options.commandFingerprint) ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(options.checkId)) throw new Error("policy-denied");
    const expectedLabel = ProvenanceLabelSchema.parse(verificationLabel(plan, task));
    const label = ProvenanceLabelSchema.parse(options.label);
    if (canonicalJson(label) !== canonicalJson(expectedLabel)) throw new Error("policy-denied");
    await recordOpaqueVerificationFileProvenance({
      store: options.store,
      runId: options.runId,
      approvalId: options.approvalId,
      taskId: task.id,
      checkId: options.checkId,
      commandFingerprint: options.commandFingerprint,
      inventory: options.inventory,
      label,
    });
  });
}

function approvedTaskContract(task: Task | null, allowedWrites: readonly string[], artifactPaths: readonly string[], reviewContract?: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (!task) {
    if (!reviewContract) throw new Error("governed review requires its fixed approved artifact contract");
    canonicalJson(reviewContract);
    return { ...reviewContract, allowedWrites: [...allowedWrites], artifactPaths: [...artifactPaths] };
  }
  const inContract = (path: string) => task.contract.filesAllowed.some((pattern) => matchesGlob(pattern, path));
  if (allowedWrites.some((path) => !inContract(path)) || artifactPaths.some((path) => !task.contract.expectedArtifacts.includes(path))) {
    throw new Error("engine-selected governed write destinations exceed the approved task contract");
  }
  return {
    filesAllowed: [...task.contract.filesAllowed],
    filesForbidden: [...task.contract.filesForbidden],
    expectedArtifacts: [...task.contract.expectedArtifacts],
    maxFilesTouched: task.contract.maxFilesTouched,
    allowedWrites: [...allowedWrites],
    verificationCommands: [...task.contract.verificationCommands],
  };
}

function assertNoSecretMaterial(value: unknown): void {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length) {
    if (++visited > 100_000) throw new Error("governed authority projection exceeds its bound");
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (/(authorization|headers?|password|secret|credential|access.?token|api.?key|(^|_)env$)/i.test(key)) {
        throw new Error("secret-bearing authority fields cannot enter governed context");
      }
      if (typeof nested === "string" && nested.includes("://")) {
        const parsed = new URL(nested);
        if (parsed.username || parsed.password) throw new Error("credential-bearing URLs cannot enter governed context");
      }
      pending.push(nested);
    }
  }
}

/** A governed review reads every approved task read path and every in-plan task's exact expected artifacts. */
function reviewReadScope(plan: AssurancePlan, reviewContract: Readonly<Record<string, unknown>> | undefined): { taskId: string; readPaths: string[]; transformationIds: string[] } {
  if (!reviewContract || !Array.isArray(reviewContract.tasks)) throw new Error("governed review requires its fixed approved artifact contract");
  const planTasks = new Set(plan.taskIds);
  const artifacts = reviewContract.tasks.flatMap((entry: unknown) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    if (typeof record.id !== "string" || !Array.isArray(record.expectedArtifacts) ||
        record.expectedArtifacts.some((path: unknown) => typeof path !== "string")) throw new Error("governed review contract task scope is malformed");
    return planTasks.has(record.id) ? record.expectedArtifacts as string[] : [];
  });
  return {
    taskId: "independent-review",
    readPaths: [...new Set([...plan.security.tasks.flatMap((entry) => entry.readPaths), ...artifacts])].sort(),
    transformationIds: [...new Set(plan.security.tasks.flatMap((entry) => entry.transformationIds))].sort(),
  };
}

function policyProjection(plan: AssurancePlan, approval: AssuranceApproval, task: Task | null, provider: GovernedIdentities["provider"], manifestDigest: string, externalTools: readonly GovernedMcpDescriptor[], reviewContract: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const taskPolicy = task ? plan.security.tasks.find((candidate) => candidate.taskId === task.id) : undefined;
  if (plan.security.mode !== "information-flow") throw new Error("governed HTTP requires information-flow assurance mode");
  if (task && !taskPolicy) throw new Error("approved task has no information-flow read/transformation contract");
  const baselineSources = approval.baselineSources.map((source) => ({ path: source.path, sha256: source.sha256 }));
  const mcpByGrant = new Map(externalTools.map((tool) => [tool.grantId, tool]));
  const externalCalls = plan.security.externalCalls
    .filter((grant) => !task || grant.taskIds.includes(task.id))
    .map((grant) => {
      const tool = mcpByGrant.get(grant.id);
      let providerTarget: Record<string, string> | null = null;
      if (grant.effect === "provider") {
        const authority = grant.authority && typeof grant.authority === "object" && !Array.isArray(grant.authority)
          ? grant.authority as Record<string, unknown>
          : {};
        const endpoint = typeof authority.endpoint === "string" ? authority.endpoint : typeof authority.origin === "string" ? authority.origin : null;
        const model = typeof authority.model === "string" ? authority.model : provider.model;
        const profile = typeof authority.profile === "string" ? authority.profile : provider.profile;
        if (!endpoint) throw new Error(`approved provider grant ${grant.id} has no configured endpoint target`);
        const sameEndpoint = endpoint !== null && new URL(endpoint).href.replace(/\/$/, "") === new URL(provider.endpoint).href.replace(/\/$/, "");
        if (!sameEndpoint || model !== provider.model || profile !== provider.profile) {
          throw new Error(`approved provider grant ${grant.id} does not match the selected provider capability`);
        }
        providerTarget = { endpoint, model, profile };
      }
      if (grant.effect === "http-mcp" && !tool) throw new Error(`approved HTTP-MCP grant ${grant.id} has no fixed tool descriptor`);
      if (grant.effect === "http-mcp" && tool && (!tool.transportFingerprint || !tool.schemaFingerprint || tool.transport !== "streamable-http")) throw new Error("HTTP-MCP transport identity is missing or unsupported");
      return {
        id: grant.id,
        taskIds: [...grant.taskIds],
        tool: grant.tool,
        sinkId: grant.sinkId,
        authority: grant.authority,
        dataPointers: [...grant.dataPointers],
        effect: grant.effect,
        providerTarget,
        transport: tool ? { transport: tool.transport, fingerprint: tool.transportFingerprint, schemaFingerprint: tool.schemaFingerprint, fixedAuthority: tool.fixedAuthority } : null,
      };
    });
  const projection = {
    manifestDigest,
    mode: plan.security.mode,
    configuredProvider: provider,
    sources: plan.security.sources.map((source) => ({ ...source, origin: namespacedOrigin("file", { sourceId: source.id, path: source.path }) })),
    sinks: plan.security.sinks,
    transformations: plan.security.transformations,
    task: taskPolicy ? { taskId: taskPolicy.taskId, readPaths: taskPolicy.readPaths, transformationIds: taskPolicy.transformationIds } : reviewReadScope(plan, reviewContract),
    externalCalls,
    baselineSources,
    contract: task ? task.contract : null,
  };
  canonicalJson(projection);
  return projection;
}

function contextLabel(metadata: unknown, contract: unknown, manifestDigest: string): ApprovedHttpAssuranceContext["plannerInput"]["label"] {
  const origins = [
    namespacedOrigin("file", { sourceId: "engine-approved-metadata", digest: sha256(canonicalJson(metadata)) }),
    namespacedOrigin("file", { sourceId: "engine-approved-contract", digest: sha256(canonicalJson(contract)) }),
    namespacedOrigin("file", { sourceId: "engine-assurance-policy", digest: manifestDigest }),
  ].sort();
  return { origins, integrity: "approved", confidentiality: "workspace" };
}

export type BuildGovernedHttpAssuranceContextOptions = Omit<CreateGovernedHttpCapabilityOptions, "resolveCurrentContext" | "withLock">;

export async function buildApprovedHttpAssuranceContext(options: BuildGovernedHttpAssuranceContextOptions): Promise<ApprovedHttpAssuranceContext> {
  AssurancePlanSchema.parse(options.plan);
  AssuranceApprovalSchema.parse(options.approval);
  validateAssuranceAdoption(options.plan, options.approval);
  if (options.approval.manifestDigest !== options.manifestDigest) throw new Error("assurance approval does not bind the current manifest");
  if (options.task && options.task.specId !== options.spec.id) throw new Error("governed task/spec binding mismatch");
  if (options.spec.id !== options.plan.specId || options.approval.specId !== options.spec.id) throw new Error("governed spec approval mismatch");
  if (!ID_PATTERN.test(options.runId) || !ID_PATTERN.test(options.profile)) throw new Error("invalid governed run or profile identity");
  if (options.provider.profile !== options.profile) throw new Error("governed provider profile does not match the selected profile");
  const hostFingerprint = await installedHostFingerprint();
  const policy = policyProjection(options.plan, options.approval, options.task, options.provider, options.manifestDigest, options.externalTools ?? [], options.reviewContract);
  assertNoSecretMaterial({ policy, externalTools: options.externalTools ?? [] });
  const metadata = approvedMetadata(options.spec, options.task, policy, options.plan);
  const taskContract = approvedTaskContract(options.task, options.allowedWrites, options.artifactPaths, options.reviewContract);
  const policyFingerprint = sha256(`legion-cli-governed-policy/v1\0${canonicalJson(policy)}`);
  const identities = checkedIdentity({
    promptFingerprint: options.promptFingerprint,
    configurationFingerprint: options.configurationFingerprint,
    contractFingerprint: options.contractFingerprint,
    sourceFingerprint: options.sourceFingerprint,
    jailFingerprint: options.jailFingerprint,
    hostFingerprint,
    approvalId: options.approval.approvalId,
    policyFingerprint,
    provider: options.provider,
  }, options.manifestDigest, options.config);
  const plannerInput = {
    approvedMetadata: metadata,
    label: contextLabel(metadata, taskContract, options.manifestDigest),
    taskContract,
  };
  return Object.freeze({
    runId: options.runId,
    taskId: options.task?.id ?? options.skillId,
    identities,
    manifestDigest: options.manifestDigest,
    plannerInput,
    policy,
  }) as ApprovedHttpAssuranceContext;
}

export async function createGovernedHttpCapability(options: CreateGovernedHttpCapabilityOptions): Promise<CreateGovernedHttpCapabilityResult> {
  const assuranceContext = await buildApprovedHttpAssuranceContext(options);
  const effectHost = await createDurableGovernedHost(options, assuranceContext);
  return Object.freeze({ assuranceContext, effectHost });
}

export function governedBootstrapProgramFingerprint(context: ApprovedHttpAssuranceContext): string {
  return deriveBootstrapFingerprint(context);
}

export async function approveGovernedAction(options: ApproveGovernedActionOptions): Promise<ActionApproval> {
  if (!ID_PATTERN.test(options.runId) || !ID_PATTERN.test(options.actionId) || !ID_PATTERN.test(options.operatorId)) throw new Error("invalid governed approval identity");
  if (!sha256Pattern.test(options.valueDigest) || options.sinkId.length === 0 || options.reason.trim().length === 0) throw new Error("invalid governed approval request");
  return options.withLock(async () => {
    const currentContext = await options.resolveCurrentContext();
    if (currentContext.runId !== options.runId) throw new Error("stale-authority");
    const state = await inspectProtectedGovernedRun(options.store, options.runId, currentContext);
    if (!state || state.checkpoint.status === "complete" ||
        currentContext.runId !== state.checkpoint.runId ||
        canonicalJson(currentContext.identities) !== canonicalJson(state.checkpoint.identities)) throw new Error("stale-authority");
    const checkpoint = state.checkpoint;
    const providerCall = checkpoint.providerCalls.find((call) => call.actionId === options.actionId && call.state === "awaiting-approval");
    const effect = checkpoint.effects.find((entry) => entry.actionId === options.actionId && entry.state === "awaiting-approval");
    if ((!providerCall && !effect) || (providerCall && effect)) throw new Error("approval-required");
    const request = providerCall ?? effect!;
    if (request.valueDigest !== options.valueDigest || request.sinkId !== options.sinkId || request.approvalDigest !== null) throw new Error("stale-authority");
    const prior = await readProtectedActionApproval(options.store, options.actionId);
    if (prior) throw new Error("stale-authority");
    const authority = request.authority;
    const approval = newApproval({
      runId: options.runId,
      actionId: options.actionId,
      programKind: authority.programKind,
      authorityDigest: authority.authorityDigest,
      programFingerprint: authority.programFingerprint,
      actionKind: providerCall ? "provider" : effect!.kind === "write" ? "write" : "http-mcp",
      policyFingerprint: checkpoint.identities.policyFingerprint,
      valueDigest: options.valueDigest,
      sinkId: options.sinkId,
      requestDigest: request.requestDigest,
      operatorId: options.operatorId,
      reason: options.reason,
      state: "approved",
    });
    await persistProtectedActionApproval(options.store, approval);
    return approval;
  });
}

export async function inspectGovernedRun(options: InspectGovernedRunOptions): Promise<GovernedState | null> {
  return inspectProtectedGovernedRun(options.store, options.runId, undefined, undefined, options.manifestDigest);
}

export async function recordAppliedFileProvenance(options: RecordAppliedFileProvenanceOptions): Promise<void> {
  return options.withLock(async () => {
    await recordGovernedFileProvenance(options);
  });
}

export { RUN_ROOT as GOVERNED_HTTP_RUN_ROOT };
export { canonicalDigest, disclosureLabel, isSealed, joinLabels, namespacedOrigin, remoteResponseLabel, sha256 } from "./assurance-flow-labels.js";
