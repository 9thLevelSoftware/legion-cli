import {
  resolveDashboardListen,
  startDashboard,
} from "@9thlevelsoftware/legion-cli-dashboard";
import type { CliOpts } from "./io.js";
import { writeErr, writeJson, writeOut } from "./io.js";

export type DashboardFlags = {
  open?: boolean;
  port?: string;
  expose?: boolean;
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

export async function runDashboard(opts: CliOpts, flags: DashboardFlags): Promise<number> {
  const portFlag = parsePort(flags.port);
  const listen = await resolveDashboardListen(opts.project, {
    port: portFlag,
    expose: flags.expose,
  });
  const handle = await startDashboard({
    projectRoot: opts.project,
    host: listen.host,
    port: listen.port,
    open: flags.open !== false,
    warn: writeErr,
  });

  if (opts.json) {
    writeJson({
      url: handle.url,
      bind: handle.host,
      port: handle.port,
      readOnly: true,
    });
  } else {
    writeOut(`Viewer: ${handle.url}`);
    writeOut("Read-only. No POST. Run CLI verbs to change state.");
  }

  await waitForSignal();
  await handle.close();
  return 0;
}
