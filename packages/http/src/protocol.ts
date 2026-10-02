import { createHash } from "node:crypto";
import { HttpAdapterError } from "./errors.js";
import type { OpenAiToolCall } from "./tools.js";

export type NormalizedUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ParsedAssistantResponse = {
  content: string;
  toolCalls: OpenAiToolCall[];
  finishReason: string;
  usage?: NormalizedUsage;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpAdapterError(`adapter.http malformed response: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function parseToolArguments(call: OpenAiToolCall): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch (err) {
    throw new HttpAdapterError(`adapter.http invalid tool arguments for ${call.function.name}: not JSON`, {
      cause: err,
    });
  }
  const args = record(parsed, `tool arguments for ${call.function.name}`);
  const name = call.function.name;
  const requireString = (key: string) => {
    if (typeof args[key] !== "string") {
      throw new HttpAdapterError(`adapter.http invalid tool arguments for ${name}: ${key} must be a string`);
    }
  };
  if (name === "read_file" || name === "list_dir") {
    requireString("path");
  } else if (name === "write_file") {
    requireString("path");
    requireString("contents");
  } else if (name === "run_command") {
    if (!Array.isArray(args.argv) || args.argv.length === 0 || args.argv.some((item) => typeof item !== "string")) {
      throw new HttpAdapterError(`adapter.http invalid tool arguments for ${name}: argv must be a non-empty string array`);
    }
  }
  return args;
}

export function toolCallSignature(call: OpenAiToolCall): string {
  return createHash("sha256")
    .update(`${call.function.name}\0${call.function.arguments}`, "utf8")
    .digest("hex");
}

export function parseAssistantResponse(json: unknown): ParsedAssistantResponse {
  const root = record(json, "root");
  if (root.error !== undefined) {
    const provider = record(root.error, "error");
    const message = typeof provider.message === "string" ? provider.message : "provider returned an error object";
    throw new HttpAdapterError(`adapter.http provider error: ${message}`);
  }
  if (!Array.isArray(root.choices) || root.choices.length !== 1) {
    throw new HttpAdapterError("adapter.http malformed response: exactly one choice is required");
  }
  const choice = record(root.choices[0], "choice");
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : "";
  const message = record(choice.message, "choice.message");
  if (message.role !== "assistant") {
    throw new HttpAdapterError("adapter.http malformed response: choice.message.role must be assistant");
  }
  const content = typeof message.content === "string" ? message.content : "";
  if (message.content !== null && message.content !== undefined && typeof message.content !== "string") {
    throw new HttpAdapterError("adapter.http malformed response: message.content must be a string or null");
  }
  const rawCalls = message.tool_calls === undefined ? [] : message.tool_calls;
  if (!Array.isArray(rawCalls)) {
    throw new HttpAdapterError("adapter.http malformed response: message.tool_calls must be an array");
  }
  const ids = new Set<string>();
  const toolCalls = rawCalls.map((entry, index) => {
    const raw = record(entry, `tool_calls[${index}]`);
    const fn = record(raw.function, `tool_calls[${index}].function`);
    if (raw.type !== "function") {
      throw new HttpAdapterError(`adapter.http malformed response: tool_calls[${index}].type must be function`);
    }
    if (typeof raw.id !== "string" || raw.id.length === 0) {
      throw new HttpAdapterError(`adapter.http malformed response: tool_calls[${index}].id is required`);
    }
    if (ids.has(raw.id)) {
      throw new HttpAdapterError(`adapter.http duplicate tool call id ${raw.id}`);
    }
    ids.add(raw.id);
    if (typeof fn.name !== "string" || fn.name.length === 0 || typeof fn.arguments !== "string") {
      throw new HttpAdapterError(`adapter.http malformed response: tool_calls[${index}].function is invalid`);
    }
    const call: OpenAiToolCall = {
      id: raw.id,
      type: "function",
      function: { name: fn.name, arguments: fn.arguments },
    };
    parseToolArguments(call);
    return call;
  });

  if (toolCalls.length === 0) {
    if (!content.trim()) {
      throw new HttpAdapterError("adapter.http incomplete terminal response: content is empty");
    }
    if (finishReason !== "stop") {
      throw new HttpAdapterError(`adapter.http incomplete terminal response: finish_reason=${finishReason || "missing"}`);
    }
  } else if (finishReason !== "tool_calls") {
    throw new HttpAdapterError(`adapter.http malformed response: tool calls require finish_reason=tool_calls (received ${finishReason || "missing"})`);
  }

  let usage: NormalizedUsage | undefined;
  if (root.usage !== undefined) {
    const rawUsage = record(root.usage, "usage");
    for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
      if (rawUsage[key] !== undefined && nonNegativeInteger(rawUsage[key]) === undefined) {
        throw new HttpAdapterError(`adapter.http malformed response: usage.${key} must be a non-negative integer`);
      }
    }
    const inputTokens = nonNegativeInteger(rawUsage.prompt_tokens);
    const outputTokens = nonNegativeInteger(rawUsage.completion_tokens);
    const totalTokens = nonNegativeInteger(rawUsage.total_tokens);
    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
      throw new HttpAdapterError("adapter.http malformed response: usage token counts are invalid");
    }
    if (
      inputTokens !== undefined &&
      outputTokens !== undefined &&
      totalTokens !== undefined &&
      totalTokens !== inputTokens + outputTokens
    ) {
      throw new HttpAdapterError("adapter.http malformed response: usage.total_tokens is inconsistent");
    }
    usage = {
      inputTokens,
      outputTokens,
      totalTokens: totalTokens ?? (
        inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined
      ),
    };
  }
  return { content, toolCalls, finishReason, usage };
}
