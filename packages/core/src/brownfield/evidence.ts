import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { runCommand } from "@9thlevelsoftware/legion-cli-agents";
import { FingerprintFileSchema, type FingerprintFile } from "@9thlevelsoftware/legion-cli-schema";
import { gardenReport } from "@9thlevelsoftware/legion-cli-wiki";
import {
  PathEscapeError,
  redactSecrets,
  toProjectRelativePosix,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";
import type { BrownfieldEvidenceOptions, BrownfieldEvidenceResult } from "../types.js";
import { runAbs, runArtifactPaths } from "./paths.js";
import { assertBrownfieldReady, readRun } from "./state.js";

/**
 * Pre-collected, deterministic evidence that specialists verify rather than trust.
 * Carried over from the effort 2–5 rigor ladder (#90); docs evidence reads `legion-cli map`
 * fingerprints when they exist and never runs the map itself. Writes under `evidence/`,
 * never `analysis/`, so `merge` never mistakes it for specialist output.
 */

/** Hung `pnpm audit` must not hold the engine lock forever. */
const AUDIT_TIMEOUT_MS = 60_000;
const VISIT_CAP = 5_000;
const LIST_CAP = 200;
const GAP_CAP = 50;
const MAX_DEPTH = 8;
const SECRET_FILE_CAP = 2_000;
const SECRET_FILE_MAX_BYTES = 1024 * 1024;

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
]);

const SKIP_LEGION_CHILDREN = new Set(["index", "cache", "worktrees", "runs", "map", "sandbox", "chat", "skills"]);

const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|cs|php|swift|c|cc|cpp|h|hpp)$/i;

/** Same regexes as persist redact; findings must never re-emit the secret. */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "sk-proj", re: /\bsk-proj-[A-Za-z0-9_-]{8,}/g },
  { name: "sk-ant", re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: "sk", re: /\bsk-[A-Za-z0-9]{20,}/g },
  { name: "xai", re: /\bxai-[A-Za-z0-9]{20,}/g },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "ghp", re: /ghp_[A-Za-z0-9]+/g },
  { name: "github_pat", re: /github_pat_[A-Za-z0-9_]+/g },
];

export function isTestFile(rel: string, name: string): boolean {
  const parts = rel.replaceAll("\\", "/").split("/");
  if (parts.includes("tests") || parts.includes("__tests__")) return true;
  if (/\.test\.[^.]+$/i.test(name) || /\.spec\.[^.]+$/i.test(name)) return true;
  if (/^test_.+\.py$/i.test(name) || /_test\.py$/i.test(name)) return true;
  return /_test\.go$/i.test(name);
}

export type Evidence = { sources: string[]; tests: string[]; sourceCount: number; testCount: number };

export async function collectEvidence(projectRoot: string): Promise<Evidence> {
  const sources: string[] = [];
  const tests: string[] = [];
  let sourceCount = 0;
  let testCount = 0;
  let visited = 0;

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (visited >= VISIT_CAP || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited >= VISIT_CAP) return;
      visited += 1;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (rel === ".legion-cli" && SKIP_LEGION_CHILDREN.has(entry.name)) continue;
        await walk(join(dir, entry.name), childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isTestFile(childRel, entry.name)) {
        testCount += 1;
        tests.push(childRel);
      } else if (SOURCE_RE.test(entry.name) && !childRel.startsWith(".legion-cli/")) {
        sourceCount += 1;
        sources.push(childRel);
      }
    }
  }

  await walk(projectRoot, "", 0);
  return { sources, tests, sourceCount, testCount };
}

export async function detectTestRunners(projectRoot: string, tests: readonly string[]): Promise<string[]> {
  const runners: string[] = [];
  try {
    const raw = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as { scripts?: { test?: unknown } };
    if (typeof raw.scripts?.test === "string" && raw.scripts.test.trim()) {
      runners.push(`package.json scripts.test: ${redactSecrets(raw.scripts.test.trim())}`);
    }
  } catch {
    // no package.json
  }
  if (existsSync(join(projectRoot, "pytest.ini"))) runners.push("pytest.ini");
  try {
    const pyproject = await readFile(join(projectRoot, "pyproject.toml"), "utf8");
    if (pyproject.includes("[tool.pytest")) runners.push("pyproject.toml [tool.pytest]");
  } catch {
    // no pyproject
  }
  if (existsSync(join(projectRoot, "go.mod")) && tests.some((path) => path.endsWith("_test.go"))) {
    runners.push("go.mod + *_test.go");
  }
  if (existsSync(join(projectRoot, "Cargo.toml"))) runners.push("Cargo.toml");
  return runners;
}

function sourceStem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}

/** Heuristic: a test with the same stem next to the source, in `__tests__/`, or mirrored under `tests/`. */
export function sourceHasNearbyTest(source: string, tests: readonly string[]): boolean {
  const posix = source.replaceAll("\\", "/");
  const sourceDir = dirname(posix).replaceAll("\\", "/");
  const base = sourceStem(posix);
  const withoutSrc = sourceDir.replace(/(^|\/)src(?=\/|$)/, "$1tests").replace(/^\//, "") || "tests";
  const nearbyDirs = new Set([
    sourceDir,
    sourceDir === "." ? "__tests__" : `${sourceDir}/__tests__`,
    sourceDir === "." ? "tests" : `tests/${sourceDir}`,
    sourceDir === "." ? "tests" : `tests/${sourceDir.replace(/^src\/?/, "")}`,
    withoutSrc,
    "test",
    "tests",
  ]);
  return tests.some((path) => {
    const p = path.replaceAll("\\", "/");
    const testDir = dirname(p).replaceAll("\\", "/");
    if (!nearbyDirs.has(testDir)) return false;
    const name = basename(p);
    if (name === `${base}_test.go` || name === `${base}_test.py` || name === `test_${base}.py`) return true;
    return /\.(test|spec)\.[^.]+$/i.test(name) && name.replace(/\.(test|spec)\.[^.]+$/i, "") === base;
  });
}

function bullets(items: readonly string[], empty: string, total?: number): string {
  if (items.length === 0) return `- ${empty}`;
  const shown = items.slice(0, LIST_CAP).map((item) => `- ${item}`);
  const count = total ?? items.length;
  if (count > shown.length) shown.push(`- … ${count - shown.length} more`);
  return shown.join("\n");
}

export function renderTestsMd(input: {
  runners: string[];
  tests: string[];
  testCount: number;
  gaps: string[];
  gapTotal: number;
  sourceCount: number;
}): string {
  return [
    "# Evidence: tests",
    "",
    "Deterministic heuristics collected by `legion-cli brownfield evidence`. Verify before citing;",
    "a nearby test file is not proof that behavior is tested.",
    "",
    "## Runners",
    bullets(input.runners, "(none detected)"),
    "",
    `## Test files (${input.testCount})`,
    bullets(input.tests, "(no test files found)", input.testCount),
    "",
    `## Source files with no nearby test (${input.gapTotal} of ${input.sourceCount})`,
    bullets(input.gaps, "(none)", input.gapTotal),
    "",
  ].join("\n");
}

type SecretFinding = { path: string; kind: string };

export async function scanSecretFindings(projectRoot: string): Promise<{ findings: SecretFinding[]; truncated: boolean }> {
  const findings: SecretFinding[] = [];
  let filesSeen = 0;
  let truncated = false;

  async function walk(dir: string, rel: string): Promise<void> {
    if (findings.length >= LIST_CAP || filesSeen >= SECRET_FILE_CAP) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (findings.length >= LIST_CAP) return;
      if (filesSeen >= SECRET_FILE_CAP) {
        truncated = true;
        return;
      }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      // Junctions/symlinks can escape the project; do not follow or record them.
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (rel === ".legion-cli" && SKIP_LEGION_CHILDREN.has(entry.name)) continue;
        await walk(abs, childRel);
        continue;
      }
      if (!st.isFile()) continue;
      filesSeen += 1;
      if (st.size > SECRET_FILE_MAX_BYTES) continue;
      let text: string;
      try {
        const buf = await readFile(abs);
        if (buf.byteLength > SECRET_FILE_MAX_BYTES || buf.includes(0)) continue;
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      let path: string;
      try {
        path = toProjectRelativePosix(projectRoot, abs);
      } catch (err) {
        if (err instanceof PathEscapeError) continue;
        continue;
      }
      for (const pattern of SECRET_PATTERNS) {
        pattern.re.lastIndex = 0;
        if (pattern.re.test(text)) findings.push({ path, kind: pattern.name });
      }
    }
  }

  await walk(projectRoot, "");
  if (filesSeen >= SECRET_FILE_CAP) truncated = true;
  return { findings, truncated };
}

export function parseAuditNames(stdout: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!json || typeof json !== "object") return [];
  const names = new Set<string>();
  const rec = json as Record<string, unknown>;
  if (rec.vulnerabilities && typeof rec.vulnerabilities === "object") {
    for (const key of Object.keys(rec.vulnerabilities as object)) names.add(key);
  }
  if (rec.advisories && typeof rec.advisories === "object") {
    for (const value of Object.values(rec.advisories as object)) {
      const moduleName = (value as { module_name?: unknown } | null)?.module_name;
      if (typeof moduleName === "string") names.add(moduleName);
    }
  }
  return [...names].sort();
}

function looksLikeAuditError(stdout: string): boolean {
  try {
    const json = JSON.parse(stdout) as { error?: unknown };
    return Boolean(json && typeof json === "object" && json.error);
  } catch {
    return stdout.trim().length > 0;
  }
}

/** Stdout-only JSON parse so stderr warnings cannot hide vulnerability names. */
export function formatAuditLines(input: {
  lockfile: string;
  bin: string;
  stdout: string;
  timedOut?: boolean;
  error?: string;
  status?: number | null;
}): string[] {
  if (input.timedOut) return [`lockfile: ${input.lockfile}`, "audit timed out (60s)"];
  if (input.error) return [`lockfile: ${input.lockfile}`, `audit skipped: ${input.bin} (${input.error})`];
  const names = parseAuditNames(input.stdout);
  const failed =
    (input.status !== undefined && input.status !== null && input.status !== 0) ||
    (names.length === 0 && looksLikeAuditError(input.stdout));
  const lines = [`lockfile: ${input.lockfile}`, `command: ${input.bin} audit --json`];
  if (failed && names.length === 0) {
    lines.push(`audit failed (exit ${input.status ?? "unknown"})`);
    return lines;
  }
  lines.push(names.length === 0 ? "packages: (none named)" : `packages: ${names.join(", ")}`);
  return lines;
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function pathIsInside(candidate: string, root: string): boolean {
  let candAbs = resolve(candidate);
  let rootAbs = resolve(root);
  try {
    candAbs = realpathSync(candAbs);
  } catch {
    // lexical fallback
  }
  try {
    rootAbs = realpathSync(rootAbs);
  } catch {
    // lexical fallback
  }
  const rel = relative(rootAbs, candAbs).replaceAll("\\", "/");
  if (rel === "" || rel === ".") return true;
  if (rel === ".." || rel.startsWith("../") || /^[A-Za-z]:/.test(rel) || rel.startsWith("/")) return false;
  return true;
}

/** PATH lookup that never returns a binary inside the project or the cwd (cmd.exe cwd-search RCE). */
export function resolveAuditBin(name: string, projectRoot: string): string | null {
  const root = resolve(projectRoot);
  const cwd = resolve(process.cwd());
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
      : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || dir === ".") continue;
    const absDir = resolve(dir);
    if (pathIsInside(absDir, root) || samePath(absDir, cwd)) continue;
    for (const ext of exts) {
      const candidate = join(absDir, ext ? `${name}${ext}` : name);
      if (!existsSync(candidate) || pathIsInside(candidate, root)) continue;
      return candidate;
    }
  }
  return null;
}

export function quoteCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\t\r\n "]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}

async function runLockfileAudit(projectRoot: string, runId: string): Promise<{ lines: string[]; ran: boolean }> {
  const pnpmLock = existsSync(join(projectRoot, "pnpm-lock.yaml"));
  const npmLock = existsSync(join(projectRoot, "package-lock.json"));
  if (!pnpmLock && !npmLock) return { lines: ["no audit (no lockfile)"], ran: false };
  const bin = pnpmLock ? "pnpm" : "npm";
  const lockfile = pnpmLock ? "pnpm-lock.yaml" : "package-lock.json";
  const argv = pnpmLock ? ["audit", "--json", "--ignore-pnpmfile"] : ["audit", "--json"];
  const resolved = resolveAuditBin(bin, projectRoot);
  if (!resolved) return { lines: formatAuditLines({ lockfile, bin, stdout: "", error: `${bin} not on PATH` }), ran: false };
  const logDir = join(projectRoot, ".legion-cli", "cache", "brownfield", runId);
  const stdoutPath = join(logDir, "audit.stdout.log");
  // The shared runner (KD-4). The user's own registry auth is needed, so the env is inherited.
  const result = await runCommand([resolved, ...argv], {
    cwd: projectRoot,
    env: "inherit",
    envOverrides: { NoDefaultCurrentDirectoryInExePath: "1", npm_config_ignore_scripts: "true" },
    timeoutMs: AUDIT_TIMEOUT_MS,
    logPath: stdoutPath,
    stderrPath: join(logDir, "audit.stderr.log"),
  });
  if (result.timedOut) return { lines: formatAuditLines({ lockfile, bin, stdout: "", timedOut: true }), ran: true };
  if (!result.started) {
    return { lines: formatAuditLines({ lockfile, bin, stdout: "", error: result.error ?? "did not start" }), ran: false };
  }
  let stdout = "";
  try {
    stdout = await readFile(stdoutPath, "utf8");
  } catch {
    stdout = "";
  }
  return { lines: formatAuditLines({ lockfile, bin, stdout, status: result.exitCode }), ran: true };
}

export function renderSecurityMd(findings: SecretFinding[], auditLines: string[], truncated = false): string {
  const secretLines =
    findings.length > 0
      ? findings.map((hit) => `- \`${hit.path}\` (${hit.kind}): [REDACTED:${hit.kind}]`).join("\n")
      : truncated
        ? "- (truncated; scan stopped at file cap)"
        : "- (none)";
  return [
    "# Evidence: security",
    "",
    "Deterministic heuristics collected by `legion-cli brownfield evidence`. Verify before citing.",
    "",
    "## Secret patterns",
    ...(truncated ? [`- scan truncated at ${SECRET_FILE_CAP} files`] : []),
    secretLines,
    "",
    "## Dependency audit",
    ...auditLines.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

/** Map fingerprints from `legion-cli map`, pruned to modules that still exist. Undefined when absent or invalid. */
async function readFingerprints(projectRoot: string): Promise<FingerprintFile | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(projectRoot, ".legion-cli", "map", "fingerprints.json"), "utf8"));
    const parsed = FingerprintFileSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    return { ...parsed.data, modules: parsed.data.modules.filter((m) => existsSync(join(projectRoot, m.path))) };
  } catch {
    return undefined;
  }
}

/** A module counts as documented if a same-stem .md, a README in its dir, or docs/<stem>.md exists. */
export function moduleHasNearbyDoc(modulePath: string, projectRoot: string): boolean {
  const dir = dirname(modulePath).replaceAll("\\", "/");
  const stem = basename(modulePath).replace(/\.[^.]+$/, "");
  const prefix = dir === "." ? "" : `${dir}/`;
  return [`${prefix}${stem}.md`, `${prefix}README.md`, `docs/${stem}.md`, `docs/${prefix}${stem}.md`].some((p) =>
    existsSync(join(projectRoot, ...p.split("/"))),
  );
}

export function renderDocsMd(input: {
  readme: string | null;
  fingerprints: boolean;
  orphans: Array<{ path: string; title: string }>;
  undocumented: string[];
  undocumentedTotal: number;
}): string {
  return [
    "# Evidence: docs",
    "",
    "Deterministic heuristics collected by `legion-cli brownfield evidence`. Verify before citing.",
    "",
    "## README",
    input.readme ? `- present: \`${input.readme}\`` : "- missing",
    "",
    "## Wiki orphans",
    bullets(input.orphans.map((page) => `\`${page.path}\` ${page.title}`), "(none)"),
    "",
    `## Exports without nearby markdown (${input.undocumentedTotal})`,
    input.fingerprints
      ? bullets(input.undocumented, "(none)", input.undocumentedTotal)
      : "- (no map fingerprints; run `legion-cli map` first for this section)",
    "",
  ].join("\n");
}

async function collectDocsEvidence(store: LegionStore): Promise<{ md: string; undocumented: number; mapped: boolean }> {
  const root = store.projectRoot;
  const fingerprints = await readFingerprints(root);
  const undocumented: string[] = [];
  let total = 0;
  for (const module of fingerprints?.modules ?? []) {
    if (moduleHasNearbyDoc(module.path, root)) continue;
    for (const name of module.exports) {
      total += 1;
      if (undocumented.length < LIST_CAP) undocumented.push(`\`${module.path}\` export \`${name}\``);
    }
  }
  let orphans: Array<{ path: string; title: string }> = [];
  try {
    orphans = gardenReport(root).orphans.map((page) => ({ path: page.path, title: page.title }));
  } catch {
    orphans = [{ path: ".legion-cli/index", title: "wiki index unavailable; run legion-cli index rebuild" }];
  }
  const readme = ["README.md", "README", "readme.md"].find((name) => existsSync(join(root, name))) ?? null;
  return {
    md: renderDocsMd({ readme, fingerprints: Boolean(fingerprints), orphans, undocumented, undocumentedTotal: total }),
    undocumented: total,
    mapped: Boolean(fingerprints),
  };
}

export async function evidenceRun(
  store: LegionStore,
  runId: string,
  opts: BrownfieldEvidenceOptions = {},
): Promise<BrownfieldEvidenceResult> {
  await assertBrownfieldReady(store);
  await readRun(store, runId);
  const root = store.projectRoot;
  const evidence = await collectEvidence(root);
  const runners = await detectTestRunners(root, evidence.tests);
  const allGaps = evidence.sources.filter((source) => !sourceHasNearbyTest(source, evidence.tests));
  const testsMd = renderTestsMd({
    runners,
    tests: evidence.tests.slice(0, LIST_CAP),
    testCount: evidence.testCount,
    gaps: allGaps.slice(0, GAP_CAP),
    gapTotal: allGaps.length,
    sourceCount: evidence.sourceCount,
  });
  const secrets = await scanSecretFindings(root);
  const audit = opts.skipAudit
    ? { lines: ["no audit (--skip-audit)"], ran: false }
    : await runLockfileAudit(root, runId);
  const paths = runArtifactPaths(runId);
  await mkdir(runAbs(root, runId, "evidence"), { recursive: true });
  await writeFile(runAbs(root, runId, "evidence", "tests.md"), testsMd, "utf8");
  await writeFile(
    runAbs(root, runId, "evidence", "security.md"),
    renderSecurityMd(secrets.findings, audit.lines, secrets.truncated),
    "utf8",
  );
  const docs = await collectDocsEvidence(store);
  await writeFile(runAbs(root, runId, "evidence", "docs.md"), docs.md, "utf8");
  return {
    runId,
    files: {
      tests: `${paths.evidenceDir}/tests.md`,
      security: `${paths.evidenceDir}/security.md`,
      docs: `${paths.evidenceDir}/docs.md`,
    },
    undocumentedExports: docs.undocumented,
    mapFingerprints: docs.mapped,
    testFiles: evidence.testCount,
    sourceFiles: evidence.sourceCount,
    coverageGaps: allGaps.length,
    runners,
    secretFindings: secrets.findings.length,
    auditRan: audit.ran,
  };
}
