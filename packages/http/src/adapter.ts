import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { HttpAdapterConfig } from "@9thlevelsoftware/legion-cli-schema";
import { postJsonPinned } from "./client.js";
import { HttpAdapterError } from "./errors.js";
import { httpAdapterNotReadyReason } from "./ssrf.js";
import { dispatchToolCall, MAX_TOOL_ROUNDS, toolsForJob, type OpenAiToolCall } from "./tools.js";
import type { HttpAgentHandle, HttpAgentJob, HttpAgentResult, SsrfLookup } from "./types.js";
import { completionsUrl } from "./url.js";

export const MAX_PROMPT_CHARS = 256 * 1024;

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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function assistantMessage(json: unknown): { content: string; toolCalls: OpenAiToolCall[] } {
  const root = asRecord(json);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const content = typeof message.content === "string" ? message.content : "";
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: OpenAiToolCall[] = [];
  for (const entry of rawCalls) {
    const rec = asRecord(entry);
    const fn = asRecord(rec.function);
    toolCalls.push({
      id: typeof rec.id === "string" ? rec.id : `call_${toolCalls.length}`,
      type: typeof rec.type === "string" ? rec.type : "function",
      function: {
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
      },
    });
  }
  return { content, toolCalls };
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
    const messages: ChatMessage[] = [
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

    let lastContent = "";
    try {
      for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
        if (signal.aborted) return fail("adapter.http aborted", { aborted: true, exitCode: null });
        const body: Record<string, unknown> = {
          model: config.model,
          messages,
        };
        if (tools.length > 0) {
          body.tools = tools;
          body.tool_choice = "auto";
        }
        const res = await postJsonPinned({
          url,
          apiKey,
          extraHeaders: config.headers,
          body,
          signal,
          allowLoopback: config.allowLoopback,
          lookup: this.#lookup,
        });
        stdout.push(`HTTP ${res.status} POST /chat/completions round=${round}\n`);
        const { content, toolCalls } = assistantMessage(res.json);
        lastContent = content;
        if (toolCalls.length === 0) break;
        messages.push({
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls,
        });
        for (const call of toolCalls) {
          const output = await dispatchToolCall(call, job.httpHost, job.skillId);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: output,
          });
        }
        if (round === MAX_TOOL_ROUNDS) {
          return fail(`adapter.http exceeded ${MAX_TOOL_ROUNDS} tool rounds`);
        }
      }
    } catch (err) {
      if (signal.aborted) return fail("adapter.http aborted", { aborted: true, exitCode: null });
      const message = err instanceof HttpAdapterError ? err.message : err instanceof Error ? err.message : String(err);
      return fail(message);
    }

    await writeFile(paths.summaryPath, lastContent.endsWith("\n") ? lastContent : `${lastContent}\n`, "utf8");
    await flush();
    return {
      exitCode: 0,
      timedOut: false,
      aborted: false,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      summaryPath: paths.summaryPath,
    };
  }
}
