import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServersConfig } from "@9thlevelsoftware/legion-cli-schema";

export type ExternalMcpTool = {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type ToolCallResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};

export class LegionMcpClientPool {
  #clients = new Map<string, Client>();
  #transports = new Map<string, StdioClientTransport>();
  #configs: McpServersConfig;

  constructor(configs: McpServersConfig = {}) {
    this.#configs = configs;
  }

  async getClient(serverName: string): Promise<Client | null> {
    const existing = this.#clients.get(serverName);
    if (existing) return existing;

    const config = this.#configs[serverName];
    if (!config || !config.command) return null;

    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
      }
      for (const [k, v] of Object.entries(config.env ?? {})) {
        if (v !== undefined) env[k] = v;
      }

      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env,
      });

      const client = new Client(
        { name: "legion-cli", version: "0.0.0" },
        { capabilities: {} },
      );

      await client.connect(transport);
      this.#clients.set(serverName, client);
      this.#transports.set(serverName, transport);
      return client;
    } catch {
      return null;
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
      } catch {
        // server unreachable or error
      }
    }
    return tools;
  }

  async callTool(
    namespacedToolName: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolCallResult | null> {
    const colonIdx = namespacedToolName.indexOf(":");
    if (colonIdx < 0) return null;
    const serverName = namespacedToolName.slice(0, colonIdx);
    const toolName = namespacedToolName.slice(colonIdx + 1);

    const client = await this.getClient(serverName);
    if (!client) return null;

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });
      return result as ToolCallResult;
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      };
    }
  }

  async closeAll(): Promise<void> {
    for (const [, transport] of this.#transports) {
      try {
        await transport.close();
      } catch {
        // ignore
      }
    }
    this.#clients.clear();
    this.#transports.clear();
  }
}
