import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  loadSnapshot,
  renderAudit,
  renderGraph,
  renderKanban,
  renderSpec,
} from "@9thlevelsoftware/legion-cli-dashboard";
import type { LegionReader } from "@9thlevelsoftware/legion-cli-persist";
import { readStatus } from "./reader.js";

export const MCP_APP_MIME = "text/html;profile=mcp-app";

export const MCP_APP_RESOURCES = [
  {
    uri: "ui://legion-cli/dashboard",
    name: "dashboard",
    title: "Dashboard",
    description: "Read-only kanban viewer. Text fallback is legion-cli status.",
  },
  {
    uri: "ui://legion-cli/spec",
    name: "spec",
    title: "Spec",
    description: "Active SPEC + PRD viewer.",
  },
  {
    uri: "ui://legion-cli/graph",
    name: "graph",
    title: "Task graph",
    description: "Task DAG viewer.",
  },
  {
    uri: "ui://legion-cli/audit",
    name: "audit",
    title: "Audit",
    description: "Audit trail viewer.",
  },
] as const;

export type McpAppName = (typeof MCP_APP_RESOURCES)[number]["name"];

/** Host CSP for MCP Apps HTML: no extra origins, only 'self'. */
export const MCP_APP_CSP = {
  connectDomains: ["'self'"],
  resourceDomains: ["'self'"],
} as const;

export function formatStatusFallback(status: Awaited<ReturnType<typeof readStatus>>): string {
  if (!status.name) {
    return [
      `phase: ${status.phase}`,
      `Next up: ${status.next.hint}`,
      `Run:  ${status.next.run}`,
      "Supported command: pnpm exec legion-cli",
    ].join("\n");
  }
  const lines = [`${status.name}  ·  ${status.mode}  ·  phase: ${status.phase}`];
  if (status.currentTaskId) lines.push(`Current task: ${status.currentTaskId}`);
  if (status.lastReadiness) lines.push(`Readiness: ${status.lastReadiness}`);
  if (status.lastReview) lines.push(`Review: ${status.lastReview}`);
  lines.push(`Next up: ${status.next.hint}`);
  lines.push(`Run:  ${status.next.run}`);
  lines.push(`Viewer: ${status.viewer}  (legion-cli dashboard)`);
  if (status.blockers.length > 0) {
    lines.push("Blockers:");
    for (const item of status.blockers) lines.push(`  ${item.detail}`);
  }
  return lines.join("\n");
}

async function htmlForPage(projectRoot: string, page: McpAppName): Promise<string> {
  const snapshot = await loadSnapshot(projectRoot, { rebuild: false });
  if (page === "spec") return renderSpec(snapshot, "");
  if (page === "graph") return renderGraph(snapshot, "");
  if (page === "audit") return renderAudit(snapshot, "");
  return renderKanban(snapshot, "");
}

export async function readAppContents(store: LegionReader, page: McpAppName, uri: string) {
  const fallback = formatStatusFallback(await readStatus(store));
  const html = await htmlForPage(store.projectRoot, page);
  return [
    {
      uri,
      mimeType: "text/plain; charset=utf-8",
      text: fallback,
    },
    {
      uri,
      mimeType: MCP_APP_MIME,
      text: html,
      _meta: {
        ui: {
          csp: MCP_APP_CSP,
        },
      },
    },
  ];
}

export function registerMcpApps(server: McpServer, store: LegionReader): void {
  for (const app of MCP_APP_RESOURCES) {
    server.registerResource(
      app.name,
      app.uri,
      {
        title: app.title,
        description: app.description,
        mimeType: MCP_APP_MIME,
      },
      async (uri) => ({
        contents: await readAppContents(store, app.name, uri.href),
      }),
    );
  }
}
