import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { parseMarkdownDocument, parseYamlDocument } from "@9thlevelsoftware/legion-cli-persist";
import { WORKFLOW_STAGE_FIELDS } from "@9thlevelsoftware/legion-cli-schema";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const bin = join(pkgRoot, "dist", "bin.js");
export const transcriptsDir = join(pkgRoot, "test", "transcripts");

/** Verbs that stop with "no agent available" unless the adapter is spawnable. */
const AGENT_VERBS = new Set(["intent", "discuss", "spec"]);

/** Concrete bounded preparation output for the default in-process spec fixture. */
function specPreparationArtifacts(args, opts) {
  const projectIndex = args.indexOf("--project");
  if (projectIndex < 0 || !args[projectIndex + 1]) return undefined;
  const dir = args[projectIndex + 1];
  const projectPath = join(dir, ".legion-cli", "PROJECT.md");
  if (!existsSync(projectPath)) return undefined;
  const project = parseMarkdownDocument(readFileSync(projectPath, "utf8")).frontmatter;
  const specId = project.activeSpecId ?? `spec-${String(project.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "product"}`;
  const specFile = join(dir, ".legion-cli", "specs", specId, "SPEC.md");
  const intentFile = join(dir, ".legion-cli", "wiki", "product", "intent-answers.yaml");
  const intent = existsSync(intentFile) ? parseYamlDocument(readFileSync(intentFile, "utf8")) : null;
  const acceptanceIds = existsSync(specFile)
    ? parseMarkdownDocument(readFileSync(specFile, "utf8")).frontmatter.acceptance.map((item) => item.id)
    : opts.preparationAcceptanceIds ?? (intent?.mapped?.mustBeTrue?.length ? intent.mapped.mustBeTrue : ["fixture outcome"]).map((_, i) => `AC-P0-${String(i + 1).padStart(2, "0")}`);
  const bodies = {
    context: "# Context\n\nUnderstand the check-in workflow and preserve existing authentication. Planning-only fixture; no product source is claimed inspected.\n",
    requirements: "# Requirements\n\nRecord and confirm check-in promptly; keep payroll outside scope. Failure behavior and applicable quality attributes need planning review.\n",
  };
  const fields = {
    context: { goal: "Specify the bounded check-in behavior", affectedPaths: "Product interaction paths to be resolved in planning", constraints: "Preserve authentication and exclude payroll", assumptions: "No repository code is present in this specification fixture" },
    requirements: { outcomes: "Record and confirm the requested check-in", invariants: "Existing authentication remains unchanged", acceptanceIds: acceptanceIds.join(", "), qualityAttributes: "Responsiveness and clear failure handling require design; no hosting change is requested" },
  };
  const artifacts = Object.entries(bodies).map(([stage, body]) => ({ stage, path: `.legion-cli/specs/${specId}/preparation/${stage}.md`, digest: createHash("sha256").update(body).digest("hex"), inputs: [], fields: fields[stage] }));
  const record = {
    schemaVersion: "legion-cli-workflow-preparation/v1",
    assessment: { schemaVersion: "legion-cli-workflow-assessment/v1", policyVersion: 2, specId,
      inputFingerprint: createHash("sha256").update("[]").digest("hex"), unresolvedDecisions: [],
      stageDecisions: Object.keys(WORKFLOW_STAGE_FIELDS).map((stage) => ({ stage, decision: stage === "infrastructure-design" ? "not_applicable" : "required", rationale: stage === "infrastructure-design" ? "This bounded behavior fixture requests no hosting or infrastructure change" : "The requested interaction, failure behavior and delivery require reviewed preparation", evidenceRefs: ["assumption: fixture defines requirements before product design"] })) },
    specArtifacts: artifacts, planArtifacts: [], acceptanceMappings: [],
  };
  return [...artifacts.map((artifact) => ({ path: artifact.path, content: bodies[artifact.stage] })), { path: ".legion-cli/cache/runs/<id>/preparation.json", content: JSON.stringify(record) }];
}

/**
 * `opts.noAgent: true` runs with no spawnable agent. Otherwise intent, discuss and spec run
 * with the in-process fake agent, so tests exercise the flow an installed agent would give.
 */
export function runCli(args, opts = {}) {
  const fakeAgent =
    AGENT_VERBS.has(args[0]) && !opts.noAgent && opts.env?.LEGION_CLI_ADAPTER === undefined
      ? { LEGION_CLI_ADAPTER: "fake" }
      : {};
  const preparation = args[0] === "spec" && !opts.noAgent && !args.includes("--from") && !args.includes("--explore") &&
    opts.env?.LEGION_CLI_FAKE_ARTIFACTS === undefined && opts.env?.LEGION_CLI_FAKE_EXIT_CODE === undefined && (opts.env?.LEGION_CLI_ADAPTER === undefined || opts.env.LEGION_CLI_ADAPTER === "fake")
    ? specPreparationArtifacts(args, opts) : undefined;
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: { ...process.env, ...fakeAgent, ...(preparation ? { LEGION_CLI_FAKE_ARTIFACTS: JSON.stringify(preparation) } : {}), ...(opts.env ?? {}) },
    windowsHide: true,
    input: opts.input,
  });
}

export function normalize(text) {
  return (text ?? "").replaceAll("\r\n", "\n");
}

export function readGolden(name) {
  return readFile(join(transcriptsDir, name), "utf8").then((text) => normalize(text));
}

export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Omit {{pointer}} so PATH cannot green-light grok in CLI-override tests. */
export function withUnspawnableGrok(config) {
  return {
    ...config,
    adapter: {
      ...config.adapter,
      grok: { args: ["--model", "grok-4"] },
    },
  };
}

export async function allowCopyJail(store) {
  const config = await store.readConfig();
  await store.writeConfig({
    ...config,
    sandbox: { ...config.sandbox, allowCopyJail: true },
  });
}

/**
 * Seed `sandbox.allowCopyJail: true` in an initialized project so doctor's sandbox
 * check is ok (not advisory/warn) on hosts without bwrap/seatbelt (Windows). Use it
 * in doctor tests whose subject is not the sandbox; the unhardened advisory path
 * has its own deterministic test.
 */
export async function allowCopyJailIn(dir) {
  await allowCopyJail(createLegionEngine(dir).store);
}

export function withNamedAdapter(config, name, id) {
  return {
    ...config,
    adapter: {
      ...config.adapter,
      named: { ...(config.adapter.named ?? {}), [name]: id },
    },
  };
}
