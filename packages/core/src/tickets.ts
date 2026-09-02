import { mergeFilesForbidden } from "@9thlevelsoftware/legion-cli-graph";
import {
  AdapterIdSchema,
  SCHEMA_VERSION,
  type AdapterId,
  type FileContract,
  type Task,
} from "@9thlevelsoftware/legion-cli-schema";
import type { NewTicket } from "./types.js";

export function nextTaskId(existing: readonly string[]): string {
  let max = 0;
  for (const id of existing) {
    const match = /^TSK-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `TSK-${String(max + 1).padStart(4, "0")}`;
}

export function defaultTicketContract(id: string, partial?: Partial<FileContract>): FileContract {
  const filesAllowed =
    partial?.filesAllowed && partial.filesAllowed.length > 0 ? [...partial.filesAllowed] : [`notes/${id}.md`];
  const expectedArtifacts =
    partial?.expectedArtifacts && partial.expectedArtifacts.length > 0
      ? [...partial.expectedArtifacts]
      : [...filesAllowed];
  const verificationCommands =
    partial?.verificationCommands && partial.verificationCommands.length > 0
      ? [...partial.verificationCommands]
      : ["pnpm test"];
  return {
    filesAllowed,
    filesForbidden: mergeFilesForbidden(partial?.filesForbidden ?? []),
    expectedArtifacts,
    verificationCommands,
    maxFilesTouched: partial?.maxFilesTouched ?? 20,
  };
}

export function ticketFromInput(id: string, specId: string, input: NewTicket): Task {
  return {
    schemaVersion: SCHEMA_VERSION.task,
    id,
    title: input.title.trim(),
    status: "todo",
    type: input.type ?? "feature",
    priority: input.priority ?? "P2",
    specId,
    adapter: input.adapter,
    parentId: input.parentId,
    blockedBy: input.parentId ? [input.parentId] : [],
    blocks: [],
    contract: defaultTicketContract(id, input.contract),
    assignee: input.fromAgent ? "agent" : "human",
    notes: input.notes ?? (input.fromAgent ? "Filed from agent extra work." : ""),
  };
}

export function parseExtraJson(raw: unknown): NewTicket[] {
  const items = Array.isArray(raw) ? raw : [raw];
  const tickets: NewTicket[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.title !== "string" || rec.title.trim().length === 0) continue;
    tickets.push({
      title: rec.title,
      parentId: typeof rec.parentId === "string" ? rec.parentId : undefined,
      fromAgent: true,
      type: rec.type === "fix" || rec.type === "bug" || rec.type === "feature" ? rec.type : undefined,
      priority: rec.priority === "P0" || rec.priority === "P1" || rec.priority === "P2" ? rec.priority : undefined,
      notes: typeof rec.notes === "string" ? rec.notes : undefined,
      adapter:
        typeof rec.adapter === "string" && AdapterIdSchema.safeParse(rec.adapter).success
          ? (rec.adapter as AdapterId)
          : undefined,
      contract: {
        filesAllowed: Array.isArray(rec.filesAllowed)
          ? rec.filesAllowed.filter((path): path is string => typeof path === "string")
          : undefined,
        expectedArtifacts: Array.isArray(rec.expectedArtifacts)
          ? rec.expectedArtifacts.filter((path): path is string => typeof path === "string")
          : undefined,
        verificationCommands: Array.isArray(rec.verificationCommands)
          ? rec.verificationCommands.filter((cmd): cmd is string => typeof cmd === "string")
          : undefined,
      },
    });
  }
  return tickets;
}

export function taskMarkdownBody(task: Task): string {
  const parent = task.parentId ? `Parent: ${task.parentId}.\n` : "";
  return `${parent}${task.title}\n`;
}
