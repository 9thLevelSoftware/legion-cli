import { spawnSync } from "node:child_process";

export type VerificationRun = {
  command: string;
  ok: boolean;
  status: number | null;
};

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

/** `cwd` = project, `shell: false`. Missing executable is an engine bug. */
export function runVerificationCommands(cwd: string, commands: readonly string[]): VerificationRun[] {
  const runs: VerificationRun[] = [];
  for (const command of commands) {
    const argv = splitCommand(command);
    if (argv.length === 0) {
      throw new Error("verificationCommands entry is empty (engine bug)");
    }
    const env = { ...process.env };
    // Nested `node --test` inherits this and exits 0 without running the file.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      env,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`verificationCommands executable missing: ${argv[0]} (engine bug)`);
      }
      throw result.error;
    }
    const run: VerificationRun = { command, ok: result.status === 0, status: result.status };
    runs.push(run);
    if (!run.ok) break;
  }
  return runs;
}
