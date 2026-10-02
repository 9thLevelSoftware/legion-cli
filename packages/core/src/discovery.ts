import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateMap } from "@9thlevelsoftware/legion-cli-map";
import { assertNoLinkInPath, toFsPath, writeTextFile } from "@9thlevelsoftware/legion-cli-persist";
import type { LegionEngine } from "./engine.js";
import { refuse } from "./errors.js";
import { collectEvidence, detectTestRunners, scanSecretFindings, sourceHasNearbyTest } from "./brownfield/evidence.js";

export const DISCOVERY_PATH = ".legion-cli/map/DISCOVERY.md";
const SELECTION_PATH = ".legion-cli/map/selection.json";
export type DiscoverySelection = { goal: string; affectedArea: string; sourceFingerprint: string };

export type DiscoveryResult = {
  path: string;
  goal: "change" | "audit";
  sourceFingerprint: string;
  sourceFiles: number;
  testFiles: number;
  findings: { id: string; priority: "P0" | "P1" | "P2"; statement: string; evidence: string[] }[];
  selection: DiscoverySelection | null;
};

async function readSelection(engine: LegionEngine): Promise<DiscoverySelection | null> {
  const abs = toFsPath(engine.projectRoot, SELECTION_PATH);
  await assertNoLinkInPath(abs, { root: engine.projectRoot });
  let raw: unknown;
  try { raw = JSON.parse(await readFile(abs, "utf8")); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  const value = raw as DiscoverySelection & { schemaVersion?: string };
  if (value?.schemaVersion !== "legion-cli-discovery-selection/v1" || typeof value.goal !== "string" || typeof value.affectedArea !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)) {
    refuse("invalid brownfield selection", "legion-cli spec");
  }
  validateSelection(value);
  return { goal: value.goal, affectedArea: value.affectedArea, sourceFingerprint: value.sourceFingerprint };
}

function validateSelection(input: { goal: string; affectedArea: string }): void {
  if (!input.goal.trim() || !input.affectedArea.trim()) refuse("audit requires a remediation goal and affected area", "legion-cli spec");
  if (/^(all|everything|whole (repo|repository|codebase)|entire (repo|repository|codebase)|[.*\/\\]+)$/i.test(input.affectedArea.trim())) {
    refuse("select a bounded affected area before planning an audit increment", "legion-cli spec");
  }
}

export async function recordDiscoverySelection(engine: LegionEngine, input: { goal: string; affectedArea: string }): Promise<DiscoverySelection> {
  validateSelection(input);
  return engine.store.withLock(async () => {
    const abs = toFsPath(engine.projectRoot, DISCOVERY_PATH);
    await assertNoLinkInPath(abs, { root: engine.projectRoot });
    const body = await readFile(abs, "utf8");
    const sourceFingerprint = /^Source snapshot: ([a-f0-9]{64})$/m.exec(body)?.[1];
    if (!sourceFingerprint) refuse("brownfield orientation is missing", "legion-cli spec");
    const selection = { goal: input.goal.trim(), affectedArea: input.affectedArea.trim(), sourceFingerprint };
    await writeTextFile(toFsPath(engine.projectRoot, SELECTION_PATH), JSON.stringify({ schemaVersion: "legion-cli-discovery-selection/v1", ...selection }, null, 2) + "\n", { root: engine.projectRoot });
    return selection;
  });
}

/** Audit bookkeeping cannot silently turn into an unselected repository-wide implementation. */
export async function assertDiscoverySelection(engine: LegionEngine): Promise<void> {
  const project = await engine.store.readProject();
  if (project.data.mode !== "brownfield" || project.data.brownfieldGoal !== "audit") return;
  const selection = await readSelection(engine);
  const abs = toFsPath(engine.projectRoot, DISCOVERY_PATH);
  await assertNoLinkInPath(abs, { root: engine.projectRoot });
  const body = await readFile(abs, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });
  if (!selection || !body.includes(`Source snapshot: ${selection.sourceFingerprint}`)) refuse("select a bounded audit remediation increment before drafting or approving a plan", "legion-cli spec");
}

/** Orientation is read-only with respect to product code: no tests, installs, or remediation. */
export async function prepareDiscovery(engine: LegionEngine): Promise<DiscoveryResult | null> {
  const project = await engine.store.readProject();
  if (project.data.mode !== "brownfield") return null;
  const goal = project.data.brownfieldGoal ?? "change";
  return engine.store.withLock(async () => {
    const map = await generateMap(engine.projectRoot, { lsp: "off" });
    const evidence = await collectEvidence(engine.projectRoot);
    const sourcePaths = evidence.sources.filter((path) => !path.startsWith(".legion-cli/"));
    const tests = evidence.tests.filter((path) => !path.startsWith(".legion-cli/"));
    const runners = await detectTestRunners(engine.projectRoot, tests);
    const hash = createHash("sha256");
    hash.update(JSON.stringify(runners));
    // Architecture fingerprints describe interfaces; byte hashes also catch implementation drift.
    for (const path of [...new Set([...sourcePaths, ...tests])].sort()) {
      const abs = toFsPath(engine.projectRoot, path);
      await assertNoLinkInPath(abs, { root: engine.projectRoot });
      hash.update(path).update("\0").update(await readFile(abs)).update("\0");
    }
    const findings: DiscoveryResult["findings"] = [];
    if (goal === "audit") {
      const secrets = await scanSecretFindings(engine.projectRoot);
      for (const finding of secrets.findings.filter((item) => !item.path.startsWith(".legion-cli/")).slice(0, 20)) {
        findings.push({ id: `F-${findings.length + 1}`, priority: "P0", statement: `Potential ${finding.kind}; confirm before remediation.`, evidence: [finding.path] });
      }
      if (runners.length === 0 && sourcePaths.length > 0) {
        findings.push({ id: `F-${findings.length + 1}`, priority: "P1", statement: "No supported test-runner configuration was detected; confirm the actual verification command.", evidence: sourcePaths.slice(0, 3) });
      }
      const gaps = sourcePaths.filter((path) => !sourceHasNearbyTest(path, tests));
      if (gaps.length > 0) {
        findings.push({ id: `F-${findings.length + 1}`, priority: "P2", statement: `${gaps.length} source files have no nearby test by filename heuristic; this does not establish missing coverage.`, evidence: gaps.slice(0, 20) });
      }
    }
    const result: DiscoveryResult = {
      path: DISCOVERY_PATH, goal, sourceFingerprint: hash.digest("hex"),
      sourceFiles: sourcePaths.length, testFiles: tests.length, findings, selection: null,
    };
    const previousSelection = await readSelection(engine);
    if (previousSelection?.sourceFingerprint === result.sourceFingerprint) result.selection = previousSelection;
    const list = (items: string[]) => items.length ? items.map((item) => `- ${item}`) : ["- None detected."];
    const body = [
      "# Brownfield discovery", "", `Intent: ${goal === "audit" ? "repository audit" : "scoped change"}`,
      `Source snapshot: ${result.sourceFingerprint}`, "",
      "## Architecture and integration points", "", "Read .legion-cli/map/ARCHITECTURE.md for module exports and imports.",
      `Mapped modules: ${map.fingerprints.modules.length}. Source files: ${sourcePaths.length}. Test files: ${tests.length}.`, "",
      "## Verification configuration (not executed)", "", ...list(runners), "",
      "## Existing behavior and constraints", "",
      "Use the selected change to inspect its entrypoints, tests, callers, persistence, and external dependencies.",
      "Confirm deployment requirements and invariants with the user; the module map cannot establish these.", "",
      "## Findings to confirm and prioritize", "",
      ...(findings.length ? findings.flatMap((finding) => [`### ${finding.id} (${finding.priority})`, finding.statement, ...list(finding.evidence), ""]) : ["No static findings were identified by this bounded orientation.", ""]),
      "## Next decision", "",
      ...(result.selection ? [`Selected goal: ${result.selection.goal}`, `Affected area: ${result.selection.affectedArea}`, ""] : []),
      goal === "audit" ? "Select a bounded remediation increment with the user before writing a specification. Unselected findings remain a backlog." : "Confirm the requested feature or fix and its affected area before writing a specification.",
      "", "This is bounded static discovery, not a comprehensive security or coverage audit. No checks or remediation were executed.", "",
    ].join("\n");
    await writeTextFile(join(engine.projectRoot, DISCOVERY_PATH), body, { root: engine.projectRoot });
    return result;
  });
}
