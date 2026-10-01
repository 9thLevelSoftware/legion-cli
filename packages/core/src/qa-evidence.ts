import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stableHash } from "@9thlevelsoftware/legion-cli-http";
import { isGitRepo, toFsPath, toPosixPath } from "@9thlevelsoftware/legion-cli-persist";
import { reportFailClosed, scorePersistedReports, specHasUi } from "@9thlevelsoftware/legion-cli-qa";
import { SCHEMA_VERSION, type AnyQAScore, type QAScore, type Spec, type Task } from "@9thlevelsoftware/legion-cli-schema";

const EXCLUDED_SOURCE_DIRS = new Set([
  ".git",
  ".legion-cli",
  "node_modules",
  ".pnpm",
  ".yarn",
  ".venv",
  "__pycache__",
]);

function includedSourcePath(path: string): boolean {
  const parts = toPosixPath(path).split("/");
  return parts.every((part) => !EXCLUDED_SOURCE_DIRS.has(part));
}

async function filesystemSourcePaths(projectRoot: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(relative ? join(projectRoot, relative) : projectRoot, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const path = toPosixPath(relative ? `${relative}/${entry.name}` : entry.name);
      if (!includedSourcePath(path)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) out.push(path);
    }
  };
  await walk("");
  return out;
}

async function sourcePathDigest(projectRoot: string, path: string, modes: readonly string[]): Promise<string | null> {
  const abs = toFsPath(projectRoot, path);
  try {
    const info = await lstat(abs);
    if (info.isSymbolicLink()) {
      return createHash("sha256").update(`symlink\0${modes.join(",")}\0${await readlink(abs)}`, "utf8").digest("hex");
    }
    if (!info.isFile()) {
      return createHash("sha256").update(`non-file\0${info.mode}`, "utf8").digest("hex");
    }
    const hash = createHash("sha256").update(`file\0${modes.join(",")}\0`, "utf8");
    for await (const chunk of createReadStream(abs)) hash.update(chunk);
    return hash.digest("hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function ordinaryModeIdentity(
  projectRoot: string,
  path: string,
  index: readonly string[],
  head: string | undefined,
): Promise<string[]> {
  const parsed = index.flatMap((entry) => {
    const match = entry.match(/^(\d{6}) [a-f0-9]+ (\d)$/);
    return match ? [`${match[1]}:${match[2]}`] : [];
  });
  const headMode = head?.match(/^(\d{6}) \S+ [a-f0-9]+$/)?.[1];
  let info;
  try {
    info = await lstat(toFsPath(projectRoot, path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const currentMode = info?.isSymbolicLink()
    ? "120000"
    : info?.isFile()
      ? process.platform === "win32" || (info.mode & 0o111) === 0
        ? "100644"
        : "100755"
      : undefined;
  const modes = new Set<string>();
  if (currentMode) modes.add(`${currentMode}:0`);
  for (const entry of parsed) {
    const [mode, stage] = entry.split(":");
    if (stage !== "0" || !currentMode || (headMode && mode !== headMode) || !headMode) modes.add(entry);
  }
  if (modes.size === 0 && headMode) modes.add(`${headMode}:0`);
  return [...modes].sort();
}

type RepositorySource = {
  paths: string[];
  indexEntries: Map<string, string[]>;
  headEntries: Map<string, string>;
};

async function repositorySource(projectRoot: string): Promise<RepositorySource> {
  if (!isGitRepo(projectRoot)) {
    return { paths: await filesystemSourcePaths(projectRoot), indexEntries: new Map(), headEntries: new Map() };
  }
  const index = spawnSync("git", ["ls-files", "-s", "-z"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  const others = spawnSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  const head = spawnSync("git", ["ls-tree", "-r", "-z", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (index.status !== 0 || others.status !== 0) {
    throw new Error(index.stderr?.trim() || others.stderr?.trim() || "git ls-files failed while computing source identity");
  }
  const indexEntries = new Map<string, string[]>();
  for (const raw of index.stdout.split("\0")) {
    if (!raw) continue;
    const tab = raw.indexOf("\t");
    if (tab < 0) throw new Error("git ls-files returned malformed index metadata");
    const metadata = raw.slice(0, tab);
    const path = toPosixPath(raw.slice(tab + 1));
    if (!path || !includedSourcePath(path)) continue;
    const entries = indexEntries.get(path) ?? [];
    entries.push(metadata);
    indexEntries.set(path, entries);
  }
  const paths = new Set(indexEntries.keys());
  const headEntries = new Map<string, string>();
  if (head.status === 0) {
    for (const raw of head.stdout.split("\0")) {
      if (!raw) continue;
      const tab = raw.indexOf("\t");
      if (tab < 0) throw new Error("git ls-tree returned malformed metadata");
      const metadata = raw.slice(0, tab);
      const path = toPosixPath(raw.slice(tab + 1));
      if (!path || !includedSourcePath(path)) continue;
      headEntries.set(path, metadata);
      paths.add(path);
    }
  }
  for (const raw of others.stdout.split("\0")) {
    const path = toPosixPath(raw);
    if (path && includedSourcePath(path)) paths.add(path);
  }
  return { paths: [...paths], indexEntries, headEntries };
}

async function submoduleSourceDigest(projectRoot: string, path: string, index: readonly string[]): Promise<string> {
  const root = toFsPath(projectRoot, path);
  let head;
  let top;
  try {
    head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
  } catch {
    return stableHash({ index, state: "unavailable" });
  }
  const sameRoot = (left: string, right: string): boolean =>
    process.platform === "win32"
      ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
      : resolve(left) === resolve(right);
  // An uninitialized gitlink directory may otherwise discover the parent repo.
  // Its index object remains authoritative until a distinct submodule worktree exists.
  if (head.status !== 0 || top.status !== 0 || !sameRoot(top.stdout.trim(), root)) {
    return stableHash({ index, state: "unavailable" });
  }
  return stableHash({ index, head: head.stdout.trim(), source: await projectSourceIdentity(root) });
}

/**
 * Identity of the current project source, including tracked, dirty, staged, and
 * untracked files. Engine state and dependency trees never enter the hash.
 */
export async function projectSourceIdentity(
  projectRoot: string,
  extraPaths: readonly string[] = [],
): Promise<string> {
  const repository = await repositorySource(projectRoot);
  const paths = new Set(repository.paths);
  for (const raw of extraPaths) {
    const path = toPosixPath(raw);
    if (path.length > 0 && includedSourcePath(path) && !path.includes("*")) paths.add(path);
  }
  const records: Array<{ path: string; index: string[]; sha256: string | null }> = [];
  for (const path of [...paths].sort()) {
    const index = [...(repository.indexEntries.get(path) ?? [])].sort();
    const head = repository.headEntries.get(path);
    const isGitlink = index.some((entry) => entry.startsWith("160000 ")) || head?.startsWith("160000 ") === true;
    const gitlinkIndex = index
      .map((entry) => entry.match(/^160000 ([a-f0-9]+) /)?.[1])
      .filter((oid): oid is string => Boolean(oid));
    if (gitlinkIndex.length === 0) {
      const headOid = head?.match(/^160000 \S+ ([a-f0-9]+)$/)?.[1];
      if (headOid) gitlinkIndex.push(headOid);
    }
    const ordinaryModes = isGitlink ? [] : await ordinaryModeIdentity(projectRoot, path, index, head);
    records.push({
      path,
      // Ordinary files are bound to their current bytes, so staging the same
      // bytes must not invalidate QA. Gitlinks have no file bytes; bind their
      // index object and distinct submodule worktree state instead.
      index: isGitlink ? gitlinkIndex.map((oid) => `160000 ${oid}`) : ordinaryModes,
      sha256: isGitlink
        ? await submoduleSourceDigest(projectRoot, path, gitlinkIndex)
        : await sourcePathDigest(projectRoot, path, ordinaryModes),
    });
  }
  return stableHash(records);
}

export async function qaSourceHash(projectRoot: string, _tasks: readonly Task[]): Promise<string> {
  return projectSourceIdentity(projectRoot);
}

export function qaSpecHash(spec: Spec, body: string): string {
  return stableHash({ spec, body });
}

type CaptureReceipt = {
  version: 1;
  kind: "unit" | "playwright";
  capture: { started: boolean; status: number | null; timedOut: boolean; error?: string };
};

function parseCaptureReceipt(raw: unknown, kind: CaptureReceipt["kind"]): CaptureReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || record.kind !== kind || !record.capture || typeof record.capture !== "object") return null;
  const capture = record.capture as Record<string, unknown>;
  if (
    typeof capture.started !== "boolean" ||
    (capture.status !== null && (typeof capture.status !== "number" || !Number.isInteger(capture.status))) ||
    typeof capture.timedOut !== "boolean" ||
    (capture.error !== undefined && typeof capture.error !== "string")
  ) return null;
  return raw as CaptureReceipt;
}

function captureFailed(receipt: CaptureReceipt): boolean {
  return !receipt.capture.started || receipt.capture.timedOut || receipt.capture.status !== 0;
}

async function readJson(projectRoot: string, path: string): Promise<unknown> {
  return JSON.parse(await readFile(toFsPath(projectRoot, path), "utf8"));
}

async function reconstructQaScore(
  projectRoot: string,
  spec: Spec,
  score: QAScore,
): Promise<QAScore | null> {
  const prefix = `.legion-cli/qa/runs/${score.id}/`;
  const unitPath = `${prefix}unit.json`;
  const unitMetaPath = `${prefix}unit.meta.json`;
  const expected = new Set([unitPath, unitMetaPath]);
  let unitReport: unknown;
  let unitReceipt: CaptureReceipt | null;
  try {
    unitReport = await readJson(projectRoot, unitPath);
    unitReceipt = parseCaptureReceipt(await readJson(projectRoot, unitMetaPath), "unit");
  } catch {
    return null;
  }
  if (!unitReceipt) return null;

  const needsPlaywright = score.mode === "full" && specHasUi(spec);
  let playwrightReport: unknown;
  let playwrightReceipt: CaptureReceipt | null = null;
  let playwrightRan = false;
  if (needsPlaywright) {
    const reportPath = `${prefix}playwright.json`;
    const metaPath = `${prefix}playwright.meta.json`;
    expected.add(reportPath);
    expected.add(metaPath);
    try {
      playwrightReport = await readJson(projectRoot, reportPath);
      playwrightReceipt = parseCaptureReceipt(await readJson(projectRoot, metaPath), "playwright");
    } catch {
      return null;
    }
    if (!playwrightReceipt) return null;
    playwrightRan = !captureFailed(playwrightReceipt) && Boolean(playwrightReport && typeof playwrightReport === "object");
  }

  let manualPassedCriterionIds: string[] | undefined;
  if (score.mode === "no-browser") {
    const manualPath = `${prefix}manual.json`;
    expected.add(manualPath);
    try {
      const raw = await readJson(projectRoot, manualPath);
      if (!raw || typeof raw !== "object") return null;
      const receipt = raw as Record<string, unknown>;
      if (
        receipt.version !== 1 ||
        receipt.kind !== "manual" ||
        receipt.specId !== spec.id ||
        !Array.isArray(receipt.passedCriterionIds) ||
        receipt.passedCriterionIds.some((id) => typeof id !== "string")
      ) return null;
      manualPassedCriterionIds = [...new Set(receipt.passedCriterionIds as string[])].sort();
    } catch {
      return null;
    }
  }

  if (score.evidencePaths.length !== expected.size || score.evidencePaths.some((path) => !expected.has(path))) return null;
  const unitFailed = captureFailed(unitReceipt) || reportFailClosed(unitReport);
  const playwrightFailed = playwrightReceipt
    ? captureFailed(playwrightReceipt) || !playwrightRan || reportFailClosed(playwrightReport)
    : false;
  const reportFailures = Number(unitFailed) + Number(playwrightFailed);
  return scorePersistedReports({
    spec,
    mode: score.mode,
    playwrightRan,
    unitReport,
    playwrightReport,
    id: score.id,
    createdAt: score.createdAt,
    evidencePaths: score.evidencePaths,
    failClosed: reportFailures > 0,
    reportFailures,
    specHash: score.specHash,
    sourceHash: score.sourceHash,
    manualPassedCriterionIds,
  });
}

export async function evaluateQaEvidenceFreshness(input: {
  projectRoot: string;
  activeSpecId: string | null | undefined;
  spec: Spec;
  specBody: string;
  tasks: readonly Task[];
  score: AnyQAScore;
}): Promise<{ current: boolean; staleReason: string | null; evidenceValid: boolean }> {
  if (input.score.schemaVersion !== SCHEMA_VERSION.qa) {
    return { current: false, staleReason: "legacy QA scores require recalculation", evidenceValid: false };
  }
  if (!input.activeSpecId || input.score.specId !== input.activeSpecId) {
    return { current: false, staleReason: "QA score is bound to a different spec", evidenceValid: false };
  }
  if (input.score.specHash !== qaSpecHash(input.spec, input.specBody)) {
    return { current: false, staleReason: "SPEC changed after QA", evidenceValid: false };
  }
  let canonical: QAScore | null = null;
  try {
    canonical = await reconstructQaScore(input.projectRoot, input.spec, input.score);
  } catch {
    canonical = null;
  }
  if (!canonical || stableHash(canonical) !== stableHash(input.score)) {
    return { current: false, staleReason: "QA score does not match its persisted evidence", evidenceValid: false };
  }
  if (input.score.sourceHash !== (await qaSourceHash(input.projectRoot, input.tasks))) {
    return { current: false, staleReason: "project source changed after QA", evidenceValid: true };
  }
  return { current: true, staleReason: null, evidenceValid: true };
}
