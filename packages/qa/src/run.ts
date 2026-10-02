import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCommandLine, runCommand as runArgv, splitCommand } from "@9thlevelsoftware/legion-cli-agents";
import { createLegionStore, writeTextFile } from "@9thlevelsoftware/legion-cli-persist";
import type { QAScore, Spec } from "@9thlevelsoftware/legion-cli-schema";
import { extractJsonPayload, parseTestReport, reportFailClosed } from "./reports.js";
import { scorePersistedReports, ZERO_TESTS_REASON, type QaMode } from "./score.js";
import { specHasUi } from "./tags.js";

export const DEFAULT_UNIT_COMMAND = "pnpm test -- --reporter=json";
export const DEFAULT_PLAYWRIGHT_COMMAND = "pnpm exec playwright test --reporter=json";
export const DEFAULT_QA_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

export { splitCommand };

export type CommandCapture = {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
  /** False when the command never ran (not found, argv-only refusal, spawn error). */
  started: boolean;
  error?: string;
  timedOut?: boolean;
};

export type QaCommandOptions = {
  timeoutMs?: number;
  /** Configured `adapter.*.apiKeyEnv` names, scrubbed on top of the KD-4 pattern. */
  secretEnvNames?: readonly string[];
  /** Where stdout/stderr logs go; defaults to `<cwd>/.legion-cli/cache/qa`. */
  logDir?: string;
  /** Log file stem, e.g. `unit`. */
  name?: string;
};

async function readLog(abs: string): Promise<string> {
  try {
    return await readFile(abs, "utf8");
  } catch {
    return "";
  }
}

/**
 * Run a QA command through the shared agents runner: argv-only, PATHEXT/.cmd-shim aware,
 * non-blocking, with API keys and tokens scrubbed from the environment (KD-4). Output is
 * streamed to log files and read back, so a chatty suite cannot overflow a buffer.
 */
export async function runCommand(cwd: string, command: string, opts?: QaCommandOptions): Promise<CommandCapture> {
  const parsed = parseCommandLine(command);
  if ("error" in parsed) {
    return { command, status: null, stdout: "", stderr: parsed.error, started: false, error: parsed.error };
  }
  const logDir = opts?.logDir ?? join(cwd, ".legion-cli", "cache", "qa");
  const name = opts?.name ?? "command";
  const stdoutPath = join(logDir, `${name}.stdout.log`);
  const stderrPath = join(logDir, `${name}.stderr.log`);
  const result = await runArgv(parsed.argv, {
    cwd,
    timeoutMs: opts?.timeoutMs ?? DEFAULT_QA_COMMAND_TIMEOUT_MS,
    logPath: stdoutPath,
    stderrPath,
    secretEnvNames: opts?.secretEnvNames,
  });
  if (!result.started) {
    const error = result.error ?? "did not start";
    return { command, status: null, stdout: "", stderr: error, started: false, error };
  }
  return {
    command,
    status: result.exitCode,
    stdout: await readLog(stdoutPath),
    stderr: await readLog(stderrPath),
    started: true,
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}

/**
 * A runner that timed out, was killed by a signal, or exited non-zero is not evidence of a pass,
 * even when its report lists only passes. A plain non-zero exit is tolerated only when the report
 * itself shows failed tests, because then the failures are already counted.
 */
function runnerFailClosedReason(capture: CommandCapture, report: unknown, label: string): string | undefined {
  if (!capture.started || capture.timedOut) return undefined; // reported by the caller's own warning
  if (capture.status === null) return `${label} command was killed by a signal; treated as failed`;
  if (capture.status === 0) return undefined;
  const failedCounted = report != null && parseTestReport(report).some((test) => !test.ok && !test.skipped);
  if (failedCounted) return undefined;
  return `${label} command exited with code ${capture.status} without a report of failed tests; treated as failed`;
}

export type RunProjectQaOptions = {
  projectRoot: string;
  spec: Pick<Spec, "id" | "acceptance" | "wireframesIndex">;
  mode: QaMode;
  unitCommand?: string;
  playwrightCommand?: string;
  id?: string;
  createdAt?: string;
  /** Configured `adapter.*.apiKeyEnv` names to scrub from the commands' environment. */
  secretEnvNames?: readonly string[];
  /** Per-command timeout; defaults to {@link DEFAULT_QA_COMMAND_TIMEOUT_MS}. */
  commandTimeoutMs?: number;
  specHash?: string;
  sourceHash?: string;
  /** Governed manual evidence from `qa checklist`, used only in no-browser mode. */
  manualPassedCriterionIds?: readonly string[];
};

export type ProjectQaResult = {
  score: QAScore;
  evidencePaths: string[];
  playwrightRan: boolean;
  /** e.g. "unit command did not start: pnpm: not found on PATH" */
  warnings: string[];
};

async function writeEvidence(projectRoot: string, abs: string, capture: CommandCapture): Promise<unknown> {
  const payload = extractJsonPayload(capture.stdout) ?? extractJsonPayload(capture.stderr);
  const body =
    payload !== null
      ? `${JSON.stringify(payload, null, 2)}\n`
      : capture.stdout || capture.stderr || `${JSON.stringify({ error: "no reporter json", status: capture.status })}\n`;
  await createLegionStore(projectRoot).withLock(() => writeTextFile(abs, body, { root: projectRoot }));
  return payload;
}

async function writeCaptureMetadata(
  projectRoot: string,
  abs: string,
  kind: "unit" | "playwright",
  capture: CommandCapture,
): Promise<void> {
  const body = {
    version: 1,
    kind,
    capture: {
      started: capture.started,
      status: capture.status,
      timedOut: capture.timedOut === true,
      ...(capture.error ? { error: capture.error } : {}),
    },
  };
  await createLegionStore(projectRoot).withLock(() =>
    writeTextFile(abs, `${JSON.stringify(body, null, 2)}\n`, { root: projectRoot }),
  );
}

export async function runProjectQa(opts: RunProjectQaOptions): Promise<ProjectQaResult> {
  const id = opts.id ?? `qa-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const qaDir = join(opts.projectRoot, ".legion-cli", "qa", "runs", id);
  await mkdir(qaDir, { recursive: true });
  const evidencePaths: string[] = [];

  const warnings: string[] = [];
  const timeoutMs = opts.commandTimeoutMs ?? DEFAULT_QA_COMMAND_TIMEOUT_MS;
  const commandOpts = { secretEnvNames: opts.secretEnvNames, timeoutMs };
  const unitCapture = await runCommand(opts.projectRoot, opts.unitCommand?.trim() || DEFAULT_UNIT_COMMAND, {
    ...commandOpts,
    logDir: qaDir,
    name: "unit",
  });
  if (!unitCapture.started) {
    // Scored P0 failed below (failClosed); say why instead of "your tests failed".
    warnings.push(`unit command did not start: ${unitCapture.error ?? "unknown error"}`);
  } else if (unitCapture.timedOut) {
    warnings.push(`unit command timed out after ${timeoutMs} ms and was stopped`);
  }
  const unitAbs = join(qaDir, "unit.json");
  const unitReport = await writeEvidence(opts.projectRoot, unitAbs, unitCapture);
  evidencePaths.push(`.legion-cli/qa/runs/${id}/unit.json`);
  await writeCaptureMetadata(opts.projectRoot, join(qaDir, "unit.meta.json"), "unit", unitCapture);
  evidencePaths.push(`.legion-cli/qa/runs/${id}/unit.meta.json`);

  if (opts.mode === "no-browser") {
    const manualEvidence = {
      version: 1,
      kind: "manual",
      specId: opts.spec.id,
      passedCriterionIds: [...new Set(opts.manualPassedCriterionIds ?? [])].sort(),
    };
    await createLegionStore(opts.projectRoot).withLock(() =>
      writeTextFile(join(qaDir, "manual.json"), `${JSON.stringify(manualEvidence, null, 2)}\n`, {
        root: opts.projectRoot,
      }),
    );
    evidencePaths.push(`.legion-cli/qa/runs/${id}/manual.json`);
  }

  const needsPlaywright = opts.mode === "full" && specHasUi(opts.spec);
  let playwrightReport: unknown;
  let playwrightRan = false;
  let playwrightCapture: CommandCapture | undefined;
  if (needsPlaywright) {
    const pwCapture = await runCommand(
      opts.projectRoot,
      opts.playwrightCommand?.trim() || DEFAULT_PLAYWRIGHT_COMMAND,
      { ...commandOpts, logDir: qaDir, name: "playwright" },
    );
    if (!pwCapture.started) {
      warnings.push(`playwright command did not start: ${pwCapture.error ?? "unknown error"}`);
    } else if (pwCapture.timedOut) {
      warnings.push(`playwright command timed out after ${timeoutMs} ms and was stopped`);
    }
    playwrightCapture = pwCapture;
    const pwAbs = join(qaDir, "playwright.json");
    playwrightReport = await writeEvidence(opts.projectRoot, pwAbs, pwCapture);
    evidencePaths.push(`.legion-cli/qa/runs/${id}/playwright.json`);
    await writeCaptureMetadata(opts.projectRoot, join(qaDir, "playwright.meta.json"), "playwright", pwCapture);
    evidencePaths.push(`.legion-cli/qa/runs/${id}/playwright.meta.json`);
    playwrightRan = Boolean(
      pwCapture.started && !pwCapture.timedOut && pwCapture.status === 0 && playwrightReport && typeof playwrightReport === "object",
    );
  }

  const unitReportFailed =
    !unitCapture.started || unitCapture.timedOut === true || unitCapture.status !== 0 || reportFailClosed(unitReport);
  const playwrightReportFailed = needsPlaywright
    ? !playwrightRan || reportFailClosed(playwrightReport)
    : false;
  const reportFailures = Number(unitReportFailed) + Number(playwrightReportFailed);
  const failClosed = reportFailures > 0;

  const unitReason = runnerFailClosedReason(unitCapture, unitReport, "unit");
  if (unitReason) {
    warnings.push(unitReason);
  }
  if (playwrightCapture) {
    const pwReason = runnerFailClosedReason(playwrightCapture, playwrightReport, "playwright");
    if (pwReason) {
      warnings.push(pwReason);
    }
  }
  const scoreOpts = {
    spec: opts.spec,
    mode: opts.mode,
    playwrightRan,
    unitReport,
    playwrightReport,
    id,
    createdAt: opts.createdAt,
    evidencePaths,
    failClosed,
    reportFailures,
    specHash: opts.specHash,
    sourceHash: opts.sourceHash,
    manualPassedCriterionIds: opts.mode === "no-browser" ? opts.manualPassedCriterionIds : undefined,
  };
  if (parseTestReport(unitReport).length + parseTestReport(playwrightReport).length === 0 && !failClosed) {
    warnings.push(ZERO_TESTS_REASON);
  }
  const score = scorePersistedReports(scoreOpts);
  return { score, evidencePaths, playwrightRan, warnings };
}
