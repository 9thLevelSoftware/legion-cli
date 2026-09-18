import { createLegionEngine, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import { resolvePersistAdapter } from "./adapter-route.js";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export type TicketCreateFlags = {
  parent?: string;
  title?: string;
  fromAgent?: boolean;
  type?: string;
  priority?: string;
  adapter?: string;
  route?: string;
};

function parseType(raw: string | undefined, nextHint: string): "feature" | "fix" | "bug" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "fix" || raw === "bug" || raw === "feature") return raw;
  refuse("type must be feature | fix | bug", nextHint);
}

function parsePriority(raw: string | undefined, nextHint: string): "P0" | "P1" | "P2" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "P0" || raw === "P1" || raw === "P2") return raw;
  refuse("priority must be P0 | P1 | P2", nextHint);
}

export async function runTicketCreate(opts: CliOpts, flags: TicketCreateFlags): Promise<number> {
  const title = flags.title?.trim();
  if (!title) {
    refuse("ticket create requires --title", HINT.ticket(flags.parent ?? "TSK-x"));
  }
  const nextHint = HINT.ticket(flags.parent ?? "TSK-x");
  const type = parseType(flags.type, nextHint);
  const priority = parsePriority(flags.priority, nextHint);
  const engine = createLegionEngine(opts.project);
  const persisted = resolvePersistAdapter(await engine.store.readConfig(), flags);
  const ticket = await engine.fileTicket({
    title,
    parentId: flags.parent,
    fromAgent: Boolean(flags.fromAgent),
    type,
    priority,
    ...(persisted.adapter ? { adapter: persisted.adapter } : {}),
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
