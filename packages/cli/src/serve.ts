import { closeMcpHttp, handleMcpHttp } from "@9thlevelsoftware/legion-cli-mcp";
import { resolveDashboardListen, startDashboard } from "@9thlevelsoftware/legion-cli-dashboard";
import type { CliOpts } from "./io.js";
import { writeErr, writeJson, writeOut } from "./io.js";

export type ServeFlags = {
  open?: boolean;
  port?: string;
  expose?: boolean;
  mcpHttp?: boolean;
  webmcp?: boolean;
  tokenStdout?: boolean;
};

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("invalid --port (0-65535)");
  }
  return port;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export async function runServe(opts: CliOpts, flags: ServeFlags): Promise<number> {
  const portFlag = parsePort(flags.port);
  const listen = await resolveDashboardListen(opts.project, {
    port: portFlag,
    expose: flags.expose,
  });
  const mcpHttp = flags.mcpHttp !== false;
  const handle = await startDashboard({
    projectRoot: opts.project,
    host: listen.host,
    port: listen.port,
    open: flags.open !== false,
    warn: writeErr,
    occupy: true,
    mcpHttp,
    webmcp: flags.webmcp === true,
    handleMcpHttp: mcpHttp ? handleMcpHttp : undefined,
    onClose: () => closeMcpHttp(),
  });

  if (opts.json) {
    writeJson({
      url: handle.url,
      bind: handle.host,
      port: handle.port,
      token: handle.token,
      sourceOfTruth: "cli",
      mcpHttp,
      mcpPath: mcpHttp ? "/mcp" : null,
    });
  } else {
    const lines = [`Viewer: ${handle.url}`];
    if (mcpHttp) lines.push(`MCP HTTP: ${handle.url}/mcp (read-only tools).`);
    lines.push(
      "Read-only viewer. Writes are CLI or token-gated HTTP POST (ticket|wikiTrust|qaChecklist). CLI remains the source of truth.",
    );
    writeOut(lines.join("\n"));
    if (flags.tokenStdout) writeOut(`Write token: ${handle.token}`);
  }

  await waitForSignal();
  await handle.close();
  return 0;
}
