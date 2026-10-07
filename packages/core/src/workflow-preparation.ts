import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { assertNoLinkInPath, type LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import {
  WorkflowPreparationSchema, WorkflowStageIdSchema, WORKFLOW_STAGE_FIELDS,
  isConcretePosixRepoRelativePath, isShortNameSegment, normalizePathKey,
  type WorkflowPreparation, type WorkflowStageId, type PreparationArtifact,
  type Spec, type Task, type IntentSourceBinding, type PlanningDecision, type SpecChallengeChange,
} from "@9thlevelsoftware/legion-cli-schema";
import { challengeInputPathAllowed } from "./spec-challenge-inputs.js";
import { planningBlockers, readIntentSource } from "./planning-assistance.js";

export type PreparationContext = {
  spec: Spec; gate: "spec" | "plan" | "ship"; tasks?: Task[]; verificationCommands?: string[];
  assuranceValidatorIds?: string[]; checkSourceInputs?: boolean;
  intentSource?: IntentSourceBinding; planningDecisions?: PlanningDecision[];
};
export type PreparationBlocker = { stage: string; code: string; message: string; next: string };
export type PreparationStage = { stage: WorkflowStageId; decision: "required" | "not_applicable"; status: "missing" | "stale" | "blocked" | "complete" | "not_applicable" };
export type PreparationValidation = {
  record: WorkflowPreparation | null; blockers: PreparationBlocker[]; stages: PreparationStage[];
  specFingerprint?: string; planFingerprint?: string;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
/** Hash captured identities, never refresh source bytes as a side effect of approval. */
export function preparationInputFingerprint(inputs: readonly { path: string; digest: string }[]): string {
  const unique = new Map(inputs.map((input) => [`${input.path}\0${input.digest}`, input]));
  return fingerprint([...unique.values()].sort((a, b) => a.path.localeCompare(b.path) || a.digest.localeCompare(b.digest)));
}
function recordPath(specId: string): string {
  if (isShortNameSegment(specId) || specId.includes("/") || !isConcretePosixRepoRelativePath(specId)) throw new Error("invalid preparation specification identity");
  return `.legion-cli/workflow/${specId}/preparation.yaml`;
}
export async function readWorkflowPreparation(store: LegionStore, specId: string): Promise<WorkflowPreparation | null> {
  const path = recordPath(specId);
  if (!(await store.pathExists(path))) return null;
  const absolute = join(store.projectRoot, ...path.split("/"));
  await assertNoLinkInPath(absolute, { root: store.projectRoot });
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error("preparation metadata must be a regular unaliased file of at most 1 MiB");
  return store.readYaml(path, WorkflowPreparationSchema);
}
/** The engine caller owns the mutation/audit boundary and lock. */
export async function writeWorkflowPreparation(store: LegionStore, record: WorkflowPreparation): Promise<void> {
  if (!store.holdsLock()) throw new Error("preparation writes require the engine lock");
  const parsed = WorkflowPreparationSchema.parse(record);
  await store.writeYaml(recordPath(parsed.assessment.specId), parsed);
}

/** Update only the reference index for acceptance added by a replay-validated challenge. */
export function projectChallengeAcceptanceReferences(
  record: WorkflowPreparation, base: Spec, applied: Spec, changes: readonly SpecChallengeChange[],
): WorkflowPreparation {
  if (record.assessment.specId !== base.id || applied.id !== base.id || base.workflowPolicyVersion !== 2 || applied.workflowPolicyVersion !== 2) {
    throw new Error("challenge preparation identity does not match its specification");
  }
  const originalIds = new Set(base.acceptance.map((criterion) => criterion.id));
  for (const criterion of base.acceptance) {
    const retained = applied.acceptance.find((candidate) => candidate.id === criterion.id);
    if (!retained || fingerprint(retained) !== fingerprint(criterion)) {
      throw new Error("challenge cannot replace existing acceptance references");
    }
  }
  const added = applied.acceptance.filter((criterion) => !originalIds.has(criterion.id));
  const additions = changes.filter((change) => change.section === "acceptance" && change.appliedId && !originalIds.has(change.appliedId));
  if (added.length !== additions.length || new Set(added.map((criterion) => criterion.id)).size !== added.length || added.some((criterion) =>
    !additions.some((change) => change.appliedId === criterion.id && change.statement === criterion.statement &&
      (change.kind === undefined || change.kind === criterion.kind) && (change.priority === undefined || change.priority === criterion.priority)))) {
    throw new Error("challenge acceptance references were not derived from its validated application");
  }
  const requirements = record.specArtifacts.filter((artifact) => artifact.stage === "requirements");
  if (requirements.length !== 1 || !requirements[0].fields.acceptanceIds?.trim()) throw new Error("challenge requires one existing requirements reference index");
  return { ...record, specArtifacts: record.specArtifacts.map((artifact) => artifact.stage === "requirements"
    ? { ...artifact, fields: { ...artifact.fields, acceptanceIds: added.length
      ? `${artifact.fields.acceptanceIds}\n${added.map((criterion) => criterion.id).join("\n")}` : artifact.fields.acceptanceIds } }
    : artifact) };
}
function artifactPathAllowed(record: WorkflowPreparation, artifact: PreparationArtifact): boolean {
  const base = artifact.stage === "context" || artifact.stage === "requirements"
    ? `.legion-cli/specs/${record.assessment.specId}/preparation/` : `.legion-cli/plans/${record.assessment.specId}/`;
  return artifact.path.startsWith(base) && isConcretePosixRepoRelativePath(artifact.path) && challengeInputPathAllowed(artifact.path);
}
async function digestFile(store: LegionStore, path: string): Promise<string> {
  if (!challengeInputPathAllowed(path)) throw new Error(`unsafe preparation input ${path}`);
  const absolute = join(store.projectRoot, ...path.split("/"));
  await assertNoLinkInPath(absolute, { root: store.projectRoot });
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error(`preparation input must be a regular unaliased file of at most 4 MiB: ${path}`);
    const bytes = await handle.readFile();
    if (bytes.length > 4 * 1024 * 1024) throw new Error(`preparation input grew beyond 4 MiB: ${path}`);
    return createHash("sha256").update(bytes).digest("hex");
  } finally { await handle.close(); }
}
export async function bindPreparationArtifacts(store: LegionStore, input: WorkflowPreparation): Promise<WorkflowPreparation> {
  const record = WorkflowPreparationSchema.parse(input);
  const bind = async (artifact: PreparationArtifact): Promise<PreparationArtifact> => {
    if (!artifactPathAllowed(record, artifact)) throw new Error(`artifact outside its stage's draft root: ${artifact.path}`);
    return { ...artifact, digest: await digestFile(store, artifact.path) };
  };
  return { ...record, assessment: { ...record.assessment, inputFingerprint: preparationInputFingerprint(record.specArtifacts.flatMap((artifact) => artifact.inputs)) },
    specArtifacts: await Promise.all(record.specArtifacts.map(bind)), planArtifacts: await Promise.all(record.planArtifacts.map(bind)) };
}

export function validateWorkflowPreparation(input: WorkflowPreparation | null, context: PreparationContext): PreparationValidation {
  const result: PreparationValidation = { record: null, blockers: [], stages: [] };
  if (context.spec.workflowPolicyVersion !== 2) return result;
  const block = (stage: string, code: string, message: string, next = context.gate === "spec" ? "legion-cli spec" : "legion-cli plan"): void => { result.blockers.push({ stage, code, message, next }); };
  if (!input) { block("context", "missing", "Preparation is missing for this specification", "legion-cli spec"); return result; }
  const parsed = WorkflowPreparationSchema.safeParse(input);
  if (!parsed.success) { block("context", "invalid", `Invalid preparation record: ${parsed.error.message}`, "legion-cli spec"); return result; }
  const record = parsed.data;
  result.record = record;
  const { importedAt: _importedAt, ...sourceIdentity } = context.intentSource ?? {};
  const decisions = (context.planningDecisions ?? []).map((decision) => ({ ...decision, resolution: decision.resolution ? { ...decision.resolution, resolvedAt: undefined } : undefined }));
  result.specFingerprint = fingerprint({ assessment: record.assessment, specArtifacts: record.specArtifacts, knowledge: record.knowledge,
    ...(context.intentSource ? { intentSource: sourceIdentity } : {}), ...(decisions.length ? { decisions } : {}) });
  result.planFingerprint = fingerprint({ specFingerprint: result.specFingerprint, planArtifacts: record.planArtifacts, acceptanceMappings: record.acceptanceMappings,
    strategy: record.strategy, comparisons: record.comparisons, testingMethods: record.testingMethods });
  if (record.assessment.specId !== context.spec.id) block("context", "identity", "Preparation belongs to a different specification", "legion-cli spec");
  if (record.assessment.inputFingerprint !== preparationInputFingerprint(record.specArtifacts.flatMap((artifact) => artifact.inputs))) block("context", "input_identity", "Preparation input fingerprint does not match its captured inputs", "legion-cli spec");
  for (const unresolved of record.assessment.unresolvedDecisions) block("requirements", "unresolved", `Resolve preparation decision: ${unresolved}`, "legion-cli spec");
  const stageDecisions = new Map(record.assessment.stageDecisions.map((decision) => [decision.stage, decision]));
  if (stageDecisions.size !== record.assessment.stageDecisions.length) block("context", "duplicate", "Preparation contains duplicate stage decisions", "legion-cli spec");
  const allArtifacts = [...record.specArtifacts, ...record.planArtifacts];
  const byStage = new Map(allArtifacts.map((artifact) => [artifact.stage, artifact]));
  if (byStage.size !== allArtifacts.length) block("context", "duplicate_artifact", "Each stage must have at most one artifact binding");
  for (const artifact of record.specArtifacts) if (!["context", "requirements"].includes(artifact.stage)) block(artifact.stage, "wrong_gate", "Specification artifacts may contain only context and requirements");
  for (const artifact of record.planArtifacts) if (["context", "requirements"].includes(artifact.stage)) block(artifact.stage, "wrong_gate", "Plan artifacts cannot replace specification artifacts");
  const declaredInputs = new Map<string, string>();
  for (const artifact of allArtifacts) {
    if (!artifactPathAllowed(record, artifact)) block(artifact.stage, "unsafe_path", `Artifact outside its permitted draft root: ${artifact.path}`);
    for (const input of artifact.inputs) {
      if (!challengeInputPathAllowed(input.path)) block(artifact.stage, "unsafe_input", `Unsafe preparation input: ${input.path}`);
      if (/^\.legion-cli\/specs\/[^/]+\/spec\.md$/.test(normalizePathKey(input.path))) block(artifact.stage, "authority_input", "SPEC.md is separately approval-bound and cannot be a byte-bound preparation source");
      const key = normalizePathKey(input.path);
      if (declaredInputs.has(key) && declaredInputs.get(key) !== input.digest) block(artifact.stage, "conflicting_input", `Conflicting input digests: ${input.path}`);
      declaredInputs.set(key, input.digest);
    }
  }
  const boundReferences = new Set([...declaredInputs.keys(), ...allArtifacts.map((artifact) => normalizePathKey(artifact.path)), ...(record.knowledge ?? []).map((input) => normalizePathKey(input.path))]);
  for (const stage of WorkflowStageIdSchema.options) {
    const decision = stageDecisions.get(stage);
    if (!decision) { block(stage, "missing_decision", `Select applicability for ${stage}`, "legion-cli spec"); result.stages.push({ stage, decision: "required", status: "missing" }); continue; }
    if (!decision.evidenceRefs.length) block(stage, "ungrounded", `${stage} needs evidence references or an explicitly labeled assumption`, "legion-cli spec");
    for (const reference of decision.evidenceRefs) {
      if (/^assumption:\s*\S/i.test(reference)) continue;
      const path = reference.split("#", 1)[0];
      if (path && ["spec.md", normalizePathKey(`.legion-cli/specs/${context.spec.id}/SPEC.md`)].includes(normalizePathKey(path))) continue;
      if (!path || !challengeInputPathAllowed(path) || !boundReferences.has(normalizePathKey(path))) block(stage, "unbound_reference", `${stage} references unbound evidence ${reference}; bind the input or label the assumption`, "legion-cli spec");
    }
    if (["context", "requirements"].includes(stage) && decision.decision !== "required") block(stage, "mandatory", `${stage} cannot be skipped`, "legion-cli spec");
    const artifact = byStage.get(stage);
    if (decision.decision === "not_applicable") {
      if (artifact) block(stage, "skipped_producer", `${stage} is skipped but still supplies an artifact`);
      result.stages.push({ stage, decision: decision.decision, status: "not_applicable" }); continue;
    }
    const needed = context.gate !== "spec" || stage === "context" || stage === "requirements";
    if (!artifact && needed) block(stage, "missing_artifact", `Complete the required ${stage} preparation`);
    if (artifact) {
      for (const field of WORKFLOW_STAGE_FIELDS[stage]) if (!artifact.fields[field]?.trim()) block(stage, "missing_field", `${stage} is missing ${field}`);
      if (stage === "requirements") {
        const ids = new Set(artifact.fields.acceptanceIds?.split(/[\s,;]+/).filter(Boolean));
        for (const criterion of context.spec.acceptance) if (!ids.has(criterion.id)) block(stage, "criterion_reference", `Requirements must reference acceptance ${criterion.id}`, "legion-cli spec");
        for (const id of ids) if (!context.spec.acceptance.some((criterion) => criterion.id === id)) block(stage, "criterion_reference", `Unknown requirements acceptance reference ${id}`, "legion-cli spec");
      }
      if (stage !== "context" && stage !== "requirements") for (const producer of record.specArtifacts) {
        if (!artifact.inputs.some((input) => normalizePathKey(input.path) === normalizePathKey(producer.path) && input.digest === producer.digest)) block(stage, "missing_dependency", `${stage} must consume the approved ${producer.stage} artifact`);
      }
    }
    result.stages.push({ stage, decision: decision.decision, status: artifact ? "complete" : "missing" });
  }
  // Explicit artifact dependencies may not point to stale identities or cycles.
  const byPath = new Map(allArtifacts.map((artifact) => [normalizePathKey(artifact.path), artifact]));
  const seen = new Set<string>(); const active = new Set<string>();
  const visit = (artifact: PreparationArtifact): void => {
    if (active.has(artifact.stage)) { block(artifact.stage, "cycle", `Preparation dependency cycle at ${artifact.stage}`); return; }
    if (seen.has(artifact.stage)) return;
    active.add(artifact.stage);
    for (const input of artifact.inputs) {
      const producer = byPath.get(normalizePathKey(input.path));
      if (normalizePathKey(input.path) === normalizePathKey(artifact.path)) block(artifact.stage, "cycle", `Preparation artifact cannot consume itself: ${artifact.path}`);
      else if (producer) {
        if (producer.digest !== input.digest) block(artifact.stage, "stale_dependency", `${artifact.stage} consumes stale ${producer.stage} preparation`);
        visit(producer);
      }
    }
    active.delete(artifact.stage); seen.add(artifact.stage);
  };
  allArtifacts.forEach(visit);
  try {
    for (const message of planningBlockers(context.planningDecisions ?? [], context.gate === "spec" ? [] : record.comparisons ?? [])) block("requirements", "planning_decision", message, context.gate === "spec" ? "legion-cli spec --explore" : "legion-cli plan --compare");
  } catch (error) { block("requirements", "invalid_decisions", String(error)); }
  if (context.gate !== "spec") validatePlan(record, context, block);
  return refreshStages(result);
}

function validatePlan(record: WorkflowPreparation, context: PreparationContext, block: (stage: string, code: string, message: string, next?: string) => void): void {
  const tasks = (context.tasks ?? []).filter((task) => task.specId === context.spec.id);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const criteria = new Map(context.spec.acceptance.map((criterion) => [criterion.id, criterion]));
  const mapped = new Set<string>();
  if (!tasks.length || !criteria.size) block("acceptance", "empty_scope", "Plan requires tasks and acceptance criteria");
  for (const mapping of record.acceptanceMappings) {
    const criterion = criteria.get(mapping.criterionId);
    if (mapped.has(mapping.criterionId)) block("acceptance", "duplicate_mapping", `Duplicate acceptance mapping ${mapping.criterionId}`);
    mapped.add(mapping.criterionId);
    if (!criterion) block("acceptance", "unknown_criterion", `Unknown acceptance criterion ${mapping.criterionId}`);
    if (mapping.notApplicableWhen !== criterion?.notApplicableWhen) block("acceptance", "scope_condition", `Non-applicability for ${mapping.criterionId} must match the approved specification`);
    if (!mapping.taskIds.length || new Set(mapping.taskIds).size !== mapping.taskIds.length) block("acceptance", "task_coverage", `${mapping.criterionId} needs unique responsible task IDs`);
    for (const taskId of mapping.taskIds) if (!taskById.has(taskId)) block("acceptance", "unknown_task", `${mapping.criterionId} references unknown task ${taskId}`);
    if (new Set(mapping.methods.map((method) => method.id)).size !== mapping.methods.length) block("acceptance", "duplicate_method", `Duplicate evidence method for ${mapping.criterionId}`);
    for (const method of mapping.methods) {
      const prefix = `${mapping.criterionId}/${method.id}`;
      if (method.kind === "task_check" && (!method.taskId || !mapping.taskIds.includes(method.taskId) || !method.command || !taskById.get(method.taskId)?.contract.verificationCommands.some((command) => command.trim() === method.command!.trim()))) block("acceptance", "unknown_check", `${prefix} must reference an approved check on a responsible task`);
      if (method.kind === "integration_check" && (!method.command || !(context.verificationCommands ?? []).some((command) => command.trim() === method.command!.trim()))) block("acceptance", "unknown_check", `${prefix} references an unplanned integration check`);
      if (method.kind === "assurance" && (!method.validatorId || !(context.assuranceValidatorIds ?? []).includes(method.validatorId))) block("acceptance", "unknown_validator", `${prefix} references an unadopted assurance validator`);
      if ((method.kind === "manual" || method.kind === "external") && !method.procedure?.trim()) block("acceptance", "missing_procedure", `${prefix} requires a concrete evidence procedure`);
    }
  }
  for (const id of criteria.keys()) if (!mapped.has(id)) block("acceptance", "unmapped", `Plan evidence for acceptance ${id}`);
  const strategy = record.strategy;
  if (strategy) {
    const outcomeIds = new Set<string>(); const coveredCriteria = new Set<string>(); const coveredTasks = new Set<string>();
    if (!strategy.outcomes.length) block("strategy", "empty_outcomes", "Selected strategy requires planned outcomes");
    for (const outcome of strategy.outcomes) {
      if (outcomeIds.has(outcome.id)) block("strategy", "duplicate_outcome", `Duplicate outcome ${outcome.id}`);
      outcomeIds.add(outcome.id);
      for (const id of outcome.acceptanceIds) { coveredCriteria.add(id); if (!criteria.has(id)) block("strategy", "unknown_criterion", `Outcome ${outcome.id} references unknown criterion ${id}`); }
      for (const id of outcome.taskIds) { coveredTasks.add(id); if (!taskById.has(id)) block("strategy", "unknown_task", `Outcome ${outcome.id} references unknown task ${id}`); }
    }
    for (const id of criteria.keys()) if (!coveredCriteria.has(id)) block("strategy", "uncovered_criterion", `Strategy does not cover ${id}`);
    for (const id of taskById.keys()) if (!coveredTasks.has(id)) block("strategy", "uncovered_task", `Strategy does not cover task ${id}`);
    if (strategy.kind === "risk-first") {
      if (!strategy.risk || !taskById.has(strategy.risk.probeTaskId)) block("strategy", "risk_probe", "Risk-first planning needs an uncertainty and an existing probe task");
      else {
        const dependsOn = (taskId: string, probe: string, seen = new Set<string>()): boolean => {
          if (seen.has(taskId)) return false; seen.add(taskId);
          return (taskById.get(taskId)?.blockedBy ?? []).some((id) => id === probe || dependsOn(id, probe, seen));
        };
        for (const id of strategy.risk.dependentTaskIds) if (!taskById.has(id) || id === strategy.risk.probeTaskId || !dependsOn(id, strategy.risk.probeTaskId)) block("strategy", "risk_order", `Risk-dependent task ${id} must depend on probe ${strategy.risk.probeTaskId}`);
      }
    }
    if (strategy.kind === "expand-contract") {
      if (!strategy.migration) block("strategy", "migration", "Expand/contract planning needs compatibility, transition and retirement prerequisites");
      else {
        for (const id of strategy.migration.retirementTaskIds) if (!taskById.has(id)) block("strategy", "unknown_retirement", `Unknown retirement task ${id}`);
        if (strategy.migration.retirementTaskIds.length && !strategy.migration.prerequisites.length) block("strategy", "retirement_evidence", "Retirement requires captured consumer transition evidence; otherwise defer retirement to a later increment");
      }
    }
  }
  const testingTasks = new Set<string>();
  for (const method of record.testingMethods ?? []) {
    if (!taskById.has(method.taskId) || testingTasks.has(method.taskId)) block("testing", "task_reference", `Testing method needs a unique existing task: ${method.taskId}`);
    testingTasks.add(method.taskId);
  }
}

function refreshStages(result: PreparationValidation): PreparationValidation {
  for (const stage of result.stages) {
    const blockers = result.blockers.filter((blocker) => blocker.stage === stage.stage);
    if (blockers.length) stage.status = blockers.some((blocker) => blocker.code.startsWith("stale")) ? "stale" : blockers.some((blocker) => blocker.code.startsWith("missing")) ? "missing" : "blocked";
  }
  return result;
}
/** Inspect a proposal before committing it; read-only and never upgrades approval. */
export async function inspectPreparationRecord(store: LegionStore, record: WorkflowPreparation, context: PreparationContext): Promise<PreparationValidation> {
  const result = validateWorkflowPreparation(record, context);
  if (!result.record) return result;
  const current = result.record;
  const block = (stage: string, code: string, message: string): void => { result.blockers.push({ stage, code, message, next: stage === "context" || stage === "requirements" ? "legion-cli spec" : "legion-cli plan" }); };
  const verify = async (stage: string, input: { path: string; digest: string }): Promise<void> => {
    try { if (await digestFile(store, input.path) !== input.digest) block(stage, "stale_input", `Preparation input changed: ${input.path}`); }
    catch (error) { block(stage, "missing_input", `Cannot read preparation input ${input.path}: ${String(error)}`); }
  };
  const artifacts = [...current.specArtifacts, ...(context.gate === "spec" ? [] : current.planArtifacts)];
  const artifactPaths = new Set(artifacts.map((artifact) => normalizePathKey(artifact.path)));
  for (const artifact of artifacts) {
    await verify(artifact.stage, artifact);
    for (const input of artifact.inputs) if (context.checkSourceInputs || artifactPaths.has(normalizePathKey(input.path))) await verify(artifact.stage, input);
  }
  for (const input of current.knowledge ?? []) {
    await verify("requirements", input);
    if (normalizePathKey(input.path).startsWith(".legion-cli/wiki/")) {
      try { if ((await store.readWikiPage(input.path)).data.trust !== "reviewed") block("requirements", "unreviewed_knowledge", `Knowledge must be reviewed before reuse: ${input.path}`); }
      catch { block("requirements", "invalid_knowledge", `Knowledge page is unavailable or lacks reviewed provenance: ${input.path}`); }
    }
  }
  for (const decision of context.planningDecisions ?? []) for (const evidence of decision.evidence) {
    if (evidence.path && evidence.digest && context.checkSourceInputs) await verify("requirements", { path: evidence.path, digest: evidence.digest });
    else if (evidence.path && !evidence.digest) block("requirements", "unbound_evidence", `Decision ${decision.id} has an unbound evidence path`);
  }
  if (context.gate !== "spec") for (const input of current.strategy?.migration?.prerequisites ?? []) await verify("delivery-handoff", input);
  if (context.intentSource && context.checkSourceInputs) {
    try {
      const source = await readIntentSource(store.projectRoot, context.intentSource.path);
      if (source.binding.digest !== context.intentSource.digest) block("requirements", "stale_source", "Imported brief changed; review its changes before approval");
    } catch (error) { block("requirements", "missing_source", `Imported brief unavailable: ${String(error)}`); }
  }
  return refreshStages(result);
}
export async function inspectWorkflowPreparation(store: LegionStore, context: PreparationContext): Promise<PreparationValidation> {
  if (context.spec.workflowPolicyVersion !== 2) return { record: null, blockers: [], stages: [] };
  try {
    const record = await readWorkflowPreparation(store, context.spec.id);
    return record ? inspectPreparationRecord(store, record, context) : validateWorkflowPreparation(null, context);
  } catch (error) {
    return { record: null, stages: [], blockers: [{ stage: "context", code: "invalid_record", message: `Preparation record cannot be read: ${String(error)}`, next: "legion-cli spec" }] };
  }
}
