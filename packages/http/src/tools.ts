import { Ajv } from "ajv";
import { HttpAdapterError } from "./errors.js";
import { parseToolArguments } from "./protocol.js";
import type { HttpToolHost } from "./types.js";

export const MAX_TOOL_ROUNDS = 32;
export const RUN_COMMAND_TIMEOUT_MS = 60_000;
export const MAX_RUN_COMMAND_BYTES = 64 * 1024;
export const MAX_TOOL_RESULT_CHARS = 64 * 1024;

const RUN_COMMAND_ALLOWLIST = new Set(["node", "nodejs", "pnpm", "npm", "npx", "pytest", "python", "python3", "go", "cargo"]);
/** argv[0] basenames that never run, even if later added to the allowlist. */
export const RUN_COMMAND_DENIED_BINS = [
  "git",
  "ssh",
  "chmod",
  "sudo",
  "cmd",
  "powershell",
  "pwsh",
  "curl",
  "wscript",
  "cscript",
] as const;
const RUN_COMMAND_DENYLIST = new Set<string>(RUN_COMMAND_DENIED_BINS);
const MAX_EXTERNAL_TOOL_SCHEMA_BYTES = 64 * 1024;
const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });

/** node -e / --eval (and -p) is arbitrary code; argv[0] allowlist is not enough. */
const NODE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "--eval-module"]);
const PYTHON_EVAL_FLAGS = new Set(["-c"]);
const NODE_EVAL_LETTERS = new Set(["e", "p"]);
const PYTHON_EVAL_LETTERS = new Set(["c"]);

function flagName(arg: string): string {
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : arg.slice(0, eq);
}

/** `-pe` / `-ep` / `-ic` are clustered short options, not a single unknown flag. */
function shortClusterHasLetter(arg: string, letters: Set<string>): boolean {
  if (!/^-[A-Za-z]+$/.test(arg)) return false;
  return [...arg.slice(1)].some((ch) => letters.has(ch));
}

function argsHaveDeniedFlag(args: readonly string[], denied: Set<string>, letters?: Set<string>): boolean {
  return args.some((arg) => {
    const name = flagName(arg);
    if (denied.has(name)) return true;
    return Boolean(letters && shortClusterHasLetter(name, letters));
  });
}

export type OpenAiTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenAiToolCall = {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
};

function commandBasename(bin: string): string {
  return bin.replaceAll("\\", "/").split("/").pop()?.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase() ?? "";
}

export function isRunCommandAllowed(argv: readonly string[]): boolean {
  const base = commandBasename(argv[0] ?? "");
  if (!base || RUN_COMMAND_DENYLIST.has(base)) return false;
  if (!RUN_COMMAND_ALLOWLIST.has(base)) return false;
  const rest = argv.slice(1);
  if ((base === "node" || base === "nodejs") && argsHaveDeniedFlag(rest, NODE_EVAL_FLAGS, NODE_EVAL_LETTERS)) {
    return false;
  }
  if (
    (base === "python" || base === "python3" || base === "pytest") &&
    argsHaveDeniedFlag(rest, PYTHON_EVAL_FLAGS, PYTHON_EVAL_LETTERS)
  ) {
    return false;
  }
  return true;
}

const FILE_PATH_PARAM = {
  type: "object",
  properties: {
    path: { type: "string", description: "Jail-relative POSIX path" },
  },
  required: ["path"],
} as const;

const READ_FILE: OpenAiTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a jail-relative POSIX file.",
    parameters: FILE_PATH_PARAM,
  },
};

const WRITE_FILE: OpenAiTool = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write a jail-relative POSIX file. Only allowedWrites succeed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Jail-relative POSIX path" },
        contents: { type: "string", description: "File contents" },
      },
      required: ["path", "contents"],
    },
  },
};

const LIST_DIR: OpenAiTool = {
  type: "function",
  function: {
    name: "list_dir",
    description: "List a jail-relative POSIX directory.",
    parameters: FILE_PATH_PARAM,
  },
};

const RUN_COMMAND: OpenAiTool = {
  type: "function",
  function: {
    name: "run_command",
    description: "Run an allowlisted argv array in the jail (shell: false).",
    parameters: {
      type: "object",
      properties: {
        argv: {
          type: "array",
          items: { type: "string" },
          description: "argv array; argv[0] basename must be allowlisted",
        },
      },
      required: ["argv"],
    },
  },
};

/** Chat is read-only JSON; file tools stay off. run_command is omitted unless the host is hardened. */
export function toolsForJob(skillId: string, host: HttpToolHost | undefined): OpenAiTool[] {
  if (!host || skillId === "chat") return [];
  const tools: OpenAiTool[] = [READ_FILE, WRITE_FILE, LIST_DIR];
  if (host.runCommand) tools.push(RUN_COMMAND);
  for (const tool of host.externalTools ?? []) {
    tools.push({
      type: "function",
      function: {
        name: tool.callName,
        description: tool.description ?? `Read-only MCP tool ${tool.namespacedName}`,
        parameters: tool.inputSchema,
      },
    });
  }
  return tools;
}

function hasRemoteRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRemoteRef);
  if (!value || typeof value !== "object") return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof nested === "string" && !nested.startsWith("#")) return true;
    if (hasRemoteRef(nested)) return true;
  }
  return false;
}

/** Validate the full advertised tool surface before a call is checkpointed or dispatched. */
export function validateToolCallArguments(
  call: OpenAiToolCall,
  host: HttpToolHost | undefined,
  skillId: string,
): Record<string, unknown> {
  const name = call.function?.name ?? "";
  const allowed = new Set(toolsForJob(skillId, host).map((tool) => tool.function.name));
  if (!allowed.has(name)) throw new HttpAdapterError(`adapter.http unknown tool ${name || "(empty)"}`);
  const args = parseToolArguments(call);
  const external = host?.externalTools?.find((tool) => tool.callName === name);
  if (!external) return args;
  let encoded: string;
  try {
    encoded = JSON.stringify(external.inputSchema);
  } catch (err) {
    throw new HttpAdapterError(`adapter.http invalid schema for external tool ${name}`, { cause: err });
  }
  if (encoded.length > MAX_EXTERNAL_TOOL_SCHEMA_BYTES || hasRemoteRef(external.inputSchema)) {
    throw new HttpAdapterError(`adapter.http invalid schema for external tool ${name}: schema is unbounded or has a remote ref`);
  }
  try {
    const validate = ajv.compile(external.inputSchema);
    if (!validate(args)) {
      const detail = validate.errors?.[0];
      throw new HttpAdapterError(
        `adapter.http invalid tool arguments for ${name}: ${detail?.instancePath || "/"} ${detail?.message ?? "schema mismatch"}`,
      );
    }
  } catch (err) {
    if (err instanceof HttpAdapterError) throw err;
    throw new HttpAdapterError(`adapter.http invalid schema for external tool ${name}`, { cause: err });
  }
  return args;
}

export function capToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n...truncated`;
}

function throwIfToolAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new HttpAdapterError("adapter.http tool dispatch aborted", { cause: signal.reason });
  }
}

export async function dispatchToolCall(
  call: OpenAiToolCall,
  host: HttpToolHost | undefined,
  skillId: string,
  signal?: AbortSignal,
): Promise<string> {
  const name = call.function?.name ?? "";
  if (!host) return "error: tool host is not available";
  let args: Record<string, unknown>;
  try {
    args = validateToolCallArguments(call, host, skillId);
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  throwIfToolAborted(signal);
  try {
    if (name === "read_file") {
      const output = await host.readFile(String(args.path ?? ""));
      throwIfToolAborted(signal);
      return capToolResult(output);
    }
    if (name === "write_file") {
      await host.writeFile(String(args.path ?? ""), String(args.contents ?? ""));
      throwIfToolAborted(signal);
      return "ok";
    }
    if (name === "list_dir") {
      const entries = await host.listDir(String(args.path ?? ""));
      throwIfToolAborted(signal);
      return capToolResult(entries.join("\n"));
    }
    if (name === "run_command") {
      const argv = Array.isArray(args.argv) ? args.argv.map((item) => String(item)) : [];
      if (!isRunCommandAllowed(argv)) {
        return "error: run_command argv is not allowlisted";
      }
      if (!host.runCommand) return "error: run_command requires a hardened sandbox";
      const result = await host.runCommand(argv, signal);
      throwIfToolAborted(signal);
      return capToolResult(JSON.stringify(result));
    }
    if (host.callExternalTool && host.externalTools?.some((tool) => tool.callName === name)) {
      const result = await host.callExternalTool(name, args, signal);
      throwIfToolAborted(signal);
      return capToolResult(result);
    }
  } catch (err) {
    throwIfToolAborted(signal);
    return capToolResult(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return `error: unknown tool ${name}`;
}
