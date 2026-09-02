import { SCHEMA_VERSION, type Packet } from "@9thlevelsoftware/legion-cli-schema";
import type { NewPacket } from "./types.js";

export function nextPacketId(existing: readonly string[]): string {
  let max = 0;
  for (const id of existing) {
    const match = /^PKT-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `PKT-${String(max + 1).padStart(4, "0")}`;
}

export function packetFromInput(
  id: string,
  input: NewPacket,
  opts: { specId?: string | null; createdAt: string },
): Packet {
  const requester =
    input.requester === "designer" || input.requester === "human" || input.requester === "pm"
      ? input.requester
      : "pm";
  return {
    schemaVersion: SCHEMA_VERSION.packet,
    id,
    title: input.title.trim(),
    status: "open",
    requester,
    request: input.request?.trim() ?? "",
    specId: opts.specId ?? null,
    ticketIds: [],
    createdAt: opts.createdAt,
    respondedAt: null,
    response: null,
  };
}

export function packetMarkdownBody(packet: Packet): string {
  const lines = [`Requested by ${packet.requester}.`, ""];
  if (packet.request.trim()) {
    lines.push(packet.request.trim(), "");
  }
  if (packet.status === "responded") {
    const response = packet.response?.trim() || "Spawned tickets for this request.";
    lines.push("## Response", "", response, "");
    if (packet.ticketIds.length > 0) {
      lines.push(`Spawned tickets: ${packet.ticketIds.join(", ")}.`, "");
    }
    lines.push("Packets spawn tickets, not execute.", "");
  }
  return `${lines.join("\n")}`;
}
