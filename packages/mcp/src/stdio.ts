import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLegionMcpServer, type LegionMcpOptions } from "./server.js";

export async function serveLegionMcp(opts: LegionMcpOptions): Promise<void> {
  const server = createLegionMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
