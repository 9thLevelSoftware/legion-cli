import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentError } from "./errors.js";

export function assertSafeRunId(runId: string): string {
  if (!runId || runId !== runId.trim() || /[\\/]/.test(runId) || runId.includes("..")) {
    throw new AgentError(`invalid runId: ${runId}`);
  }
  return runId;
}

export function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

export function assertRepoRelative(path: string): string {
  const posix = toPosixPath(path).replace(/^\.\//, "");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    throw new AgentError(`path is outside the project workspace: ${path}`);
  }
  const parts = posix.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".")) {
    throw new AgentError(`path is outside the project workspace: ${path}`);
  }
  return posix;
}

export type RunCachePaths = {
  cacheDir: string;
  runDir: string;
  skillDir: string;
  skillMd: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  summaryPath: string;
  posix: {
    prompt: string;
    skill: string;
    summary: string;
  };
};

export function runCachePaths(projectRoot: string, runId: string): RunCachePaths {
  const id = assertSafeRunId(runId);
  const cacheDir = join(projectRoot, ".legion-cli", "cache");
  const runDir = join(cacheDir, "runs", id);
  const skillDir = join(cacheDir, "skills", id);
  return {
    cacheDir,
    runDir,
    skillDir,
    skillMd: join(skillDir, "SKILL.md"),
    promptPath: join(runDir, "prompt.md"),
    stdoutPath: join(runDir, "stdout.log"),
    stderrPath: join(runDir, "stderr.log"),
    summaryPath: join(runDir, "summary.md"),
    posix: {
      prompt: `.legion-cli/cache/runs/${id}/prompt.md`,
      skill: `.legion-cli/cache/skills/${id}/SKILL.md`,
      summary: `.legion-cli/cache/runs/${id}/summary.md`,
    },
  };
}

export async function writeRunPrompt(opts: {
  projectRoot: string;
  runId: string;
  body: string;
  /** When compose already included DESIGN.md / package files. */
  skipDesignAppend?: boolean;
}): Promise<string> {
  const paths = runCachePaths(opts.projectRoot, opts.runId);
  await mkdir(paths.runDir, { recursive: true });
  let body = opts.body.endsWith("\n") ? opts.body : `${opts.body}\n`;
  if (!opts.skipDesignAppend) {
    const designPath = join(opts.projectRoot, ".legion-cli", "design", "DESIGN.md");
    try {
      const design = await readFile(designPath, "utf8");
      const text = design.endsWith("\n") ? design : `${design}\n`;
      body += `\n## DESIGN.md\n\n${text}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  await writeFile(paths.promptPath, body, "utf8");
  return paths.promptPath;
}
