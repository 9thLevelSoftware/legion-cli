import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { scrubSecretsEnv } from "./env-scrub.js";
import { quoteCmdArgForSpawn, resolveBinary, unwrapCmdShim } from "./which.js";

export type RunCommandOptions = {
  cwd: string;
  /**
   * Default: `process.env` with credentials removed (KD-4). `"inherit"` passes the full
   * environment; only brownfield evidence (the user's own `pnpm audit`) uses it.
   */
  env?: "scrubbed" | "inherit";
  /** Extra names to scrub, e.g. every configured `adapter.*.apiKeyEnv`. */
  secretEnvNames?: readonly string[];
  /** Extra variables set after scrubbing (e.g. `npm_config_ignore_scripts`). */
  envOverrides?: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** stdout (and stderr, unless `stderrPath` is set) are streamed here, never buffered. */
  logPath: string;
  stderrPath?: string;
};

export type RunCommandResult = {
  /** False when the process never ran: not found, refused, or a spawn error. */
  started: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: string;
  logPath: string;
};

export const ARGV_ONLY_MESSAGE = "verificationCommands are argv-only; split it into separate commands";

/** Split a command line into argv, honouring "double" and 'single' quotes. */
export function splitCommand(command: string): string[] {
  return tokenize(command).map((token) => token.value);
}

type Token = { value: string; quoted: boolean };

function tokenize(command: string): Token[] {
  const out: Token[] = [];
  const re = /"((?:\\"|[^"])*)"|'((?:\\'|[^'])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const quoted = match[3] === undefined;
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    out.push({ value: raw.replaceAll('\\"', '"').replaceAll("\\'", "'"), quoted });
  }
  return out;
}

const SHELL_OPERATOR_TOKEN = /^(?:&&|\|\||\||;|&|[0-9]?>>?|<)$/;
const SHELL_METACHAR = /[;|<>`]|\$\(|&&/;

/**
 * Parse a configured command string. There is no shell: `a && b`, pipes, redirects, `;`,
 * backticks and `$(` are refused rather than passed to the first program as arguments.
 */
export function parseCommandLine(command: string): { argv: string[] } | { error: string } {
  const tokens = tokenize(command);
  if (tokens.length === 0) return { error: "empty command" };
  for (const token of tokens) {
    if (token.quoted) continue;
    if (SHELL_OPERATOR_TOKEN.test(token.value) || SHELL_METACHAR.test(token.value)) {
      return { error: ARGV_ONLY_MESSAGE };
    }
  }
  return { argv: tokens.map((token) => token.value) };
}

/** cmd.exe would interpret these even inside quotes (`%VAR%`, `^`) or split on them. */
const CMD_UNSAFE_ARG = /[&|<>^%\r\n]/;

type Launch = { command: string; args: string[]; verbatim: boolean } | { error: string };

function planLaunch(argv: readonly string[], cwd: string): Launch {
  const [first, ...rest] = argv;
  if (!first) return { error: "empty command" };
  const hasSeparator = first.includes("/") || first.includes("\\");
  const candidate = hasSeparator && !isAbsolute(first) ? resolve(cwd, first) : first;
  const resolved = resolveBinary(candidate);
  if (!resolved) return { error: `${first}: not found on PATH` };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const unwrapped = unwrapCmdShim(resolved);
    if (unwrapped) {
      return { command: unwrapped.command, args: [...unwrapped.prefixArgs, ...rest], verbatim: false };
    }
    const unsafe = rest.find((arg) => CMD_UNSAFE_ARG.test(arg));
    if (unsafe !== undefined) {
      return { error: `${first} is a .cmd/.bat script; argument ${JSON.stringify(unsafe)} contains & | < > ^ % or a newline` };
    }
    const line = [resolved, ...rest].map(quoteCmdArgForSpawn).join(" ");
    // /s strips exactly the outer quote pair, so the line is quoted once more.
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
  }
  return { command: resolved, args: rest, verbatim: false };
}

function buildEnv(opts: RunCommandOptions): NodeJS.ProcessEnv {
  const env =
    opts.env === "inherit"
      ? { ...process.env }
      : scrubSecretsEnv(process.env, { extraNames: opts.secretEnvNames ?? [] });
  // A nested `node --test` inherits this and exits 0 without running anything.
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...opts.envOverrides };
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill("SIGKILL"));
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Run `argv` without a shell and without blocking the event loop. Resolves `argv[0]` through
 * PATH/PATHEXT; npm `.cmd` shims are unwrapped to node + script, and any other `.cmd`/`.bat`
 * runs via `%ComSpec% /d /s /c` with metacharacter arguments refused. Output streams to
 * `logPath`. On timeout the whole process tree is killed. Never throws for launch failures.
 */
export async function runCommand(argv: readonly string[], opts: RunCommandOptions): Promise<RunCommandResult> {
  const base = { logPath: opts.logPath, exitCode: null, signal: null, timedOut: false };
  const launch = planLaunch(argv, opts.cwd);
  if ("error" in launch) return { ...base, started: false, error: launch.error };

  let out: FileHandle | undefined;
  let err: FileHandle | undefined;
  try {
    await mkdir(dirname(opts.logPath), { recursive: true });
    out = await open(opts.logPath, "w");
    if (opts.stderrPath) {
      await mkdir(dirname(opts.stderrPath), { recursive: true });
      err = await open(opts.stderrPath, "w");
    }
  } catch (error) {
    await out?.close().catch(() => undefined);
    return { ...base, started: false, error: `cannot open log: ${(error as Error).message}` };
  }

  try {
    return await new Promise<RunCommandResult>((done) => {
      let child: ChildProcess;
      try {
        child = spawn(launch.command, launch.args, {
          cwd: opts.cwd,
          env: buildEnv(opts),
          stdio: ["ignore", out!.fd, (err ?? out)!.fd],
          windowsHide: true,
          shell: false,
          windowsVerbatimArguments: launch.verbatim,
          detached: process.platform !== "win32",
        });
      } catch (error) {
        done({ ...base, started: false, error: (error as Error).message });
        return;
      }
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, opts.timeoutMs);
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // An 'error' before 'spawn' means the process never started (ENOENT, EACCES, EINVAL).
        done({ ...base, started: child.pid !== undefined, error: error.message, timedOut });
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done({ ...base, started: true, exitCode: code, signal, timedOut });
      });
    });
  } finally {
    await out.close().catch(() => undefined);
    await err?.close().catch(() => undefined);
  }
}
