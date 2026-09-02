import { createLegionEngine, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export type PacketNewFlags = {
  title?: string;
  request?: string;
  requester?: string;
};

export type PacketRespondFlags = {
  message?: string;
  title?: string;
  type?: string;
  priority?: string;
};

function requesterOf(value: string | undefined): "pm" | "designer" | "human" {
  if (value === "designer" || value === "human" || value === "pm") return value;
  return "pm";
}

export async function runPacketNew(opts: CliOpts, flags: PacketNewFlags): Promise<number> {
  const title = flags.title?.trim();
  if (!title) {
    refuse("packet new requires --title", HINT.packet);
  }
  const engine = createLegionEngine(opts.project);
  const result = await engine.newPacket({
    title,
    request: flags.request,
    requester: requesterOf(flags.requester),
  });
  if (opts.json) {
    writeJson({
      ok: true,
      id: result.packet.id,
      path: result.path,
      status: result.packet.status,
      ticketIds: result.packet.ticketIds,
      next: HINT.packetRespond(result.packet.id),
    });
    return 0;
  }
  writeOut(`Filed ${result.packet.id}.`);
  writeOut(`Review packet: ${result.path}`);
  writeOut("Packets spawn tickets, not execute.");
  writeOut(`Next: ${HINT.packetRespond(result.packet.id)}`);
  return 0;
}

export async function runPacketRespond(opts: CliOpts, id: string, flags: PacketRespondFlags): Promise<number> {
  const packetId = id.trim();
  if (!packetId) {
    refuse("packet respond requires an id", HINT.packetRespond());
  }
  const type = flags.type === "fix" || flags.type === "bug" || flags.type === "feature" ? flags.type : undefined;
  const priority =
    flags.priority === "P0" || flags.priority === "P1" || flags.priority === "P2" ? flags.priority : undefined;
  const engine = createLegionEngine(opts.project);
  const result = await engine.respondPacket({
    id: packetId,
    message: flags.message,
    title: flags.title,
    type,
    priority,
  });
  const ticketIds = result.tickets.map((ticket) => ticket.id);
  if (opts.json) {
    writeJson({
      ok: true,
      id: result.packet.id,
      path: result.path,
      status: result.packet.status,
      ticketIds,
      next: "legion-cli next",
    });
    return 0;
  }
  writeOut(`Responded to ${result.packet.id}.`);
  writeOut(`Spawned ${ticketIds.join(", ") || "no tickets"} (not execute).`);
  writeOut("Packets spawn tickets, not execute.");
  writeOut("Next: legion-cli next");
  return 0;
}
