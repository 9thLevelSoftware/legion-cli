import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  AcceptanceReceiptSchema,
  PlanApprovalReceiptSchema,
  SpecApprovalReceiptSchema,
  WorkflowEvidenceReceiptSchema,
  WorkflowClaimSchema,
  type AcceptanceReceipt,
  type LegionConfig,
  type PlanApprovalReceipt,
  type ProjectFile,
  type SpecApprovalReceipt,
  type Spec,
  type Task,
  type WorkflowEvidenceReceipt,
  type WorkflowClaim,
} from "@9thlevelsoftware/legion-cli-schema";
import {
  isGitRepo,
  isPidAlive,
  journaledRemove,
  runGit,
  ownProcessStartedAt,
  processIdentity,
  sameProcessStart,
  toFsPath,
  writeTextFile,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";

export const WORKFLOW_APPROVAL_PATH = ".legion-cli/workflow/plan-approval.yaml";
export const WORKFLOW_SPEC_APPROVAL_PATH = ".legion-cli/workflow/spec-approval.yaml";
export const WORKFLOW_EVIDENCE_PATH = ".legion-cli/workflow/execution.yaml";
export const WORKFLOW_ACCEPTANCE_PATH = ".legion-cli/workflow/acceptance.yaml";
export const WORKFLOW_REVIEW_PATH = ".legion-cli/qa/review.md";
export const WORKFLOW_REVIEW_RECEIPT_PATH = ".legion-cli/workflow/review.md";
export const WORKFLOW_CLAIM_PATH = ".legion-cli/workflow/run-claim.yaml";

type MarkdownValue<T> = { data: T; body: string };

export type WorkflowPlanSnapshot = {
  specId: string;
  planFingerprint: string;
  specFingerprint: string;
  taskFingerprint: string;
  configFingerprint: string;
  taskIds: string[];
  acceptanceIds: string[];
  preparationFingerprint?: string;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

export function workflowFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function workflowEnvironmentFingerprint(): string {
  return workflowFingerprint({ platform: process.platform, arch: process.arch, node: process.version });
}

function approvedTask(task: Task): Omit<Task, "status"> {
  const { status: _status, ...stable } = task;
  return stable;
}

export function createWorkflowPlanSnapshot(input: {
  spec: MarkdownValue<Spec>;
  tasks: Array<MarkdownValue<Task>>;
  planBody: string | null;
  config: LegionConfig;
  project: ProjectFile;
  discoveryContext?: string | null;
  assuranceFingerprint?: string;
  preparationFingerprint?: string;
}): WorkflowPlanSnapshot {
  const tasks = input.tasks
    .filter((entry) => entry.data.specId === input.spec.data.id)
    .sort((left, right) => left.data.id.localeCompare(right.data.id));
  const specFingerprint = workflowFingerprint(input.spec);
  const taskFingerprint = workflowFingerprint(
    tasks.map((entry) => ({ task: approvedTask(entry.data), body: entry.body })),
  );
  const configFingerprint = workflowFingerprint({
    config: input.config,
    project: {
      name: input.project.name,
      mode: input.project.mode,
      brownfieldGoal: input.project.brownfieldGoal,
      controlMode: input.project.controlMode,
    },
  });
  const planFingerprint = workflowFingerprint({
    specFingerprint,
    taskFingerprint,
    configFingerprint,
    planBody: input.planBody,
    discoveryContext: input.discoveryContext ?? null,
    ...(input.assuranceFingerprint !== undefined ? { assuranceFingerprint: input.assuranceFingerprint } : {}),
    ...(input.preparationFingerprint !== undefined ? { preparationFingerprint: input.preparationFingerprint } : {}),
  });
  return {
    specId: input.spec.data.id,
    planFingerprint,
    specFingerprint,
    taskFingerprint,
    configFingerprint,
    taskIds: tasks.map((entry) => entry.data.id),
    acceptanceIds: input.spec.data.acceptance.map((criterion) => criterion.id),
    ...(input.preparationFingerprint !== undefined ? { preparationFingerprint: input.preparationFingerprint } : {}),
  };
}

/** Approval covers every task, independent of its priority; completion evidence must cover that same set. */
export function incompleteApprovedWorkflowTasks(
  approval: Pick<PlanApprovalReceipt, "taskIds">,
  tasks: readonly Task[],
  evidence?: Pick<WorkflowEvidenceReceipt, "completedTaskIds"> | null,
): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return approval.taskIds.filter((id) => {
    const task = byId.get(id);
    return !task || (task.status !== "done" && task.status !== "compacted") ||
      (evidence !== undefined && !evidence?.completedTaskIds.includes(id));
  });
}

export async function readWorkflowDiscoveryContext(projectRoot: string): Promise<string | null> {
  const parts: string[] = [];
  for (const path of [".legion-cli/map/DISCOVERY.md", ".legion-cli/map/selection.json"]) {
    try {
      parts.push(`${path}\n${await readFile(toFsPath(projectRoot, path), "utf8")}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

async function hashProductPath(projectRoot: string, posixPath: string): Promise<unknown> {
  const abs = toFsPath(projectRoot, posixPath);
  let info;
  try {
    info = await lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path: posixPath, kind: "missing" };
    throw err;
  }
  if (info.isSymbolicLink()) {
    return { path: posixPath, kind: "symlink", mode: info.mode, target: await readlink(abs) };
  }
  if (info.isFile()) {
    const content = await readFile(abs);
    return { path: posixPath, kind: "file", mode: info.mode, sha256: createHash("sha256").update(content).digest("hex") };
  }
  if (!info.isDirectory()) return { path: posixPath, kind: "other" };

  const root = resolve(projectRoot);
  const entries: unknown[] = [];
  const walk = async (dir: string): Promise<void> => {
    const names = await readdir(dir, { withFileTypes: true });
    names.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of names) {
      const child = join(dir, entry.name);
      const rel = relative(root, child).split(sep).join("/");
      if (rel === ".git" || rel.startsWith(".git/") || rel === "node_modules" || rel.startsWith("node_modules/")) {
        continue;
      }
      if (rel === ".legion-cli/cache" || rel.startsWith(".legion-cli/cache/")) continue;
      const childInfo = await lstat(child);
      if (childInfo.isSymbolicLink()) {
        entries.push({ path: rel, kind: "symlink", mode: childInfo.mode, target: await readlink(child) });
      } else if (childInfo.isDirectory()) {
        await walk(child);
      } else if (childInfo.isFile()) {
        entries.push({
          path: rel,
          kind: "file",
          mode: childInfo.mode,
          sha256: createHash("sha256").update(await readFile(child)).digest("hex"),
        });
      }
    }
  };
  await walk(abs);
  return { path: posixPath, kind: "directory", entries };
}

function gitPaths(projectRoot: string, args: string[]): string[] {
  const run = runGit(projectRoot, args);
  if (run.status !== 0) throw new Error(run.stderr.trim() || `git ${args.join(" ")} failed`);
  return run.stdout
    .split("\0")
    .map((path) => path.replaceAll("\\", "/"))
    .filter(Boolean);
}

const UNTRACKED_PRODUCT_IGNORES = new Set([
  "node_modules", "target", "dist", "build", "coverage", ".cache", ".next", ".turbo",
]);

function excludedProductPath(path: string, untracked: boolean): boolean {
  if (path === ".legion-cli" || path.startsWith(".legion-cli/")) return true;
  if (path === ".git" || path.startsWith(".git/")) return true;
  if (!untracked) return false;
  return path.split("/").some((part) => UNTRACKED_PRODUCT_IGNORES.has(part));
}

async function nonGitProductPaths(projectRoot: string): Promise<string[]> {
  const out: string[] = [];
  const root = resolve(projectRoot);
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const path = relative(root, abs).split(sep).join("/");
      if (excludedProductPath(path, true)) continue;
      if (entry.isDirectory()) await walk(abs);
      else out.push(path);
    }
  };
  await walk(root);
  return out;
}
export async function workflowProductPaths(projectRoot: string): Promise<string[]> {
  if (isGitRepo(projectRoot)) {
    const tracked = gitPaths(projectRoot, ["ls-files", "-z"]).filter((path) => !excludedProductPath(path, false));
    const untracked = gitPaths(projectRoot, ["ls-files", "-z", "--others", "--exclude-standard"])
      .filter((path) => !excludedProductPath(path, true));
    return [...new Set([...tracked, ...untracked])].sort((left, right) => left.localeCompare(right));
  }
  return nonGitProductPaths(projectRoot);
}

/** Snapshot product inputs and outputs while excluding Legion's own receipts and generated dependency/build trees. */
export async function workflowProductFingerprint(projectRoot: string, _tasks: readonly Task[]): Promise<string> {
  const paths = await workflowProductPaths(projectRoot);
  const values = new Array<unknown>(paths.length);
  let nextPath = 0;
  let failed = false;
  let failure: unknown;
  const hashPaths = async (): Promise<void> => {
    while (!failed) {
      const index = nextPath++;
      if (index >= paths.length) return;
      try {
        values[index] = await hashProductPath(projectRoot, paths[index]!);
      } catch (err) {
        if (!failed) failure = err;
        failed = true;
      }
    }
  };
  // Preserve path order and drain started reads before propagating the first failure.
  await Promise.all(Array.from({ length: Math.min(12, paths.length) }, hashPaths));
  if (failed) throw failure;
  return workflowFingerprint(values);
}

async function readOptional<T>(store: LegionStore, path: string, schema: { parse(value: unknown): T }): Promise<T | null> {
  if (!(await store.pathExists(path))) return null;
  return store.readYaml(path, schema as never);
}

export function readPlanApproval(store: LegionStore): Promise<PlanApprovalReceipt | null> {
  return readOptional(store, WORKFLOW_APPROVAL_PATH, PlanApprovalReceiptSchema);
}

export function readSpecApproval(store: LegionStore): Promise<SpecApprovalReceipt | null> {
  return readOptional(store, WORKFLOW_SPEC_APPROVAL_PATH, SpecApprovalReceiptSchema);
}

export function readWorkflowEvidence(store: LegionStore): Promise<WorkflowEvidenceReceipt | null> {
  return readOptional(store, WORKFLOW_EVIDENCE_PATH, WorkflowEvidenceReceiptSchema);
}

export function readAcceptanceReceipt(store: LegionStore): Promise<AcceptanceReceipt | null> {
  return readOptional(store, WORKFLOW_ACCEPTANCE_PATH, AcceptanceReceiptSchema);
}

/** A claim's holder is live while its PID runs with the recorded start time; an unknown identity counts as live. */
export async function workflowClaimHolderLive(claim: WorkflowClaim): Promise<boolean> {
  if (!isPidAlive(claim.pid)) return false;
  const actualStartedAt = await processIdentity(claim.pid);
  return actualStartedAt === null || sameProcessStart(actualStartedAt, claim.processStartedAt);
}

export async function acquireWorkflowClaim(store: LegionStore): Promise<WorkflowClaim> {
  return store.withLock(async () => {
    const existing = await readOptional(store, WORKFLOW_CLAIM_PATH, WorkflowClaimSchema);
    if (existing && await workflowClaimHolderLive(existing)) {
      throw new Error(`another focused workflow is running (pid ${existing.pid})`);
    }
    const claim = WorkflowClaimSchema.parse({
      schemaVersion: "legion-cli-workflow-claim/v1",
      token: randomUUID(),
      pid: process.pid,
      processStartedAt: ownProcessStartedAt(),
      claimedAt: new Date().toISOString(),
    });
    await store.writeYaml(WORKFLOW_CLAIM_PATH, claim);
    return claim;
  });
}

export async function releaseWorkflowClaim(store: LegionStore, token: string): Promise<void> {
  await store.withLock(async () => {
    const existing = await readOptional(store, WORKFLOW_CLAIM_PATH, WorkflowClaimSchema);
    if (!existing || existing.token !== token) return;
    // Journaled like the claim's write: an unjournaled delete reads as tampering to a later restore of a
    // dead run's command, which would resurrect this released claim and block the next workflow.
    await journaledRemove(store.projectRoot, toFsPath(store.projectRoot, WORKFLOW_CLAIM_PATH));
  });
}

export async function writePlanApproval(store: LegionStore, receipt: PlanApprovalReceipt): Promise<void> {
  await store.writeYaml(WORKFLOW_APPROVAL_PATH, PlanApprovalReceiptSchema.parse(receipt));
}

export async function writeSpecApproval(store: LegionStore, receipt: SpecApprovalReceipt): Promise<void> {
  await store.writeYaml(WORKFLOW_SPEC_APPROVAL_PATH, SpecApprovalReceiptSchema.parse(receipt));
}

export async function writeWorkflowEvidence(store: LegionStore, receipt: WorkflowEvidenceReceipt): Promise<void> {
  await store.writeYaml(WORKFLOW_EVIDENCE_PATH, WorkflowEvidenceReceiptSchema.parse(receipt));
}

export async function writeAcceptanceReceipt(store: LegionStore, receipt: AcceptanceReceipt): Promise<void> {
  await store.writeYaml(WORKFLOW_ACCEPTANCE_PATH, AcceptanceReceiptSchema.parse(receipt));
}

export async function writeWorkflowReviewReport(store: LegionStore, body: string): Promise<{
  verdict: "PASS" | "FAIL";
  evidencePath: string;
  evidenceFingerprint: string;
}> {
  const matches = [...body.matchAll(/^\s*(?:[-*]\s*)?(?:review\s+)?verdict\s*:\s*(PASS|FAIL)\s*$/gim)];
  if (matches.length !== 1) throw new Error("review report must contain exactly one explicit verdict");
  await store.withLock(() => writeTextFile(toFsPath(store.projectRoot, WORKFLOW_REVIEW_RECEIPT_PATH), body, {
    root: store.projectRoot,
  }));
  return {
    verdict: matches[0]?.[1] as "PASS" | "FAIL",
    evidencePath: WORKFLOW_REVIEW_RECEIPT_PATH,
    evidenceFingerprint: createHash("sha256").update(body).digest("hex"),
  };
}

export async function workflowReviewEvidenceFresh(
  projectRoot: string,
  evidence: { evidencePath: string; evidenceFingerprint: string } | null,
): Promise<boolean> {
  if (!evidence || evidence.evidencePath !== WORKFLOW_REVIEW_RECEIPT_PATH) return false;
  try {
    const body = await readFile(toFsPath(projectRoot, evidence.evidencePath));
    return createHash("sha256").update(body).digest("hex") === evidence.evidenceFingerprint;
  } catch {
    return false;
  }
}

export async function readPlanBody(projectRoot: string, specId: string): Promise<string | null> {
  const path = toFsPath(projectRoot, `.legion-cli/plans/${specId}.md`);
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function readExplicitReviewEvidence(projectRoot: string): Promise<{
  verdict: "PASS" | "FAIL";
  evidencePath: string;
  evidenceFingerprint: string;
  body: string;
  modifiedAtMs: number;
} | null> {
  let body: string;
  let modifiedAtMs: number;
  try {
    const path = toFsPath(projectRoot, WORKFLOW_REVIEW_PATH);
    body = await readFile(path, "utf8");
    modifiedAtMs = (await lstat(path)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const matches = [...body.matchAll(/^\s*(?:[-*]\s*)?(?:review\s+)?verdict\s*:\s*(PASS|FAIL)\s*$/gim)];
  if (matches.length !== 1) return null;
  return {
    verdict: matches[0]?.[1] as "PASS" | "FAIL",
    evidencePath: WORKFLOW_REVIEW_PATH,
    evidenceFingerprint: createHash("sha256").update(body).digest("hex"),
    body,
    modifiedAtMs,
  };
}
