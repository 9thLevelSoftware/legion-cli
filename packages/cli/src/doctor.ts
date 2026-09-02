import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_GENERIC_ARGS, isResolvedAdapterSpawnable } from "@9thlevelsoftware/legion-cli-agents";
import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import {
  readAuditEvents,
  summarizeAuditMetrics,
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
import { scanWikiSecrets, type SecretHit } from "./secrets.js";
import { isSpawnableBinary, listOnPath, runTool } from "./which.js";

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

function formatPathGroup(name: string, paths: string[]): string[] {
  const lines = [`  ${name}`];
  if (paths.length === 0) {
    lines.push("    (not found)");
    return lines;
  }
  for (const abs of paths) lines.push(`    - ${abs}`);
  return lines;
}

function fakeSpawnable(): boolean {
  return process.env.LEGION_CLI_ADAPTER === "fake";
}

const POINTER_PLACEHOLDER = "{{pointer}}";

function extraBinary(id: ExtraAdapterId, config: LegionConfig | null): string {
  return config?.adapter[id]?.binary ?? ASSUMED_EXTRA_BINARIES[id];
}

function extraOnPath(id: ExtraAdapterId, config: LegionConfig | null): boolean {
  return isSpawnableBinary(extraBinary(id, config));
}

/** Match ExtraAdapter.detect(): empty args default to {{pointer}}; nonempty args must include it. */
function extraPointerOk(id: ExtraAdapterId, config: LegionConfig | null): boolean {
  const args = config?.adapter[id]?.args;
  const effective = !args || args.length === 0 ? [POINTER_PLACEHOLDER] : args;
  return effective.some((arg) => arg.includes(POINTER_PLACEHOLDER));
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

function pushArgsTrustWarnings(config: LegionConfig, warnings: string[]): void {
  const extraArgs = config.adapter.claude?.extraArgs ?? [];
  if (extraArgs.length > 0) {
    warnings.push(`claude extraArgs are set (trust warning): ${extraArgs.join(" ")}`);
  }
  const genericArgs = config.adapter.generic?.args;
  if (!isFrozenGenericArgs(genericArgs) && genericArgs) {
    warnings.push(`generic args are set (trust warning): ${genericArgs.join(" ")}`);
  }
  for (const id of EXTRA_ADAPTER_IDS) {
    const args = config.adapter[id]?.args;
    if (!isFrozenGenericArgs(args) && args) {
      warnings.push(`${id} args are set (trust warning): ${args.join(" ")}`);
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
    if (!extraPointerOk(extraId, config)) {
      warnings.push(`adapter.${extraId}.args must include {{pointer}}`);
    }
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
};

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

  const legionCliPaths = listOnPath(["legion-cli", "legion-cli.cmd", "legion-cli.exe"]);
  const legionPaths = listOnPath(["legion", "legion.cmd", "legion.exe"]);
  const pathListing: PathListing[] = [
    { name: "legion-cli", paths: legionCliPaths },
    { name: "legion", paths: legionPaths },
  ];
  if (legionCliPaths.length > 1) {
    warnings.push("multiple legion-cli binaries on PATH (collision check)");
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
    // resolveAdapter(config) then isSpawnable — PATH-only misses per-id args/{{pointer}}.
    spawnable = await isResolvedAdapterSpawnable(config);
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

    for (const skill of SkillIdSchema.options) {
      const id = config.adapter.routes?.[skill];
      if (!id) continue;
      const routeSpawnable = await isResolvedAdapterSpawnable(config, id);
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

    for (const [name, id] of Object.entries(config.adapter.named ?? {})) {
      if (await isResolvedAdapterSpawnable(config, id)) continue;
      warnings.push(`adapter.named.${name} (${id}) is not spawnable`);
    }

    // Active spec slice only; skip unreadable files. Task.adapter is warn-only.
    try {
      for (const task of await engine.listSliceTasks()) {
        if (!task.adapter) continue;
        if (await isResolvedAdapterSpawnable(config, task.adapter)) continue;
        warnings.push(`${task.id} adapter (${task.adapter}) is not spawnable`);
      }
    } catch {
      // unreadable STATE.md / tasks dir must not crash doctor
    }

    pushArgsTrustWarnings(config, warnings);
  }

  const secrets: SecretHit[] = await scanWikiSecrets(engine.store.paths.wikiDir);
  if (secrets.length > 0) {
    warnings.push(`wiki secret scan: ${secrets.length} hit(s)`);
  }

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
    secrets: secrets.map((hit) => ({ name: hit.name, file: hit.file })),
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
    `Playwright  ${playwrightDetail}`,
    `Lock        ${lockPresent ? "present" : "absent"}`,
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
    "",
    "Routes",
    ...(routed.length > 0 ? routed.map(formatRoutedLine) : ["  (none)"]),
    "",
    secrets.length === 0 ? "Secrets     none" : `Secrets     ${secrets.length} hit(s)`,
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
