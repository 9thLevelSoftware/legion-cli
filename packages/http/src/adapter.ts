import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { HttpAdapterConfig } from "@9thlevelsoftware/legion-cli-schema";
import {
  assertCompatibleCheckpoint,
  checkpointPath,
  readHttpCheckpoint,
  recoverPendingToolOutcome,
  sha256Text,
  stableHash,
  writeHttpCheckpoint,
  type HttpCheckpoint,
  type HttpCheckpointIdentities,
  type HttpToolOutcome,
} from "./checkpoint.js";
import { postJsonPinned } from "./client.js";
import { HttpAdapterError } from "./errors.js";
import { parseAssistantResponse, toolCallSignature } from "./protocol.js";
import { httpAdapterNotReadyReason } from "./ssrf.js";
import {
  dispatchToolCall,
  MAX_TOOL_ROUNDS,
  toolsForJob,
  validateToolCallArguments,
  type OpenAiToolCall,
} from "./tools.js";
import type { HttpAgentHandle, HttpAgentJob, HttpAgentResult, SsrfLookup } from "./types.js";

export const MAX_PROMPT_CHARS = 256 * 1024;

/** Golden join: strip one trailing slash, then `/chat/completions`. */
export function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
};

type DetectResult = { ok: boolean; version?: string; reason?: string };

function runLogPaths(cwd: string, runId: string): { stdoutPath: string; stderrPath: string; summaryPath: string } {
  const runDir = join(cwd, ".legion-cli", "cache", "runs", runId);
  return {
    stdoutPath: join(runDir, "stdout.log"),
    stderrPath: join(runDir, "stderr.log"),
    summaryPath: join(runDir, "summary.md"),
  };
}

class HttpHandle implements HttpAgentHandle {
  readonly pid = null;
  readonly #run: (signal: AbortSignal) => Promise<HttpAgentResult>;
  readonly #controller = new AbortController();
  #result: Promise<HttpAgentResult> | undefined;
  #timedOut = false;
  #timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(run: (signal: AbortSignal) => Promise<HttpAgentResult>, timeoutMs: number) {
    this.#run = run;
    if (timeoutMs > 0) {
      this.#timeout = setTimeout(() => {
        this.#timedOut = true;
        this.#controller.abort();
      }, timeoutMs);
    }
  }

  wait(): Promise<HttpAgentResult> {
    this.#result ??= this.#run(this.#controller.signal)
      .then((result) => {
        if (this.#timedOut) return { ...result, timedOut: true, aborted: false, exitCode: null };
        return result;
      })
      .finally(() => {
        if (this.#timeout) clearTimeout(this.#timeout);
      });
    return this.#result;
  }

  async abort(): Promise<void> {
    this.#controller.abort();
  }
}

export class HttpAdapter {
  readonly id = "http" as const;
  readonly binary = "(http)";
  readonly #config?: HttpAdapterConfig;
  readonly #lookup?: SsrfLookup;

  constructor(config?: HttpAdapterConfig, lookup?: SsrfLookup) {
    this.#config = config;
    this.#lookup = lookup;
  }

  async detect(): Promise<DetectResult> {
    const reason = httpAdapterNotReadyReason(this.#config);
    if (reason) return { ok: false, reason };
    return { ok: true, version: this.#config?.model };
  }

  async spawn(job: HttpAgentJob): Promise<HttpAgentHandle> {
    return new HttpHandle((signal) => this.#run(job, signal), job.timeoutMs);
  }

  async #run(job: HttpAgentJob, signal: AbortSignal): Promise<HttpAgentResult> {
    const paths = runLogPaths(job.cwd, job.runId);
    const savedCheckpointPath = checkpointPath(job.checkpointRoot ?? job.cwd, job.runId);
    await mkdir(dirname(paths.stdoutPath), { recursive: true });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const flush = async () => {
      await writeFile(paths.stdoutPath, stdout.join(""), "utf8");
      await writeFile(paths.stderrPath, stderr.join(""), "utf8");
    };

    const fail = async (message: string, extra: Partial<HttpAgentResult> = {}): Promise<HttpAgentResult> => {
      stderr.push(`${message}\n`);
      await flush();
      return {
        exitCode: extra.exitCode === undefined ? 1 : extra.exitCode,
        timedOut: Boolean(extra.timedOut),
        aborted: Boolean(extra.aborted),
        stdoutPath: paths.stdoutPath,
        stderrPath: paths.stderrPath,
        checkpointPath: savedCheckpointPath,
        usage: extra.usage,
        recovery: extra.recovery,
      };
    };

    const reason = httpAdapterNotReadyReason(this.#config, { ...process.env, ...job.env });
    if (reason) return fail(reason);
    const config = this.#config;
    if (!config) return fail("adapter.http is not configured");

    if (signal.aborted) return fail("adapter.http aborted", { aborted: true, exitCode: null });

    const promptAbs = isAbsolute(job.promptPath) ? job.promptPath : join(job.cwd, job.promptPath);
    let prompt: string;
    try {
      prompt = await readFile(promptAbs, "utf8");
    } catch (err) {
      return fail(`adapter.http could not read prompt.md: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return fail(`adapter.http prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }

    const apiKey = (job.env[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "").trim();
    const url = new URL(completionsUrl(config.baseUrl));
    const tools = toolsForJob(job.skillId, job.httpHost);
    const initialMessages: ChatMessage[] = [
      {
        role: "system",
        content: [
          job.pointerPrompt,
          "",
          "Use tools to read and write jail-relative POSIX paths when tools are present.",
          "Do not git add or git commit. Do not print secrets.",
        ].join("\n"),
      },
      { role: "user", content: prompt },
    ];

    const identities: HttpCheckpointIdentities = {
      promptHash: sha256Text(prompt),
      configHash: stableHash({
        baseUrl: config.baseUrl,
        model: config.model,
        apiKeyEnv: config.apiKeyEnv,
        allowLoopback: config.allowLoopback,
        headers: config.headers ?? {},
        profile: job.profile,
        outputLimit: job.outputLimit,
        maxRequests: job.maxRequests,
        maxToolRounds: job.maxToolRounds,
        maxReportedTokens: job.maxReportedTokens,
        maxEstimatedCostUsd: job.maxEstimatedCostUsd,
        pricing: job.pricing,
        externalConfigIdentity: job.externalConfigIdentity,
      }),
      contractHash: job.contractIdentity ?? stableHash(tools),
      sourceIdentity: job.sourceIdentity ?? stableHash({ cwd: job.cwd }),
      jailIdentity: job.jailIdentity ?? stableHash({ jailRoot: job.httpHost?.jailRoot ?? job.cwd }),
    };
    if (job.resume && (!job.sourceIdentity || !job.contractIdentity || !job.jailIdentity)) {
      return fail("adapter.http resume requires explicit source, contract, and jail identities");
    }

    let checkpoint: HttpCheckpoint;
    const existing = job.resume ? await readHttpCheckpoint(savedCheckpointPath) : null;
    if (job.resume) {
      if (!existing) return fail(`adapter.http checkpoint not found for ${job.runId}`);
      try {
        assertCompatibleCheckpoint(existing, identities);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      checkpoint = existing;
    } else {
      checkpoint = {
        version: 1,
        runId: job.runId,
        identities,
        conversation: initialMessages as Array<Record<string, unknown>>,
        round: 0,
        toolOutcomes: [],
        usage: { requests: 0, toolCalls: 0, model: config.model, ...(job.profile ? { profile: job.profile } : {}) },
        usageAccounting: { tokenTotalIncomplete: false, tokenLowerBound: 0, costIncomplete: false },
        completion: { status: "running" },
        updatedAt: new Date().toISOString(),
      };
      await writeHttpCheckpoint(savedCheckpointPath, checkpoint);
    }

    const messages = checkpoint.conversation as ChatMessage[];
    // Legacy checkpoints lack per-request completeness. Resume conservatively for cost caps.
    checkpoint.usageAccounting ??= {
      tokenTotalIncomplete: checkpoint.usage.requests > 0 && checkpoint.usage.totalTokens === undefined,
      tokenLowerBound: checkpoint.usage.totalTokens ?? (checkpoint.usage.inputTokens ?? 0) + (checkpoint.usage.outputTokens ?? 0),
      costIncomplete: checkpoint.usage.requests > 0,
    };
    const usageAccounting = checkpoint.usageAccounting;
    const saveCheckpoint = async () => {
      checkpoint.updatedAt = new Date().toISOString();
      await writeHttpCheckpoint(savedCheckpointPath, checkpoint);
    };
    const resultUsage = () => ({ ...checkpoint.usage });
    const usageLimitFailure = (inclusive = true): string | null => {
      const tokenUsage = usageAccounting.tokenLowerBound;
      const estimatedCost = checkpoint.usage.estimatedCostUsd ?? 0;
      if (job.maxReportedTokens !== undefined && (inclusive ? tokenUsage >= job.maxReportedTokens : tokenUsage > job.maxReportedTokens)) {
        return `adapter.http reached reported token limit ${job.maxReportedTokens}`;
      }
      if (job.maxReportedTokens !== undefined && checkpoint.usage.requests > 0 && usageAccounting.tokenTotalIncomplete) {
        return "adapter.http cannot enforce reported token limit because provider usage is incomplete";
      }
      if (
        job.maxEstimatedCostUsd !== undefined &&
        checkpoint.usage.requests > 0 &&
        (usageAccounting.costIncomplete || checkpoint.usage.estimatedCostUsd === undefined)
      ) {
        return "adapter.http cannot enforce estimated cost limit because pricing or reported usage is incomplete";
      }
      if (job.maxEstimatedCostUsd !== undefined && (inclusive ? estimatedCost >= job.maxEstimatedCostUsd : estimatedCost > job.maxEstimatedCostUsd)) {
        return `adapter.http reached estimated cost limit ${job.maxEstimatedCostUsd}`;
      }
      return null;
    };
    const checkpointRecovery = (): HttpAgentResult["recovery"] => {
      if (checkpoint.request?.status === "dispatching") return "manual";
      const pending = checkpoint.toolOutcomes.filter((outcome) => outcome.status === "pending");
      if (pending.length === 0) return "none";
      return pending.every((outcome) =>
        outcome.name === "read_file" || outcome.name === "list_dir",
      )
        ? "resume"
        : "manual";
    };
    if (checkpoint.completion.status === "complete") {
      const summary = checkpoint.completion.summary ?? "";
      await writeFile(paths.summaryPath, summary.endsWith("\n") ? summary : `${summary}\n`, "utf8");
      await flush();
      return {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        stdoutPath: paths.stdoutPath,
        stderrPath: paths.stderrPath,
        summaryPath: paths.summaryPath,
        checkpointPath: savedCheckpointPath,
        usage: resultUsage(),
      };
    }
    if (checkpoint.request?.status === "dispatching") {
      return fail(
        `adapter.http provider request round ${checkpoint.request.round} outcome is uncertain; recovery is blocked`,
        { usage: resultUsage(), recovery: "manual" },
      );
    }

    const lastPersisted = messages.at(-1);
    if (
      lastPersisted?.role === "assistant" &&
      (!lastPersisted.tool_calls || lastPersisted.tool_calls.length === 0) &&
      typeof lastPersisted.content === "string" &&
      lastPersisted.content.trim()
    ) {
      const exceededLimit = usageLimitFailure(false);
      if (exceededLimit) return fail(exceededLimit, { usage: resultUsage() });
      checkpoint.completion = { status: "complete", summary: lastPersisted.content };
      await saveCheckpoint();
      await writeFile(paths.summaryPath, lastPersisted.content.endsWith("\n") ? lastPersisted.content : `${lastPersisted.content}\n`, "utf8");
      await flush();
      return {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        stdoutPath: paths.stdoutPath,
        stderrPath: paths.stderrPath,
        summaryPath: paths.summaryPath,
        checkpointPath: savedCheckpointPath,
        usage: resultUsage(),
      };
    }
    const persistedLimitFailure = usageLimitFailure();
    if (persistedLimitFailure) return fail(persistedLimitFailure, { usage: resultUsage() });

    try {
      let repairedMissingOutcomes = false;
      for (const message of messages) {
        for (const call of message.tool_calls ?? []) {
          const signature = toolCallSignature(call);
          const prior = checkpoint.toolOutcomes.find((item) => item.id === call.id);
          if (prior && prior.signature !== signature) {
            throw new HttpAdapterError(`adapter.http conflicting checkpoint tool call id ${call.id}`);
          }
          if (!prior) {
            checkpoint.toolOutcomes.push({
              id: call.id,
              signature,
              name: call.function.name,
              arguments: call.function.arguments,
              status: "pending",
            });
            checkpoint.usage.toolCalls += 1;
            repairedMissingOutcomes = true;
          }
        }
      }
      if (repairedMissingOutcomes) await saveCheckpoint();
      const responded = new Set(
        messages
          .filter((message) => message.role === "tool" && typeof message.tool_call_id === "string")
          .map((message) => message.tool_call_id as string),
      );
      for (let index = 0; index < checkpoint.toolOutcomes.length; index += 1) {
        const outcome = checkpoint.toolOutcomes[index];
        if (!outcome || responded.has(outcome.id)) continue;
        const recovered = outcome.status === "completed"
          ? outcome
          : await recoverPendingToolOutcome(outcome, job.httpHost, job.skillId);
        checkpoint.toolOutcomes[index] = recovered;
        messages.push({ role: "tool", tool_call_id: recovered.id, content: recovered.result ?? "" });
        responded.add(recovered.id);
        checkpoint.conversation = messages as Array<Record<string, unknown>>;
        await saveCheckpoint();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(message, {
        usage: resultUsage(),
        recovery: /outcome is uncertain/.test(message) ? "manual" : checkpointRecovery(),
      });
    }

    let lastContent = "";
    try {
      const toolRoundLimit = Math.min(job.maxToolRounds ?? MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS);
      for (let round = checkpoint.round + 1; round <= toolRoundLimit; round += 1) {
        if (signal.aborted) return fail("adapter.http aborted", { aborted: true, exitCode: null });
        if (job.maxRequests !== undefined && checkpoint.usage.requests >= job.maxRequests) {
          return fail(`adapter.http reached profile request limit ${job.maxRequests}`, { usage: resultUsage() });
        }
        const preDispatchLimitFailure = usageLimitFailure();
        if (preDispatchLimitFailure) return fail(preDispatchLimitFailure, { usage: resultUsage() });
        const body: Record<string, unknown> = {
          model: config.model,
          messages,
        };
        if (job.outputLimit !== undefined) body.max_tokens = job.outputLimit;
        if (tools.length > 0) {
          body.tools = tools;
          body.tool_choice = "auto";
        }
        checkpoint.request = { status: "dispatching", round, requestHash: stableHash(body) };
        checkpoint.conversation = messages as Array<Record<string, unknown>>;
        await saveCheckpoint();
        const res = await postJsonPinned({
          url,
          apiKey,
          extraHeaders: config.headers,
          body,
          signal,
          allowLoopback: config.allowLoopback,
          lookup: this.#lookup,
        });
        checkpoint.usage.requests += 1;
        stdout.push(`HTTP ${res.status} POST /chat/completions round=${round}\n`);
        const { content, toolCalls, usage } = parseAssistantResponse(res.json);
        if (usage) {
          if (usage.inputTokens !== undefined) {
            checkpoint.usage.inputTokens = (checkpoint.usage.inputTokens ?? 0) + usage.inputTokens;
          }
          if (usage.outputTokens !== undefined) {
            checkpoint.usage.outputTokens = (checkpoint.usage.outputTokens ?? 0) + usage.outputTokens;
          }
          const tokenLowerBound = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
          usageAccounting.tokenLowerBound += tokenLowerBound;
          if (usage.totalTokens === undefined) {
            usageAccounting.tokenTotalIncomplete = true;
            checkpoint.usage.totalTokens = undefined;
          } else if (!usageAccounting.tokenTotalIncomplete) {
            checkpoint.usage.totalTokens = (checkpoint.usage.totalTokens ?? 0) + usage.totalTokens;
          }
        } else {
          usageAccounting.tokenTotalIncomplete = true;
          checkpoint.usage.totalTokens = undefined;
        }
        const completeCostRound = Boolean(
          job.pricing?.inputPerMillionUsd !== undefined &&
          job.pricing.outputPerMillionUsd !== undefined &&
          job.pricing.requestUsd !== undefined &&
          usage?.inputTokens !== undefined &&
          usage.outputTokens !== undefined
        );
        if (!completeCostRound) usageAccounting.costIncomplete = true;
        if (!usageAccounting.costIncomplete && completeCostRound) {
          checkpoint.usage.estimatedCostUsd =
            ((checkpoint.usage.inputTokens ?? 0) / 1_000_000) * job.pricing!.inputPerMillionUsd! +
            ((checkpoint.usage.outputTokens ?? 0) / 1_000_000) * job.pricing!.outputPerMillionUsd! +
            checkpoint.usage.requests * job.pricing!.requestUsd!;
          checkpoint.usage.costEstimated = true;
        } else {
          checkpoint.usage.estimatedCostUsd = undefined;
          checkpoint.usage.costEstimated = false;
        }
        lastContent = content;
        for (const call of toolCalls) validateToolCallArguments(call, job.httpHost, job.skillId);
        const assistant: ChatMessage = {
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls,
        };
        messages.push(assistant);
        const newCallIds = new Set<string>();
        for (const call of toolCalls) {
          const signature = toolCallSignature(call);
          const prior = checkpoint.toolOutcomes.find((item) => item.id === call.id);
          if (prior) {
            throw new HttpAdapterError(
              `adapter.http ${prior.signature === signature ? "duplicate" : "conflicting"} tool call id ${call.id}`,
            );
          }
          checkpoint.toolOutcomes.push({
            id: call.id,
            signature,
            name: call.function.name,
            arguments: call.function.arguments,
            status: "pending",
          });
          checkpoint.usage.toolCalls += 1;
          newCallIds.add(call.id);
        }
        checkpoint.round = round;
        checkpoint.request = undefined;
        checkpoint.conversation = messages as Array<Record<string, unknown>>;
        // Parsed response, usage, completed round, assistant call, and every pending outcome land atomically.
        await saveCheckpoint();
        const exceededLimit = usageLimitFailure(false);
        if (exceededLimit) return fail(exceededLimit, { usage: resultUsage() });
        if (toolCalls.length === 0) break;
        const reachedLimit = usageLimitFailure();
        if (reachedLimit) return fail(reachedLimit, { usage: resultUsage() });
        for (const call of toolCalls) {
          if (signal.aborted) {
            return fail("adapter.http aborted", {
              aborted: true,
              exitCode: null,
              usage: resultUsage(),
              recovery: checkpointRecovery(),
            });
          }
          const signature = toolCallSignature(call);
          const prior = checkpoint.toolOutcomes.find((item) => item.id === call.id);
          if (prior && prior.signature !== signature) {
            throw new HttpAdapterError(`adapter.http conflicting tool call id ${call.id}`);
          }
          let outcome: HttpToolOutcome;
          if (prior?.status === "completed") {
            outcome = prior;
          } else if (prior && !newCallIds.has(call.id)) {
            outcome = await recoverPendingToolOutcome(prior, job.httpHost, job.skillId);
            Object.assign(prior, outcome);
          } else {
            if (!prior) throw new HttpAdapterError(`adapter.http missing pending tool call ${call.id}`);
            outcome = prior;
            const output = await dispatchToolCall(call, job.httpHost, job.skillId, signal);
            outcome.status = "completed";
            outcome.result = output;
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: outcome.result ?? "",
          });
          checkpoint.conversation = messages as Array<Record<string, unknown>>;
          // Completion and matching tool response are persisted together.
          await saveCheckpoint();
        }
        if (round === toolRoundLimit) {
          return fail(`adapter.http exceeded ${toolRoundLimit} tool rounds`);
        }
      }
    } catch (err) {
      if (signal.aborted) return fail("adapter.http aborted", { aborted: true, exitCode: null, recovery: checkpointRecovery() });
      const message = err instanceof HttpAdapterError ? err.message : err instanceof Error ? err.message : String(err);
      return fail(message, {
        usage: resultUsage(),
        recovery: err instanceof HttpAdapterError && !/outcome is uncertain/.test(message)
          ? "none"
          : checkpointRecovery(),
      });
    }

    checkpoint.completion = { status: "complete", summary: lastContent };
    checkpoint.conversation = messages as Array<Record<string, unknown>>;
    await saveCheckpoint();
    await writeFile(paths.summaryPath, lastContent.endsWith("\n") ? lastContent : `${lastContent}\n`, "utf8");
    await flush();
    return {
      exitCode: 0,
      timedOut: false,
      aborted: false,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      summaryPath: paths.summaryPath,
      checkpointPath: savedCheckpointPath,
      usage: resultUsage(),
    };
  }
}
