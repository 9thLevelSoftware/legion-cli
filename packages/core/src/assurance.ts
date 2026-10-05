import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isAlias, isCollection, parseDocument } from "yaml";
import { parseExtensionFrontmatter, resolveAdapterId, resolveExtensionDir, validateExtensionResources, type ExtensionManifest } from "@9thlevelsoftware/legion-cli-agents";
import { bindKnowledgeUnit, type KnowledgeBindingResult } from "@9thlevelsoftware/legion-cli-map";
import { assertAgentPathAllowed, assertNoLinkInPath, canonicalJson, toFsPath, type LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { AssuranceApprovalSchema, AssuranceExecutionSchema, AssurancePlanSchema, CheckEvidenceSchema, ComponentInputSchema, COMPONENT_LIMITS, SCHEMA_VERSION, normalizePathKey, validateAssuranceAdoption, validateAssuranceJson, type AssuranceApproval, type AssuranceExecution, type AssurancePlan, type CheckEvidence, type ComponentInput, type ComponentRuntimeIdentity, type LegionConfig, type PlanApprovalReceipt, type ProvenanceLabel, type Spec, type Task } from "@9thlevelsoftware/legion-cli-schema";
import { resolveComponentRuntime, runComponentValidator, snapshotComponentFiles } from "@9thlevelsoftware/legion-cli-sandbox";
import { refuse } from "./errors.js";
import { readFileProvenance } from "./assurance-flow-host.js";
import { joinLabels, labelProductBytes } from "./assurance-flow-labels.js";

export const ASSURANCE_PLAN_PATH = ".legion-cli/workflow/assurance.yaml";
export const ASSURANCE_APPROVAL_PATH = ".legion-cli/workflow/assurance-approval.yaml";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const REAPPROVE = "legion-cli plan approve";

export type AssuranceStatus = {
  mode: AssurancePlan["security"]["mode"] | null;
  status: "valid" | "invalid";
  manifestDigest: string | null;
  informationFlow: "not-enforced" | "pending" | "partial" | "enforced";
  blocker: string | null;
  traceStatus?: AssuranceExecution["traceStatus"];
  policyStatus?: AssuranceExecution["policyStatus"];
  coverage?: AssuranceCriterionEvidence[];
  checks?: AssuranceCheckDecision[];
};
export type AssuranceState = {
  manifest: AssurancePlan | null;
  approval: AssuranceApproval | null;
  fingerprint?: string;
  status?: AssuranceStatus;
};

async function readBoundedYaml(path: string, maximumBytes = MAX_MANIFEST_BYTES): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maximumBytes) throw new Error(`assurance YAML exceeds ${maximumBytes} bytes`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    const doc = parseDocument(text, { uniqueKeys: true, strict: true, version: "1.2" });
    if (doc.errors.length || doc.warnings.length) throw new Error("invalid or ambiguous assurance YAML");
    const pending: Array<{ node: unknown; depth: number }> = [{ node: doc.contents, depth: 0 }];
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (depth > 32) throw new Error("assurance YAML exceeds depth 32");
      if (isAlias(node)) throw new Error("assurance YAML aliases are not permitted");
      if (isCollection(node)) {
        for (const item of node.items) {
          if (item && typeof item === "object" && "key" in item && "value" in item) {
            pending.push({ node: item.key, depth: depth + 1 }, { node: item.value, depth: depth + 1 });
          } else pending.push({ node: item, depth: depth + 1 });
        }
      }
    }
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!validateAssuranceJson(value)) throw new Error("assurance YAML must contain finite, bounded JSON with valid Unicode");
    canonicalJson(value);
    return value;
  } finally {
    await file.close();
  }
}

export async function readAssuranceDraft(path: string): Promise<AssurancePlan> {
  return AssurancePlanSchema.parse(await readBoundedYaml(path));
}

export function assuranceManifestDigest(plan: AssurancePlan): string {
  return createHash("sha256").update("legion-cli-assurance-plan/v1\0").update(canonicalJson(AssurancePlanSchema.parse(plan))).digest("hex");
}

export async function loadAssurance(store: LegionStore): Promise<AssuranceState> {
  const hasPlan = await store.pathExists(ASSURANCE_PLAN_PATH);
  const hasApproval = await store.pathExists(ASSURANCE_APPROVAL_PATH);
  if (!hasPlan && !hasApproval) return { manifest: null, approval: null };
  let manifest: AssurancePlan | null = null;
  let approval: AssuranceApproval | null = null;
  let fingerprint: string | undefined;
  let blocker: string | null = null;
  try {
    await assertNoLinkInPath(toFsPath(store.projectRoot, ASSURANCE_PLAN_PATH), { root: store.projectRoot });
    await assertNoLinkInPath(toFsPath(store.projectRoot, ASSURANCE_APPROVAL_PATH), { root: store.projectRoot });
    if (!hasPlan) throw new Error("adopted assurance manifest is missing");
    manifest = await readAssuranceDraft(toFsPath(store.projectRoot, ASSURANCE_PLAN_PATH));
    fingerprint = assuranceManifestDigest(manifest);
    if (!hasApproval) throw new Error("assurance approval commit marker is missing");
    approval = AssuranceApprovalSchema.parse(await readBoundedYaml(toFsPath(store.projectRoot, ASSURANCE_APPROVAL_PATH)));
    validateAssuranceAdoption(manifest, approval);
    if (approval.manifestDigest !== fingerprint) throw new Error("adopted assurance manifest digest mismatch");
    const nativeHost = await resolveAssuranceHost(manifest);
    if (canonicalJson(nativeHost) !== canonicalJson(approval.nativeHost)) {
      throw new Error("packaged validator host identity changed; reapprove the plan");
    }
  } catch (error) {
    blocker = `assurance requires reapproval: ${error instanceof Error ? error.message : String(error)}`;
  }
  return {
    manifest, approval,
    ...(fingerprint ? { fingerprint } : {}),
    status: {
      mode: manifest?.security.mode ?? null, status: blocker ? "invalid" : "valid",
      manifestDigest: fingerprint ?? null,
      informationFlow: manifest?.security.mode === "information-flow" ? "pending" : "not-enforced",
      blocker,
    },
  };
}

export function bindAssuranceApproval(state: AssuranceState, receipt: PlanApprovalReceipt | null, planFingerprint: string): AssuranceStatus | undefined {
  if (!state.status) return undefined;
  let blocker = state.status.blocker;
  if (!blocker && (!receipt || !state.approval || state.approval.approvalId !== receipt.approvalId || state.approval.specId !== receipt.specId || state.approval.planFingerprint !== receipt.planFingerprint || receipt.planFingerprint !== planFingerprint)) {
    blocker = "assurance approval does not bind the current plan approval epoch; reapprove the plan";
  }
  return { ...state.status, status: blocker ? "invalid" : "valid", blocker };
}

export async function resolveAssuranceHost(plan: AssurancePlan): Promise<ComponentRuntimeIdentity | null> {
  if (plan.validators.length === 0) return null;
  try {
    return await resolveComponentRuntime();
  } catch (error) {
    refuse(`component validators unavailable: ${error instanceof Error ? error.message : String(error)}`, REAPPROVE);
  }
}

export function assertAssuranceTransports(plan: AssurancePlan, config: LegionConfig, tasks: Task[]): void {
  if (plan.security.mode !== "information-flow") return;
  for (const task of tasks) {
    const resolved = resolveAdapterId({ config, skillId: "execute", taskAdapter: task.adapter, taskProfile: task.profile });
    if (resolved.id !== "http") throw new Error(`information-flow requires HTTP transport for task ${task.id}; resolved ${resolved.id}`);
  }
  const review = resolveAdapterId({ config, skillId: "review" });
  if (review.id !== "http") throw new Error(`information-flow requires HTTP review transport; resolved ${review.id}`);
  if (Object.values(config.mcpServers ?? {}).some((server) => server.transport === "stdio")) throw new Error("information-flow does not permit MCP stdio servers");
}

export async function validateAssuranceContext(plan: AssurancePlan, context: { spec: Spec; tasks: Task[]; config: LegionConfig; projectRoot: string }): Promise<void> {
  AssurancePlanSchema.parse(plan);
  if (plan.specId !== context.spec.id) throw new Error("assurance specId does not match the active frozen spec");
  const acceptanceIds = new Set(context.spec.acceptance.map((entry) => entry.id));
  const taskIds = new Set(context.tasks.map((entry) => entry.id));
  if (plan.acceptanceIds.some((id) => !acceptanceIds.has(id))) throw new Error("assurance references an unknown acceptance criterion");
  if (plan.taskIds.some((id) => !taskIds.has(id))) throw new Error("assurance references an unknown task");
  if (plan.security.mode === "information-flow" && context.tasks.some((task) => !plan.taskIds.includes(task.id))) throw new Error("information-flow requires contracts for every active task");
  assertAssuranceTransports(plan, context.config, context.tasks);
  const paths = new Set([
    ...plan.security.sources.map((entry) => entry.path),
    ...plan.security.tasks.flatMap((entry) => entry.readPaths),
    ...plan.knowledge.map((entry) => entry.source.path),
    ...plan.validators.flatMap((entry) => entry.inputFiles),
    ...plan.delivery.artifacts.map((entry) => entry.path),
    ...context.tasks.flatMap((task) => [...task.contract.filesAllowed, ...task.contract.expectedArtifacts]),
  ]);
  for (const path of paths) await assertAgentPathAllowed(context.projectRoot, path);
  for (const sink of plan.security.sinks) {
    const url = new URL(sink.origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(`invalid assurance sink origin ${sink.id}`);
  }
  for (const grant of plan.security.externalCalls) {
    for (const pointer of grant.dataPointers) {
      const parts = pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
      // Data may only extend authority objects with new keys: never land on, inside, or above an authority value.
      let value: unknown = grant.authority;
      for (const [index, part] of parts.entries()) {
        if (value === null || typeof value !== "object" || Array.isArray(value) ||
            (index === parts.length - 1 && Object.hasOwn(value, part))) throw new Error(`external-call ${grant.id} data pointer overlaps fixed authority`);
        if (!Object.hasOwn(value, part)) break;
        value = (value as Record<string, unknown>)[part];
      }
    }
  }
  for (const check of plan.validators) {
    await resolveValidatorComponent(context.projectRoot, check, [...new Set([...check.inputFiles, ...assuranceUnitClosure(plan, check.inputUnitIds).map((unit) => unit.source.path)])]);
  }
}

export async function prepareAssuranceApproval(plan: AssurancePlan, receipt: PlanApprovalReceipt, projectRoot: string, nativeHost: ComponentRuntimeIdentity | null): Promise<AssuranceApproval> {
  const baselineSources: AssuranceApproval["baselineSources"] = [];
  for (const source of plan.security.sources) {
    await assertAgentPathAllowed(projectRoot, source.path);
    let sha256: string | null = null;
    try {
      const path = toFsPath(projectRoot, source.path);
      const info = await lstat(path);
      if (!info.isFile()) throw new Error(`assurance source ${source.path} must be a regular file`);
      const hash = createHash("sha256");
      for await (const bytes of createReadStream(path)) hash.update(bytes);
      sha256 = hash.digest("hex");
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    baselineSources.push({ path: source.path, sha256 });
  }
  const sidecar = AssuranceApprovalSchema.parse({ schemaVersion: SCHEMA_VERSION.assuranceApproval, approvalId: receipt.approvalId, specId: receipt.specId, planFingerprint: receipt.planFingerprint, manifestDigest: assuranceManifestDigest(plan), approvedAt: receipt.approvedAt, nativeHost, baselineSources });
  validateAssuranceAdoption(plan, sidecar);
  return sidecar;
}

export async function invalidateAssuranceApproval(store: LegionStore): Promise<void> {
  await assertNoLinkInPath(toFsPath(store.projectRoot, ASSURANCE_APPROVAL_PATH), { root: store.projectRoot });
  await rm(toFsPath(store.projectRoot, ASSURANCE_APPROVAL_PATH), { force: true });
}

export async function writeAssuranceManifest(store: LegionStore, plan: AssurancePlan | null): Promise<void> {
  await invalidateAssuranceApproval(store);
  if (plan) await store.writeYaml(ASSURANCE_PLAN_PATH, AssurancePlanSchema.parse(plan));
  else {
    const path = toFsPath(store.projectRoot, ASSURANCE_PLAN_PATH);
    await assertNoLinkInPath(path, { root: store.projectRoot });
    await rm(path, { force: true });
  }
}

export async function writeAssuranceApproval(store: LegionStore, approval: AssuranceApproval): Promise<void> {
  await store.writeYaml(ASSURANCE_APPROVAL_PATH, AssuranceApprovalSchema.parse(approval));
}

export const ASSURANCE_EXECUTION_PATH = ".legion-cli/workflow/assurance-execution.yaml";
export const ASSURANCE_TRACE_PREREQUISITE = "durable governance trace is incomplete; the governed trace writer and current-epoch validation are required before assured ship";
const MISSING_OBSERVATION_LABEL = "component receipt lacks its information-flow label";

async function checkObservationLabel(projectRoot: string, plan: AssurancePlan, approval: AssuranceApproval, inputs: CheckEvidence["inputs"]): Promise<ProvenanceLabel> {
  const generated = new Map((await readFileProvenance(projectRoot))?.files.map((entry) => [normalizePathKey(entry.path), entry] as const) ?? []);
  return joinLabels(inputs.map((input) => labelProductBytes({
    policySources: plan.security.sources, baselineSources: approval.baselineSources,
    generated: generated.get(normalizePathKey(input.path)), path: input.path,
    digest: input.kind === "file" ? input.sha256 : input.kind === "unit" ? input.observedFileDigest : null,
  })));
}

export type AssuranceCheckDecision = {
  checkId: string;
  result: CheckEvidence["result"] | "unknown";
  decision: "execute" | "reuse" | "blocked";
  reason: string;
  inputDigest: string | null;
  reuseKey: string;
  executionId: string | null;
  reusedFrom: string | null;
};
export type AssuranceCriterionEvidence = {
  acceptanceId: string;
  status: "covered" | "failed" | "unknown";
  unitIds: string[];
  taskIds: string[];
  checkIds: string[];
  observations: { checkId: string; id: string; status: "passed" | "failed" | "error"; code: string; detail?: string }[];
};
export type AssuranceUnitEvidence = {
  unitId: string;
  path: string;
  status: "bound" | "unknown";
  changed: boolean;
  reason: string | null;
  syntaxDigest: string | null;
  observedFileDigest: string | null;
  mode: string | null;
  acceptanceIds: string[];
  taskIds: string[];
  checkIds: string[];
  dependsOn: string[];
};
export type AssuranceEvidenceReport = {
  adopted: boolean;
  approvalId: string | null;
  manifestDigest: string | null;
  policyStatus: AssuranceExecution["policyStatus"] | "not-adopted";
  traceStatus: AssuranceExecution["traceStatus"] | "not-adopted";
  criteria: AssuranceCriterionEvidence[];
  units: AssuranceUnitEvidence[];
  checks: AssuranceCheckDecision[];
  blocker: string | null;
};
export type AssuranceImpactReport = AssuranceEvidenceReport & {
  impacts: { path: string; unitIds: string[]; taskIds: string[]; checkIds: string[]; acceptanceIds: string[] }[];
};

type ApprovedCheck = AssurancePlan["validators"][number];
type PreparedCheck = {
  packet: ComponentInput | null;
  inputDigest: string | null;
  inputs: CheckEvidence["inputs"];
  parserVersion: string | null;
  configurationDigest: string;
  reuseKey: string;
  reason: string | null;
  bindings: KnowledgeBindingResult[];
};

export function assuranceUnitClosure(plan: AssurancePlan, unitIds: readonly string[]): AssurancePlan["knowledge"] {
  const units = new Map(plan.knowledge.map((unit) => [unit.id, unit]));
  const selected = new Set<string>();
  const pending = [...unitIds];
  while (pending.length) {
    const id = pending.pop()!;
    if (selected.has(id)) continue;
    const unit = units.get(id);
    if (!unit) throw new Error(`undeclared knowledge unit ${id}`);
    selected.add(id);
    pending.push(...unit.dependsOn);
  }
  return [...selected].sort().map((id) => units.get(id)!);
}

function boundedDiagnostic(text: string): string {
  const clean = stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  if (Buffer.byteLength(clean, "utf8") <= 4096) return clean || "validator unavailable";
  let result = "";
  let bytes = 0;
  for (const character of clean) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > 4096) break;
    result += character;
    bytes += size;
  }
  return result;
}

export async function prepareAssuranceCheck(projectRoot: string, plan: AssurancePlan, approval: AssuranceApproval, check: ApprovedCheck): Promise<PreparedCheck> {
  const units = assuranceUnitClosure(plan, check.inputUnitIds);
  const bindings: KnowledgeBindingResult[] = [];
  for (const unit of units) bindings.push(await bindKnowledgeUnit(projectRoot, unit));
  const inputs: CheckEvidence["inputs"] = [];
  let reason: string | null = null;
  let files: ComponentInput["files"] = [];
  try {
    files = await snapshotComponentFiles(projectRoot, check.inputFiles);
    for (const file of files) inputs.push(file.kind === "missing"
      ? { kind: "missing", path: file.path, exists: false }
      : { kind: "file", path: file.path, exists: true, mode: file.mode, sha256: file.sha256 });
  } catch (error) {
    reason = boundedDiagnostic(`validator ${check.id} raw input admission failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const binding of bindings) {
    if (binding.status === "bound") {
      inputs.push({
        kind: "unit", unitId: binding.input.unitId, path: binding.input.path,
        syntaxDigest: binding.input.syntaxDigest, observedFileDigest: binding.source.sha256, mode: binding.source.mode,
        ...(binding.input.selector ? { selector: binding.input.selector } : {}),
      });
    } else {
      reason ??= boundedDiagnostic(`knowledge unit ${binding.unitId} is unknown: ${binding.reason}`);
      if (!inputs.some((input) => input.kind !== "unit" && input.path === binding.path)) {
        if (binding.source.sha256 && binding.source.mode) inputs.push({ kind: "file", path: binding.path, exists: true, sha256: binding.source.sha256, mode: binding.source.mode });
        else inputs.push({ kind: "missing", path: binding.path, exists: false });
      }
    }
  }
  const parserVersion = bindings.find((binding) => binding.parserVersion !== null)?.parserVersion ?? null;
  const configurationDigest = createHash("sha256").update("legion-cli-validator-configuration/v1\0").update(canonicalJson(check.configuration)).digest("hex");
  let packet: ComponentInput | null = null;
  let inputDigest: string | null = null;
  if (!reason) {
    try {
      packet = ComponentInputSchema.parse({
        abi: "legion-validator/v1", projectCheckId: check.id, extensionCheckId: check.extensionCheckId,
        acceptanceIds: [...check.acceptanceIds].sort(), unitIds: units.map((unit) => unit.id),
        configuration: check.configuration, files,
        units: bindings.flatMap((binding) => binding.status === "bound" ? [binding.input] : []),
      });
      inputDigest = createHash("sha256").update(canonicalJson(packet)).digest("hex");
    } catch (error) {
      packet = null;
      reason = boundedDiagnostic(`validator ${check.id} packet admission failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const reuseKey = createHash("sha256").update("legion-cli-component-reuse/v1\0").update(canonicalJson({
    approvalId: approval.approvalId, manifestDigest: assuranceManifestDigest(plan), definition: check,
    configurationDigest, moduleSha256: check.componentSha256, runtime: approval.nativeHost,
    os: process.platform, arch: process.arch, abi: "legion-validator/v1", limits: COMPONENT_LIMITS,
    parserVersion, inputDigest,
    unitModes: bindings.map((binding) => ({ unitId: binding.status === "bound" ? binding.input.unitId : binding.unitId, mode: binding.source.mode })),
    admission: reason ? { reason, inputs } : null,
  })).digest("hex");
  return { packet, inputDigest, inputs, parserVersion, configurationDigest, reuseKey, reason, bindings };
}

async function readCheckReceipt(store: LegionStore, checkId: string, executionId?: string): Promise<CheckEvidence | null> {
  const path = executionId
    ? `.legion-cli/workflow/checks/${checkId}/${createHash("sha256").update(executionId).digest("hex")}.yaml`
    : `.legion-cli/workflow/checks/${checkId}.yaml`;
  if (!await store.pathExists(path)) return null;
  await assertNoLinkInPath(toFsPath(store.projectRoot, path), { root: store.projectRoot });
  const receipt = CheckEvidenceSchema.parse(await readBoundedYaml(toFsPath(store.projectRoot, path), 4 * 1024 * 1024));
  if (receipt.checkId !== checkId || (executionId !== undefined && receipt.executionId !== executionId)) throw new Error(`validator ${checkId} receipt identity mismatch`);
  if (receipt.output && receipt.observationDigest !== createHash("sha256").update(canonicalJson(receipt.output.observations)).digest("hex")) throw new Error(`validator ${checkId} observation digest mismatch`);
  return receipt;
}

async function checkPriorEvidence(store: LegionStore, approval: AssuranceApproval, check: ApprovedCheck, prepared: PreparedCheck): Promise<{ prior: CheckEvidence | null; original: CheckEvidence | null; reason: string }> {
  const prior = await readCheckReceipt(store, check.id);
  if (!prior) return { prior, original: null, reason: "no prior component evidence" };
  if (prior.reuseKey !== prepared.reuseKey) {
    const changes: string[] = [];
    if (prior.approvalId !== approval.approvalId) changes.push("approval epoch");
    if (prior.manifestDigest !== approval.manifestDigest) changes.push("approved manifest/check definition");
    if (prior.moduleSha256 !== check.componentSha256) changes.push("component module");
    if (canonicalJson(prior.runtime) !== canonicalJson(approval.nativeHost)) changes.push("native host/runtime/settings/target");
    if (prior.parserVersion !== prepared.parserVersion) changes.push("parser version");
    if (prior.configurationDigest !== prepared.configurationDigest) changes.push("configuration");
    if (prior.inputDigest !== prepared.inputDigest) changes.push("guest-visible input packet");
    if (prepared.inputs.some((input) => input.kind === "unit" && !prior.inputs.some((old) => old.kind === "unit" && old.unitId === input.unitId && old.mode === input.mode))) changes.push("unit existence/mode");
    return { prior, original: null, reason: prepared.reason ?? `changed ${changes.join(", ") || "complete input/runtime identity"}` };
  }
  if (prior.result !== "passed") return { prior, original: null, reason: prior.reason ?? `unchanged ${prior.result} component stage requires explicit retry` };
  const originalId = prior.reusedFrom ?? prior.executionId;
  const original = await readCheckReceipt(store, check.id, originalId);
  if (!original || original.reusedFrom !== null || original.result !== "passed" || original.reuseKey !== prepared.reuseKey ||
      canonicalJson(original.output) !== canonicalJson(prior.output) || original.observationDigest !== prior.observationDigest) {
    throw new Error(`validator ${check.id} original executed evidence is missing or mismatched`);
  }
  const inputIdentity = (inputs: CheckEvidence["inputs"]) => inputs.map((input) => input.kind === "unit"
    ? { kind: input.kind, unitId: input.unitId, path: input.path, mode: input.mode, syntaxDigest: input.syntaxDigest, ...(input.selector ? { selector: input.selector } : {}) }
    : input);
  for (const candidate of [prior, original]) {
    if (candidate.approvalId !== approval.approvalId || candidate.manifestDigest !== approval.manifestDigest ||
        candidate.extensionCheckId !== check.extensionCheckId || candidate.moduleSha256 !== check.componentSha256 ||
        candidate.inputDigest !== prepared.inputDigest || candidate.parserVersion !== prepared.parserVersion ||
        candidate.configurationDigest !== prepared.configurationDigest ||
        canonicalJson(candidate.runtime) !== canonicalJson(approval.nativeHost) ||
        canonicalJson(inputIdentity(candidate.inputs)) !== canonicalJson(inputIdentity(prepared.inputs))) {
      throw new Error(`validator ${check.id} reusable receipt metadata differs from its complete key`);
    }
  }
  return { prior, original, reason: "identical complete component input/runtime key; prior passed execution is reusable" };
}

async function resolveValidatorComponent(projectRoot: string, check: ApprovedCheck, inputPaths: readonly string[] = []): Promise<{ extensionDir: string; manifest: ExtensionManifest }> {
  const resolved = await resolveExtensionDir({ projectRoot, extensionId: check.extensionRef.slice("extension:".length) });
  if (!resolved.ok) throw new Error(resolved.reason);
  for (const name of ["EXTENSION.md", "SKILL.md"]) {
    let text: string;
    try { text = await readFile(join(resolved.extensionDir, name), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const parsed = parseExtensionFrontmatter(text, `extensions/${check.extensionRef.slice(10)}/${name}`);
    if (!parsed.ok) throw new Error(`validator ${check.id} extension manifest is invalid`);
    await validateExtensionResources(resolved.extensionDir, parsed.manifest);
    const runtime = parsed.manifest.runtime;
    if (!runtime || runtime.sha256 !== check.componentSha256 || !parsed.manifest.requiredChecks.includes(check.extensionCheckId)) throw new Error(`validator ${check.id} extension runtime differs from approval`);
    if (parsed.manifest.permissions.commands.length || parsed.manifest.requiredTools.length ||
        parsed.manifest.allowedTools.some((tool) => tool !== "Read") ||
        parsed.manifest.permissions.write.some((path) => path !== ".legion-cli/extensions/runs/**")) throw new Error(`validator ${check.id} grants commands, host tools, or product writes`);
    for (const path of parsed.manifest.permissions.read) await assertAgentPathAllowed(projectRoot, path);
    for (const path of inputPaths) {
      await assertAgentPathAllowed(projectRoot, path);
      if (!parsed.manifest.permissions.read.some((permission) => {
        const root = normalizePathKey(permission.replace(/\/\*\*?$/, ""));
        return normalizePathKey(path) === root || normalizePathKey(path).startsWith(`${root}/`);
      })) throw new Error(`validator ${check.id} input exceeds extension read permission: ${path}`);
    }
    const componentPath = join(resolved.extensionDir, runtime.component);
    await assertNoLinkInPath(componentPath, { root: resolved.extensionDir });
    const componentInfo = await lstat(componentPath);
    if (!componentInfo.isFile() || componentInfo.size > 16 * 1024 * 1024) throw new Error(`validator ${check.id} component must be a regular file of at most 16 MiB`);
    const componentHash = createHash("sha256");
    let componentSize = 0;
    for await (const bytes of createReadStream(componentPath)) {
      componentSize += bytes.length;
      if (componentSize > 16 * 1024 * 1024) throw new Error(`validator ${check.id} component exceeds 16 MiB`);
      componentHash.update(bytes);
    }
    if (componentHash.digest("hex") !== check.componentSha256) throw new Error(`validator ${check.id} component bytes do not match the approved digest`);
    return { extensionDir: resolved.extensionDir, manifest: parsed.manifest };
  }
  throw new Error(`validator ${check.id} extension manifest is missing`);
}

export async function readAssuranceExecution(store: LegionStore): Promise<AssuranceExecution | null> {
  if (!await store.pathExists(ASSURANCE_EXECUTION_PATH)) return null;
  await assertNoLinkInPath(toFsPath(store.projectRoot, ASSURANCE_EXECUTION_PATH), { root: store.projectRoot });
  return AssuranceExecutionSchema.parse(await readBoundedYaml(toFsPath(store.projectRoot, ASSURANCE_EXECUTION_PATH)));
}

export async function runAssuranceChecks(options: {
  store: LegionStore;
  plan: AssurancePlan;
  approval: AssuranceApproval;
  productFingerprint: string;
  environmentFingerprint: string;
  retry: boolean;
  informationFlowPosture: AssuranceStatus["informationFlow"];
  observeProduct: () => Promise<string>;
  persist: (receipt: CheckEvidence, execution: AssuranceExecution) => Promise<void>;
}): Promise<{ execution: AssuranceExecution; blocker: string | null; decisions: AssuranceCheckDecision[]; raced: boolean }> {
  const { store, plan, approval } = options;
  AssurancePlanSchema.parse(plan);
  AssuranceApprovalSchema.parse(approval);
  validateAssuranceAdoption(plan, approval);
  if (assuranceManifestDigest(plan) !== approval.manifestDigest) throw new Error("component stage manifest differs from approved authority");
  const executionId = randomUUID();
  const references: AssuranceExecution["checks"] = [];
  const decisions: AssuranceCheckDecision[] = [];
  let blocker: string | null = null;
  let raced = false;
  const aggregate = (): AssuranceExecution => AssuranceExecutionSchema.parse({
    schemaVersion: SCHEMA_VERSION.assuranceExecution, executionId, approvalId: approval.approvalId,
    manifestDigest: assuranceManifestDigest(plan), productFingerprint: options.productFingerprint, environmentFingerprint: options.environmentFingerprint,
    checks: references, policyStatus: plan.security.mode === "adapter-default" ? "not-enforced" : options.informationFlowPosture === "enforced" ? "enforced" : "blocked",
    traceStatus: "incomplete", status: "blocked", blocker: boundedDiagnostic(blocker ?? ASSURANCE_TRACE_PREREQUISITE), recordedAt: new Date().toISOString(),
  });
  const labelRequired = plan.security.mode === "information-flow";
  const usedUnits = new Set(plan.validators.flatMap((check) => assuranceUnitClosure(plan, check.inputUnitIds).map((unit) => unit.id)));
  for (const unit of plan.knowledge) {
    if (usedUnits.has(unit.id)) continue;
    const binding = await bindKnowledgeUnit(store.projectRoot, unit);
    if (binding.status === "unknown") {
      blocker = boundedDiagnostic(`knowledge unit ${unit.id} is unknown: ${binding.reason}`);
      return { execution: aggregate(), blocker, decisions, raced };
    }
  }
  for (const check of plan.validators) {
    const before = await options.observeProduct();
    if (before !== options.productFingerprint) { blocker = "product inputs changed before component evidence admission"; raced = true; break; }
    const prepared = await prepareAssuranceCheck(store.projectRoot, plan, approval, check);
    const { prior, original: reusable, reason: priorReason } = await checkPriorEvidence(store, approval, check, prepared);
    const unlabeled = labelRequired && reusable !== null && reusable.observationLabel === undefined;
    const original = unlabeled ? null : reusable;
    const reason = unlabeled ? MISSING_OBSERVATION_LABEL : priorReason;
    if (!options.retry && prior?.reuseKey === prepared.reuseKey && prior.result !== "passed" && (!labelRequired || prior.observationLabel !== undefined)) {
      blocker = prior.reason ?? `validator ${check.id} is ${prior.result}; explicit retry required`;
      if (await options.observeProduct() !== before) {
        blocker = "product inputs changed while inspecting blocked component evidence";
        raced = true;
      }
      references.push({ checkId: check.id, receiptDigest: createHash("sha256").update(canonicalJson(prior)).digest("hex"), executionId: prior.executionId, result: prior.result, reuse: prior.reusedFrom ? "reused" : "executed" });
      decisions.push({ checkId: check.id, result: prior.result, decision: "blocked", reason: blocker, inputDigest: prepared.inputDigest, reuseKey: prepared.reuseKey, executionId: prior.executionId, reusedFrom: prior.reusedFrom });
      break;
    }
    let output: CheckEvidence["output"] = original?.output ?? null;
    let result: CheckEvidence["result"] = original ? "passed" : "unavailable";
    let unavailableReason = prepared.reason;
    if (original) {
      try {
        await resolveValidatorComponent(store.projectRoot, check, prepared.inputs.map((input) => input.path));
        const currentRuntime = await resolveComponentRuntime();
        if (canonicalJson(currentRuntime) !== canonicalJson(approval.nativeHost)) throw new Error("current component runtime differs from approved authority; reapproval required");
      } catch (error) {
        result = "unavailable";
        output = null;
        unavailableReason = `validator ${check.id} reuse admission unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (!original && prepared.packet) {
      try {
        const resolved = await resolveValidatorComponent(store.projectRoot, check, prepared.inputs.map((input) => input.path));
        const run = await runComponentValidator(prepared.packet, {
          componentPath: join(resolved.extensionDir, resolved.manifest.runtime!.component),
          componentSha256: check.componentSha256, runtimeIdentity: approval.nativeHost!,
        });
        if (run.inputDigest !== prepared.inputDigest || run.moduleSha256 !== check.componentSha256 ||
            (run.runtime !== null && canonicalJson(run.runtime) !== canonicalJson(approval.nativeHost))) throw new Error("component host/input authority differs from approved evidence");
        result = run.status;
        output = run.output;
        unavailableReason = run.reason;
      } catch (error) { unavailableReason = `validator ${check.id} unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const observationLabel = labelRequired ? await checkObservationLabel(store.projectRoot, plan, approval, prepared.inputs) : undefined;
    const after = await options.observeProduct();
    if (after !== before) {
      raced = true;
      result = "unavailable";
      output = null;
      unavailableReason = `product inputs changed during component ${original ? "reuse attachment" : "execution"}: ${check.id}`;
    }
    const receipt = CheckEvidenceSchema.parse({
      schemaVersion: SCHEMA_VERSION.checkEvidence, checkId: check.id, extensionCheckId: check.extensionCheckId,
      approvalId: approval.approvalId, manifestDigest: assuranceManifestDigest(plan), inputDigest: prepared.inputDigest,
      reuseKey: prepared.reuseKey, inputs: prepared.inputs, moduleSha256: check.componentSha256,
      runtime: approval.nativeHost, parserVersion: prepared.parserVersion, configurationDigest: prepared.configurationDigest,
      result, output, reason: result === "unavailable" ? boundedDiagnostic(unavailableReason ?? `validator ${check.id} unavailable`) : null,
      observationDigest: output ? createHash("sha256").update(canonicalJson(output.observations)).digest("hex") : null,
      executionId: randomUUID(), reusedFrom: original && result === "passed" && !raced ? original.executionId : null, recordedAt: new Date().toISOString(),
      ...(observationLabel ? { observationLabel } : {}),
    });
    references.push({ checkId: check.id, receiptDigest: createHash("sha256").update(canonicalJson(receipt)).digest("hex"), executionId: receipt.executionId, result: receipt.result, reuse: receipt.reusedFrom ? "reused" : "executed" });
    if (result !== "passed") blocker = receipt.reason ?? `validator ${check.id} failed`;
    decisions.push({ checkId: check.id, result, decision: result === "unavailable" ? "blocked" : original ? "reuse" : "execute", reason: blocker ?? reason, inputDigest: prepared.inputDigest, reuseKey: prepared.reuseKey, executionId: receipt.executionId, reusedFrom: receipt.reusedFrom });
    await options.persist(receipt, aggregate());
    if (blocker) break;
  }
  if (await options.observeProduct() !== options.productFingerprint) {
    blocker = "product inputs changed at component-stage completion";
    raced = true;
  }
  return { execution: aggregate(), blocker, decisions, raced };
}

export async function writeAssuranceCheck(store: LegionStore, receipt: CheckEvidence, execution: AssuranceExecution): Promise<void> {
  const checked = CheckEvidenceSchema.parse(receipt);
  const historyPath = `.legion-cli/workflow/checks/${checked.checkId}/${createHash("sha256").update(checked.executionId).digest("hex")}.yaml`;
  if (await store.pathExists(historyPath)) throw new Error("component execution receipt is immutable");
  await store.writeYaml(historyPath, checked);
  await store.writeYaml(`.legion-cli/workflow/checks/${checked.checkId}.yaml`, checked);
  await store.writeYaml(ASSURANCE_EXECUTION_PATH, AssuranceExecutionSchema.parse(execution));
}

export async function inspectAssuranceEvidence(store: LegionStore, state: AssuranceState, acceptanceIds: readonly string[], informationFlowPosture: AssuranceStatus["informationFlow"]): Promise<AssuranceEvidenceReport> {
  const plan = state.manifest;
  const approval = state.approval;
  if (!plan || !approval || state.status?.status === "invalid") return {
    adopted: Boolean(state.status), approvalId: approval?.approvalId ?? null, manifestDigest: state.fingerprint ?? null,
    policyStatus: state.status ? "blocked" : "not-adopted", traceStatus: state.status ? "incomplete" : "not-adopted",
    criteria: acceptanceIds.map((acceptanceId) => ({ acceptanceId, status: "unknown", unitIds: [], taskIds: [], checkIds: [], observations: [] })),
    units: [], checks: [], blocker: state.status?.blocker ?? null,
  };
  const labelRequired = plan.security.mode === "information-flow";
  const decisions: AssuranceCheckDecision[] = [];
  const receipts = new Map<string, CheckEvidence>();
  const bindingMap = new Map<string, KnowledgeBindingResult>();
  const priorReceipts = new Map<string, CheckEvidence | null>();
  const checkUnits = new Map<string, Set<string>>();
  for (const check of plan.validators) {
    const prepared = await prepareAssuranceCheck(store.projectRoot, plan, approval, check);
    for (const binding of prepared.bindings) bindingMap.set(binding.status === "bound" ? binding.input.unitId : binding.unitId, binding);
    const { prior, original, reason } = await checkPriorEvidence(store, approval, check, prepared);
    priorReceipts.set(check.id, prior);
    checkUnits.set(check.id, new Set(prepared.bindings.map((binding) => binding.status === "bound" ? binding.input.unitId : binding.unitId)));
    const matching = prior?.reuseKey === prepared.reuseKey ? prior : null;
    const unlabeled = labelRequired && matching !== null && (matching.observationLabel === undefined || (original !== null && original.observationLabel === undefined));
    const current = unlabeled ? null : matching;
    if (current) receipts.set(check.id, current);
    decisions.push({
      checkId: check.id, result: unlabeled ? "unavailable" : current?.result ?? "unknown",
      decision: unlabeled ? "execute" : original ? "reuse" : current && current.result !== "passed" ? "blocked" : "execute",
      reason: unlabeled ? MISSING_OBSERVATION_LABEL : prepared.reason ?? reason, inputDigest: prepared.inputDigest, reuseKey: prepared.reuseKey,
      executionId: matching?.executionId ?? null, reusedFrom: matching?.reusedFrom ?? null,
    });
  }
  const units: AssuranceUnitEvidence[] = [];
  for (const unit of plan.knowledge) {
    const binding = bindingMap.get(unit.id) ?? await bindKnowledgeUnit(store.projectRoot, unit);
    const observed: Extract<CheckEvidence["inputs"][number], { kind: "unit" }>[] = [];
    for (const check of plan.validators) {
      if (!checkUnits.get(check.id)!.has(unit.id)) continue;
      const prior = priorReceipts.get(check.id);
      const input = prior?.inputs.find((entry) => entry.kind === "unit" && entry.unitId === unit.id);
      if (input?.kind === "unit") observed.push(input);
    }
    units.push({
      unitId: unit.id, path: unit.source.path, status: binding.status,
      changed: binding.status === "unknown" || observed.some((input) => binding.status === "bound" && (input.syntaxDigest !== binding.input.syntaxDigest || input.mode !== binding.source.mode)),
      reason: binding.status === "unknown" ? boundedDiagnostic(binding.reason) : null,
      syntaxDigest: binding.status === "bound" ? binding.input.syntaxDigest : null,
      observedFileDigest: binding.source.sha256, mode: binding.source.mode,
      acceptanceIds: unit.acceptanceIds, taskIds: unit.taskIds,
      checkIds: plan.validators.filter((check) => checkUnits.get(check.id)!.has(unit.id)).map((check) => check.id),
      dependsOn: unit.dependsOn,
    });
  }
  const criteria: AssuranceCriterionEvidence[] = acceptanceIds.map((acceptanceId) => {
    const linkedUnits = units.filter((unit) => unit.acceptanceIds.includes(acceptanceId));
    const checks = plan.validators.filter((check) => check.acceptanceIds.includes(acceptanceId) || linkedUnits.some((unit) => unit.checkIds.includes(check.id)));
    const observations = checks.flatMap((check) => {
      const receipt = receipts.get(check.id);
      const disclose = receipt?.observationLabel?.confidentiality === "public";
      return (receipt?.output?.observations ?? []).map((observation) => ({
        checkId: check.id, id: observation.id, status: observation.status, code: observation.code,
        ...(disclose && observation.detail !== undefined ? { detail: observation.detail } : {}),
      }));
    });
    const failed = checks.some((check) => receipts.get(check.id)?.result === "failed");
    const unknown = !checks.length || linkedUnits.some((unit) => unit.status === "unknown") || checks.some((check) => receipts.get(check.id)?.result !== "passed");
    return { acceptanceId, status: failed ? "failed" : unknown ? "unknown" : "covered", unitIds: linkedUnits.map((unit) => unit.unitId), taskIds: [...new Set(linkedUnits.flatMap((unit) => unit.taskIds))].sort(), checkIds: checks.map((check) => check.id), observations };
  });
  const aggregate = await readAssuranceExecution(store);
  if (aggregate?.approvalId === approval.approvalId && aggregate.manifestDigest === approval.manifestDigest) {
    for (const [index, reference] of aggregate.checks.entries()) {
      if (reference.checkId !== plan.validators[index]?.id) throw new Error("assurance execution checks differ from approved manifest order");
      const receipt = await readCheckReceipt(store, reference.checkId, reference.executionId);
      if (!receipt || reference.receiptDigest !== createHash("sha256").update(canonicalJson(receipt)).digest("hex") ||
          receipt.approvalId !== approval.approvalId || receipt.manifestDigest !== approval.manifestDigest ||
          reference.result !== receipt.result || reference.reuse !== (receipt.reusedFrom ? "reused" : "executed")) throw new Error(`assurance execution references invalid component evidence: ${reference.checkId}`);
    }
  }
  return {
    adopted: true, approvalId: approval.approvalId, manifestDigest: assuranceManifestDigest(plan),
    policyStatus: plan.security.mode === "adapter-default" ? "not-enforced" : informationFlowPosture === "enforced" ? "enforced" : "blocked", traceStatus: "incomplete",
    criteria, units, checks: decisions,
    blocker: decisions.find((check) => check.decision === "blocked")?.reason ?? units.find((unit) => unit.status === "unknown")?.reason ??
      (decisions.some((check) => check.decision === "execute") ? "component evidence is missing or stale; execute the approved component stage" :
        !aggregate || aggregate.approvalId !== approval.approvalId || aggregate.manifestDigest !== approval.manifestDigest ||
            aggregate.checks.length !== plan.validators.length || aggregate.checks.some((reference) => receipts.get(reference.checkId)?.executionId !== reference.executionId)
          ? "current assurance execution sidecar is missing; execute the approved stages"
          : ASSURANCE_TRACE_PREREQUISITE),
  };
}

export function assuranceImpact(report: AssuranceEvidenceReport, plan: AssurancePlan | null): AssuranceImpactReport {
  const paths = new Set([...report.units.filter((unit) => unit.changed).map((unit) => unit.path),
    ...(plan?.validators.filter((check) => report.checks.some((decision) => decision.checkId === check.id && decision.decision !== "reuse")).flatMap((check) => check.inputFiles) ?? [])]);
  return { ...report, impacts: [...paths].sort().map((path) => {
    const affected = new Set(report.units.filter((unit) => unit.path === path).map((unit) => unit.unitId));
    let changed = true;
    while (changed) {
      changed = false;
      for (const unit of report.units) {
        if (!affected.has(unit.unitId) && unit.dependsOn.some((id) => affected.has(id))) { affected.add(unit.unitId); changed = true; }
      }
    }
    const units = report.units.filter((unit) => affected.has(unit.unitId));
    const checkIds = [...new Set([...units.flatMap((unit) => unit.checkIds), ...(plan?.validators.filter((check) => check.inputFiles.includes(path)).map((check) => check.id) ?? [])])];
    return { path, unitIds: units.map((unit) => unit.unitId), taskIds: [...new Set([...units.flatMap((unit) => unit.taskIds), ...report.units.filter((unit) => unit.checkIds.some((id) => checkIds.includes(id))).flatMap((unit) => unit.taskIds)])].sort(), checkIds,
      acceptanceIds: report.criteria.filter((criterion) => criterion.checkIds.some((id) => checkIds.includes(id)) || criterion.unitIds.some((id) => affected.has(id))).map((criterion) => criterion.acceptanceId) };
  }) };
}
