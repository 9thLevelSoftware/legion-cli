import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_GENERIC_ARGS,
  FROZEN_ARGV_TABLE,
  REQUIRED_SKILL_IDS,
  SKILL_BODY_WARN_CHARS,
  argsIncludePointer,
  extraArgsOrDefault,
  extraArgvIsSpawnable,
  extraArgvRefuseReason,
  genericArgsOrDefault,
  hashSkillTree,
  listResolvedSkillCatalog,
} from "@9thlevelsoftware/legion-cli-agents";
import {
  argvSummarySafe,
  createLegionEngine,
  describeLiveSpawn,
  findSkillsDir,
  HINT,
  listRetainedQuarantines,
  refuse,
  retainedControlDir,
} from "@9thlevelsoftware/legion-cli-core";
import { assertExecuteSandbox, detectSandbox } from "@9thlevelsoftware/legion-cli-sandbox";
import {
  isGitRepo,
  readAuditEvents,
  summarizeAuditMetrics,
  tryGitHead,
  type LocalMetrics,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  ASSUMED_EXTRA_BINARIES,
  EXTRA_ADAPTER_IDS,
  QAScoreSchema,
  SCHEMA_VERSION,
  SkillIdSchema,
  type AdapterId,
  type ExtraAdapterId,
  type LegionConfig,
  type Phase,
  type SkillId,
} from "@9thlevelsoftware/legion-cli-schema";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { closePrompt, isYes, readLine } from "./prompt.js";
import { scanWikiSecrets, type SecretHit } from "./secrets.js";
import { isSpawnableBinary, listOnPath, pathLegionIsLegionCli, runBounded, runTool } from "./which.js";

export type DoctorCheck = {
  ok: boolean;
  label: string;
  detail: string;
};

export type PathListing = {
  name: string;
  paths: string[];
};

function nodeMajor(version: string): number {
  const major = Number(version.split(".")[0]);
  return Number.isFinite(major) ? major : 0;
}

function toolVersion(name: string, args: string[]): { ok: boolean; detail: string } {
  const result = runTool(name, args);
  if (result.status !== 0) return { ok: false, detail: "not found" };
  const line = result.stdout.trim().split(/\r?\n/)[0] ?? "";
  return { ok: true, detail: line || "ok" };
}

const PE_HELP_FINGERPRINT = "Product Engineering lifecycle engine";
const INSTALLER_PATH_WARNING =
  "PATH legion is the plugin installer; upgrade it to bin legion-plugins or put Legion CLI first";

function formatPathGroup(name: string, paths: string[]): string[] {
  const lines = [`  ${name}`];
  if (paths.length === 0) {
    lines.push("    (not found)");
    return lines;
  }
  for (const abs of paths) lines.push(`    - ${abs}`);
  return lines;
}

function looksLikeInstallerHelp(text: string): boolean {
  // Real `@9thlevelsoftware/legion` printHelp() tokens: package name + `--uninstall`.
  // PE help also mentions the package; it never prints `--uninstall`.
  return (
    text.includes("@9thlevelsoftware/legion") &&
    /--uninstall\b/.test(text) &&
    !text.includes(PE_HELP_FINGERPRINT)
  );
}

function pickLegionProbe(legionPaths: string[]): string | undefined {
  if (process.platform === "win32") {
    const winBin = legionPaths.find((abs) => /\.(cmd|bat|exe)$/i.test(abs));
    if (winBin) return winBin;
  }
  return legionPaths[0];
}

async function installerFingerprintWarning(legionPaths: string[]): Promise<string | undefined> {
  const probe = pickLegionProbe(legionPaths);
  if (!probe) return undefined;
  const result = await runBounded(probe, ["--help"], 5_000);
  if (result.timedOut || result.truncated) return undefined;
  const text = `${result.stdout}\n${result.stderr}`;
  return looksLikeInstallerHelp(text) ? INSTALLER_PATH_WARNING : undefined;
}

function fakeSpawnable(): boolean {
  return process.env.LEGION_CLI_ADAPTER === "fake";
}

function extraBinary(id: ExtraAdapterId, config: LegionConfig | null): string {
  return config?.adapter[id]?.binary ?? ASSUMED_EXTRA_BINARIES[id];
}

function extraOnPath(id: ExtraAdapterId, config: LegionConfig | null): boolean {
  return isSpawnableBinary(extraBinary(id, config));
}

function extraResolvedArgs(id: ExtraAdapterId, config: LegionConfig | null): string[] {
  return extraArgsOrDefault(id, config?.adapter[id]?.args ?? [], extraBinary(id, config));
}

/** Match ExtraAdapter argv without executing the binary (`versionOf` / `--version`). */
function extraArgvOk(id: ExtraAdapterId, config: LegionConfig | null): boolean {
  return extraArgvIsSpawnable(id, config?.adapter[id]?.args ?? [], extraBinary(id, config));
}

function isConfiguredSpawnable(config: LegionConfig, id: AdapterId): boolean {
  if (id === "fake") return fakeSpawnable();
  if (id === "claude") return isSpawnableBinary("claude");
  if (id === "generic") {
    const spec = config.adapter.generic;
    if (!spec?.binary) return false;
    return argsIncludePointer(genericArgsOrDefault(spec.args ?? [])) && isSpawnableBinary(spec.binary);
  }
  if (id === "http") return false;
  return extraOnPath(id, config) && extraArgvOk(id, config);
}

const REQUIRED_ROUTE_SKILLS = new Set<SkillId>(["plan", "execute", "review"]);

export type DoctorRoutedAdapter = {
  id: AdapterId;
  via: string;
  skill: SkillId | null;
  required: boolean;
  spawnable: boolean;
};

function isRequiredRouteSkill(skill: SkillId): boolean {
  return REQUIRED_ROUTE_SKILLS.has(skill);
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

function isFrozenGenericArgs(args: readonly string[] | undefined): boolean {
  if (!args || args.length === 0) return true;
  return sameArgs(args, DEFAULT_GENERIC_ARGS);
}

function isFrozenExtraArgs(id: ExtraAdapterId, args: readonly string[] | undefined): boolean {
  if (!args || args.length === 0) return true;
  return sameArgs(args, FROZEN_ARGV_TABLE[id].argv ?? DEFAULT_GENERIC_ARGS);
}

function formatArgsTrustWarning(label: string, args: readonly string[]): string {
  return `${label} are set (trust warning): ${argvSummarySafe(args)}`;
}

function cachedSpawnable(config: LegionConfig): (id?: AdapterId) => boolean {
  const cache = new Map<string, boolean>();
  return (id) => {
    const key = id ?? config.adapter.default;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const ok = isConfiguredSpawnable(config, key);
    cache.set(key, ok);
    return ok;
  };
}

function pushArgsTrustWarnings(config: LegionConfig, warnings: string[]): void {
  const extraArgs = config.adapter.claude?.extraArgs ?? [];
  if (extraArgs.length > 0) {
    warnings.push(formatArgsTrustWarning("claude extraArgs", extraArgs));
  }
  const genericArgs = config.adapter.generic?.args;
  if (!isFrozenGenericArgs(genericArgs) && genericArgs) {
    warnings.push(formatArgsTrustWarning("generic args", genericArgs));
  }
  for (const id of EXTRA_ADAPTER_IDS) {
    const args = config.adapter[id]?.args;
    if (!isFrozenExtraArgs(id, args) && args) {
      warnings.push(formatArgsTrustWarning(`${id} args`, args));
    }
  }
}

function pushDefaultPathWarnings(id: AdapterId, config: LegionConfig, warnings: string[]): void {
  if (id === "claude" && !isSpawnableBinary("claude")) {
    warnings.push("configured binary claude is missing from PATH");
  }
  if (id === "generic") {
    const binary = config.adapter.generic?.binary;
    if (!binary) {
      warnings.push("adapter.generic.binary is missing");
    } else if (!isSpawnableBinary(binary)) {
      warnings.push(`configured binary ${binary} is missing from PATH`);
    }
  }
  if ((EXTRA_ADAPTER_IDS as readonly string[]).includes(id)) {
    const extraId = id as ExtraAdapterId;
    const binary = extraBinary(extraId, config);
    if (!isSpawnableBinary(binary)) {
      warnings.push(`configured binary ${binary} is missing from PATH`);
    }
    const argvReason = extraArgvRefuseReason(extraId, extraResolvedArgs(extraId, config), binary);
    if (argvReason) warnings.push(argvReason);
  }
}

function formatRoutedLine(entry: DoctorRoutedAdapter): string {
  const label = (entry.skill ?? "default").padEnd(13);
  const spawn = entry.spawnable ? "spawnable" : "not spawnable";
  const optional = entry.required || entry.spawnable ? "" : " (optional)";
  return `  ${label}${entry.id}  ${spawn}${optional}`;
}

async function loadConfig(engine: ReturnType<typeof createLegionEngine>): Promise<{
  config: LegionConfig | null;
  error: string | null;
}> {
  if (!(await engine.store.pathExists(".legion-cli/config.yaml"))) {
    return { config: null, error: "adapter.default is missing" };
  }
  try {
    return { config: await engine.store.readConfig(), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { config: null, error: message };
  }
}

function formatCheck(check: DoctorCheck): string {
  const mark = check.ok ? "ok  " : "FAIL";
  return `${mark}  ${check.label} (${check.detail})`;
}

export type DoctorMetricsFlags = {
  metrics?: boolean;
  clearStaleRun?: boolean;
};

/**
 * KD-2 (8b): the explicit way out of a freeze held by a control record that cannot be read. The
 * engine refuses while the recorded engine or agent process is alive with a matching start time;
 * this asks first, because the replay reverts the working tree.
 */
export async function runClearStaleRun(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const live = await engine.liveAgentRun();
  if (!live) {
    if (opts.json) {
      writeJson({ ok: true, cleared: false, detail: "no agent-run record is freezing engine writes" });
      return 0;
    }
    writeOut("No agent-run record is freezing engine writes.");
    return 0;
  }
  if (!opts.yes) {
    writeOut(`Stale run: ${describeLiveSpawn(live)}`);
    writeOut(
      "Clearing it reverts the working tree to the run's pre-spawn state, quarantines the agent's versions and blocks its task. Continue? [y/N]",
    );
    const answer = await readLine("> ");
    if (!isYes(answer)) {
      refuse("doctor --clear-stale-run declined", HINT.clearStaleRun);
    }
  }
  const result = await engine.clearStaleRun();
  if (opts.json) {
    writeJson({ ok: true, cleared: true, ...result, next: result.taskId ? `legion-cli task retry ${result.taskId}` : "legion-cli status" });
    return 0;
  }
  writeOut(`Cleared ${result.runId}.`);
  if (result.reverted.length > 0) writeOut(`Reverted: ${result.reverted.join(", ")}`);
  for (const line of result.unrestorable) writeOut(`NOT restored: ${line}`);
  if (result.quarantineDir) writeOut(`The displaced versions are in quarantine at ${result.quarantineDir}`);
  writeOut(result.taskId ? `Next: legion-cli task retry ${result.taskId}` : "Next: legion-cli status");
  return 0;
}

async function qaScoresFallback(projectRoot: string): Promise<{ runs: number; passes: number }> {
  const dir = join(projectRoot, ".legion-cli", "qa", "scores");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { runs: 0, passes: 0 };
  }
  let runs = 0;
  let passes = 0;
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    try {
      const parsed = QAScoreSchema.safeParse(JSON.parse(await readFile(join(dir, name), "utf8")));
      if (!parsed.success) continue;
      runs += 1;
      if (parsed.data.pass) passes += 1;
    } catch {
      continue;
    }
  }
  return { runs, passes };
}

const AUDIT_SOURCE = ".legion-cli/audit/events.jsonl";
const QA_SCORES_SOURCE = ".legion-cli/qa/scores";

function mergeQaFallback(
  metrics: LocalMetrics,
  fallback: { runs: number; passes: number },
): { metrics: LocalMetrics; qaSource: string | null } {
  if (metrics.qa.runs > 0) return { metrics, qaSource: AUDIT_SOURCE };
  if (fallback.runs === 0) return { metrics, qaSource: null };
  return {
    metrics: {
      ...metrics,
      qa: {
        runs: fallback.runs,
        passes: fallback.passes,
        passRate: fallback.passes / fallback.runs,
      },
    },
    qaSource: QA_SCORES_SOURCE,
  };
}

function formatPassRate(qa: LocalMetrics["qa"]): string {
  if (qa.runs === 0 || qa.passRate === null) return "n/a (0 runs)";
  const pct = Math.round(qa.passRate * 100);
  return `${qa.passes}/${qa.runs} (${pct}%)`;
}

function formatMeanDuration(execute: LocalMetrics["execute"]): string {
  if (execute.runs === 0 || execute.meanDurationMs === null) return "n/a (0 runs)";
  return `${Math.round(execute.meanDurationMs)} ms`;
}

function formatMetricsLines(metrics: LocalMetrics, phase: Phase | null, qaSource: string | null): string[] {
  const kinds = Object.keys(metrics.refusesByType).sort();
  const lines = [
    "Local metrics (on disk only; never phones home)",
    `  Source      ${AUDIT_SOURCE}`,
  ];
  if (qaSource && qaSource !== AUDIT_SOURCE) {
    lines.push(`  QA source   ${qaSource}`);
  }
  if (phase) lines.push(`  Phase       ${phase}`);
  if (process.env.DO_NOT_TRACK === "1") {
    lines.push("  DO_NOT_TRACK=1 honored (these metrics are not telemetry)");
  }
  lines.push("  Refuses by type");
  if (kinds.length === 0) {
    lines.push("    none");
  } else {
    const width = Math.max(...kinds.map((kind) => kind.length));
    for (const kind of kinds) {
      lines.push(`    ${kind.padEnd(width)}  ${metrics.refusesByType[kind]}`);
    }
  }
  lines.push(`  QA pass rate            ${formatPassRate(metrics.qa)}`);
  lines.push(`  Mean execute duration   ${formatMeanDuration(metrics.execute)}`);
  lines.push(`  Timeouts                ${metrics.timeouts}`);
  return lines;
}

export async function runDoctor(opts: CliOpts, flags: DoctorMetricsFlags = {}): Promise<number> {
  if (flags.clearStaleRun) {
    try {
      return await runClearStaleRun(opts);
    } finally {
      closePrompt();
    }
  }
  const engine = createLegionEngine(opts.project);
  const checks: DoctorCheck[] = [];
  const warnings: string[] = [];

  const nodeVersion = process.versions.node;
  checks.push({
    ok: nodeMajor(nodeVersion) >= 22,
    label: "Node >= 22",
    detail: `v${nodeVersion}`,
  });

  const pnpm = toolVersion("pnpm", ["--version"]);
  checks.push({ ok: pnpm.ok, label: "pnpm", detail: pnpm.detail });

  const git = toolVersion("git", ["--version"]);
  checks.push({
    ok: git.ok,
    label: "git",
    detail: git.detail.replace(/^git version\s+/i, ""),
  });

  // KD-3: every agent spawn needs a repo with at least one commit.
  const repo = isGitRepo(opts.project);
  const head = repo ? tryGitHead(opts.project) : null;
  checks.push({
    ok: head !== null,
    label: "git repository",
    detail: head
      ? "yes"
      : `${repo ? "no commit yet" : "not a git repository"}; next: git init && git add -A && git commit -m "start"`,
  });

  const legionCliPaths = listOnPath(["legion-cli", "legion-cli.cmd", "legion-cli.exe"]);
  const legionPaths = listOnPath(["legion", "legion.cmd", "legion.exe"]);
  const pathListing: PathListing[] = [
    { name: "legion-cli", paths: legionCliPaths },
    { name: "legion", paths: legionPaths },
  ];
  if (legionCliPaths.length > 1) {
    warnings.push("multiple legion-cli binaries on PATH (collision check)");
  }
  const installerWarn = await installerFingerprintWarning(legionPaths);
  if (installerWarn) warnings.push(installerWarn);
  if (!installerWarn && pathLegionIsLegionCli(legionPaths) === false) {
    warnings.push("PATH legion is another program; run npm link --force in packages/cli to make legion run Legion CLI");
  }

  const playwright = runTool("pnpm", ["exec", "playwright", "--version"], opts.project);
  const playwrightDetail =
    playwright.status === 0 ? playwright.stdout.trim().split(/\r?\n/)[0] || "ok" : "not installed";

  const lockPresent = await engine.store.pathExists(".legion-cli/index/engine.lock");
  const { config, error: configError } = await loadConfig(engine);

  const adapterDefault = config?.adapter.default ?? null;
  const routes = config?.adapter.routes ?? {};
  const named = config?.adapter.named ?? {};
  const routed: DoctorRoutedAdapter[] = [];
  let spawnable = false;
  if (!adapterDefault || !config) {
    checks.push({
      ok: false,
      label: "adapter.default",
      detail: configError ?? "missing",
    });
  } else {
    // PATH + argv only — never versionOf / spawnSync on repo-configured binaries.
    const spawnableOf = cachedSpawnable(config);
    spawnable = spawnableOf(adapterDefault);
    checks.push({
      ok: true,
      label: "adapter.default",
      detail: adapterDefault,
    });
    checks.push({
      ok: spawnable,
      label: "adapter spawnable",
      detail: spawnable ? "yes" : `${adapterDefault} is not spawnable`,
    });
    routed.push({
      id: adapterDefault,
      via: "default",
      skill: null,
      required: true,
      spawnable,
    });
    pushDefaultPathWarnings(adapterDefault, config, warnings);

    const routeEntries = SkillIdSchema.options.flatMap((skill) => {
      const id = config.adapter.routes?.[skill];
      return id ? [{ skill, id }] : [];
    });
    const routeResults = routeEntries.map(({ skill, id }) => ({
      skill,
      id,
      spawnable: spawnableOf(id),
    }));
    for (const { skill, id, spawnable: routeSpawnable } of routeResults) {
      const required = isRequiredRouteSkill(skill);
      routed.push({
        id,
        via: `routes.${skill}`,
        skill,
        required,
        spawnable: routeSpawnable,
      });
      if (required) {
        checks.push({
          ok: routeSpawnable,
          label: `adapter.routes.${skill} spawnable`,
          detail: routeSpawnable ? "yes" : `${id} is not spawnable`,
        });
      } else if (!routeSpawnable) {
        warnings.push(`adapter.routes.${skill} (${id}) is not spawnable (optional skill)`);
      }
    }

    const namedResults = Object.entries(config.adapter.named ?? {}).map(([name, id]) => ({
      name,
      id,
      ok: spawnableOf(id),
    }));
    for (const { name, id, ok } of namedResults) {
      if (ok) continue;
      warnings.push(`adapter.named.${name} (${id}) is not spawnable`);
    }

    // Active spec slice only; skip unreadable files. Task.adapter is warn-only.
    try {
      const sliceTasks = (await engine.listSliceTasks()).filter((task) => task.adapter);
      const taskResults = sliceTasks.map((task) => ({
        id: task.id,
        adapter: task.adapter as AdapterId,
        ok: spawnableOf(task.adapter),
      }));
      for (const { id, adapter, ok } of taskResults) {
        if (ok) continue;
        warnings.push(`${id} adapter (${adapter}) is not spawnable`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`could not read active slice tasks: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    pushArgsTrustWarnings(config, warnings);
  }

  const detectedSandbox = detectSandbox();
  let sandboxOk = true;
  let sandboxDetail = `${detectedSandbox.backend}, hardened=${detectedSandbox.hardened}`;
  if (config) {
    try {
      assertExecuteSandbox(config, {});
    } catch (err) {
      sandboxOk = false;
      sandboxDetail = err instanceof Error ? err.message : String(err);
      warnings.push(
        `sandbox config cannot satisfy requireHardened (${config.sandbox.backend}); guarded execute needs --allow-no-sandbox or sandbox.allowCopyJail`,
      );
    }
  } else if (detectedSandbox.backend === "copy") {
    sandboxOk = false;
    warnings.push("sandbox is not hardened; guarded execute needs --allow-no-sandbox or sandbox.allowCopyJail");
  }
  checks.push({
    ok: sandboxOk,
    label: "sandbox",
    detail: sandboxDetail,
  });

  const skillsDir = findSkillsDir();
  const catalogResult = await listResolvedSkillCatalog({
    projectRoot: opts.project,
    packagedSkillsDir: skillsDir,
  });
  const skippedBySkill = new Map(
    catalogResult.skipped.map((row) => {
      const id = row.path.replace(/^(?:\.legion-cli\/)?skills\//, "").replace(/\/SKILL\.md$/i, "");
      return [id, row] as const;
    }),
  );
  for (const skillId of REQUIRED_SKILL_IDS) {
    const entry = catalogResult.catalog.skills.find((skill) => skill.skillId === skillId);
    const skipped = skippedBySkill.get(skillId);
    if (entry) {
      checks.push({ ok: true, label: `skill ${skillId} frontmatter`, detail: "ok" });
      if (entry.bodyChars > SKILL_BODY_WARN_CHARS) {
        warnings.push(
          `${entry.path} body is ${entry.bodyChars} characters (warn at ${SKILL_BODY_WARN_CHARS})`,
        );
      }
    } else {
      checks.push({
        ok: false,
        label: `skill ${skillId} frontmatter`,
        detail: skipped?.reason ?? "missing or invalid frontmatter",
      });
    }
  }
  for (const entry of catalogResult.catalog.skills) {
    if ((REQUIRED_SKILL_IDS as readonly string[]).includes(entry.skillId)) continue;
    if (entry.bodyChars > SKILL_BODY_WARN_CHARS) {
      warnings.push(
        `${entry.path} body is ${entry.bodyChars} characters (warn at ${SKILL_BODY_WARN_CHARS})`,
      );
    }
  }
  for (const skipped of catalogResult.skipped) {
    if (skipped.required) continue;
    if (skipped.reason === "missing SKILL.md") continue;
    warnings.push(`optional skill ${skipped.path}: ${skipped.reason}`);
  }

  const overlayLines: string[] = [];
  for (const overlay of catalogResult.overlays) {
    const skillId = overlay.skillId;
    let packagedHash = "missing";
    if (skillsDir && existsSync(join(skillsDir, skillId, "SKILL.md"))) {
      try {
        packagedHash = await hashSkillTree(join(skillsDir, skillId));
      } catch (err) {
        packagedHash = err instanceof Error ? err.message : String(err);
      }
    }
    if (!overlay.pin) {
      overlayLines.push(`  ${skillId.padEnd(13)}unreadable overlay.json  packaged ${packagedHash}`);
      continue;
    }
    const origin =
      overlay.pin.source.type === "github"
        ? `github:${overlay.pin.source.origin}@${overlay.pin.source.ref}`
        : `local ${overlay.pin.source.origin}`;
    if (!overlay.digestOk) {
      overlayLines.push(
        `  ${skillId.padEnd(13)}pin ${overlay.pin.integrity.sha256} tree ${overlay.treeSha256 ?? "unreadable"}  ${origin}  packaged ${packagedHash}`,
      );
      continue;
    }
    overlayLines.push(`  ${skillId.padEnd(13)}pin ${overlay.pin.integrity.sha256}  ${origin}  packaged ${packagedHash}`);
  }

  const secrets: SecretHit[] = await scanWikiSecrets(engine.store.paths.wikiDir);
  if (secrets.length > 0) {
    warnings.push(`wiki secret scan: ${secrets.length} hit(s)`);
  }

  // Retained quarantines (KD-1, R-40): outside the project, never deleted by the engine. Each
  // manifest is checked against the sha256 recorded in the protected audit log.
  const auditedManifests = new Map<string, string>();
  try {
    for (const event of await readAuditEvents(opts.project)) {
      if (event.type !== "quarantine_created") continue;
      // Deferred events are written by whatever could reach the control dir, so they never count
      // as integrity evidence (R-18).
      if (event.actor === "deferred" || event.data.deferred === true) continue;
      const dir = event.data.dir;
      const sha = event.data.manifestSha256;
      if (typeof dir === "string" && typeof sha === "string") auditedManifests.set(dir.toLowerCase(), sha);
    }
  } catch {
    // unreadable audit log: every quarantine reads as unaudited below
  }
  const quarantines = (await listRetainedQuarantines(opts.project)).map((entry) => {
    const audited = auditedManifests.get(entry.dir.toLowerCase());
    const integrity =
      entry.manifestSha256 === null
        ? "MANIFEST.json missing"
        : audited === undefined
          ? "not in the audit log"
          : audited === entry.manifestSha256
            ? "intact"
            : "MANIFEST.json does not match the audited hash";
    if (integrity !== "intact") warnings.push(`quarantine ${entry.dir}: ${integrity}`);
    return { ...entry, integrity };
  });
  // The freeze must never be invisible: say which run holds it and when it lifts (R-6, R-19).
  const agentRun = await engine.liveAgentRun();
  if (agentRun) {
    warnings.push(
      agentRun.state === "live"
        ? `an agent run is in progress (${describeLiveSpawn(agentRun)}); engine writes are frozen`
        : `a stale agent-run record is freezing engine writes (${describeLiveSpawn(agentRun)}); remove ${agentRun.controlDir} once you are sure no agent is running`,
    );
  }

  const quarantineLines = quarantines.map(
    (entry) => `  ${entry.runId}  ${entry.files} file(s), ${entry.bytes} bytes  ${entry.integrity}  ${entry.dir}`,
  );
  // R-8: pre-spawn backups retained for incident runs and crash replay. A clean finish drops its own.
  const controlRetention = await retainedControlDir(opts.project);

  const schemaVersions = Object.values(SCHEMA_VERSION);

  const extraLabels = Object.fromEntries(
    EXTRA_ADAPTER_IDS.map((id) => {
      const binary = extraBinary(id, config);
      return [id, extraOnPath(id, config) ? `on PATH (${binary})` : `missing (${binary})`];
    }),
  ) as Record<ExtraAdapterId, string>;
  const adapterMatrix = {
    claude: isSpawnableBinary("claude") ? "on PATH" : "missing",
    generic: config?.adapter.generic?.binary
      ? isSpawnableBinary(config.adapter.generic.binary)
        ? `on PATH (${config.adapter.generic.binary})`
        : `missing (${config.adapter.generic.binary})`
      : "(unset)",
    fake: fakeSpawnable() ? "spawnable (LEGION_CLI_ADAPTER=fake)" : "not spawnable (set LEGION_CLI_ADAPTER=fake)",
    ...extraLabels,
    http: !config?.adapter.http ? "not configured" : "not spawnable (detect-only)",
  };

  const ok = checks.every((check) => check.ok);
  let metrics: LocalMetrics | null = null;
  let metricsPhase: Phase | null = null;
  let qaSource: string | null = null;
  if (flags.metrics) {
    const events = await readAuditEvents(opts.project);
    const merged = mergeQaFallback(summarizeAuditMetrics(events), await qaScoresFallback(opts.project));
    metrics = merged.metrics;
    qaSource = merged.qaSource;
    try {
      metricsPhase = (await engine.getState()).phase;
    } catch {
      metricsPhase = null;
    }
  }

  const report = {
    ok,
    checks,
    warnings,
    path: Object.fromEntries(pathListing.map((group) => [group.name, group.paths])),
    playwright: playwrightDetail,
    lock: lockPresent ? "present" : "absent",
    schemaVersions,
    adapter: {
      default: adapterDefault,
      spawnable,
      routes,
      named,
      routed,
      matrix: adapterMatrix,
    },
    sandbox: {
      backend: detectedSandbox.backend,
      hardened: detectedSandbox.hardened,
    },
    secrets: secrets.map((hit) => ({ name: hit.name, file: hit.file })),
    overlays: overlayLines.map((line) => line.trim()),
    quarantine: quarantines,
    agentRun: agentRun
      ? {
          runId: agentRun.runId,
          skillId: agentRun.skillId,
          state: agentRun.state,
          controlDir: agentRun.controlDir,
          expiresAt: agentRun.expiresAt ? new Date(agentRun.expiresAt).toISOString() : null,
          detail: agentRun.detail ?? null,
        }
      : null,
    ...(metrics
      ? {
          metrics: {
            telemetry: "off" as const,
            source: AUDIT_SOURCE,
            qaSource,
            phase: metricsPhase,
            ...metrics,
          },
        }
      : {}),
  };

  if (opts.json) {
    writeJson(report);
    return ok ? 0 : 1;
  }

  const lines: string[] = [
    "Legion CLI doctor",
    "Supported command: pnpm exec legion-cli",
    "",
    ...checks.map(formatCheck),
    "",
    "PATH",
    ...pathListing.flatMap((group) => formatPathGroup(group.name, group.paths)),
    "",
    `Sandbox     ${detectedSandbox.backend} hardened=${detectedSandbox.hardened}`,
    `Playwright  ${playwrightDetail}`,
    `Lock        ${lockPresent ? "present" : "absent"}`,
    ...(lockPresent
      ? [
          "            held by a running legion-cli, or left by one that crashed. A dead holder's lock is",
          "            cleared on the next verb; a live one is never stolen. If no legion-cli is running,",
          "            delete .legion-cli/index/engine.lock.",
        ]
      : []),
    "schemaVersions",
    ...schemaVersions.map((version) => `  ${version}`),
    "",
    "Adapter",
    `  default      ${adapterDefault ?? "missing"}`,
    `  spawnable    ${spawnable ? "yes" : "no"}`,
    `  claude       ${adapterMatrix.claude}`,
    `  generic      ${adapterMatrix.generic}`,
    `  fake         ${adapterMatrix.fake}`,
    ...EXTRA_ADAPTER_IDS.map((id) => `  ${id.padEnd(13)}${adapterMatrix[id]}`),
    `  ${"http".padEnd(13)}${adapterMatrix.http}`,
    "",
    "Routes",
    ...(routed.length > 0 ? routed.map(formatRoutedLine) : ["  (none)"]),
    ...(overlayLines.length > 0 ? ["", "Overlays (pin vs packaged)", ...overlayLines] : []),
    "",
    secrets.length === 0 ? "Secrets     none" : `Secrets     ${secrets.length} hit(s)`,
    ...(agentRun ? ["", "Agent run", `  ${describeLiveSpawn(agentRun)}`] : []),
    ...(quarantineLines.length > 0
      ? ["", "Quarantine (retained; never deleted by Legion)", ...quarantineLines]
      : []),
    ...(controlRetention.runs > 0
      ? [
          "",
          "Run control dir (pre-spawn backups kept for incident runs and crash replay)",
          `  ${controlRetention.runs} run(s), ${controlRetention.files} file(s), ${controlRetention.bytes} bytes  ${controlRetention.dir}`,
          "  these are copies of files git cannot reproduce, including ignored ones such as .env;",
          "  a run older than 30 days has its copies dropped at the start of the next run",
        ]
      : []),
  ];
  if (warnings.length > 0) {
    lines.push("", "Warnings");
    for (const warning of warnings) lines.push(`  ${warning}`);
  }
  if (metrics) {
    lines.push("", ...formatMetricsLines(metrics, metricsPhase, qaSource));
  }
  lines.push("", ok ? "Doctor passed." : "Doctor failed.");
  writeOut(lines.join("\n"));
  return ok ? 0 : 1;
}
