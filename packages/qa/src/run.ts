import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { QAScore, Spec } from "@9thlevelsoftware/legion-cli-schema";
import { extractJsonPayload, reportFailClosed } from "./reports.js";
import { scoreSpecReports, type QaMode } from "./score.js";
import { specHasUi } from "./tags.js";

export const DEFAULT_UNIT_COMMAND = "pnpm test -- --reporter=json";
export const DEFAULT_PLAYWRIGHT_COMMAND = "pnpm exec playwright test --reporter=json";

export function splitCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\"|[^"])*)"|'((?:\\'|[^'])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    out.push(raw.replaceAll('\\"', '"').replaceAll("\\'", "'"));
  }
  return out;
}

export type CommandCapture = {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
  started: boolean;
};

function spawnArgv(argv: string[], cwd: string): ReturnType<typeof spawnSync> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    env,
  });
}

export function runCommand(cwd: string, command: string): CommandCapture {
  const argv = splitCommand(command);
  if (argv.length === 0) {
    return { command, status: null, stdout: "", stderr: "empty command", started: false };
  }
  let result = spawnArgv(argv, cwd);
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT" && process.platform === "win32") {
    const exe = argv[0].toLowerCase();
    if (!exe.endsWith(".cmd") && !exe.endsWith(".exe")) {
      result = spawnArgv([`${argv[0]}.cmd`, ...argv.slice(1)], cwd);
    }
  }
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (result.error) {
    return {
      command,
      status: null,
      stdout,
      stderr: stderr || result.error.message,
      started: (result.error as NodeJS.ErrnoException).code !== "ENOENT",
    };
  }
  return {
    command,
    status: result.status,
    stdout,
    stderr,
    started: true,
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
};

export type ProjectQaResult = {
  score: QAScore;
  evidencePaths: string[];
  playwrightRan: boolean;
};

async function writeEvidence(abs: string, capture: CommandCapture): Promise<unknown> {
  const payload = extractJsonPayload(capture.stdout) ?? extractJsonPayload(capture.stderr);
  const body =
    payload !== null
      ? `${JSON.stringify(payload, null, 2)}\n`
      : capture.stdout || capture.stderr || `${JSON.stringify({ error: "no reporter json", status: capture.status })}\n`;
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, body, "utf8");
  return payload;
}

export async function runProjectQa(opts: RunProjectQaOptions): Promise<ProjectQaResult> {
  const qaDir = join(opts.projectRoot, ".legion-cli", "qa");
  await mkdir(qaDir, { recursive: true });
  const evidencePaths: string[] = [];

  const unitCapture = runCommand(opts.projectRoot, opts.unitCommand?.trim() || DEFAULT_UNIT_COMMAND);
  const unitAbs = join(qaDir, "unit.json");
  const unitReport = await writeEvidence(unitAbs, unitCapture);
  evidencePaths.push(".legion-cli/qa/unit.json");

  const needsPlaywright = opts.mode === "full" && specHasUi(opts.spec);
  let playwrightReport: unknown;
  let playwrightRan = false;
  if (needsPlaywright) {
    const pwCapture = runCommand(opts.projectRoot, opts.playwrightCommand?.trim() || DEFAULT_PLAYWRIGHT_COMMAND);
    const pwAbs = join(qaDir, "playwright.json");
    playwrightReport = await writeEvidence(pwAbs, pwCapture);
    evidencePaths.push(".legion-cli/qa/playwright.json");
    playwrightRan = Boolean(pwCapture.started && playwrightReport && typeof playwrightReport === "object");
  }

  const failClosed = !unitCapture.started || reportFailClosed(unitReport);
  const score = scoreSpecReports({
    spec: opts.spec,
    mode: opts.mode,
    playwrightRan,
    unitReport,
    playwrightReport,
    id: opts.id,
    createdAt: opts.createdAt,
    evidencePaths,
    failClosed,
  });
  return { score, evidencePaths, playwrightRan };
}
