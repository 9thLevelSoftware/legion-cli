import { createLegionEngine, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import {
  ADAPTER_ID_HELP,
  AdapterIdSchema,
  HttpAdapterConfigSchema,
  type AdapterId,
} from "@9thlevelsoftware/legion-cli-schema";
import { tryGitHead } from "@9thlevelsoftware/legion-cli-persist";
import type { CliOpts } from "./io.js";
import { writeErr, writeJson, writeOut } from "./io.js";
import { promptIfTty } from "./prompt.js";

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

  const adapterRaw = await requireValue(
    flags.adapter,
    `Adapter (${ADAPTER_ID_HELP}): `,
    "adapter.default is required",
    `legion-cli init --adapter ${ADAPTER_ID_HELP}`,
  );
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

  let http: { baseUrl: string; model: string; apiKeyEnv: string; allowLoopback?: boolean } | undefined;
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

  const engine = createLegionEngine(opts.project);
  await engine.init({ name, adapter, generic, http, mode });
  const next = mode === "brownfield" ? "legion-cli brownfield" : "legion-cli intent";
  if (tryGitHead(opts.project) === null) {
    // KD-3: agent runs (plan, execute, review, …) are refused until the repo has a commit.
    writeErr(
      `Note: Legion needs a git repository with at least one commit to protect your files during agent runs.\nNext: ${HINT.spawnGitRepo}`,
    );
  }

  if (opts.json) {
    writeJson({
      ok: true,
      name,
      mode,
      adapter,
      next,
    });
    return 0;
  }

  writeOut(
    [
      "Legion CLI created a project in this folder.",
      `mode: ${mode}`,
      `adapter.default: ${adapter}`,
      "Supported command: pnpm exec legion-cli",
      `Next: ${next}`,
    ].join("\n"),
  );
  return 0;
}
