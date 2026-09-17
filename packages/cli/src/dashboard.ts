import type { CliOpts } from "./io.js";
import { runServe, type ServeFlags } from "./serve.js";

export type DashboardFlags = Pick<ServeFlags, "open" | "port" | "expose" | "webmcp" | "tokenStdout">;

export async function runDashboard(opts: CliOpts, flags: DashboardFlags): Promise<number> {
  return runServe(opts, flags, { mcpHttp: false });
}
