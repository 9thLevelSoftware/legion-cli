import { randomBytes } from "node:crypto";
import type { AgentUsage } from "./profiles.js";
import { AgentError } from "./errors.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type TelemetryInput = {
  endpoint?: string;
  adapter: string;
  profile?: string;
  skill: string;
  outcome: string;
  usage?: AgentUsage;
  fetchImpl?: FetchLike;
};

function collectorUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AgentError("telemetry.otlpEndpoint must be a URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!new Set(["127.0.0.1", "::1"]).has(host)) {
    throw new AgentError("telemetry.otlpEndpoint must use an explicit loopback IP collector (127.0.0.1 or ::1)");
  }
  if (url.username || url.password) throw new AgentError("telemetry.otlpEndpoint cannot include credentials");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AgentError("telemetry.otlpEndpoint must use http or https");
  }
  const base = url.toString().replace(/\/$/, "");
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}

function attr(key: string, value: string | number | boolean): Record<string, unknown> {
  const field = typeof value === "string" ? "stringValue" : typeof value === "boolean" ? "boolValue" : "doubleValue";
  return { key, value: { [field]: value } };
}

function usageAttributes(usage: AgentUsage | undefined): Array<Record<string, unknown>> {
  if (!usage) return [];
  const pairs: Array<[string, string | number | boolean | undefined]> = [
    ["legion.usage.requests", usage.requests],
    ["legion.usage.tool_calls", usage.toolCalls],
    ["legion.usage.input_tokens", usage.inputTokens],
    ["legion.usage.output_tokens", usage.outputTokens],
    ["legion.usage.total_tokens", usage.totalTokens],
    ["legion.usage.model", usage.model],
    ["legion.usage.estimated_cost_usd", usage.estimatedCostUsd],
    ["legion.usage.cost_estimated", usage.costEstimated],
  ];
  return pairs.flatMap(([key, value]) => value === undefined ? [] : [attr(key, value)]);
}

export function usageTelemetryPayload(input: Omit<TelemetryInput, "endpoint" | "fetchImpl">): Record<string, unknown> {
  const started = BigInt(Date.now()) * 1_000_000n;
  const ended = started + 1n;
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", "legion-cli")] },
        scopeSpans: [
          {
            scope: { name: "@9thlevelsoftware/legion-cli-agents" },
            spans: [
              {
                traceId: randomBytes(16).toString("hex"),
                spanId: randomBytes(8).toString("hex"),
                name: "legion.agent.run",
                kind: 1,
                startTimeUnixNano: started.toString(),
                endTimeUnixNano: ended.toString(),
                attributes: [
                  attr("legion.adapter", input.adapter),
                  attr("legion.skill", input.skill),
                  attr("legion.outcome", input.outcome),
                  ...(input.profile ? [attr("legion.profile", input.profile)] : []),
                  ...usageAttributes(input.usage),
                ],
                status: { code: input.outcome === "complete" || input.outcome === "done" ? 1 : 2 },
              },
            ],
          },
        ],
      },
    ],
  };
}

export async function exportUsageTelemetry(input: TelemetryInput): Promise<{ sent: boolean; reason?: string }> {
  if (process.env.DO_NOT_TRACK === "1") return { sent: false, reason: "do-not-track" };
  if (!input.endpoint) return { sent: false, reason: "disabled" };
  const url = collectorUrl(input.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(usageTelemetryPayload(input)),
      signal: controller.signal,
      redirect: "manual",
    });
    if (!response.ok) return { sent: false, reason: `collector returned HTTP ${response.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
