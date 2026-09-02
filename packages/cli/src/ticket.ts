import { createLegionEngine, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export type TicketCreateFlags = {
  parent?: string;
  title?: string;
  fromAgent?: boolean;
  type?: string;
  priority?: string;
};

export async function runTicketCreate(opts: CliOpts, flags: TicketCreateFlags): Promise<number> {
  const title = flags.title?.trim();
  if (!title) {
    refuse("ticket create requires --title", HINT.ticket(flags.parent ?? "TSK-x"));
  }
  const type = flags.type === "fix" || flags.type === "bug" || flags.type === "feature" ? flags.type : undefined;
  const priority =
    flags.priority === "P0" || flags.priority === "P1" || flags.priority === "P2" ? flags.priority : undefined;
  const engine = createLegionEngine(opts.project);
  const ticket = await engine.fileTicket({
    title,
    parentId: flags.parent,
    fromAgent: Boolean(flags.fromAgent),
    type,
    priority,
  });
  if (opts.json) {
    writeJson({
      ok: true,
      id: ticket.id,
      parentId: ticket.parentId ?? null,
      next: "legion-cli next",
    });
    return 0;
  }
  writeOut(`Filed ${ticket.id}${ticket.parentId ? ` (parent ${ticket.parentId})` : ""}.`);
  writeOut("Extra work is a linked ticket, not an expansion.");
  writeOut("Next: legion-cli next");
  return 0;
}
