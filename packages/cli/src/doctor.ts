import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { SCHEMA_VERSION, type AdapterId, type LegionConfig } from "@9thlevelsoftware/legion-cli-schema";
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

function adapterSpawnable(id: AdapterId, config: LegionConfig | null): boolean {
  if (id === "fake") return fakeSpawnable();
  if (id === "claude") return isSpawnableBinary("claude");
  const binary = config?.adapter.generic?.binary;
  if (!binary) return false;
  return isSpawnableBinary(binary);
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

export async function runDoctor(opts: CliOpts): Promise<number> {
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
  let spawnable = false;
  if (!adapterDefault) {
    checks.push({
      ok: false,
      label: "adapter.default",
      detail: configError ?? "missing",
    });
  } else {
    spawnable = adapterSpawnable(adapterDefault, config);
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
    if (adapterDefault === "claude" && !isSpawnableBinary("claude")) {
      warnings.push("configured binary claude is missing from PATH");
    }
    if (adapterDefault === "generic") {
      const binary = config?.adapter.generic?.binary;
      if (!binary) {
        warnings.push("adapter.generic.binary is missing");
      } else if (!isSpawnableBinary(binary)) {
        warnings.push(`configured binary ${binary} is missing from PATH`);
      }
    }
  }

  const extraArgs = config?.adapter.claude?.extraArgs ?? [];
  if (extraArgs.length > 0) {
    warnings.push(`claude extraArgs are set (trust warning): ${extraArgs.join(" ")}`);
  }

  const secrets: SecretHit[] = await scanWikiSecrets(engine.store.paths.wikiDir);
  if (secrets.length > 0) {
    warnings.push(`wiki secret scan: ${secrets.length} hit(s)`);
  }

  const schemaVersions = Object.values(SCHEMA_VERSION);

  const adapterMatrix = {
    claude: isSpawnableBinary("claude") ? "on PATH" : "missing",
    generic: config?.adapter.generic?.binary
      ? isSpawnableBinary(config.adapter.generic.binary)
        ? `on PATH (${config.adapter.generic.binary})`
        : `missing (${config.adapter.generic.binary})`
      : "(unset)",
    fake: fakeSpawnable() ? "spawnable (LEGION_CLI_ADAPTER=fake)" : "not spawnable (set LEGION_CLI_ADAPTER=fake)",
    grok: isSpawnableBinary("grok") ? "on PATH (detect-only)" : "missing  detect-only",
    codex: isSpawnableBinary("codex") ? "on PATH (detect-only)" : "missing  detect-only",
  };

  const ok = checks.every((check) => check.ok);
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
      matrix: adapterMatrix,
    },
    secrets: secrets.map((hit) => ({ name: hit.name, file: hit.file })),
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
    `  grok         ${adapterMatrix.grok}`,
    `  codex        ${adapterMatrix.codex}`,
    "",
    secrets.length === 0 ? "Secrets     none" : `Secrets     ${secrets.length} hit(s)`,
  ];
  if (warnings.length > 0) {
    lines.push("", "Warnings");
    for (const warning of warnings) lines.push(`  ${warning}`);
  }
  lines.push("", ok ? "Doctor passed." : "Doctor failed.");
  writeOut(lines.join("\n"));
  return ok ? 0 : 1;
}
