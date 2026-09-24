import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCommandLine, runCommand as runArgv, splitCommand } from "@9thlevelsoftware/legion-cli-agents";
import { createLegionStore, writeTextFile } from "@9thlevelsoftware/legion-cli-persist";
import type { QAScore, Spec } from "@9thlevelsoftware/legion-cli-schema";
import { extractJsonPayload, reportFailClosed } from "./reports.js";
import { scoreQa, scoreSpecReports, ZERO_TESTS_REASON, type QaMode } from "./score.js";
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

export async function runProjectQa(opts: RunProjectQaOptions): Promise<ProjectQaResult> {
  const qaDir = join(opts.projectRoot, ".legion-cli", "qa");
  await mkdir(qaDir, { recursive: true });
  const evidencePaths: string[] = [];

  const warnings: string[] = [];
  const timeoutMs = opts.commandTimeoutMs ?? DEFAULT_QA_COMMAND_TIMEOUT_MS;
  const commandOpts = { secretEnvNames: opts.secretEnvNames, timeoutMs };
  const unitCapture = await runCommand(opts.projectRoot, opts.unitCommand?.trim() || DEFAULT_UNIT_COMMAND, {
    ...commandOpts,
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
  evidencePaths.push(".legion-cli/qa/unit.json");

  const needsPlaywright = opts.mode === "full" && specHasUi(opts.spec);
  let playwrightReport: unknown;
  let playwrightRan = false;
  if (needsPlaywright) {
    const pwCapture = await runCommand(
      opts.projectRoot,
      opts.playwrightCommand?.trim() || DEFAULT_PLAYWRIGHT_COMMAND,
      { ...commandOpts, name: "playwright" },
    );
    if (!pwCapture.started) {
      warnings.push(`playwright command did not start: ${pwCapture.error ?? "unknown error"}`);
    } else if (pwCapture.timedOut) {
      warnings.push(`playwright command timed out after ${timeoutMs} ms and was stopped`);
    }
    const pwAbs = join(qaDir, "playwright.json");
    playwrightReport = await writeEvidence(opts.projectRoot, pwAbs, pwCapture);
    evidencePaths.push(".legion-cli/qa/playwright.json");
    playwrightRan = Boolean(pwCapture.started && playwrightReport && typeof playwrightReport === "object");
  }

  const failClosed = !unitCapture.started || reportFailClosed(unitReport);
  const scoreOpts = {
    spec: opts.spec,
    mode: opts.mode,
    playwrightRan,
    unitReport,
    playwrightReport,
    id: opts.id,
    createdAt: opts.createdAt,
    evidencePaths,
    failClosed,
  };
  let score;
  try {
    score = scoreSpecReports(scoreOpts);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ZERO_TESTS_REASON) throw err;
    if (!failClosed) warnings.push(ZERO_TESTS_REASON);
    score = scoreQa({
      specId: opts.spec.id,
      mode: opts.mode,
      specHasUi: specHasUi(opts.spec),
      playwrightRan,
      tests: [{ title: `${ZERO_TESTS_REASON} @p0`, ok: false, skipped: false, visualFailure: false, priority: "P0" }],
      id: opts.id,
      createdAt: opts.createdAt,
      evidencePaths,
      failClosed: true,
    });
  }
  return { score, evidencePaths, playwrightRan, warnings };
}
