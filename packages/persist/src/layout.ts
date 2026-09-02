import { join } from "node:path";

export const LEGION_DIR = ".legion-cli";
export const INDEX_DB_BASENAME = "legion-cli.db";
export const LOCK_BASENAME = "engine.lock";

export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
export const MAX_INGEST_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_INGEST_TREE_BYTES = 64 * 1024 * 1024;

export type LegionPaths = {
  root: string;
  projectMd: string;
  stateMd: string;
  contextMd: string;
  configYaml: string;
  wikiDir: string;
  wikiReadme: string;
  topicsYaml: string;
  intentAnswers: string;
  decisionsDir: string;
  assumptionsDir: string;
  specsDir: string;
  discussMd: string;
  plansDir: string;
  tasksDir: string;
  packetsDir: string;
  qaDir: string;
  designDir: string;
  auditDir: string;
  indexDir: string;
  db: string;
  lock: string;
  cacheDir: string;
  runsDir: string;
  worktreesDir: string;
};

export function legionPaths(projectRoot: string): LegionPaths {
  const root = join(projectRoot, LEGION_DIR);
  const indexDir = join(root, "index");
  return {
    root,
    projectMd: join(root, "PROJECT.md"),
    stateMd: join(root, "STATE.md"),
    contextMd: join(root, "CONTEXT.md"),
    configYaml: join(root, "config.yaml"),
    wikiDir: join(root, "wiki"),
    wikiReadme: join(root, "wiki", "README.md"),
    topicsYaml: join(root, "wiki", "topics.yaml"),
    intentAnswers: join(root, "wiki", "product", "intent-answers.yaml"),
    decisionsDir: join(root, "decisions"),
    assumptionsDir: join(root, "assumptions"),
    specsDir: join(root, "specs"),
    discussMd: join(root, "discuss", "DISCUSS.md"),
    plansDir: join(root, "plans"),
    tasksDir: join(root, "tasks"),
    packetsDir: join(root, "packets"),
    qaDir: join(root, "qa"),
    designDir: join(root, "design"),
    auditDir: join(root, "audit"),
    indexDir,
    db: join(indexDir, INDEX_DB_BASENAME),
    lock: join(indexDir, LOCK_BASENAME),
    cacheDir: join(root, "cache"),
    runsDir: join(root, "runs"),
    worktreesDir: join(root, "worktrees"),
  };
}

export function specPath(specId: string): string {
  return `.legion-cli/specs/${specId}/SPEC.md`;
}

export function taskPath(taskId: string): string {
  return `.legion-cli/tasks/${taskId}.md`;
}

export function packetPath(packetId: string): string {
  return `.legion-cli/packets/${packetId}.md`;
}

export function assumptionPath(id: string): string {
  return `.legion-cli/assumptions/${id}.md`;
}

export function decisionPath(fileName: string): string {
  const base = fileName.endsWith(".md") ? fileName : `${fileName}.md`;
  return `.legion-cli/decisions/${base}`;
}

export function ingestReceiptPath(id: string): string {
  return `.legion-cli/audit/ingest-${id}.md`;
}

export function wikiPageStorePath(sourcePosix: string): string {
  const trimmed = sourcePosix.replace(/^\/+/, "");
  const withMd = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
  return `.legion-cli/wiki/ingested/${withMd}`;
}

export function runStorePath(runId: string): string {
  return `.legion-cli/runs/${runId}`;
}

export function runResumePath(runId: string): string {
  return `.legion-cli/runs/${runId}/resume.json`;
}

export function runPagePath(runId: string, fileName: string): string {
  return `.legion-cli/runs/${runId}/${fileName}`;
}

export function worktreeStorePath(runId: string): string {
  return `.legion-cli/worktrees/${runId}`;
}

export function wikiRunPagePath(runId: string, fileName: string): string {
  return `.legion-cli/wiki/runs/${runId}/${fileName}`;
}
