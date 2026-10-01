import { createLegionEngine, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import {
  ADAPTER_ID_HELP,
  AcpAdapterConfigSchema,
  AdapterIdSchema,
  HttpAdapterConfigSchema,
  type AdapterId,
} from "@9thlevelsoftware/legion-cli-schema";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { promptIfTty } from "./prompt.js";
import { isSpawnableBinary } from "./which.js";
import { detectSandbox } from "@9thlevelsoftware/legion-cli-sandbox";
import { httpAdapterNotReadyReason } from "@9thlevelsoftware/legion-cli-http";

export type InitFlags = {
  name?: string;
  adapter?: string;
  mode?: string;
  genericBinary?: string;
  genericArgs?: string[];
  httpBaseUrl?: string;
  httpModel?: string;
  httpApiKeyEnv?: string;
  httpAllowLoopback?: boolean;
  acpCommand?: string;
  acpArgs?: string[];
};

async function requireValue(
  flag: string | undefined,
  prompt: string,
  message: string,
  nextHint: string,
): Promise<string> {
  const fromFlag = flag?.trim();
  if (fromFlag) return fromFlag;
  const typed = await promptIfTty(prompt);
  if (typed) return typed;
  refuse(message, nextHint);
}

const ADAPTER_CHOICES: Array<{ id: AdapterId; description: string }> = [
  { id: "claude", description: "Claude Code command-line adapter" },
  { id: "codex", description: "Codex command-line adapter" },
  { id: "openai", description: "OpenAI command-line adapter" },
  { id: "grok", description: "Grok command-line adapter" },
  { id: "mimo", description: "Mimo command-line adapter" },
  { id: "minimax", description: "MiniMax command-line adapter" },
  { id: "generic", description: "an explicit local command and arguments" },
  { id: "http", description: "an OpenAI-compatible HTTP endpoint" },
  { id: "acp", description: "an experimental Agent Client Protocol command (explicit opt-in)" },
  { id: "fake", description: "deterministic test adapter" },
];

export type InitPreflight = {
  ready: boolean;
  adapter: { ready: boolean; detail: string; remediation: string };
  sandbox: { ready: boolean; backend: string; detail: string; remediation: string };
};

function preflightInit(
  adapter: AdapterId,
  generic: { binary: string; args: string[] } | undefined,
  http: { baseUrl: string; model: string; apiKeyEnv: string; allowLoopback: boolean } | undefined,
  acp?: { command: string; args: string[]; enabled: true },
): InitPreflight {
  const adapterReady =
    adapter === "fake" ? true :
    adapter === "http" ? httpAdapterNotReadyReason(http) === null :
    adapter === "acp" ? Boolean(acp?.enabled && isSpawnableBinary(acp.command)) :
    isSpawnableBinary(adapter === "generic" ? (generic?.binary ?? "") : adapter === "claude" ? "claude" : adapter);
  const adapterDetail =
    adapter === "fake" ? "deterministic adapter selected" :
    adapter === "http" ? (httpAdapterNotReadyReason(http) ?? "HTTP configuration and environment key are present") :
    adapter === "acp" ? (adapterReady ? `${acp?.command} is on PATH; experimental ACP explicitly enabled` : `${acp?.command ?? "ACP command"} is not on PATH`) :
    adapterReady ? `${adapter === "generic" ? generic?.binary : adapter} is on PATH` : `${adapter === "generic" ? generic?.binary : adapter} is not on PATH`;
  const detected = detectSandbox();
  const sandboxReady = detected.hardened;
  return {
    ready: adapterReady && sandboxReady,
    adapter: {
      ready: adapterReady,
      detail: adapterDetail,
      remediation: adapterReady ? "none" : `install or configure the selected ${adapter} adapter, then run legion-cli doctor`,
    },
    sandbox: {
      ready: sandboxReady,
      backend: detected.backend,
      detail: sandboxReady ? `${detected.backend} hardened sandbox available` : "only a copy jail is available",
      remediation: sandboxReady ? "none" : "install a supported hardened sandbox, then run legion-cli doctor",
    },
  };
}

async function chooseAdapter(flag: string | undefined): Promise<string> {
  if (flag?.trim()) return flag.trim();
  const prompt = [
    "Choose an adapter:",
    ...ADAPTER_CHOICES.map((choice, index) => `${index + 1}) ${choice.id} — ${choice.description}`),
    "Adapter number or id: ",
  ].join("\n");
  const selected = await promptIfTty(prompt);
  if (!selected) {
    refuse("adapter.default is required", `legion-cli init --adapter ${ADAPTER_ID_HELP}`);
  }
  const number = Number(selected);
  return Number.isSafeInteger(number) && number >= 1 && number <= ADAPTER_CHOICES.length
    ? ADAPTER_CHOICES[number - 1].id
    : selected;
}

export async function runInit(opts: CliOpts, flags: InitFlags): Promise<number> {
  const mode = (flags.mode ?? "greenfield").trim();
  if (mode !== "greenfield" && mode !== "brownfield") {
    refuse("init mode must be greenfield or brownfield", HINT.initMode);
  }

  const name = await requireValue(
    flags.name,
    "Product name: ",
    "init requires a product name",
    "legion-cli init --name <product>",
  );

  const adapterRaw = await chooseAdapter(flags.adapter);
  const adapterParsed = AdapterIdSchema.safeParse(adapterRaw);
  if (!adapterParsed.success) {
    refuse(`adapter.default must be ${ADAPTER_ID_HELP}`, `legion-cli init --adapter ${ADAPTER_ID_HELP}`);
  }
  const adapter: AdapterId = adapterParsed.data;

  let generic: { binary: string; args: string[] } | undefined;
  if (adapter === "generic") {
    const binary = await requireValue(
      flags.genericBinary,
      "Generic adapter binary: ",
      "adapter.generic is required when adapter.default is generic",
      "legion-cli init --adapter generic --generic-binary <bin>",
    );
    generic = { binary, args: flags.genericArgs ?? [] };
  }

  let http: { baseUrl: string; model: string; apiKeyEnv: string; allowLoopback: boolean } | undefined;
  if (adapter === "http") {
    const hint =
      "legion-cli init --adapter http --http-base-url <url> --http-model <id> --http-api-key-env <ENV>";
    const baseUrl = await requireValue(
      flags.httpBaseUrl,
      "HTTP base URL: ",
      "adapter.http.baseUrl is required when adapter.default is http",
      hint,
    );
    const model = await requireValue(
      flags.httpModel,
      "HTTP model: ",
      "adapter.http.model is required when adapter.default is http",
      hint,
    );
    const apiKeyEnv = await requireValue(
      flags.httpApiKeyEnv,
      "HTTP api key env var (A-Z0-9_): ",
      "adapter.http.apiKeyEnv is required when adapter.default is http",
      hint,
    );
    const parsedHttp = HttpAdapterConfigSchema.safeParse({
      baseUrl,
      model,
      apiKeyEnv,
      ...(flags.httpAllowLoopback ? { allowLoopback: true } : {}),
    });
    if (!parsedHttp.success) {
      const issue = parsedHttp.error.issues[0];
      refuse(issue?.message ?? "adapter.http is invalid", hint);
    }
    http = parsedHttp.data;
  }

  let acp: { command: string; args: string[]; enabled: true } | undefined;
  if (adapter === "acp") {
    const hint = "legion-cli init --adapter acp --acp-command <bin> [--acp-args <args...>]";
    const command = await requireValue(
      flags.acpCommand,
      "ACP agent command: ",
      "adapter.acp.command is required when adapter.default is acp",
      hint,
    );
    const parsedAcp = AcpAdapterConfigSchema.safeParse({ command, args: flags.acpArgs ?? [], enabled: true });
    if (!parsedAcp.success) {
      refuse(parsedAcp.error.issues[0]?.message ?? "adapter.acp is invalid", hint);
    }
    acp = { ...parsedAcp.data, enabled: true };
  }

  const engine = createLegionEngine(opts.project);
  await engine.init({ name, adapter, generic, http, acp, mode });
  const next = mode === "brownfield" ? "legion-cli brownfield" : "legion-cli intent";
  const preflight = preflightInit(adapter, generic, http, acp);

  if (opts.json) {
    writeJson({
      ok: true,
      name,
      mode,
      adapter,
      next,
      preflight,
    });
    return 0;
  }

  writeOut(
    [
      "Legion CLI created a project in this folder.",
      `mode: ${mode}`,
      `adapter.default: ${adapter}`,
      `adapter readiness: ${preflight.adapter.ready ? "ready" : "needs attention"} (${preflight.adapter.detail})`,
      `sandbox readiness: ${preflight.sandbox.ready ? "ready" : "needs attention"} (${preflight.sandbox.detail})`,
      ...(!preflight.ready
        ? [`Remediation: ${preflight.adapter.remediation}; ${preflight.sandbox.remediation}`]
        : []),
      "Supported command: pnpm exec legion-cli",
      `Next: ${next}`,
    ].join("\n"),
  );
  return 0;
}
