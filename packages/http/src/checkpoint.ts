import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HttpAdapterError } from "./errors.js";
import { parseToolArguments, toolCallSignature } from "./protocol.js";
import { dispatchToolCall, type OpenAiToolCall } from "./tools.js";
import type { HttpToolHost } from "./types.js";
import type { HttpAgentUsage } from "./types.js";

export const HTTP_CHECKPOINT_VERSION = 1 as const;

export type HttpCheckpointIdentities = {
  promptHash: string;
  configHash: string;
  contractHash: string;
  sourceIdentity: string;
  jailIdentity: string;
};

export type HttpToolOutcome = {
  id: string;
  signature: string;
  name: string;
  arguments: string;
  status: "pending" | "completed";
  result?: string;
};

export type HttpCheckpoint = {
  version: typeof HTTP_CHECKPOINT_VERSION;
  runId: string;
  identities: HttpCheckpointIdentities;
  conversation: Array<Record<string, unknown>>;
  round: number;
  toolOutcomes: HttpToolOutcome[];
  usage: HttpAgentUsage & { model: string };
  /** Internal monotonic completeness flags; once incomplete, later rounds cannot make accounting exact. */
  usageAccounting?: { tokenTotalIncomplete: boolean; tokenLowerBound: number; costIncomplete: boolean };
  request?: { status: "dispatching"; round: number; requestHash: string };
  completion: { status: "running" | "complete"; summary?: string };
  updatedAt: string;
};

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableHash(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return sha256Text(JSON.stringify(normalize(value)));
}

export function checkpointPath(cwd: string, runId: string): string {
  return join(cwd, ".legion-cli", "cache", "runs", runId, "http-checkpoint.json");
}

export function assertCompatibleCheckpoint(
  checkpoint: Pick<HttpCheckpoint, "version" | "runId" | "identities">,
  expected: HttpCheckpointIdentities,
): void {
  if (checkpoint.version !== HTTP_CHECKPOINT_VERSION) {
    throw new HttpAdapterError(`adapter.http checkpoint version mismatch`);
  }
  for (const key of Object.keys(expected) as Array<keyof HttpCheckpointIdentities>) {
    if (checkpoint.identities[key] !== expected[key]) {
      throw new HttpAdapterError(`adapter.http checkpoint ${key} mismatch`);
    }
  }
}

export async function readHttpCheckpoint(path: string): Promise<HttpCheckpoint | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as HttpCheckpoint;
    if (!validHttpCheckpoint(parsed)) {
      throw new HttpAdapterError("adapter.http checkpoint is malformed or unsupported");
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (err instanceof HttpAdapterError) throw err;
    throw new HttpAdapterError("adapter.http checkpoint is not valid JSON", { cause: err });
  }
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || nonNegativeInteger(value);
}

function validHttpCheckpoint(value: unknown): value is HttpCheckpoint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Partial<HttpCheckpoint>;
  if (checkpoint.version !== HTTP_CHECKPOINT_VERSION || typeof checkpoint.runId !== "string" || !checkpoint.runId) {
    return false;
  }
  if (!checkpoint.identities || typeof checkpoint.identities !== "object") return false;
  for (const key of ["promptHash", "configHash", "contractHash", "sourceIdentity", "jailIdentity"] as const) {
    if (typeof checkpoint.identities[key] !== "string" || checkpoint.identities[key].length === 0) return false;
  }
  if (!Array.isArray(checkpoint.conversation)) return false;
  if (
    checkpoint.conversation.some(
      (message) => message === null || typeof message !== "object" || Array.isArray(message) || typeof message.role !== "string",
    )
  ) {
    return false;
  }
  if (!nonNegativeInteger(checkpoint.round) || checkpoint.round > 1_000 || !Array.isArray(checkpoint.toolOutcomes)) return false;
  if (checkpoint.request !== undefined) {
    if (
      checkpoint.request.status !== "dispatching" ||
      !nonNegativeInteger(checkpoint.request.round) ||
      checkpoint.request.round !== checkpoint.round + 1 ||
      !/^[a-f0-9]{64}$/.test(checkpoint.request.requestHash)
    ) return false;
  }
  const ids = new Set<string>();
  for (const outcome of checkpoint.toolOutcomes) {
    if (!outcome || typeof outcome !== "object") return false;
    if (typeof outcome.id !== "string" || !outcome.id || ids.has(outcome.id)) return false;
    ids.add(outcome.id);
    if (!/^[a-f0-9]{64}$/.test(outcome.signature)) return false;
    if (typeof outcome.name !== "string" || !outcome.name || typeof outcome.arguments !== "string") return false;
    if (outcome.status !== "pending" && outcome.status !== "completed") return false;
    if (outcome.status === "completed" && typeof outcome.result !== "string") return false;
    try {
      parseToolArguments(callFromOutcome(outcome));
    } catch {
      return false;
    }
  }
  const usage = checkpoint.usage;
  if (!usage || typeof usage !== "object") return false;
  if (!nonNegativeInteger(usage.requests) || !nonNegativeInteger(usage.toolCalls) || typeof usage.model !== "string" || !usage.model) {
    return false;
  }
  if (!optionalNonNegativeInteger(usage.inputTokens) || !optionalNonNegativeInteger(usage.outputTokens) || !optionalNonNegativeInteger(usage.totalTokens)) {
    return false;
  }
  if (usage.profile !== undefined && (typeof usage.profile !== "string" || !usage.profile)) return false;
  if (usage.estimatedCostUsd !== undefined && (typeof usage.estimatedCostUsd !== "number" || !Number.isFinite(usage.estimatedCostUsd) || usage.estimatedCostUsd < 0)) return false;
  if (usage.costEstimated !== undefined && typeof usage.costEstimated !== "boolean") return false;
  if (checkpoint.usageAccounting !== undefined) {
    if (
      typeof checkpoint.usageAccounting !== "object" ||
      typeof checkpoint.usageAccounting.tokenTotalIncomplete !== "boolean" ||
      !nonNegativeInteger(checkpoint.usageAccounting.tokenLowerBound) ||
      typeof checkpoint.usageAccounting.costIncomplete !== "boolean"
    ) return false;
  }
  const completion = checkpoint.completion;
  if (!completion || (completion.status !== "running" && completion.status !== "complete")) return false;
  if (completion.status === "complete" && typeof completion.summary !== "string") return false;
  if (typeof checkpoint.updatedAt !== "string" || !Number.isFinite(Date.parse(checkpoint.updatedAt))) return false;
  return true;
}

export async function writeHttpCheckpoint(path: string, checkpoint: HttpCheckpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

function callFromOutcome(outcome: HttpToolOutcome): OpenAiToolCall {
  return {
    id: outcome.id,
    type: "function",
    function: { name: outcome.name, arguments: outcome.arguments },
  };
}

export async function recoverPendingToolOutcome(
  outcome: HttpToolOutcome,
  host: HttpToolHost | undefined,
  skillId: string,
): Promise<HttpToolOutcome> {
  if (outcome.status === "completed") return outcome;
  if (!host) throw new HttpAdapterError(`adapter.http tool call ${outcome.id} has no recovery host`);
  const call = callFromOutcome(outcome);
  if (toolCallSignature(call) !== outcome.signature) {
    throw new HttpAdapterError(`adapter.http checkpoint tool call ${outcome.id} signature mismatch`);
  }
  if (outcome.name === "read_file" || outcome.name === "list_dir") {
    return { ...outcome, status: "completed", result: await dispatchToolCall(call, host, skillId) };
  }
  if (outcome.name === "write_file") {
    const args = parseToolArguments(call);
    const current = await host.readFile(String(args.path));
    if (sha256Text(current) === sha256Text(String(args.contents))) {
      return { ...outcome, status: "completed", result: "ok (reconciled)" };
    }
  }
  throw new HttpAdapterError(
    `adapter.http tool call ${outcome.id} outcome is uncertain; recovery is blocked`,
  );
}

/** Repair the sole safe crash gap: an outcome was durably completed before its tool message append. */
export function restoreCompletedToolMessages(
  checkpoint: Pick<HttpCheckpoint, "conversation" | "toolOutcomes">,
): boolean {
  const responded = new Set<string>();
  for (const message of checkpoint.conversation) {
    if (message.role !== "tool") continue;
    if (typeof message.tool_call_id !== "string" || responded.has(message.tool_call_id)) {
      throw new HttpAdapterError("adapter.http checkpoint has duplicate or invalid tool responses");
    }
    responded.add(message.tool_call_id);
  }
  let changed = false;
  for (const outcome of checkpoint.toolOutcomes) {
    if (outcome.status !== "completed" || responded.has(outcome.id)) continue;
    const ownerIndex = checkpoint.conversation.findIndex((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return false;
      return message.tool_calls.some((raw) => {
        const call = raw as Partial<OpenAiToolCall>;
        return call.id === outcome.id;
      });
    });
    if (ownerIndex < 0) {
      throw new HttpAdapterError(`adapter.http checkpoint completed tool ${outcome.id} has no assistant call`);
    }
    const laterAssistant = checkpoint.conversation
      .slice(ownerIndex + 1)
      .some((message) => message.role === "assistant");
    if (laterAssistant) {
      throw new HttpAdapterError(`adapter.http checkpoint tool sequence is incomplete for ${outcome.id}`);
    }
    checkpoint.conversation.push({
      role: "tool",
      tool_call_id: outcome.id,
      content: outcome.result ?? "",
    });
    responded.add(outcome.id);
    changed = true;
  }
  return changed;
}
