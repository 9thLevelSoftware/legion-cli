import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { GovernedProgramSchema } from "@9thlevelsoftware/legion-cli-schema";
import { postJsonPinned } from "./client.js";
import type { HttpAdapterConfig } from "@9thlevelsoftware/legion-cli-schema";
import type { GovernedHttpAgentJob, HttpAgentResult, HttpAgentUsage, SsrfLookup } from "./types.js";
import type { EffectIntent, FailureCode, GovernedState, ProviderUsageReceipt, GovernedValueRecord, HttpGovernedCheckpoint } from "./governed-types.js";

export function fileOriginId(sourceId: string, canonicalPath: string): string {
  return namespacedOrigin("file", { sourceId, path: canonicalPath });
}

export function remoteOriginId(descriptor: unknown): string {
  return namespacedOrigin("remote", descriptor);
}

function namespacedOrigin(namespace: "file" | "remote", descriptor: unknown): string {
  const digestBytes = createHash("sha256").update(`legion-cli-${namespace}-origin/v1\0${canonical(descriptor)}`, "utf8").digest();
  return `${namespace}-${base32(digestBytes)}`;
}

function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const canonicalDigest = (domain: string, value: unknown) => createHash("sha256").update(`${domain}\0${canonical(value)}`, "utf8").digest("hex");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function encodeStrictOutput(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== text) throw new Error("invalid-output");
  return bytes;
}
export function governedActionId(candidate: string = randomUUID()): string {
  return `act-${candidate.toLowerCase()}`;
}
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
};

function parseStrictJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] ?? "")) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      if (text[at] === "\\") { at += 2; continue; }
      if (text[at++] === '"') break;
    }
    const parsed = JSON.parse(text.slice(start, at)) as string;
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(parsed)) throw new Error("invalid-output");
    return parsed;
  };
  const value = (depth: number): unknown => {
    if (depth > 32) throw new Error("invalid-output");
    ws();
    if (text[at] === "{") {
      at++;
      const seen = new Set<string>();
      const object: Record<string, unknown> = {};
      ws();
      if (text[at] === "}") { at++; return object; }
      for (;;) {
        ws();
        if (text[at] !== '"') throw new Error("invalid-output");
        const key = string();
        if (seen.has(key)) throw new Error("invalid-output");
        seen.add(key);
        ws();
        if (text[at++] !== ":") throw new Error("invalid-output");
        object[key] = value(depth + 1);
        ws();
        const next = text[at++];
        if (next === "}") return object;
        if (next !== ",") throw new Error("invalid-output");
      }
    }
    if (text[at] === "[") {
      at++;
      const array: unknown[] = [];
      ws();
      if (text[at] === "]") { at++; return array; }
      for (;;) {
        array.push(value(depth + 1));
        ws();
        const next = text[at++];
        if (next === "]") return array;
        if (next !== ",") throw new Error("invalid-output");
      }
    }
    if (text[at] === '"') return string();
    const start = at;
    while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++;
    if (start === at) throw new Error("invalid-output");
    return JSON.parse(text.slice(start, at)) as unknown;
  };
  const parsed = value(0);
  ws();
  if (at !== text.length) throw new Error("invalid-output");
  return parsed;
}

function unavailableResult(job: GovernedHttpAgentJob): HttpAgentResult {
  const hashedRunId = createHash("sha256").update(`legion-cli-governed-run-path/v1\0${job.runId}`, "utf8").digest("hex");
  const checkpointPath = join(job.checkpointRoot ?? job.cwd, ".legion-cli", "audit", "http-governed", hashedRunId, "http-governed-checkpoint.json");
  return { exitCode: 1, timedOut: false, aborted: false, stdoutPath: "", stderrPath: "", checkpointPath, recovery: "manual", usage: { requests: 0, toolCalls: 0 } };
}

function asBytes(value: GovernedValueRecord): Uint8Array | null {
  if (!value.retained) return null;
  if (value.retained.encoding === "utf8") return new TextEncoder().encode(value.retained.content);
  return new Uint8Array(Buffer.from(value.retained.content, "base64"));
}

function retainedValue(bytes: Uint8Array): { encoding: "utf8" | "base64"; content: string } {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (new TextEncoder().encode(decoded).every((byte, index) => byte === bytes[index]) && new TextEncoder().encode(decoded).length === bytes.length) return { encoding: "utf8", content: decoded };
  return { encoding: "base64", content: Buffer.from(bytes).toString("base64") };
}
function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function approvedExternalGrant(policy: unknown, grantId: string): Record<string, unknown> | null {
  const root = asObject(policy);
  const security = asObject(root?.security);
  const grants = Array.isArray(root?.externalCalls) ? root.externalCalls : Array.isArray(security?.externalCalls) ? security.externalCalls : [];
  return grants.map(asObject).find((grant) => grant?.id === grantId) ?? null;
}
function approvedTransformation(policy: unknown, transformationId: string): Record<string, unknown> | null {
  const root = asObject(policy);
  const security = asObject(root?.security);
  const transformations = Array.isArray(root?.transformations) ? root.transformations : Array.isArray(security?.transformations) ? security.transformations : [];
  return transformations.map(asObject).find((transformation) => transformation?.id === transformationId) ?? null;
}
function providerUsage(root: Record<string, unknown>, job: GovernedHttpAgentJob): ProviderUsageReceipt {
  const raw = asObject(root.usage);
  const count = (key: string) => {
    const value = raw?.[key];
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
  };
  const inputTokens = count("prompt_tokens");
  const outputTokens = count("completion_tokens");
  const reportedTotal = count("total_tokens");
  const totalTokens = reportedTotal ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const price = job.pricing;
  const costUsd = inputTokens !== null && outputTokens !== null && price?.inputPerMillionUsd !== undefined && price.outputPerMillionUsd !== undefined && price.requestUsd !== undefined
    ? inputTokens * price.inputPerMillionUsd / 1_000_000 + outputTokens * price.outputPerMillionUsd / 1_000_000 + price.requestUsd
    : null;
  return {
    requestCharge: 1, inputTokens, outputTokens, totalTokens,
    tokenLowerBound: Math.max(inputTokens ?? 0, outputTokens ?? 0, reportedTotal ?? 0),
    costUsd, tokenAccounting: inputTokens !== null && outputTokens !== null && totalTokens !== null ? "complete" : "incomplete",
    costAccounting: costUsd === null ? "incomplete" : "complete",
  };
}
function approvedProviderSink(policy: unknown, endpoint: string): string | null {
  const root = asObject(policy);
  const security = asObject(root?.security);
  const sinks = Array.isArray(root?.sinks) ? root.sinks : Array.isArray(security?.sinks) ? security.sinks : [];
  const sink = sinks.map(asObject).find((candidate) => typeof candidate?.id === "string" && candidate.origin === endpoint);
  return typeof sink?.id === "string" ? sink.id : null;
}

export async function runGovernedHttp(job: GovernedHttpAgentJob, signal: AbortSignal, config: HttpAdapterConfig | undefined, lookup?: SsrfLookup): Promise<HttpAgentResult> {
  const result = unavailableResult(job);
  const blocked = (code: FailureCode) => ({ ...result, governedBlock: code });
  if (!config || !job.assuranceContext || !job.effectHost) return blocked("policy-denied");
  if (config.model !== job.assuranceContext.identities.provider.model || config.baseUrl.replace(/\/$/, "") !== job.assuranceContext.identities.provider.endpoint.replace(/\/$/, "")) return blocked("stale-authority");
  const apiKey = (job.env[config.apiKeyEnv] ?? "").trim();
  if (!apiKey || signal.aborted) return blocked("transport-failure");
  let state: GovernedState;
  try { state = await job.effectHost.open(job.assuranceContext, Boolean(job.resume)); } catch { return blocked("stale-authority"); }
  if (state.checkpoint.status === "complete") return { ...result, exitCode: 0, recovery: "none" };
  if (state.checkpoint.status === "blocked" && state.checkpoint.blocker !== "approval-required") return blocked(state.checkpoint.blocker ?? "policy-denied");
  if (state.checkpoint.providerCalls.some((call) => call.state === "pending" || call.state === "uncertain") || (state.checkpoint.phase === "program" && state.checkpoint.effects.some((effect) => effect.state === "pending" || effect.state === "uncertain"))) return blocked("uncertain-effect");
  if (state.checkpoint.phase === "bootstrap" && state.checkpoint.providerCalls.length > 0 && state.checkpoint.candidateProgram === null) {
    const failed = state.checkpoint.providerCalls.find((call) => call.state === "completed" && call.outcome?.kind === "failure");
    return blocked(failed?.outcome?.kind === "failure" ? failed.outcome.code : "invalid-program");
  }
  if (state.checkpoint.phase === "program") {
    const checkpoint = state.checkpoint;
    const index = checkpoint.cursor;
    const failedCall = checkpoint.providerCalls.find((call) => call.state === "completed" && call.outcome?.kind === "failure" && ((call.purpose.kind === "derive" || call.purpose.kind === "external-call") && checkpoint.program.operations[index]?.id === call.purpose.operationId));
    const failedEffect = checkpoint.effects.find((effect) => effect.state === "completed" && effect.outcome?.kind === "failure" && effect.operationId === checkpoint.program.operations[index]?.id);
    if (failedCall?.outcome?.kind === "failure") return blocked(failedCall.outcome.code);
    if (failedEffect?.outcome?.kind === "failure") return blocked(failedEffect.outcome.code);
  }
  if (state.checkpoint.phase === "bootstrap") {
    let candidate = state.checkpoint.candidateProgram;
    if (!candidate) {
      const bodyObject = {
        model: job.assuranceContext.identities.provider.model,
        messages: [
          { role: "system", content: "Produce one strict governed JSON program. Only use the supplied approved metadata and contract. No tools or commands." },
          { role: "user", content: canonical({ approvedMetadata: job.assuranceContext.plannerInput.approvedMetadata, taskContract: job.assuranceContext.plannerInput.taskContract }) },
        ],
        temperature: 0,
        stream: false,
      };
      const bodyBytes = new TextEncoder().encode(JSON.stringify(bodyObject));
      if (bodyBytes.byteLength > MAX_REQUEST_BYTES) return blocked("resource-limit");
      const bodyDigest = digest(bodyBytes);
      const valueDigest = digest(new TextEncoder().encode(canonical(bodyObject.messages)));
      const authority = {
        programKind: "bootstrap" as const,
        authorityDigest: state.checkpoint.bootstrapAuthorityDigest,
        programFingerprint: canonicalDigest("legion-cli-governed-bootstrap-recipe/v1", { recipe: "approved-metadata-to-frozen-program/v1", runId: job.assuranceContext.runId, taskId: job.assuranceContext.taskId, identities: job.assuranceContext.identities, manifestDigest: job.assuranceContext.manifestDigest, plannerInput: job.assuranceContext.plannerInput, policy: job.assuranceContext.policy }),
      };
      const sinkId = "planner";
      const requestDigest = digest(new TextEncoder().encode(canonical({ version: 1, endpoint: job.assuranceContext.identities.provider.endpoint, model: job.assuranceContext.identities.provider.model, profile: job.assuranceContext.identities.provider.profile, bodyDigest })));
      const prior = state.checkpoint.providerCalls.find((call) => call.state === "awaiting-approval" && call.role === "planner" && call.purpose.kind === "plan" && call.requestDigest === requestDigest && call.bodyDigest === bodyDigest && call.valueDigest === valueDigest);
      const actionId = prior?.actionId ?? governedActionId();
      const intent: EffectIntent = {
        kind: "provider", actionId, authority, sinkId, requestDigest, valueDigest, inputs: [], role: "planner", purpose: { kind: "plan" },
        endpoint: job.assuranceContext.identities.provider.endpoint, model: job.assuranceContext.identities.provider.model, bodyDigest, requestBytes: bodyBytes.byteLength, requestBody: bodyBytes, inputValues: [],
        label: job.assuranceContext.plannerInput.label,
        usage: { requestCharge: 0, inputTokens: null, outputTokens: null, totalTokens: null, tokenLowerBound: 0, costUsd: null, tokenAccounting: "incomplete", costAccounting: "incomplete" },
      };
      const admission = await job.effectHost.prepareEffect(state.revision, intent);
      if (admission.kind !== "ready") return blocked(admission.code);
      let received: { responseDigest: string; responseBytes: Uint8Array; status: number } | undefined;
      let receivedUsage: ProviderUsageReceipt | undefined;
      try {
        const url = new URL(`${job.assuranceContext.identities.provider.endpoint.replace(/\/$/, "")}/chat/completions`);
        const response = await postJsonPinned({ url, apiKey, extraHeaders: config.headers, serializedBody: bodyBytes, signal, allowLoopback: config.allowLoopback, lookup, rawResponse: true, captureStatus: true });
        received = response;
        if (response.responseBytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("resource-limit");
        const root = parseStrictJson(response.responseBytes);
        if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("invalid-output");
        const responseObject = root as Record<string, unknown>;
        receivedUsage = providerUsage(responseObject, job);
        if (response.status < 200 || response.status >= 300) throw new Error("transport-failure");
        const choices = Array.isArray(responseObject.choices) ? responseObject.choices : [];
        const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>).message : null;
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid-output");
        const content = (message as Record<string, unknown>).content;
        if (typeof content !== "string" || (message as Record<string, unknown>).tool_calls !== undefined) throw new Error("invalid-output");
        let programValue: unknown;
        try { programValue = parseStrictJson(encodeStrictOutput(content)); }
        catch (error) {
          if (error instanceof Error && error.message === "invalid-output") throw error;
          throw new Error("invalid-program");
        }
        const validated = GovernedProgramSchema.safeParse(programValue);
        if (!validated.success) throw new Error("invalid-program");
        candidate = validated.data;
        await job.effectHost.completeEffect(admission.permit, { outcome: { kind: "success", resultDigest: digest(new TextEncoder().encode(canonical(candidate))) }, providerUsage: receivedUsage, candidateProgram: candidate, producedValue: null, producedBytes: null, responseDigest: response.responseDigest, responseBytes: response.responseBytes.byteLength });
      } catch (err) {
        const code = err instanceof Error && ["invalid-output", "invalid-program", "resource-limit", "transport-failure"].includes(err.message) ? err.message as FailureCode : "transport-failure";
        if (received) {
          const failedUsage: ProviderUsageReceipt = receivedUsage ?? { requestCharge: 1, inputTokens: null, outputTokens: null, totalTokens: null, tokenLowerBound: 0, costUsd: null, tokenAccounting: "incomplete", costAccounting: "incomplete" };
          try { await job.effectHost.completeEffect(admission.permit, { outcome: { kind: "failure", code }, providerUsage: failedUsage, candidateProgram: null, producedValue: null, producedBytes: null, responseDigest: received.responseDigest, responseBytes: received.responseBytes.byteLength }); }
          catch { return blocked("uncertain-effect"); }
        } else {
          await job.effectHost.markUncertain(admission.permit, code);
        }
        return blocked(code);
      }
      state = await job.effectHost.open(job.assuranceContext, true);
    }
    if (!candidate) return blocked("invalid-program");
    try { state = await job.effectHost.freezeProgram(state.revision); } catch { return blocked("stale-authority"); }
    if (state.checkpoint.phase !== "program") return blocked("invalid-program");
  }
  const acquiredValues = new Map<string, Uint8Array>();
  let recoveryFailureCode: FailureCode | undefined;
  const materialize = async (record: GovernedValueRecord, depth = 0): Promise<Uint8Array | null> => {
    if (depth > 32) { recoveryFailureCode = "resource-limit"; return null; }
    const acquired = acquiredValues.get(record.id) ?? asBytes(record);
    if (acquired) return acquired;
    const producer = record.producer;
    if (producer.kind === "external-call") return null;
    if (producer.kind === "read") {
      try {
        const source = await job.effectHost.readSource(producer.path, signal);
        if (source.content.byteLength !== record.bytes || source.evidence.digest !== record.digest || source.evidence.bytes !== record.bytes || canonical(source.evidence.label) !== canonical(record.label) || digest(source.content) !== record.digest) { recoveryFailureCode = "recovery-value-mismatch"; return null; }
        acquiredValues.set(record.id, source.content);
        return source.content;
      } catch { return null; }
    }
    const checkpoint = state.checkpoint;
    if (checkpoint.phase !== "program") return null;
    const original = checkpoint.providerCalls.find((call) => call.actionId === producer.originalCallId);
    if (!original || original.state !== "completed" || original.outcome?.kind !== "success" || original.outcome.resultDigest !== record.digest || original.purpose.kind !== "derive" || original.purpose.operationId !== producer.operationId) return null;
    const previousFailure = checkpoint.providerCalls.find((call) => call.purpose.kind === "rederive" && call.purpose.operationId === producer.operationId && call.purpose.originalCallId === producer.originalCallId && call.state === "completed" && call.outcome?.kind === "failure");
    if (previousFailure?.outcome?.kind === "failure") { recoveryFailureCode = previousFailure.outcome.code; return null; }
    const operation = checkpoint.program.operations.find((candidate) => candidate.kind === "derive" && candidate.id === producer.operationId);
    const transformation = approvedTransformation(job.assuranceContext.policy, producer.transformationId);
    const sinkId = approvedProviderSink(job.assuranceContext.policy, job.assuranceContext.identities.provider.endpoint);
    if (!operation || operation.kind !== "derive" || operation.transformationId !== producer.transformationId || !transformation || typeof transformation.instruction !== "string" || !sinkId) return null;
    const inputs: Array<{ record: GovernedValueRecord; content: Uint8Array }> = [];
    for (const id of operation.inputs) {
      const inputRecord = checkpoint.values.find((value) => value.id === id);
      if (!inputRecord) return null;
      const content = await materialize(inputRecord, depth + 1);
      if (!content) return null;
      inputs.push({ record: inputRecord, content });
    }
    const packet = { transformationId: operation.transformationId, instruction: transformation.instruction, inputs: inputs.map(({ record: input, content }) => ({ id: input.id, digest: input.digest, value: retainedValue(content) })) };
    const valueDigest = digest(new TextEncoder().encode(canonical(packet)));
    const requestBody = new TextEncoder().encode(JSON.stringify({ model: job.assuranceContext.identities.provider.model, messages: [{ role: "system", content: "Apply exactly the approved transformation and return only its output. No tools or commands." }, { role: "user", content: canonical(packet) }], temperature: 0, stream: false }));
    if (requestBody.byteLength > MAX_REQUEST_BYTES) return null;
    const bodyDigest = digest(requestBody);
    const requestDigest = digest(new TextEncoder().encode(canonical({ version: 1, kind: "rederive", endpoint: config.baseUrl, model: config.model, profile: job.assuranceContext.identities.provider.profile, operationId: operation.id, transformationId: operation.transformationId, originalCallId: producer.originalCallId, bodyDigest })));
    const prior = checkpoint.providerCalls.find((call) => call.state === "awaiting-approval" && call.purpose.kind === "rederive" && call.purpose.operationId === operation.id && call.purpose.originalCallId === producer.originalCallId && call.requestDigest === requestDigest && call.bodyDigest === bodyDigest && call.valueDigest === valueDigest);
    const actionId = prior?.actionId ?? governedActionId();
    const authority: EffectIntent["authority"] = { programKind: "governed", authorityDigest: checkpoint.programAuthorityDigest, programFingerprint: checkpoint.programFingerprint };
    const origins = [...new Set([...job.assuranceContext.plannerInput.label.origins, ...inputs.flatMap(({ record: input }) => input.label.origins)])].sort();
    if (origins.length > 256) return null;
    const labels = [job.assuranceContext.plannerInput.label, ...inputs.map(({ record: input }) => input.label)];
    const confidentiality: GovernedValueRecord["label"]["confidentiality"] = labels.some((item) => item.confidentiality === "sealed") ? "sealed" : labels.some((item) => item.confidentiality === "workspace") ? "workspace" : "public";
    const label = { origins, integrity: "untrusted" as const, confidentiality };
    if (canonical(label) !== canonical(record.label)) return null;
    const intent: EffectIntent = { kind: "provider", actionId, authority, sinkId, requestDigest, valueDigest, inputs: inputs.map(({ record: input }) => ({ id: input.id, digest: input.digest, bytes: input.bytes, label: input.label })), role: "quarantined", purpose: { kind: "rederive", operationId: operation.id, originalCallId: producer.originalCallId }, endpoint: config.baseUrl, model: config.model, bodyDigest, requestBytes: requestBody.byteLength, requestBody, inputValues: inputs.map(({ record: input, content }) => ({ evidence: { id: input.id, digest: input.digest, bytes: input.bytes, label: input.label }, content })), label, usage: { requestCharge: 0, inputTokens: null, outputTokens: null, totalTokens: null, tokenLowerBound: 0, costUsd: null, tokenAccounting: "incomplete", costAccounting: "incomplete" } };
    const admission = await job.effectHost.prepareEffect(state.revision, intent);
    if (admission.kind !== "ready") return null;
    let received: { responseDigest: string; responseBytes: Uint8Array; status: number } | undefined;
    let receivedUsage: ProviderUsageReceipt | undefined;
    try {
      const response = await postJsonPinned({ url: new URL(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`), apiKey, extraHeaders: config.headers, serializedBody: requestBody, signal, allowLoopback: config.allowLoopback, lookup, rawResponse: true, captureStatus: true });
      received = response;
      if (response.responseBytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("resource-limit");
      const root = parseStrictJson(response.responseBytes);
      if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("transport-failure");
      const responseObject = root as Record<string, unknown>;
      receivedUsage = providerUsage(responseObject, job);
      if (response.status < 200 || response.status >= 300) throw new Error("transport-failure");
      const choices = Array.isArray(responseObject.choices) ? responseObject.choices : [];
      const choice = choices.length === 1 && choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : null;
      const message = choice && asObject(choice.message);
      if (!message || message.role !== "assistant" || choice?.finish_reason !== "stop" || message.tool_calls !== undefined || typeof message.content !== "string") throw new Error("invalid-output");
      if (Buffer.byteLength(message.content, "utf8") > MAX_VALUE_BYTES) throw new Error("resource-limit");
      const output = encodeStrictOutput(message.content);
      if (digest(output) !== record.digest) {
        const failure: FailureCode = "recovery-value-mismatch";
        await job.effectHost.completeEffect(admission.permit, { outcome: { kind: "failure", code: failure }, providerUsage: receivedUsage, producedValue: null, producedBytes: null, candidateProgram: null, responseDigest: response.responseDigest, responseBytes: response.responseBytes.byteLength });
        recoveryFailureCode = failure;
        state = await job.effectHost.open(job.assuranceContext, true);
        return null;
      }
      await job.effectHost.completeEffect(admission.permit, { outcome: { kind: "success", resultDigest: record.digest }, providerUsage: receivedUsage, producedValue: null, producedBytes: output, candidateProgram: null, responseDigest: response.responseDigest, responseBytes: response.responseBytes.byteLength });
      state = await job.effectHost.open(job.assuranceContext, true);
      acquiredValues.set(record.id, output);
      return output;
    } catch (error) {
      const code: FailureCode = error instanceof Error && ["invalid-output", "resource-limit", "transport-failure"].includes(error.message) ? error.message as FailureCode : "transport-failure";
      if (received) {
        const usage = receivedUsage ?? { requestCharge: 1 as const, inputTokens: null, outputTokens: null, totalTokens: null, tokenLowerBound: 0, costUsd: null, tokenAccounting: "incomplete" as const, costAccounting: "incomplete" as const };
        try { await job.effectHost.completeEffect(admission.permit, { outcome: { kind: "failure", code }, providerUsage: usage, producedValue: null, producedBytes: null, candidateProgram: null, responseDigest: received.responseDigest, responseBytes: received.responseBytes.byteLength }); }
        catch { return null; }
      } else await job.effectHost.markUncertain(admission.permit, code);
      state = await job.effectHost.open(job.assuranceContext, true);
      return null;
    }
  };
  while (state.checkpoint.phase === "program" && state.checkpoint.cursor < state.checkpoint.program.operations.length) {
    if (signal.aborted) return blocked("uncertain-effect");
    const checkpoint = state.checkpoint;
    const operation = checkpoint.program.operations[checkpoint.cursor];
    if (!operation) return blocked("invalid-program");
    if (operation.kind === "finish") {
      const next = { ...checkpoint, cursor: checkpoint.cursor + 1, status: "complete", blocker: null, recordedAt: new Date().toISOString() } as HttpGovernedCheckpoint;
      try { state = await job.effectHost.saveProgress(state.revision, next); } catch { return blocked("stale-authority"); }
      break;
    }
    if (operation.kind === "derive") {
      const transformation = approvedTransformation(job.assuranceContext.policy, operation.transformationId);
      const sinkId = approvedProviderSink(job.assuranceContext.policy, job.assuranceContext.identities.provider.endpoint);
      if (!transformation || typeof transformation.instruction !== "string" || !sinkId) return blocked("policy-denied");
      const data: Array<{ record: GovernedValueRecord; content: Uint8Array }> = [];
      for (const id of operation.inputs) {
        const record = checkpoint.values.find((value) => value.id === id);
        if (!record) return blocked("missing-sealed-value");
        const content = await materialize(record);
        if (!content) return blocked(recoveryFailureCode ?? (record.producer.kind === "external-call" ? "missing-sealed-value" : "recovery-value-mismatch"));
        if (content.byteLength > MAX_VALUE_BYTES) return blocked("resource-limit");
        data.push({ record, content });
      }
      const inputValues = data.map(({ record, content }) => ({ evidence: { id: record.id, digest: record.digest, bytes: record.bytes, label: record.label }, content }));
      const packet = { transformationId: operation.transformationId, instruction: transformation.instruction, inputs: data.map(({ record, content }) => ({ id: record.id, digest: record.digest, value: retainedValue(content) })) };
      const valueDigest = digest(new TextEncoder().encode(canonical(packet)));
      const bodyObject = { model: job.assuranceContext.identities.provider.model, messages: [{ role: "system", content: "Apply exactly the approved transformation and return only its output. No tools or commands." }, { role: "user", content: canonical(packet) }], temperature: 0, stream: false };
      const requestBody = new TextEncoder().encode(JSON.stringify(bodyObject));
      if (requestBody.byteLength > MAX_REQUEST_BYTES) return blocked("resource-limit");
      const bodyDigest = digest(requestBody);
      const requestDigest = digest(new TextEncoder().encode(canonical({ version: 1, kind: "derive", endpoint: config.baseUrl, model: config.model, profile: job.assuranceContext.identities.provider.profile, operationId: operation.id, transformationId: operation.transformationId, bodyDigest })));
      const prior = checkpoint.providerCalls.find((call) => call.state === "awaiting-approval" && call.purpose.kind === "derive" && call.purpose.operationId === operation.id && call.requestDigest === requestDigest && call.bodyDigest === bodyDigest && call.valueDigest === valueDigest);
      const actionId = prior?.actionId ?? governedActionId();
      const origins = [...new Set([...job.assuranceContext.plannerInput.label.origins, ...data.flatMap(({ record }) => record.label.origins)])].sort();
      if (origins.length > 256) return blocked("resource-limit");
      const labels = [job.assuranceContext.plannerInput.label, ...data.map(({ record }) => record.label)];
      const confidentiality: GovernedValueRecord["label"]["confidentiality"] = labels.some((item) => item.confidentiality === "sealed") ? "sealed" : labels.some((item) => item.confidentiality === "workspace") ? "workspace" : "public";
      const label = { origins, integrity: "untrusted" as const, confidentiality };
      const authority: EffectIntent["authority"] = { programKind: "governed", authorityDigest: checkpoint.programAuthorityDigest, programFingerprint: checkpoint.programFingerprint };
      const intent: EffectIntent = { kind: "provider", actionId, authority, sinkId, requestDigest, valueDigest, inputs: data.map(({ record }) => ({ id: record.id, digest: record.digest, bytes: record.bytes, label: record.label })), role: "quarantined", purpose: { kind: "derive", operationId: operation.id }, endpoint: config.baseUrl, model: config.model, bodyDigest, requestBytes: requestBody.byteLength, requestBody, inputValues, label, usage: { requestCharge: 0, inputTokens: null, outputTokens: null, totalTokens: null, tokenLowerBound: 0, costUsd: null, tokenAccounting: "incomplete", costAccounting: "incomplete" } };
      const admission = await job.effectHost.prepareEffect(state.revision, intent);
      if (admission.kind !== "ready") return blocked(admission.code);
      let received: { responseDigest: string; responseBytes: Uint8Array; status: number } | undefined;
      let receivedUsage: ProviderUsageReceipt | undefined;
      try {
      const response = await postJsonPinned({ url: new URL(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`), apiKey, extraHeaders: config.headers, serializedBody: requestBody, signal, allowLoopback: config.allowLoopback, lookup, rawResponse: true, captureStatus: true });
      received = response;
      if (response.responseBytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("resource-limit");
      const root = parseStrictJson(response.responseBytes);
      if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("transport-failure");
      const responseObject = root as Record<string, unknown>;
      receivedUsage = providerUsage(responseObject, job);
      if (response.status < 200 || response.status >= 300) throw new Error("transport-failure");
      const choices = Array.isArray(responseObject.choices) ? responseObject.choices : [];
      const choice = choices.length === 1 && choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : null;
      const message = choice && asObject(choice.message);
      if (!message || message.role !== "assistant" || choice?.finish_reason !== "stop" || message.tool_calls !== undefined || typeof message.content !== "string") throw new Error("invalid-output");
      if (Buffer.byteLength(message.content, "utf8") > MAX_VALUE_BYTES) throw new Error("resource-limit");
      const producedBytes = encodeStrictOutput(message.content);
      const producedValue: GovernedValueRecord = { id: operation.id, digest: digest(producedBytes), bytes: producedBytes.byteLength, label, producer: { kind: "derive", operationId: operation.id, transformationId: operation.transformationId, inputIds: [...operation.inputs], originalCallId: actionId }, retained: confidentiality === "sealed" ? null : retainedValue(producedBytes) };
      await job.effectHost.completeEffect(admission.permit, { outcome: { kind: "success", resultDigest: producedValue.digest }, providerUsage: receivedUsage, producedValue, producedBytes, candidateProgram: null, responseDigest: response.responseDigest, responseBytes: response.responseBytes.byteLength });
      acquiredValues.set(operation.id, producedBytes);
      } catch (error) {
        const code = error instanceof Error && ["invalid-output", "resource-limit", "transport-failure"].includes(error.message) ? error.message as FailureCode : "transport-failure";
        if (received) {
          const usage = receivedUsage ?? { requestCharge: 1 as const, inputTokens: null, outputTokens: null, totalTokens: null, tokenLowerBound: 0, costUsd: null, tokenAccounting: "incomplete" as const, costAccounting: "incomplete" as const };
          try { await job.effectHost.completeEffect(admission.permit, { outcome: { kind: "failure", code }, providerUsage: usage, producedValue: null, producedBytes: null, candidateProgram: null, responseDigest: received.responseDigest, responseBytes: received.responseBytes.byteLength }); }
          catch { return blocked("uncertain-effect"); }
        } else await job.effectHost.markUncertain(admission.permit, code);
        return blocked(code);
      }
      state = await job.effectHost.open(job.assuranceContext, true);
      continue;
    }
    if (operation.kind === "read") {
      let source;
      try { source = await job.effectHost.readSource(operation.path, signal); } catch { return blocked("policy-denied"); }
      if (source.content.byteLength > MAX_VALUE_BYTES || source.evidence.bytes !== source.content.byteLength || source.evidence.digest !== digest(source.content)) return blocked("resource-limit");
      acquiredValues.set(operation.id, source.content);
      const value: GovernedValueRecord = {
        id: operation.id, digest: source.evidence.digest, bytes: source.content.byteLength, label: source.evidence.label,
        producer: { kind: "read", operationId: operation.id, path: operation.path, sourceDigest: source.evidence.digest },
        retained: source.evidence.label.confidentiality === "sealed" ? null : retainedValue(source.content),
      };
      if (checkpoint.values.reduce((sum, item) => sum + item.bytes, 0) + value.bytes > 64 * 1024 * 1024) return blocked("resource-limit");
      const next = { ...checkpoint, cursor: checkpoint.cursor + 1, values: [...checkpoint.values, value], recordedAt: new Date().toISOString() } as HttpGovernedCheckpoint;
      try { state = await job.effectHost.saveProgress(state.revision, next); } catch { return blocked("stale-authority"); }
      continue;
    }
    const authority: EffectIntent["authority"] = { programKind: "governed", authorityDigest: checkpoint.programAuthorityDigest, programFingerprint: checkpoint.programFingerprint };
    if (operation.kind === "write") {
      const record = checkpoint.values.find((value) => value.id === operation.value);
      const bytes = record && await materialize(record);
      if (!record || !bytes) return blocked(recoveryFailureCode ?? "missing-sealed-value");
      const valueEvidence = { id: record.id, digest: record.digest, bytes: record.bytes, label: record.label };
      const requestDigest = digest(new TextEncoder().encode(canonical({ kind: "write", path: operation.path, expectedTargetDigest: operation.expectedTargetDigest, valueDigest: record.digest, jailFingerprint: checkpoint.identities.jailFingerprint })));
      const prior = checkpoint.effects.find((effect) => effect.state === "awaiting-approval" && effect.operationId === operation.id && effect.kind === "write" && effect.sinkId === operation.id && effect.requestDigest === requestDigest && effect.valueDigest === record.digest);
      const actionId = prior?.actionId ?? governedActionId();
      const intent: EffectIntent = { kind: "write", actionId, operationId: operation.id, authority, sinkId: operation.id, requestDigest, valueDigest: record.digest, inputs: [valueEvidence], path: operation.path, value: valueEvidence, expectedTargetDigest: operation.expectedTargetDigest };
      const admission = await job.effectHost.prepareEffect(state.revision, intent);
      if (admission.kind !== "ready") return blocked(admission.code);
      try {
        const completion = await job.effectHost.dispatchWrite(admission.permit, bytes, signal);
        if (completion.outcome.kind !== "success") return blocked(completion.outcome.code);
        state = await job.effectHost.open(job.assuranceContext, true);
      } catch { return blocked("uncertain-effect"); }
      continue;
    }
    if (operation.kind === "external-call") {
      const grant = approvedExternalGrant(job.assuranceContext.policy, operation.grantId);
      const pointers = operation.data.map((entry) => entry.pointer);
      if (!grant || (grant.effect !== "http-mcp" && grant.effect !== "provider") || canonical(grant.authority) !== canonical(operation.authority) || typeof grant.sinkId !== "string" || !Array.isArray(grant.dataPointers) || canonical(grant.dataPointers) !== canonical(pointers)) return blocked("policy-denied");
      const data: Array<{ pointer: string; value: GovernedValueRecord; content: Uint8Array }> = [];
      for (const entry of operation.data) {
        const value = checkpoint.values.find((item) => item.id === entry.value);
        const content = value && await materialize(value);
        if (!value || !content) return blocked(recoveryFailureCode ?? (value?.producer.kind === "external-call" ? "missing-sealed-value" : "recovery-value-mismatch"));
        data.push({ pointer: entry.pointer, value, content });
      }
      const inputs = data.map(({ value }) => ({ id: value.id, digest: value.digest, bytes: value.bytes, label: value.label }));
      const inputValues = data.map(({ value, content }) => ({ evidence: { id: value.id, digest: value.digest, bytes: value.bytes, label: value.label }, content }));
      const packet = { grantId: operation.grantId, authority: operation.authority, data: data.map(({ pointer, content }) => ({ pointer, value: retainedValue(content) })) };
      const valueDigest = digest(new TextEncoder().encode(canonical(packet)));
      if (grant.effect === "provider") {
        if (typeof grant.tool !== "string" || job.assuranceContext.identities.provider.endpoint !== config.baseUrl.replace(/\/$/, "") || job.assuranceContext.identities.provider.model !== config.model) return blocked("policy-denied");
        const bodyObject = {
          model: job.assuranceContext.identities.provider.model,
          messages: [
            { role: "system", content: "Return only the opaque response for this approved external call. No tools or commands." },
            { role: "user", content: canonical(packet) },
          ],
          temperature: 0,
          stream: false,
        };
        const requestBody = new TextEncoder().encode(JSON.stringify(bodyObject));
        if (requestBody.byteLength > MAX_REQUEST_BYTES || data.some((entry) => entry.content.byteLength > MAX_VALUE_BYTES)) return blocked("resource-limit");
        const bodyDigest = digest(requestBody);
        const requestDigest = digest(new TextEncoder().encode(canonical({ version: 1, kind: "external-call-provider", endpoint: config.baseUrl, model: config.model, profile: job.assuranceContext.identities.provider.profile, grantId: operation.grantId, sinkId: grant.sinkId, authority: operation.authority, pointers, bodyDigest })));
        const prior = checkpoint.providerCalls.find((call) => call.state === "awaiting-approval" && call.purpose.kind === "external-call" && call.purpose.operationId === operation.id && call.purpose.grantId === operation.grantId && call.requestDigest === requestDigest && call.bodyDigest === bodyDigest && call.valueDigest === valueDigest);
        const actionId = prior?.actionId ?? governedActionId();
        const labelOrigins = [...new Set([...job.assuranceContext.plannerInput.label.origins, ...data.flatMap(({ value }) => value.label.origins)])].sort();
        if (labelOrigins.length > 256) return blocked("resource-limit");
        const requestLabel = { origins: labelOrigins, integrity: data.some(({ value }) => value.label.integrity === "untrusted") ? "untrusted" as const : job.assuranceContext.plannerInput.label.integrity, confidentiality: data.some(({ value }) => value.label.confidentiality === "sealed") ? "sealed" as const : job.assuranceContext.plannerInput.label.confidentiality };
        const intent: EffectIntent = { kind: "provider", actionId, authority, sinkId: grant.sinkId as string, requestDigest, valueDigest, inputs, role: "quarantined", purpose: { kind: "external-call", operationId: operation.id, grantId: operation.grantId }, endpoint: config.baseUrl, model: config.model, bodyDigest, requestBytes: requestBody.byteLength, requestBody, inputValues, externalGrant: { operationId: operation.id, grantId: operation.grantId, sinkId: grant.sinkId as string, authority: operation.authority, dataPointers: pointers }, label: requestLabel, usage: { requestCharge: 0, inputTokens: null, outputTokens: null, totalTokens: null, tokenLowerBound: 0, costUsd: null, tokenAccounting: "incomplete", costAccounting: "incomplete" } };
        const admission = await job.effectHost.prepareEffect(state.revision, intent);
        if (admission.kind !== "ready") return blocked(admission.code);
        let received: { responseDigest: string; responseBytes: Uint8Array; status: number } | undefined;
        let receivedUsage: ProviderUsageReceipt | undefined;
        try {
          const response = await postJsonPinned({ url: new URL(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`), apiKey, extraHeaders: config.headers, serializedBody: requestBody, signal, allowLoopback: config.allowLoopback, lookup, rawResponse: true, captureStatus: true });
          received = response;
          if (response.responseBytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("resource-limit");
          const root = parseStrictJson(response.responseBytes);
          if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("transport-failure");
          const responseObject = root as Record<string, unknown>;
          receivedUsage = providerUsage(responseObject, job);
          if (response.status < 200 || response.status >= 300) throw new Error("transport-failure");
          const choices = Array.isArray(responseObject.choices) ? responseObject.choices : [];
          const choice = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : null;
          const message = choice && asObject(choice.message);
          if (choices.length !== 1 || !message || message.role !== "assistant" || choice?.finish_reason !== "stop" || message.tool_calls !== undefined || typeof message.content !== "string") throw new Error("invalid-output");
          if (Buffer.byteLength(message.content, "utf8") > MAX_VALUE_BYTES) throw new Error("resource-limit");
          const responseContent = encodeStrictOutput(message.content);
          const usageReceipt = receivedUsage;
          const outputOrigins = [...new Set([...labelOrigins, remoteOriginId({ grantId: operation.grantId, authority: operation.authority, endpoint: config.baseUrl, model: config.model, profile: job.assuranceContext.identities.provider.profile })])].sort();
          if (outputOrigins.length > 256) throw new Error("resource-limit");
          const producedValue: GovernedValueRecord = { id: operation.id, digest: digest(responseContent), bytes: responseContent.byteLength, label: { origins: outputOrigins, integrity: "untrusted", confidentiality: "sealed" }, producer: { kind: "external-call", operationId: operation.id, actionId }, retained: null };
          await job.effectHost.completeEffect(admission.permit, { outcome: { kind: "success", resultDigest: producedValue.digest }, providerUsage: usageReceipt, producedValue, producedBytes: responseContent, candidateProgram: null, responseDigest: response.responseDigest, responseBytes: response.responseBytes.byteLength });
        } catch (error) {
          const code = error instanceof Error && ["invalid-output", "resource-limit", "transport-failure"].includes(error.message) ? error.message as FailureCode : "transport-failure";
          if (received) {
            const providerUsage = receivedUsage ?? { requestCharge: 1 as const, inputTokens: null, outputTokens: null, totalTokens: null, tokenLowerBound: 0, costUsd: null, tokenAccounting: "incomplete" as const, costAccounting: "incomplete" as const };
            try { await job.effectHost.completeEffect(admission.permit, { outcome: { kind: "failure", code }, providerUsage, producedValue: null, producedBytes: null, candidateProgram: null, responseDigest: received.responseDigest, responseBytes: received.responseBytes.byteLength }); }
            catch { return blocked("uncertain-effect"); }
          } else await job.effectHost.markUncertain(admission.permit, code);
          return blocked(code);
        }
        state = await job.effectHost.open(job.assuranceContext, true);
        continue;
      }
      const transport = asObject(grant.transport);
      if (grant.effect !== "http-mcp" || typeof grant.tool !== "string" || !transport ||
          transport.transport !== "streamable-http" ||
          typeof transport.fingerprint !== "string" || typeof transport.schemaFingerprint !== "string" ||
          canonical(transport.fixedAuthority) !== canonical(operation.authority) ||
          canonical(grant.dataPointers) !== canonical(pointers)) return blocked("policy-denied");
      const transportFingerprint = transport.fingerprint;
      const schemaFingerprint = transport.schemaFingerprint;
      let argumentsDigest: string;
      try {
        argumentsDigest = await job.effectHost.mcpArgumentsDigest(operation.grantId, data.map(({ pointer, content }) => ({ pointer, content })));
      } catch { return blocked("policy-denied"); }
      const requestDigest = digest(new TextEncoder().encode(canonical({ version: 2, kind: "http-mcp", grantId: operation.grantId, sinkId: grant.sinkId, authority: operation.authority, transportFingerprint, schemaFingerprint, dataPointers: pointers, valueDigest, argumentsDigest })));
      const prior = checkpoint.effects.find((effect) => effect.state === "awaiting-approval" && effect.operationId === operation.id && effect.kind === "external-call" && effect.sinkId === grant.sinkId && effect.requestDigest === requestDigest && effect.valueDigest === valueDigest);
      const actionId = prior?.actionId ?? governedActionId();
      const intent: EffectIntent = { kind: "http-mcp", actionId, operationId: operation.id, authority, sinkId: grant.sinkId as string, requestDigest, valueDigest, inputs, grantId: operation.grantId, transportFingerprint, schemaFingerprint, fixedAuthority: operation.authority, data: data.map(({ pointer, value, content }) => ({ pointer, value: { id: value.id, digest: value.digest, bytes: value.bytes, label: value.label }, content })) };
      const admission = await job.effectHost.prepareEffect(state.revision, intent);
      if (admission.kind !== "ready") return blocked(admission.code);
      try {
        const completion = await job.effectHost.dispatchMcp(admission.permit, data.map(({ pointer, content }) => ({ pointer, content })), signal);
        if (completion.outcome.kind !== "success") return blocked(completion.outcome.code);
        state = await job.effectHost.open(job.assuranceContext, true);
      } catch { return blocked("uncertain-effect"); }
      continue;
    }
    return blocked("policy-denied");
  }
  const plannerUsage = state.checkpoint.usage.planner;
  const quarantineUsage = state.checkpoint.usage.quarantined;
  const usage: HttpAgentUsage = {
    requests: plannerUsage.requests + quarantineUsage.requests,
    toolCalls: 0,
    ...(plannerUsage.inputTokens !== null && quarantineUsage.inputTokens !== null ? { inputTokens: plannerUsage.inputTokens + quarantineUsage.inputTokens } : {}),
    ...(plannerUsage.outputTokens !== null && quarantineUsage.outputTokens !== null ? { outputTokens: plannerUsage.outputTokens + quarantineUsage.outputTokens } : {}),
    ...(plannerUsage.inputTokens !== null && plannerUsage.outputTokens !== null && quarantineUsage.inputTokens !== null && quarantineUsage.outputTokens !== null ? { totalTokens: plannerUsage.inputTokens + plannerUsage.outputTokens + quarantineUsage.inputTokens + quarantineUsage.outputTokens } : {}),
    model: job.assuranceContext.identities.provider.model,
    profile: job.assuranceContext.identities.provider.profile,
    ...(plannerUsage.costUsd !== null && quarantineUsage.costUsd !== null ? { estimatedCostUsd: plannerUsage.costUsd + quarantineUsage.costUsd } : {}),
    costEstimated: plannerUsage.costAccounting === "incomplete" || quarantineUsage.costAccounting === "incomplete",
  };
  result.usage = usage;
  return state.checkpoint.status === "complete" ? { ...result, exitCode: 0, recovery: "none" } : blocked("policy-denied");
}
