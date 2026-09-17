import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  gitWorktreeAdd,
  isGitRepo,
  PathEscapeError,
  PersistError,
  redactSecrets,
  runPagePath,
  runResumePath,
  toProjectRelativePosix,
  tryGitHead,
  WIKI_PAGE_SCHEMA_VERSION,
  wikiRunPagePath,
  worktreeStorePath,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  BrownfieldRunIdSchema,
  BrownfieldRunSchema,
  FingerprintFileSchema,
  SCHEMA_VERSION,
  type BrownfieldRun,
  type FingerprintFile,
} from "@9thlevelsoftware/legion-cli-schema";
import { gardenReport } from "@9thlevelsoftware/legion-cli-wiki";
import { HINT, refuse } from "./errors.js";
import type { MapResult } from "./map.js";
import type { BrownfieldEffort, BrownfieldOptions, BrownfieldResult, PromoteRunOptions, PromoteRunResult } from "./types.js";

export const BROWNFIELD_PAGES = [
  "intent.md",
  "assumptions.md",
  "architecture.md",
  "code.md",
  "analysis.md",
  "design.md",
] as const;

/** Same 60s cap as map LSP — hung `pnpm audit` must not hold the engine forever. */
const AUDIT_TIMEOUT_MS = 60_000;
const WALK_CAP = 80;
const SECRET_FILE_CAP = 200;
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
]);

const SKIP_LEGION_CHILDREN = new Set(["index", "cache", "worktrees", "runs", "map", "sandbox", "chat", "skills"]);

/** Same regexes as `packages/cli/src/secrets.ts` / persist redact — findings must not re-emit the secret. */
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

function nowIso(): string {
  return new Date().toISOString();
}

function newRunId(): string {
  return randomBytes(4).toString("hex");
}

function isEffort(n: number): n is BrownfieldEffort {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5;
}

function parseEffort(raw: number | undefined): BrownfieldEffort {
  const effort = raw ?? 1;
  if (!Number.isInteger(effort) || !isEffort(effort)) {
    refuse("brownfield --effort must be 1–5", HINT.brownfield);
  }
  return effort;
}

function asEffort(n: number): BrownfieldEffort {
  if (!isEffort(n)) refuse("brownfield --effort must be 1–5", HINT.brownfield);
  return n;
}

function ladderPages(effort: BrownfieldEffort, mapped: boolean): string[] {
  const pages: string[] = [...BROWNFIELD_PAGES];
  if (effort >= 2) pages.push("tests.md");
  if (effort >= 3) pages.push("security.md");
  if (effort >= 4) pages.push("docs.md");
  if (effort >= 5 && mapped) pages.push("improvement-spec.md");
  return pages;
}

function parseRunId(raw: string): string {
  const parsed = BrownfieldRunIdSchema.safeParse(raw.trim().toLowerCase());
  if (!parsed.success) {
    refuse("brownfield run id must be 8 hex chars", HINT.brownfieldResume);
  }
  return parsed.data;
}

async function writeRunFile(projectRoot: string, storePath: string, body: string): Promise<void> {
  const abs = join(projectRoot, ...storePath.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  const normalized = body.endsWith("\n") ? body : `${body}\n`;
  await writeFile(abs, normalized, "utf8");
}

async function readRunResume(store: LegionStore, runId: string): Promise<BrownfieldRun> {
  const storePath = runResumePath(runId);
  if (!(await store.pathExists(storePath))) {
    refuse(`Cannot resume: run ${runId} not found`, HINT.brownfieldResume);
  }
  const abs = join(store.projectRoot, ...storePath.split("/"));
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(abs, "utf8"));
  } catch {
    refuse("Cannot resume: state file not found or invalid", HINT.brownfieldResume);
  }
  const parsed = BrownfieldRunSchema.safeParse(raw);
  if (!parsed.success || parsed.data.runId !== runId) {
    refuse("Cannot resume: state file not found or invalid", HINT.brownfieldResume);
  }
  return parsed.data;
}

async function writeRunResume(projectRoot: string, run: BrownfieldRun): Promise<void> {
  const storePath = runResumePath(run.runId);
  const abs = join(projectRoot, ...storePath.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

function isTestFile(rel: string, name: string): boolean {
  if (rel === "tests" || rel.startsWith("tests/")) return true;
  if (/\.test\.[^.]+$/i.test(name) || /\.spec\.[^.]+$/i.test(name)) return true;
  return /_test\.go$/i.test(name);
}

type Evidence = {
  layout: string[];
  sources: string[];
  tests: string[];
  markdown: string[];
};

async function collectEvidence(projectRoot: string): Promise<Evidence> {
  const layout: string[] = [];
  const sources: string[] = [];
  const tests: string[] = [];
  const markdown: string[] = [];

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (layout.length + sources.length >= WALK_CAP && tests.length >= WALK_CAP && markdown.length >= WALK_CAP) {
      return;
    }
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (rel === ".legion-cli" && SKIP_LEGION_CHILDREN.has(entry.name)) continue;
        if (depth === 0 && layout.length < WALK_CAP) layout.push(`${childRel}/`);
        await walk(join(dir, entry.name), childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (depth === 0 && layout.length < WALK_CAP) layout.push(childRel);
      if (isTestFile(childRel, entry.name)) {
        if (tests.length < WALK_CAP) tests.push(childRel);
      } else if (
        /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|cs|php)$/i.test(entry.name) ||
        childRel.startsWith("src/")
      ) {
        if (sources.length < WALK_CAP) sources.push(childRel);
      }
      if (/\.md$/i.test(entry.name) && markdown.length < WALK_CAP) markdown.push(childRel);
    }
  }

  await walk(projectRoot, "", 0);
  return { layout, sources, tests, markdown };
}

async function readPackageHint(projectRoot: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      name?: unknown;
      description?: unknown;
    };
    const name = typeof raw.name === "string" ? raw.name : "";
    const description = typeof raw.description === "string" ? raw.description : "";
    return [name, description].filter((part) => part.length > 0).join(" — ");
  } catch {
    return "";
  }
}

async function detectTestRunners(projectRoot: string, tests: readonly string[]): Promise<string[]> {
  const runners: string[] = [];
  try {
    const raw = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      scripts?: { test?: unknown };
    };
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

function sourceHasNearbyTest(source: string, tests: readonly string[]): boolean {
  const base = source.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
  return tests.some((path) => {
    const name = path.replace(/^.*\//, "");
    if (name === `${base}_test.go`) return true;
    return /\.(test|spec)\.[^.]+$/i.test(name) && name.replace(/\.(test|spec)\.[^.]+$/i, "") === base;
  });
}

function renderTestsMd(input: { runners: string[]; tests: string[]; gaps: string[] }): string {
  const runners = input.runners.length > 0 ? input.runners.map((r) => `- ${r}`).join("\n") : "- (none detected)";
  const listed = input.tests.length > 0 ? input.tests.map((p) => `- ${p}`).join("\n") : "- (no test files listed)";
  const gaps =
    input.gaps.length > 0
      ? input.gaps.map((source, i) => {
          const id = `A-T${String(i + 1).padStart(2, "0")}`;
          return `### ${id}\n- **Statement**: \`${source}\` has no nearby test\n- **Status**: needs_confirmation\n`;
        }).join("\n")
      : "- (none)\n";
  return [
    "# Tests",
    "",
    "## Runners",
    runners,
    "",
    "## Test files",
    listed,
    "",
    "## Coverage gaps",
    gaps,
  ].join("\n");
}

type SecretFinding = { path: string; kind: string };

async function scanSecretFindings(projectRoot: string): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  let filesSeen = 0;

  async function walk(dir: string, rel: string): Promise<void> {
    if (findings.length >= WALK_CAP || filesSeen >= SECRET_FILE_CAP) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (findings.length >= WALK_CAP || filesSeen >= SECRET_FILE_CAP) return;
      if (entry.name === "." || entry.name === "..") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      // Junctions/symlinks can escape the project; do not follow or record childRel.
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (rel === ".legion-cli" && SKIP_LEGION_CHILDREN.has(entry.name)) continue;
        await walk(abs, childRel);
        continue;
      }
      if (!st.isFile()) continue;
      filesSeen += 1;
      let text: string;
      try {
        const buf = await readFile(abs);
        if (buf.byteLength > SECRET_FILE_MAX_BYTES) continue;
        if (buf.includes(0)) continue;
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
        if (!pattern.re.test(text)) continue;
        findings.push({ path, kind: pattern.name });
      }
    }
  }

  await walk(projectRoot, "");
  return findings;
}

function parseAuditNames(stdout: string): string[] {
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
      if (value && typeof value === "object" && typeof (value as { module_name?: unknown }).module_name === "string") {
        names.add((value as { module_name: string }).module_name);
      }
    }
  }
  return [...names].sort();
}

/** Stdout-only JSON parse so stderr warnings cannot hide vulnerability names. */
function formatAuditLines(input: {
  lockfile: string;
  bin: string;
  stdout: string;
  stderr?: string;
  timedOut?: boolean;
  error?: string;
}): string[] {
  if (input.timedOut) {
    return [`lockfile: ${input.lockfile}`, "audit timed out (60s)"];
  }
  if (input.error) {
    return [`lockfile: ${input.lockfile}`, `audit skipped: ${input.bin} (${input.error})`];
  }
  const names = parseAuditNames(input.stdout);
  const lines = [`lockfile: ${input.lockfile}`, `command: ${input.bin} audit --json`];
  if (names.length === 0) {
    lines.push("packages: (none named)");
  } else {
    lines.push(`packages: ${names.join(", ")}`);
  }
  return lines;
}

function runLockfileAudit(projectRoot: string): string[] {
  const pnpmLock = existsSync(join(projectRoot, "pnpm-lock.yaml"));
  const npmLock = existsSync(join(projectRoot, "package-lock.json"));
  if (!pnpmLock && !npmLock) {
    return ["no audit (no lockfile)"];
  }
  const bin = pnpmLock ? "pnpm" : "npm";
  const lockfile = pnpmLock ? "pnpm-lock.yaml" : "package-lock.json";
  const argv = ["audit", "--json"];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const spawnOnce = (command: string) =>
    spawnSync(command, argv, {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: AUDIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
  let result = spawnOnce(bin);
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT" && process.platform === "win32") {
    result = spawnOnce(`${bin}.cmd`);
  }
  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
    (result.signal === "SIGKILL" && result.status === null);
  if (timedOut) {
    return formatAuditLines({ lockfile, bin, stdout: "", timedOut: true });
  }
  if (result.error) {
    return formatAuditLines({
      lockfile,
      bin,
      stdout: "",
      error: (result.error as NodeJS.ErrnoException).code ?? result.error.message,
    });
  }
  return formatAuditLines({ lockfile, bin, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
}

function renderSecurityMd(findings: SecretFinding[], auditLines: string[]): string {
  const secretLines =
    findings.length > 0
      ? findings.map((hit) => `- \`${hit.path}\` (${hit.kind}): [REDACTED:${hit.kind}]`).join("\n")
      : "- (none)";
  return [
    "# Security",
    "",
    "## Secrets",
    secretLines,
    "",
    "## Dependency audit",
    ...auditLines.map((line) => (line.startsWith("no audit") ? line : `- ${line}`)),
    "",
  ].join("\n");
}

async function readFingerprints(projectRoot: string): Promise<FingerprintFile | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(projectRoot, ".legion-cli", "map", "fingerprints.json"), "utf8"));
    const parsed = FingerprintFileSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function nearbyMarkdownExists(modulePath: string, markdown: ReadonlySet<string>): boolean {
  const dir = dirname(modulePath).replaceAll("\\", "/");
  const base = modulePath.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
  const dirPrefix = dir === "." ? "" : `${dir}/`;
  const candidates = [
    `${dirPrefix}${base}.md`,
    `${dirPrefix}README.md`,
    `docs/${base}.md`,
    `docs/${dirPrefix}${base}.md`,
  ];
  return candidates.some((path) => markdown.has(path));
}

function renderDocsMd(input: {
  readme: string | null;
  orphans: Array<{ path: string; title: string }>;
  undocumented: string[];
}): string {
  const readme = input.readme ? `- present: \`${input.readme}\`` : "- missing";
  const orphans =
    input.orphans.length > 0
      ? input.orphans.map((page) => `- \`${page.path}\` ${page.title}`).join("\n")
      : "- (none)";
  const undocumented =
    input.undocumented.length > 0
      ? input.undocumented.map((line) => `- ${line}`).join("\n")
      : "- (none, or no fingerprints yet)";
  return [
    "# Docs",
    "",
    "## README",
    readme,
    "",
    "## Wiki orphans",
    orphans,
    "",
    "## Exports without nearby markdown",
    undocumented,
    "",
  ].join("\n");
}

function findReadme(projectRoot: string): string | null {
  for (const name of ["README.md", "README", "readme.md"]) {
    if (existsSync(join(projectRoot, name))) return name;
  }
  return null;
}

function renderPages(input: {
  runId: string;
  name: string;
  effort: BrownfieldEffort;
  context: string;
  execute: boolean;
  packageHint: string;
  layout: string[];
  sources: string[];
}): Record<(typeof BROWNFIELD_PAGES)[number], string> {
  const rawContext = input.context.trim();
  const context = rawContext || "(none)";
  const layout = input.layout.length > 0 ? input.layout.map((p) => `- ${p}`).join("\n") : "- (empty tree)";
  const sources =
    input.sources.length > 0 ? input.sources.map((p) => `- ${p}`).join("\n") : "- (no source files listed)";
  const pkg = input.packageHint || "(no package.json)";
  const outOfScope =
    input.effort === 1
      ? [
          "## Out of scope (effort 1)",
          "- LSP / architecture fingerprints",
          "- Tests, security, and documentation specialists (effort 2+)",
        ]
      : [
          `## Out of scope (effort ${input.effort})`,
          input.effort < 5 ? "- Durable architecture map lives in `.legion-cli/map/` after effort 5" : "- This file is evidence, not a frozen SPEC",
        ];
  return {
    "intent.md": [
      "# Intent brief",
      "",
      `- **Run ID**: ${input.runId}`,
      `- **Project**: ${input.name}`,
      `- **Captured**: ${nowIso()}`,
      `- **Effort level**: ${input.effort}`,
      `- **Execute requested**: ${input.execute}`,
      "",
      "## User Goal",
      context,
      "",
      "## First principles",
      "Existing code is evidence, not ground truth. Effort 1 does not treat observed behavior as intent.",
      "",
      "## Success Criteria",
      "- [ ] Architecture and code evidence captured in this run",
      "- [ ] Improvement SPEC can be written from this run (promote first if the wiki should own it)",
      "",
      ...outOfScope,
      "",
    ].join("\n"),
    "assumptions.md": [
      "# Assumptions register",
      "",
      "## Summary",
      "- **Total assumptions**: 2",
      "- **Needs user confirmation**: 2",
      "",
      "### A-001",
      "- **Statement**: Observed behavior is the intended product contract",
      "- **Evidence**: repository layout (no LSP)",
      "- **Confidence**: low",
      "- **Status**: needs_confirmation",
      "- **Source**: [Architecture]",
      "- **Impact if wrong**: bug",
      "",
      "### A-002",
      "- **Statement**: Current source files represent the system the user can demo",
      "- **Evidence**: listed source paths",
      "- **Confidence**: medium",
      "- **Status**: provisional",
      "- **Source**: [Code]",
      "- **Impact if wrong**: suggestion",
      "",
    ].join("\n"),
    "architecture.md": [
      "# Architecture (effort 1)",
      "",
      "No LSP. Layout from directory evidence only.",
      "",
      `Package: ${pkg}`,
      "",
      "## Top-level",
      layout,
      "",
      "## First-principles ideal",
      "Reconstruct intended architecture from the demo and intent brief, then diff against this layout.",
      "",
    ].join("\n"),
    "code.md": [
      "# Code (effort 1)",
      "",
      "Source files treated as evidence, not ground truth.",
      "",
      sources,
      "",
    ].join("\n"),
    "analysis.md": [
      "# Brownfield analysis findings",
      "",
      ...(rawContext ? [rawContext, ""] : []),
      input.effort === 1
        ? "Effort 1: Architecture + Code only. No LSP."
        : `Effort ${input.effort}: in-process rigor ladder (no brownfield skill spawn).`,
      "",
      "### Architecture Summary",
      `Top-level evidence (${input.layout.length} entries). Existing layering may be accidental.`,
      "",
      "### Code Summary",
      `${input.sources.length} source files listed as evidence.`,
      "",
      "### Assumptions Needing Confirmation",
      "- A-001 Observed behavior is the intended product contract",
      "",
    ].join("\n"),
    "design.md": [
      "# Improvement design",
      "",
      "Gaps from effort-1 architecture + code. Not a frozen SPEC.",
      "",
      "## Recommended next",
      "1. Confirm A-001 / A-002 (code is evidence).",
      `2. \`legion-cli run promote ${input.runId}\` if these pages should live in the wiki (untrusted until wiki trust).`,
      "3. \`legion-cli spec\` for the improvement increment.",
      "",
      "## Execute isolation",
      input.execute
        ? "This run requested `--execute`: product writes go in a git worktree, not the main checkout."
        : "Add `--execute` later (`legion-cli brownfield --resume`) to isolate product writes in a git worktree.",
      "",
    ].join("\n"),
  };
}

async function writeNamedPages(
  projectRoot: string,
  runId: string,
  pages: Record<string, string>,
): Promise<void> {
  for (const [name, body] of Object.entries(pages)) {
    await writeRunFile(projectRoot, runPagePath(runId, name), body);
  }
}

function toResult(run: BrownfieldRun): BrownfieldResult {
  return {
    runId: run.runId,
    effort: asEffort(run.effort),
    execute: run.execute,
    phase: run.phase,
    pages: run.pages,
    worktreePath: run.worktreePath ?? null,
    promoted: run.promoted,
    resumePath: runResumePath(run.runId),
  };
}

async function ensureWorktree(store: LegionStore, run: BrownfieldRun): Promise<BrownfieldRun> {
  const head = tryGitHead(store.projectRoot);
  if (!head) {
    refuse("brownfield --execute requires a git commit (HEAD)", HINT.gitRepo);
  }
  const rel = worktreeStorePath(run.runId);
  const abs = join(store.projectRoot, ".legion-cli", "worktrees", run.runId);
  try {
    gitWorktreeAdd(store.projectRoot, abs, `brownfield/${run.runId}`);
  } catch (err) {
    if (err instanceof PersistError) {
      refuse(err.message, HINT.gitRepo);
    }
    throw err;
  }
  return {
    ...run,
    execute: true,
    phase: "complete",
    preSpawnRef: head,
    worktreePath: rel,
    pages: [...run.pages],
  };
}

async function writeDocsMd(store: LegionStore, runId: string, evidence: Evidence): Promise<void> {
  const fingerprints = await readFingerprints(store.projectRoot);
  const mdSet = new Set(evidence.markdown);
  const undocumented: string[] = [];
  if (fingerprints) {
    for (const module of fingerprints.modules) {
      if (nearbyMarkdownExists(module.path, mdSet)) continue;
      for (const name of module.exports) {
        undocumented.push(`\`${module.path}\` export \`${name}\``);
        if (undocumented.length >= WALK_CAP) break;
      }
      if (undocumented.length >= WALK_CAP) break;
    }
  }
  let orphans: Array<{ path: string; title: string }> = [];
  try {
    orphans = gardenReport(store.projectRoot).orphans.map((page) => ({ path: page.path, title: page.title }));
  } catch {
    orphans = [];
  }
  await writeRunFile(
    store.projectRoot,
    runPagePath(runId, "docs.md"),
    renderDocsMd({
      readme: findReadme(store.projectRoot),
      orphans,
      undocumented,
    }),
  );
}

async function writeLadderExtras(
  store: LegionStore,
  runId: string,
  effort: BrownfieldEffort,
  evidence: Evidence,
  extras: { findings: SecretFinding[]; auditLines: string[] },
): Promise<void> {
  if (effort < 2) return;
  const runners = await detectTestRunners(store.projectRoot, evidence.tests);
  const gaps = evidence.sources.filter((source) => !sourceHasNearbyTest(source, evidence.tests)).slice(0, 20);
  await writeRunFile(store.projectRoot, runPagePath(runId, "tests.md"), renderTestsMd({
    runners,
    tests: evidence.tests,
    gaps,
  }));
  if (effort < 3) return;
  await writeRunFile(
    store.projectRoot,
    runPagePath(runId, "security.md"),
    renderSecurityMd(extras.findings, extras.auditLines),
  );
  if (effort < 4) return;
  await writeDocsMd(store, runId, evidence);
}

function extractUserGoal(intentBody: string): string {
  const match = intentBody.match(/^## User Goal\s*\n([\s\S]*?)(?=\n## |$)/m);
  const goal = (match?.[1] ?? "").trim();
  return goal || "(none)";
}

function extractAnalysisHeadings(analysisBody: string): string[] {
  const found = [...analysisBody.matchAll(/^#{2,3} (.+)$/gm)].map((match) => match[1].trim()).filter(Boolean);
  return found.length > 0 ? found : ["Architecture and code evidence captured"];
}

function renderImprovementSpec(input: { runId: string; name: string; userGoal: string; mustBeTrue: string[] }): string {
  const bullets = input.mustBeTrue.map((item) => `- ${item}`).join("\n");
  const first = input.mustBeTrue[0] ?? "Architecture and code evidence captured";
  return [
    "# Improvement SPEC draft (not frozen)",
    `- **Run ID**: ${input.runId}`,
    `- **Status**: draft-in-run`,
    `- **Title**: ${input.name} improvements`,
    "## Problem",
    input.userGoal,
    "## Must be true",
    bullets,
    "## Must not change",
    "- Existing public CLI/API unless a finding names it",
    "## Out of scope",
    "- Unrelated debt not in this run",
    "## Acceptance",
    `- AC-P0-01 (P0): ${first}`,
    "## Next",
    `1. \`legion-cli run promote ${input.runId}\``,
    "2. `legion-cli wiki trust` the promoted pages",
    "3. `legion-cli spec` (templates) — this file is not SPEC.md",
    "",
  ].join("\n");
}

function renderEffort5Architecture(map: MapResult, fingerprints: FingerprintFile | undefined): string {
  const modules =
    fingerprints && fingerprints.modules.length > 0
      ? fingerprints.modules
          .map((module) => `- \`${module.path}\` — exports: ${module.exports.join(", ")}`)
          .join("\n")
      : "- (none)";
  return [
    "# Architecture (effort 5)",
    "",
    `backend: ${map.backend}`,
    `rootHash: ${fingerprints?.rootHash ?? "(unknown)"}`,
    `modules: ${map.modules}`,
    "",
    "Durable map: `.legion-cli/map/ARCHITECTURE.md`. This run page is a summary, not the durable map.",
    "",
    "## Modules",
    modules,
    "",
  ].join("\n");
}

export type PreparedBrownfield =
  | { kind: "done"; result: BrownfieldResult }
  | { kind: "pending"; run: BrownfieldRun; resume: boolean };

/** Lock-held: validate and build the in-memory run. Does not persist a new run (map/audit stay outside #mutate). */
export async function prepareBrownfield(store: LegionStore, opts: BrownfieldOptions): Promise<PreparedBrownfield> {
  const stateExists = await store.pathExists(".legion-cli/STATE.md");
  if (!stateExists) {
    refuse("brownfield is refused until init", HINT.init);
  }
  if (!isGitRepo(store.projectRoot)) {
    refuse("brownfield requires a git repository", HINT.gitRepo);
  }

  const executeRequested = Boolean(opts.execute);
  const context = (opts.context ?? "").trim();

  if (opts.resume) {
    const runId = parseRunId(opts.resume);
    let run = await readRunResume(store, runId);
    if (opts.effort !== undefined) {
      const requested = parseEffort(opts.effort);
      if (requested !== asEffort(run.effort)) {
        refuse("resuming a brownfield run cannot change effort; start a new run", HINT.brownfield);
      }
    }
    const wantExecute = run.execute || executeRequested;
    if (run.phase === "complete" && !wantExecute) {
      refuse("Run already complete; start a new legion-cli brownfield invocation", HINT.brownfield);
    }
    if (run.phase === "complete" && wantExecute) {
      run = await ensureWorktree(store, { ...run, execute: true });
      await writeRunResume(store.projectRoot, run);
      return { kind: "done", result: toResult(run) };
    }
    return {
      kind: "pending",
      resume: true,
      run: {
        ...run,
        execute: wantExecute,
        context: run.context || context,
      },
    };
  }

  const effort = parseEffort(opts.effort);
  const runId = opts.runId ? parseRunId(opts.runId) : newRunId();
  if (await store.pathExists(runResumePath(runId))) {
    refuse(`brownfield run ${runId} already exists`, HINT.brownfieldResume);
  }
  return {
    kind: "pending",
    resume: false,
    run: {
      schemaVersion: SCHEMA_VERSION.run,
      runId,
      effort,
      execute: executeRequested,
      phase: "analysis",
      preSpawnRef: tryGitHead(store.projectRoot) ?? "UNBORN",
      startedAt: nowIso(),
      worktreePath: null,
      promoted: false,
      pages: ladderPages(effort, false),
      context,
    },
  };
}

/** Secrets walk + 60s audit — call outside #mutate. */
export async function collectBrownfieldAudit(
  projectRoot: string,
  effort: number,
): Promise<{ findings: Array<{ path: string; kind: string }>; auditLines: string[] }> {
  if (effort < 3) return { findings: [], auditLines: [] };
  const findings = await scanSecretFindings(projectRoot);
  const auditLines = runLockfileAudit(projectRoot);
  return { findings, auditLines };
}

async function applyEffort5Map(store: LegionStore, run: BrownfieldRun, map: MapResult): Promise<void> {
  const fingerprints = await readFingerprints(store.projectRoot);
  await writeRunFile(
    store.projectRoot,
    runPagePath(run.runId, "architecture.md"),
    renderEffort5Architecture(map, fingerprints),
  );
  let intentBody = "";
  let analysisBody = "";
  try {
    intentBody = await readFile(join(store.projectRoot, ...runPagePath(run.runId, "intent.md").split("/")), "utf8");
  } catch {
    intentBody = "";
  }
  try {
    analysisBody = await readFile(join(store.projectRoot, ...runPagePath(run.runId, "analysis.md").split("/")), "utf8");
  } catch {
    analysisBody = "";
  }
  const project = (await store.readProject()).data;
  await writeRunFile(
    store.projectRoot,
    runPagePath(run.runId, "improvement-spec.md"),
    renderImprovementSpec({
      runId: run.runId,
      name: project.name,
      userGoal: extractUserGoal(intentBody),
      mustBeTrue: extractAnalysisHeadings(analysisBody),
    }),
  );
}

/** Lock-held write of run pages after outside-lock audit/map. */
export async function commitBrownfield(
  store: LegionStore,
  run: BrownfieldRun,
  extras: {
    resume: boolean;
    findings: SecretFinding[];
    auditLines: string[];
    map?: MapResult;
  },
): Promise<BrownfieldResult> {
  const existed = await store.pathExists(runResumePath(run.runId));
  if (existed && !extras.resume) {
    refuse(`brownfield run ${run.runId} already exists`, HINT.brownfieldResume);
  }

  const effort = asEffort(run.effort);
  const project = (await store.readProject()).data;
  await mkdir(join(store.projectRoot, ".legion-cli", "runs", run.runId), { recursive: true });

  const evidence = await collectEvidence(store.projectRoot);
  const pages = renderPages({
    runId: run.runId,
    name: project.name,
    effort,
    context: run.context,
    execute: run.execute,
    packageHint: await readPackageHint(store.projectRoot),
    layout: evidence.layout,
    sources: evidence.sources,
  });
  await writeNamedPages(store.projectRoot, run.runId, pages);
  await writeLadderExtras(store, run.runId, effort, evidence, {
    findings: extras.findings,
    auditLines: extras.auditLines,
  });

  let next: BrownfieldRun = {
    ...run,
    pages: ladderPages(effort, Boolean(extras.map)),
    phase: run.execute ? "execute" : "complete",
  };

  if (effort >= 5 && extras.map) {
    await applyEffort5Map(store, next, extras.map);
    next = { ...next, pages: ladderPages(5, true) };
  }

  await writeRunResume(store.projectRoot, next);
  if (next.execute) {
    next = await ensureWorktree(store, next);
    await writeRunResume(store.projectRoot, next);
  }
  return toResult(next);
}

export async function promoteBrownfieldRun(
  store: LegionStore,
  runIdRaw: string,
  opts: PromoteRunOptions = {},
): Promise<PromoteRunResult> {
  const stateExists = await store.pathExists(".legion-cli/STATE.md");
  if (!stateExists) {
    refuse("run promote is refused until init", HINT.init);
  }
  const runId = parseRunId(runIdRaw);
  const run = await readRunResume(store, runId);
  // Re-promote always overwrites wiki body and trust. Ingest skip-if-unchanged does not apply.
  const trust = opts.trust === true ? "reviewed" : "untrusted";
  const copied: string[] = [];
  for (const name of run.pages) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const sourceStore = runPagePath(runId, name);
    if (!(await store.pathExists(sourceStore))) continue;
    const abs = join(store.projectRoot, ...sourceStore.split("/"));
    const body = await readFile(abs, "utf8");
    const dest = wikiRunPagePath(runId, name);
    const title = name.replace(/\.md$/i, "");
    await store.writeWikiPage(
      dest,
      {
        schemaVersion: WIKI_PAGE_SCHEMA_VERSION,
        title: `Brownfield ${runId} ${title}`,
        aliases: [],
        tags: ["brownfield", "run"],
        trust,
        updated: nowIso(),
        source: sourceStore,
      },
      body,
    );
    copied.push(dest);
  }
  if (copied.length === 0) {
    refuse(`run ${runId} has no markdown pages to promote`, HINT.brownfield);
  }
  await writeRunResume(store.projectRoot, { ...run, promoted: true });
  await store.rebuild();
  return { runId, pages: copied, trust };
}
