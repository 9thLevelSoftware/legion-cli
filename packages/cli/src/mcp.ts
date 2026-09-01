import { serveLegionMcp } from "@9thlevelsoftware/legion-cli-mcp";
import type { CliOpts } from "./io.js";

export async function runMcp(opts: CliOpts): Promise<number> {
  await serveLegionMcp({ projectRoot: opts.project });
  return 0;
}
