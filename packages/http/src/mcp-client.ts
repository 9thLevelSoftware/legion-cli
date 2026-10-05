import { stableHash } from "./checkpoint.js";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig, McpServersConfig } from "@9thlevelsoftware/legion-cli-schema";
import { isLoopbackHttpHost, isPrivateOrLocalHost } from "./ssrf.js";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent } from "undici";

export const MCP_POOL_MAX = 32;
export const MCP_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_TOOL_TIMEOUT_MS = 60_000;
export const MCP_REMOTE_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Host keys an MCP child may inherit. Declared `config.env` is merged on top. */
export const MCP_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "LOGNAME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMP",
  "TEMP",
  "TMPDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "windir",
  "PATHEXT",
  "ComSpec",
  "COMSPEC",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "ProgramFiles",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "USERNAME",
] as const;

export type McpFailReason =
  | "unknown-server"
  | "spawn-failed"
  | "tool-error"
  | "parse-error"
  | "pool-full"
  | "policy-denied"
  | "response-too-large";

export class McpClientError extends Error {
  readonly reason: McpFailReason;
  constructor(reason: McpFailReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpClientError";
    this.reason = reason;
  }
}

export function buildMcpSpawnEnv(
  source: NodeJS.ProcessEnv = process.env,
  declared: Record<string, string> = {},
): Record<string, string> {
  const allow = new Set(MCP_ENV_ALLOWLIST.map((key) => key.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!allow.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(declared)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function isParseError(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /JSON|parse/i.test(message);
}

function asMcpError(err: unknown, fallback: McpFailReason): McpClientError {
  if (err instanceof McpClientError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new McpClientError(isParseError(err) ? "parse-error" : fallback, message, { cause: err });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export async function closeMcpTransports(
  transports: Iterable<{ close(): Promise<void> }>,
): Promise<void> {
  const errors: Error[] = [];
  for (const transport of transports) {
    try {
      await transport.close();
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "MCP transport close failed");
}

export type ExternalMcpTool = {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
};

export type ToolCallResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
  reason?: McpFailReason;
};
export type GovernedToolCallCapture = {
  result: ToolCallResult;
  responseDigest: string;
  responseBytes: number;
};

type CapturedWireResponse = {
  complete: boolean;
  responseDigest: string | null;
  responseBytes: number;
  status: number;
};

type GovernedCaptureScope = {
  toolName: string;
  responses: CapturedWireResponse[];
};

function errorResult(reason: McpFailReason, message: string): ToolCallResult {
  return {
    isError: true,
    reason,
    content: [{ type: "text", text: message }],
  };
}

export type McpLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: McpLookup = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((entry) => ({ address: entry.address, family: entry.family }));
};

async function resolveMcpRemoteUrl(
  raw: string,
  allowLoopback = false,
  lookup: McpLookup = defaultLookup,
): Promise<{ url: URL; records: Array<{ address: string; family: number }> }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new McpClientError("policy-denied", "MCP remote URL is invalid", { cause: err });
  }
  if (url.username || url.password) {
    throw new McpClientError("policy-denied", "MCP remote URL cannot include userinfo");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new McpClientError("policy-denied", "MCP remote URL must use https");
  }
  const records = await lookup(url.hostname);
  if (records.length === 0) throw new McpClientError("policy-denied", "MCP remote URL did not resolve");
  const loopback = records.every((entry) => isLoopbackHttpHost(entry.address));
  if (url.protocol === "http:" && !(allowLoopback && loopback)) {
    throw new McpClientError("policy-denied", "MCP remote URL must use https (http is allowed only for loopback fixtures)");
  }
  if (!allowLoopback && records.some((entry) => isPrivateOrLocalHost(entry.address))) {
    throw new McpClientError("policy-denied", "MCP remote URL resolved to a private address");
  }
  if (allowLoopback && records.some((entry) => isPrivateOrLocalHost(entry.address) && !isLoopbackHttpHost(entry.address))) {
    throw new McpClientError("policy-denied", "MCP remote URL resolved to a non-loopback private address");
  }
  return { url, records };
}

export async function validateMcpRemoteUrl(
  raw: string,
  allowLoopback = false,
  lookup: McpLookup = defaultLookup,
): Promise<URL> {
  return (await resolveMcpRemoteUrl(raw, allowLoopback, lookup)).url;
}

function capResponse(response: Response, onDone: () => void, captured?: CapturedWireResponse): Response {
  const hash = captured ? createHash("sha256") : null;
  if (captured) captured.status = response.status;
  const finish = () => {
    if (captured && hash) {
      captured.complete = true;
      captured.responseDigest = hash.digest("hex");
      captured.responseBytes = 0;
    }
  };
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MCP_REMOTE_MAX_RESPONSE_BYTES) {
    response.body?.cancel().catch(() => undefined);
    onDone();
    throw new McpClientError("response-too-large", "MCP remote response exceeded size cap");
  }
  if (!response.body) {
    finish();
    onDone();
    return response;
  }
  const reader = response.body.getReader();
  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        if (captured) {
          captured.complete = true;
          captured.responseDigest = hash!.digest("hex");
          captured.responseBytes = received;
        }
        controller.close();
        onDone();
        return;
      }
      received += next.value.byteLength;
      if (received > MCP_REMOTE_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        controller.error(new McpClientError("response-too-large", "MCP remote response exceeded size cap"));
        onDone();
        return;
      }
      hash?.update(next.value);
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason).finally(onDone);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

type CaptureRequest = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<CapturedWireResponse | undefined>;

function requestBodyText(body: NonNullable<Parameters<typeof fetch>[1]>["body"]): string | null {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: true }).decode(body);
  return null;
}

function captureToolRequest(toolName: string, scope: GovernedCaptureScope): CaptureRequest {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "POST") return undefined;
    let body = requestBodyText(init?.body);
    if (body === null && input instanceof Request) {
      try { body = await input.clone().text(); } catch { return undefined; }
    }
    if (body === null) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return undefined; }
    const request = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    const params = request?.params && typeof request.params === "object" && !Array.isArray(request.params) ? request.params as Record<string, unknown> : null;
    if (request?.method !== "tools/call" || params?.name !== toolName) return undefined;
    const captured: CapturedWireResponse = { complete: false, responseDigest: null, responseBytes: 0, status: 0 };
    scope.responses.push(captured);
    return captured;
  };
}


function remoteFetch(allowLoopback: boolean, lookup: McpLookup, captureRequest?: CaptureRequest): typeof fetch {
  return async (input, init) => {
    const captured = await captureRequest?.(input, init);
    const resolved = await resolveMcpRemoteUrl(
      typeof input === "string" || input instanceof URL ? String(input) : input.url,
      allowLoopback,
      lookup,
    );
    const pinned = [...resolved.records].sort((a, b) => a.address.localeCompare(b.address))[0];
    if (!pinned) throw new McpClientError("policy-denied", "MCP remote URL did not resolve");
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          const all = typeof options === "object" && options !== null && options.all === true;
          if (all) {
            callback(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            callback(null, pinned.address, pinned.family);
          }
        },
      },
    });
    let closed = false;
    const closeDispatcher = () => {
      if (closed) return;
      closed = true;
      void dispatcher.close();
    };
    const timeout = AbortSignal.timeout(MCP_TOOL_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(resolved.url, {
        ...init,
        signal,
        redirect: "manual",
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
    } catch (err) {
      closeDispatcher();
      throw err;
    }
    if (response.status >= 300 && response.status < 400) {
      response.body?.cancel().catch(() => undefined);
      closeDispatcher();
      throw new McpClientError("policy-denied", `MCP remote redirect HTTP ${response.status} refused`);
    }
    return capResponse(response, closeDispatcher, captured);
  };
}

export async function createMcpClientTransport(
  config: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
  lookup: McpLookup = defaultLookup,
  captureRequest?: CaptureRequest,
): Promise<Transport> {
  const transportKind = (config as { transport?: string }).transport ?? "stdio";
  if (transportKind === "stdio") {
    const stdio = config as Extract<McpServerConfig, { transport: "stdio" }>;
    return new StdioClientTransport({
      command: stdio.command,
      args: stdio.args ?? [],
      env: buildMcpSpawnEnv(env, stdio.env ?? {}),
      stderr: "pipe",
    });
  }
  const remote = config as Extract<McpServerConfig, { transport: "sse" | "streamable-http" }>;
  const url = await validateMcpRemoteUrl(remote.url, remote.allowLoopback, lookup);
  const token = remote.authTokenEnv ? env[remote.authTokenEnv]?.trim() : undefined;
  if (remote.authTokenEnv && !token) {
    throw new McpClientError("policy-denied", `MCP auth environment variable ${remote.authTokenEnv} is missing`);
  }
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const boundedFetch = remoteFetch(remote.allowLoopback, lookup, captureRequest);
  if (transportKind === "sse") {
    return new SSEClientTransport(url, {
      requestInit: { headers },
      eventSourceInit: headers ? ({ fetch: (input: string | URL | Request, init?: RequestInit) => boundedFetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...headers },
      }) } as never) : undefined,
      fetch: boundedFetch,
    });
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    fetch: boundedFetch,
    reconnectionOptions: {
      initialReconnectionDelay: 250,
      maxReconnectionDelay: 2_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 2,
    },
  });
}

export type LegionMcpClientPoolOptions = {
  governedHttpToolAllowlist?: readonly string[];
  /** Deterministic fixture seam; production uses the transport-specific factory above. */
  transportFactory?: (config: McpServerConfig, captureRequest?: CaptureRequest) => Promise<Transport>;
  /** Deterministic timeout seam; production keeps the bounded default. */
  toolTimeoutMs?: number;
};

export class LegionMcpClientPool {
  #clients = new Map<string, Client>();
  #transports = new Map<string, Transport>();
  #failures = new Map<string, McpClientError>();
  #inflight = new Map<string, Promise<Client>>();
  #captureScopes = new Map<string, GovernedCaptureScope>();
  #captureActive = new Set<string>();
  #activeToolCalls = new Map<string, number>();
  #configs: McpServersConfig;
  #governedHttpToolAllowlist: Set<string>;
  #reservations = 0;
  #closed = false;
  #generation = 0;
  #transportFactory: (config: McpServerConfig, captureRequest?: CaptureRequest) => Promise<Transport>;
  #toolTimeoutMs: number;

  constructor(configs: McpServersConfig = {}, options: LegionMcpClientPoolOptions = {}) {
    this.#configs = configs;
    this.#governedHttpToolAllowlist = new Set(options.governedHttpToolAllowlist ?? []);
    this.#transportFactory = options.transportFactory ?? ((config, captureRequest) => createMcpClientTransport(config, process.env, defaultLookup, captureRequest));
    this.#toolTimeoutMs = options.toolTimeoutMs ?? MCP_TOOL_TIMEOUT_MS;
  }

  async getClient(serverName: string, signal?: AbortSignal): Promise<Client | null> {
    if (this.#closed) throw new McpClientError("spawn-failed", "MCP client pool is closed");
    if (signal?.aborted) throw abortReason(signal);
    const existing = this.#clients.get(serverName);
    if (existing) return existing;

    const config = this.#configs[serverName];
    if (!config) return null;

    const failed = this.#failures.get(serverName);
    if (failed) throw failed;

    const inflight = this.#inflight.get(serverName);
    if (inflight) return waitWithSignal(inflight, signal);

    const pending = this.#connect(serverName, config, this.#generation, signal);
    this.#inflight.set(serverName, pending);
    try {
      return await waitWithSignal(pending, signal);
    } finally {
      this.#inflight.delete(serverName);
    }
  }

  async #connect(
    serverName: string,
    config: McpServerConfig,
    generation: number,
    signal?: AbortSignal,
  ): Promise<Client> {
    if (this.#clients.size + this.#reservations >= MCP_POOL_MAX) {
      throw new McpClientError("pool-full", `MCP pool is full (${MCP_POOL_MAX})`);
    }
    this.#reservations += 1;
    let transport: Transport;
    try {
      const captureRequest: CaptureRequest = async (input, init) => {
        const scope = this.#captureScopes.get(serverName);
        return scope ? captureToolRequest(scope.toolName, scope)(input, init) : undefined;
      };
      transport = await this.#transportFactory(config, captureRequest);
    } catch (err) {
      this.#reservations = Math.max(0, this.#reservations - 1);
      throw err;
    }
    if (signal?.aborted) {
      this.#reservations = Math.max(0, this.#reservations - 1);
      await transport.close().catch(() => undefined);
      throw abortReason(signal);
    }

    const client = new Client({ name: "legion-cli", version: "0.0.0" }, { capabilities: {} });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new McpClientError("spawn-failed", "MCP connect timed out"));
        }, MCP_CONNECT_TIMEOUT_MS);
        const prevClose = transport.onclose;
        transport.onclose = () => {
          prevClose?.();
          clearTimeout(timer);
          reject(new McpClientError("spawn-failed", "MCP server exited during connect"));
        };
        client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS, signal }).then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (err: unknown) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });
      if (this.#closed || generation !== this.#generation) {
        throw new McpClientError("spawn-failed", "MCP client pool closed during connect");
      }
      this.#clients.set(serverName, client);
      this.#transports.set(serverName, transport);
      return client;
    } catch (err) {
      try {
        await transport.close();
      } catch {
        // child already gone
      }
      try {
        await client.close();
      } catch {
        // connect never finished
      }
      if (signal?.aborted) throw abortReason(signal);
      const wrapped = asMcpError(err, "spawn-failed");
      this.#failures.set(serverName, wrapped);
      throw wrapped;
    } finally {
      this.#reservations = Math.max(0, this.#reservations - 1);
    }
  }

  async listAllTools(signal?: AbortSignal): Promise<ExternalMcpTool[]> {
    const tools: ExternalMcpTool[] = [];
    for (const serverName of Object.keys(this.#configs)) {
      try {
        const client = await this.getClient(serverName, signal);
        if (!client) continue;
        const res = await client.listTools(undefined, { timeout: this.#toolTimeoutMs, signal });
        for (const t of res.tools) {
          tools.push({
            serverName,
            name: `${serverName}:${t.name}`,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
            readOnly: t.annotations?.readOnlyHint === true,
          });
        }
      } catch (err) {
        const wrapped = asMcpError(err, "spawn-failed");
        this.#failures.set(serverName, wrapped);
      }
    }
    return tools;
  }

  async callTool(
    namespacedToolName: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<ToolCallResult | null> {
    const colonIdx = namespacedToolName.indexOf(":");
    if (colonIdx < 0) return errorResult("unknown-server", "MCP tool name must be server:tool");
    const serverName = namespacedToolName.slice(0, colonIdx);
    const toolName = namespacedToolName.slice(colonIdx + 1);
    if (this.#captureActive.has(serverName)) return errorResult("policy-denied", "MCP server is serving a governed call");
    this.#activeToolCalls.set(serverName, (this.#activeToolCalls.get(serverName) ?? 0) + 1);
    try {
      const client = await this.getClient(serverName, signal);
      if (!client) return errorResult("unknown-server", `unknown MCP server ${serverName}`);
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      }, undefined, { timeout: this.#toolTimeoutMs, signal });
      if (JSON.stringify(result).length > MCP_REMOTE_MAX_RESPONSE_BYTES) {
        return errorResult("response-too-large", "MCP tool result exceeded size cap");
      }
      return result as ToolCallResult;
    } catch (err) {
      const wrapped = asMcpError(err, "tool-error");
      return errorResult(wrapped.reason, wrapped.message);
    } finally {
      const count = this.#activeToolCalls.get(serverName) ?? 1;
      if (count <= 1) this.#activeToolCalls.delete(serverName);
      else this.#activeToolCalls.set(serverName, count - 1);
    }
  }

  async callGovernedHttpTool(
    namespacedToolName: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<ToolCallResult | null> {
    if (!this.#governedHttpToolAllowlist.has(namespacedToolName)) {
      return errorResult("policy-denied", `MCP tool ${namespacedToolName} is not in the governed HTTP allowlist`);
    }
    const colonIdx = namespacedToolName.indexOf(":");
    if (colonIdx < 1) return errorResult("unknown-server", "MCP tool name must be server:tool");
    const serverName = namespacedToolName.slice(0, colonIdx);
    const toolName = namespacedToolName.slice(colonIdx + 1);
    try {
      const client = await this.getClient(serverName, signal);
      if (!client) return errorResult("unknown-server", `unknown MCP server ${serverName}`);
      const listed = await client.listTools(undefined, { timeout: this.#toolTimeoutMs, signal });
      const declared = listed.tools.find((tool) => tool.name === toolName);
      if (!declared || declared.annotations?.readOnlyHint !== true) {
        return errorResult("policy-denied", `MCP tool ${namespacedToolName} is not declared read-only`);
      }
      return this.callTool(namespacedToolName, args, signal);
    } catch (err) {
      const wrapped = asMcpError(err, "tool-error");
      return errorResult(wrapped.reason, wrapped.message);
    }
  }
  async callGovernedHttpToolCaptured(
    namespacedToolName: string,
    args: Record<string, unknown>,
    expectedSchemaFingerprint: string,
    signal?: AbortSignal,
  ): Promise<GovernedToolCallCapture | null> {
    if (!this.#governedHttpToolAllowlist.has(namespacedToolName)) return null;
    const colonIdx = namespacedToolName.indexOf(":");
    if (colonIdx < 1) return null;
    const serverName = namespacedToolName.slice(0, colonIdx);
    const toolName = namespacedToolName.slice(colonIdx + 1);
    const config = this.#configs[serverName] as { transport?: string } | undefined;
    if (config?.transport !== "streamable-http" || this.#captureActive.has(serverName) || (this.#activeToolCalls.get(serverName) ?? 0) > 0) return null;
    this.#captureActive.add(serverName);
    try {
      const listed = (await this.listAllTools(signal)).filter((tool) => tool.readOnly && this.#governedHttpToolAllowlist.has(tool.name));
      const identity = stableHash(listed.sort((a, b) => a.name.localeCompare(b.name)).map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema, readOnly: tool.readOnly })));
      if (identity !== expectedSchemaFingerprint || !listed.some((tool) => tool.name === namespacedToolName)) return null;
      const client = this.#clients.get(serverName);
      if (!client) return null;
      const scope: GovernedCaptureScope = { toolName, responses: [] };
      this.#captureScopes.set(serverName, scope);
      const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: this.#toolTimeoutMs, signal });
      const response = scope.responses.length === 1 ? scope.responses[0] : undefined;
      if (!response || !response.complete || response.status !== 200 || response.responseBytes <= 0 || !response.responseDigest) return null;
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > MCP_REMOTE_MAX_RESPONSE_BYTES) return null;
      return { result: result as ToolCallResult, responseDigest: response.responseDigest, responseBytes: response.responseBytes };
    } catch {
      return null;
    } finally {
      this.#captureScopes.delete(serverName);
      this.#captureActive.delete(serverName);
    }
  }


  async closeAll(): Promise<void> {
    this.#closed = true;
    this.#generation += 1;
    await Promise.allSettled([...this.#inflight.values()]);
    const transports = [...this.#transports.values()];
    this.#clients.clear();
    this.#transports.clear();
    this.#failures.clear();
    this.#inflight.clear();
    this.#reservations = 0;
    await closeMcpTransports(transports);
  }
}
