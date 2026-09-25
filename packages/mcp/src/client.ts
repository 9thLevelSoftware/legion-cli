import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig, McpServersConfig } from "@9thlevelsoftware/legion-cli-schema";

export const MCP_POOL_MAX = 32;
export const MCP_CONNECT_TIMEOUT_MS = 10_000;

/** Host keys an MCP child may inherit. Declared `config.env` is merged on top. */
export const MCP_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "LOGNAME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMP",
  "TEMP",
  "TMPDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "windir",
  "PATHEXT",
  "ComSpec",
  "COMSPEC",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "ProgramFiles",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "USERNAME",
] as const;

export type McpFailReason = "unknown-server" | "spawn-failed" | "tool-error" | "parse-error" | "pool-full";

export class McpClientError extends Error {
  readonly reason: McpFailReason;
  constructor(reason: McpFailReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpClientError";
    this.reason = reason;
  }
}

export function buildMcpSpawnEnv(
  source: NodeJS.ProcessEnv = process.env,
  declared: Record<string, string> = {},
): Record<string, string> {
  const allow = new Set(MCP_ENV_ALLOWLIST.map((key) => key.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!allow.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(declared)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function isParseError(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /JSON|parse/i.test(message);
}

function asMcpError(err: unknown, fallback: McpFailReason): McpClientError {
  if (err instanceof McpClientError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new McpClientError(isParseError(err) ? "parse-error" : fallback, message, { cause: err });
}

export async function closeMcpTransports(
  transports: Iterable<{ close(): Promise<void> }>,
): Promise<void> {
  const errors: Error[] = [];
  for (const transport of transports) {
    try {
      await transport.close();
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "MCP transport close failed");
}

export type ExternalMcpTool = {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type ToolCallResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
  reason?: McpFailReason;
};

function errorResult(reason: McpFailReason, message: string): ToolCallResult {
  return {
    isError: true,
    reason,
    content: [{ type: "text", text: message }],
  };
}

export class LegionMcpClientPool {
  #clients = new Map<string, Client>();
  #transports = new Map<string, StdioClientTransport>();
  #failures = new Map<string, McpClientError>();
  #inflight = new Map<string, Promise<Client>>();
  #configs: McpServersConfig;

  constructor(configs: McpServersConfig = {}) {
    this.#configs = configs;
  }

  async getClient(serverName: string): Promise<Client | null> {
    const existing = this.#clients.get(serverName);
    if (existing) return existing;

    const config = this.#configs[serverName];
    if (!config || !config.command) return null;

    const failed = this.#failures.get(serverName);
    if (failed) throw failed;

    const inflight = this.#inflight.get(serverName);
    if (inflight) return inflight;

    const pending = this.#connect(serverName, config);
    this.#inflight.set(serverName, pending);
    try {
      return await pending;
    } finally {
      this.#inflight.delete(serverName);
    }
  }

  async #connect(serverName: string, config: McpServerConfig): Promise<Client> {
    const command = config.command;
    if (!command) {
      throw new McpClientError("unknown-server", `MCP server ${serverName} has no command`);
    }
    if (this.#clients.size >= MCP_POOL_MAX) {
      throw new McpClientError("pool-full", `MCP pool is full (${MCP_POOL_MAX})`);
    }

    const env = buildMcpSpawnEnv(process.env, config.env ?? {});
    const transport = new StdioClientTransport({
      command,
      args: config.args ?? [],
      env,
      stderr: "pipe",
    });

    const client = new Client({ name: "legion-cli", version: "0.0.0" }, { capabilities: {} });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new McpClientError("spawn-failed", "MCP connect timed out"));
        }, MCP_CONNECT_TIMEOUT_MS);
        const prevClose = transport.onclose;
        transport.onclose = () => {
          prevClose?.();
          clearTimeout(timer);
          reject(new McpClientError("spawn-failed", "MCP server exited during connect"));
        };
        client.connect(transport).then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (err: unknown) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });
      this.#clients.set(serverName, client);
      this.#transports.set(serverName, transport);
      return client;
    } catch (err) {
      try {
        await transport.close();
      } catch {
        // child already gone
      }
      try {
        await client.close();
      } catch {
        // connect never finished
      }
      const wrapped = asMcpError(err, "spawn-failed");
      this.#failures.set(serverName, wrapped);
      throw wrapped;
    }
  }

  async listAllTools(): Promise<ExternalMcpTool[]> {
    const tools: ExternalMcpTool[] = [];
    for (const serverName of Object.keys(this.#configs)) {
      try {
        const client = await this.getClient(serverName);
        if (!client) continue;
        const res = await client.listTools();
        for (const t of res.tools) {
          tools.push({
            serverName,
            name: `${serverName}:${t.name}`,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
          });
        }
      } catch (err) {
        const wrapped = asMcpError(err, "spawn-failed");
        this.#failures.set(serverName, wrapped);
      }
    }
    return tools;
  }

  async callTool(
    namespacedToolName: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolCallResult | null> {
    const colonIdx = namespacedToolName.indexOf(":");
    if (colonIdx < 0) return errorResult("unknown-server", "MCP tool name must be server:tool");
    const serverName = namespacedToolName.slice(0, colonIdx);
    const toolName = namespacedToolName.slice(colonIdx + 1);

    try {
      const client = await this.getClient(serverName);
      if (!client) return errorResult("unknown-server", `unknown MCP server ${serverName}`);
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });
      return result as ToolCallResult;
    } catch (err) {
      const wrapped = asMcpError(err, "tool-error");
      return errorResult(wrapped.reason, wrapped.message);
    }
  }

  async closeAll(): Promise<void> {
    const transports = [...this.#transports.values()];
    this.#clients.clear();
    this.#transports.clear();
    this.#failures.clear();
    this.#inflight.clear();
    await closeMcpTransports(transports);
  }
}
