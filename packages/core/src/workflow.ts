import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, readlink, rm } from "node:fs/promises";
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
  });
  return {
    specId: input.spec.data.id,
    planFingerprint,
    specFingerprint,
    taskFingerprint,
    configFingerprint,
    taskIds: tasks.map((entry) => entry.data.id),
    acceptanceIds: input.spec.data.acceptance.map((criterion) => criterion.id),
  };
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

/** Snapshot product inputs and outputs while excluding Legion's own receipts and generated dependency/build trees. */
export async function workflowProductFingerprint(projectRoot: string, _tasks: readonly Task[]): Promise<string> {
  let paths: string[];
  if (isGitRepo(projectRoot)) {
    const tracked = gitPaths(projectRoot, ["ls-files", "-z"]).filter((path) => !excludedProductPath(path, false));
    const untracked = gitPaths(projectRoot, ["ls-files", "-z", "--others", "--exclude-standard"])
      .filter((path) => !excludedProductPath(path, true));
    paths = [...new Set([...tracked, ...untracked])].sort((left, right) => left.localeCompare(right));
  } else {
    paths = await nonGitProductPaths(projectRoot);
  }
  const values: unknown[] = [];
  for (const path of paths) values.push(await hashProductPath(projectRoot, path));
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

export async function acquireWorkflowClaim(store: LegionStore): Promise<WorkflowClaim> {
  return store.withLock(async () => {
    const existing = await readOptional(store, WORKFLOW_CLAIM_PATH, WorkflowClaimSchema);
    if (existing && isPidAlive(existing.pid)) {
      const actualStartedAt = await processIdentity(existing.pid);
      if (actualStartedAt === null || sameProcessStart(actualStartedAt, existing.processStartedAt)) {
        throw new Error(`another focused workflow is running (pid ${existing.pid})`);
      }
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
    await rm(toFsPath(store.projectRoot, WORKFLOW_CLAIM_PATH), { force: true });
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
