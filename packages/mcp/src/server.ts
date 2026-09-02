import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerMcpApps } from "./apps.js";
import {
  createReaderStore,
  McpReadError,
  readAuditTrail,
  readBrief,
  readCurrentTask,
  readFeatureFlags,
  readSearch,
  readShow,
  readStatus,
  readTaskGraph,
  readWikiBacklinks,
} from "./reader.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string };

export const MCP_TOOLS = [
  "legion_cli_status",
  "legion_cli_search",
  "legion_cli_show",
  "legion_cli_task_graph",
  "legion_cli_brief",
  "legion_cli_current_task",
  "legion_cli_audit_trail",
  "legion_cli_wiki_backlinks",
] as const;

export type McpToolName = (typeof MCP_TOOLS)[number];

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export type LegionMcpOptions = {
  projectRoot: string;
};

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

async function runRead<T>(fn: () => Promise<T>) {
  try {
    return jsonResult(await fn());
  } catch (err) {
    if (err instanceof McpReadError) return errorResult(err);
    return errorResult(err);
  }
}

export async function createLegionMcpServer(opts: LegionMcpOptions): Promise<McpServer> {
  const store = createReaderStore(opts.projectRoot);
  const flags = await readFeatureFlags(store);
  const server = new McpServer({
    name: "legion-cli",
    version: pkg.version,
  });

  server.registerTool(
    "legion_cli_status",
    {
      title: "Status",
      description: "Where the Legion CLI project is: phase, current task, next command, blockers.",
      annotations: READ_ONLY,
      ...(flags.mcpApps ?
        { _meta: { ui: { resourceUri: "ui://legion-cli/dashboard" } } }
      : {}),
    },
    async () => runRead(() => readStatus(store)),
  );

  server.registerTool(
    "legion_cli_search",
    {
      title: "Search wiki",
      description: "Search the wiki. Untrusted bodies are omitted unless includeUntrusted is true.",
      inputSchema: {
        q: z.string().describe("keyword query"),
        includeUntrusted: z.boolean().optional().describe("search untrusted bodies"),
        mentions: z.boolean().optional().describe("pages that wikilink to this page"),
      },
      annotations: READ_ONLY,
    },
    async ({ q, includeUntrusted, mentions }) =>
      runRead(() => readSearch(store, q, { includeUntrusted, mentions })),
  );

  server.registerTool(
    "legion_cli_show",
    {
      title: "Show page",
      description: "Open one wiki, spec, task, decision, or assumption page.",
      inputSchema: {
        page: z.string().describe("wiki page, spec, or task"),
      },
      annotations: READ_ONLY,
    },
    async ({ page }) => runRead(() => readShow(store, page)),
  );

  server.registerTool(
    "legion_cli_task_graph",
    {
      title: "Task graph",
      description: "Active-spec task DAG with blockedBy/blocks and ready flags.",
      inputSchema: {
        specId: z.string().optional().describe("spec id; defaults to STATE.activeSpecId"),
      },
      annotations: READ_ONLY,
    },
    async ({ specId }) => runRead(() => readTaskGraph(store, specId)),
  );

  server.registerTool(
    "legion_cli_brief",
    {
      title: "Session brief",
      description: "Print what the next agent will see (wiki + decisions + current task).",
      annotations: READ_ONLY,
    },
    async () => runRead(() => readBrief(store)),
  );

  server.registerTool(
    "legion_cli_current_task",
    {
      title: "Current task",
      description: "The in-progress task from STATE.currentTaskId, if any.",
      annotations: READ_ONLY,
    },
    async () => runRead(() => readCurrentTask(store)),
  );

  server.registerTool(
    "legion_cli_audit_trail",
    {
      title: "Audit trail",
      description: "Read .legion-cli/audit/events.jsonl (empty if none).",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("max events to return (default 100)"),
      },
      annotations: READ_ONLY,
    },
    async ({ limit }) => runRead(() => readAuditTrail(store, limit)),
  );

  server.registerTool(
    "legion_cli_wiki_backlinks",
    {
      title: "Wiki backlinks",
      description: "Pages that wikilink to the given wiki page.",
      inputSchema: {
        page: z.string().describe("wiki page id, path, or title"),
      },
      annotations: READ_ONLY,
    },
    async ({ page }) => runRead(() => readWikiBacklinks(store, page)),
  );

  if (flags.mcpApps) {
    registerMcpApps(server, store);
  }

  return server;
}
