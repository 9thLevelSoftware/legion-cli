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
  if (value === undefined || value.trim() === "") return "pm";
  if (value === "designer" || value === "human" || value === "pm") return value;
  refuse("requester must be pm | designer | human", HINT.packet);
}

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
  const nextHint = HINT.packetRespond(packetId);
  const type = parseType(flags.type, nextHint);
  const priority = parsePriority(flags.priority, nextHint);
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
