import type { HttpToolHost } from "./types.js";

export const MAX_TOOL_ROUNDS = 32;
export const RUN_COMMAND_TIMEOUT_MS = 60_000;

const RUN_COMMAND_ALLOWLIST = new Set(["node", "pnpm", "npm", "npx", "pytest", "python", "go", "cargo"]);
const RUN_COMMAND_DENYLIST = new Set([
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
]);

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
  return RUN_COMMAND_ALLOWLIST.has(base);
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
  return tools;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(raw || "{}"));
  } catch {
    throw new Error("tool arguments are not JSON");
  }
}

export async function dispatchToolCall(
  call: OpenAiToolCall,
  host: HttpToolHost | undefined,
  skillId: string,
): Promise<string> {
  const name = call.function?.name ?? "";
  const allowed = new Set(toolsForJob(skillId, host).map((tool) => tool.function.name));
  if (!allowed.has(name)) {
    return `error: unknown tool ${name || "(empty)"}`;
  }
  if (!host) return "error: tool host is not available";
  let args: Record<string, unknown>;
  try {
    args = parseArgs(call.function.arguments ?? "");
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    if (name === "read_file") {
      return await host.readFile(String(args.path ?? ""));
    }
    if (name === "write_file") {
      await host.writeFile(String(args.path ?? ""), String(args.contents ?? ""));
      return "ok";
    }
    if (name === "list_dir") {
      const names = await host.listDir(String(args.path ?? ""));
      return names.join("\n");
    }
    if (name === "run_command") {
      const argv = Array.isArray(args.argv) ? args.argv.map((item) => String(item)) : [];
      if (!isRunCommandAllowed(argv)) {
        return "error: run_command argv is not allowlisted";
      }
      if (!host.runCommand) return "error: run_command requires a hardened sandbox";
      const result = await host.runCommand(argv);
      return JSON.stringify(result);
    }
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return `error: unknown tool ${name}`;
}
