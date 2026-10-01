import { isAbsolute } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentApp,
  AgentCapabilities,
  ClientCapabilities,
  Implementation,
  MaybePromise,
  PermissionOptionId,
  RequestPermissionRequest,
  SessionNotification,
  StopReason,
  Stream,
} from "@agentclientprotocol/sdk";

/**
 * ACP stays opt-in: callers must explicitly construct this adapter and provide
 * either an SDK AgentApp (fixtures/in-process agents) or an SDK Stream.
 */
export type ExperimentalAcpTarget = AgentApp | Stream;

export type ExperimentalAcpPermissionPolicy = (
  request: RequestPermissionRequest,
  context: { signal: AbortSignal },
) => MaybePromise<PermissionOptionId | null>;

export type ExperimentalAcpOptions = {
  target: ExperimentalAcpTarget | (() => MaybePromise<ExperimentalAcpTarget>);
  clientName?: string;
  clientCapabilities?: ClientCapabilities;
  permissionPolicy?: ExperimentalAcpPermissionPolicy;
  /** Persistent allow decisions require an additional, explicit opt-in. */
  allowPersistentPermissions?: boolean;
  onProgress?: (notification: SessionNotification) => MaybePromise<void>;
};

export type ExperimentalAcpRun = {
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
};

export type ExperimentalAcpPermissionRecord = {
  toolCallId: string;
  outcome: "cancelled" | "selected";
  optionId?: string;
};

export type ExperimentalAcpResult = {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: Implementation | null;
  sessionId: string;
  stopReason: StopReason;
  cancelled: boolean;
  text: string;
  updates: SessionNotification[];
  permissions: ExperimentalAcpPermissionRecord[];
};

export type ExperimentalAcpAvailability = {
  available: false;
  experimental: true;
  reason: string;
};

/** Reports the default state used by onboarding and opt-in smoke harnesses. */
export function experimentalAcpAvailability(): ExperimentalAcpAvailability {
  return {
    available: false,
    experimental: true,
    reason: "ACP is disabled by default; explicitly construct ExperimentalAcpAdapter with a connection target",
  };
}

function isStream(target: ExperimentalAcpTarget): target is Stream {
  return "writable" in target && "readable" in target;
}

function textFromUpdate(notification: SessionNotification): string {
  const update = notification.update as unknown as {
    sessionUpdate?: unknown;
    content?: { type?: unknown; text?: unknown };
  };
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content?.type === "text" &&
    typeof update.content.text === "string"
  ) {
    return update.content.text;
  }
  return "";
}

/**
 * Experimental ACP v1 client adapter backed by the official SDK.
 *
 * Product routing wires it only when `adapter.acp.enabled: true` is explicitly
 * configured. Construction remains explicit, and permissions fail closed unless a governing callback
 * selects one of the options offered by the agent.
 */
export class ExperimentalAcpAdapter {
  readonly #options: ExperimentalAcpOptions;

  constructor(options: ExperimentalAcpOptions) {
    this.#options = options;
  }

  async run(run: ExperimentalAcpRun): Promise<ExperimentalAcpResult> {
    if (!isAbsolute(run.cwd)) throw new Error("experimental ACP cwd must be absolute");
    if (run.signal?.aborted) throw new Error("experimental ACP run was cancelled before initialization");

    const target =
      typeof this.#options.target === "function"
        ? await this.#options.target()
        : this.#options.target;
    const updates: SessionNotification[] = [];
    const permissions: ExperimentalAcpPermissionRecord[] = [];
    const text: string[] = [];

    const client = acp
      .client({ name: this.#options.clientName ?? "legion-cli-experimental-acp" })
      .onNotification(acp.methods.client.session.update, async ({ params }) => {
        updates.push(params);
        const chunk = textFromUpdate(params);
        if (chunk) text.push(chunk);
        await this.#options.onProgress?.(params);
      })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params, signal }) => {
        if (run.signal?.aborted || signal.aborted || !this.#options.permissionPolicy) {
          permissions.push({ toolCallId: params.toolCall.toolCallId, outcome: "cancelled" });
          return { outcome: { outcome: "cancelled" } };
        }

        const optionId = await this.#options.permissionPolicy(params, { signal });
        if (optionId === null) {
          permissions.push({ toolCallId: params.toolCall.toolCallId, outcome: "cancelled" });
          return { outcome: { outcome: "cancelled" } };
        }
        const selected = params.options.find((option) => option.optionId === optionId);
        if (!selected) {
          throw new Error(`experimental ACP permission policy selected unavailable option ${optionId}`);
        }
        if (selected.kind === "allow_always" && !this.#options.allowPersistentPermissions) {
          permissions.push({ toolCallId: params.toolCall.toolCallId, outcome: "cancelled" });
          return { outcome: { outcome: "cancelled" } };
        }
        permissions.push({
          toolCallId: params.toolCall.toolCallId,
          outcome: "selected",
          optionId,
        });
        return { outcome: { outcome: "selected", optionId } };
      });

    const operation = async (context: acp.ClientContext): Promise<ExperimentalAcpResult> => {
      const initialized = await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: this.#options.clientCapabilities ?? {},
        clientInfo: {
          name: this.#options.clientName ?? "legion-cli-experimental-acp",
          version: "0.0.0",
        },
      });
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(
          `experimental ACP agent selected unsupported protocol version ${initialized.protocolVersion}`,
        );
      }

      const session = await context.request(acp.methods.agent.session.new, {
        cwd: run.cwd,
        mcpServers: [],
      });
      let cancelNotification: Promise<void> | undefined;
      let cancelError: unknown;
      const cancel = () => {
        cancelNotification ??= context
          .notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
          .catch((error: unknown) => {
            cancelError = error;
          });
      };
      run.signal?.addEventListener("abort", cancel, { once: true });

      let response;
      try {
        response = await context.request(
          acp.methods.agent.session.prompt,
          {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: run.prompt }],
          },
          { cancellationSignal: run.signal },
        );
        await cancelNotification;
        if (cancelError) throw cancelError;
      } finally {
        run.signal?.removeEventListener("abort", cancel);
        if (initialized.agentCapabilities?.sessionCapabilities?.close != null) {
          await context.request(acp.methods.agent.session.close, { sessionId: session.sessionId });
        }
      }

      return {
        protocolVersion: initialized.protocolVersion,
        agentCapabilities: initialized.agentCapabilities,
        agentInfo: initialized.agentInfo,
        sessionId: session.sessionId,
        stopReason: response.stopReason,
        cancelled: response.stopReason === "cancelled" || Boolean(run.signal?.aborted),
        text: text.join(""),
        updates,
        permissions,
      };
    };

    return isStream(target)
      ? client.connectWith(target, operation)
      : client.connectWith(target, operation);
  }
}
