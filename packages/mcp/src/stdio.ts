import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLegionMcpServer, type LegionMcpOptions } from "./server.js";

function waitForStdioClose(stdin: NodeJS.ReadStream, transport: StdioServerTransport): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stdin.once("end", done);
    stdin.once("close", done);
    const prev = transport.onclose;
    transport.onclose = () => {
      prev?.();
      done();
    };
  });
}

export async function serveLegionMcp(opts: LegionMcpOptions): Promise<void> {
  const server = await createLegionMcpServer(opts);
  const transport = new StdioServerTransport();
  const closed = waitForStdioClose(process.stdin, transport);
  await server.connect(transport);
  await closed;
  await server.close();
}
