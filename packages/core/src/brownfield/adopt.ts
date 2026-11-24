import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { assertNoLinkInPath, toFsPath, writeTextFile, type LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import {
  type BrownfieldDagNode,
  type Spec,
} from "@9thlevelsoftware/legion-cli-schema";
import type { DiscoverySelection } from "../discovery.js";
import { HINT, refuse } from "../errors.js";
import { buildSpecFromIntent, specMarkdownBody } from "../spec-build.js";
import type { BrownfieldAdoptOptions, BrownfieldAdoptResult } from "../types.js";
import { readDag } from "./dag.js";
import { section } from "./markdown.js";
import { runAbs } from "./paths.js";
import { parseRunId, readRun } from "./state.js";

const SELECTION_PATH = ".legion-cli/map/selection.json";
const DISCOVERY_PATH = ".legion-cli/map/DISCOVERY.md";
const BROAD_AREA_RE = /^(all|everything|whole (repo|repository|codebase)|entire (repo|repository|codebase)|[.*\/\\]+)$/i;

async function readOptionalRunFile(projectRoot: string, runId: string, rel: string): Promise<string> {
  const abs = runAbs(projectRoot, runId, rel);
  if (!existsSync(abs)) return "";
  await assertNoLinkInPath(abs, { root: projectRoot });
  return readFile(abs, "utf8");
}

function firstNonEmptyLines(text: string, limit = 6): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !/^\(.*\)$/.test(line))
    .slice(0, limit);
}

function normalizeAffectedArea(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed || BROAD_AREA_RE.test(trimmed)) return fallback;
  return trimmed;
}

export async function adoptBrownfieldRun(
  store: LegionStore,
  runIdRaw: string,
  opts: BrownfieldAdoptOptions & {
    allocateSpecId: (name: string) => Promise<string>;
  },
): Promise<{
  result: BrownfieldAdoptResult;
  spec: Spec;
  specBody: string;
}> {
  const runId = parseRunId(runIdRaw);
  const run = await readRun(store, runId);

  let selectedNode: BrownfieldDagNode | null = null;
  const dagAbs = runAbs(store.projectRoot, runId, "dag.json");
  if (existsSync(dagAbs)) {
    const dag = await readDag(store.projectRoot, runId);
    if (opts.prId !== undefined) {
      const wanted = opts.prId.trim().toLowerCase();
      selectedNode = dag.nodes.find((node) => node.id.toLowerCase() === wanted) ?? null;
      if (!selectedNode) {
        refuse(`unknown brownfield PR ${opts.prId} in run ${runId}`, HINT.brownfieldDag(runId));
      }
    } else {
      selectedNode = dag.nodes.find((node) => node.status !== "skipped") ?? dag.nodes[0] ?? null;
    }
  } else if (opts.prId !== undefined) {
    refuse(`brownfield run ${runId} has no dag.json matching ${opts.prId}`, HINT.brownfieldDag(runId));
  }

  const [intentMd, findingsMd, designMd] = await Promise.all([
    readOptionalRunFile(store.projectRoot, runId, "intent.md"),
    readOptionalRunFile(store.projectRoot, runId, "findings.md"),
    readOptionalRunFile(store.projectRoot, runId, "design.md"),
  ]);

  const intentLines = firstNonEmptyLines(section(intentMd, "Goal") || section(intentMd, "User Goal") || intentMd, 3);
  const fallbackGoal = intentLines[0] || run.context?.trim() || `Brownfield remediation (${runId})`;
  const title = selectedNode ? selectedNode.title : fallbackGoal;
  const goal = (selectedNode ? `${selectedNode.title} (${selectedNode.id})` : fallbackGoal).trim();
  const fallbackArea = selectedNode ? `${selectedNode.id}: ${selectedNode.title}` : `brownfield run ${runId}`;
  const rawArea = selectedNode
    ? (selectedNode.files.join(", ").trim() || selectedNode.tracesTo.trim() || run.context?.trim() || "")
    : (run.context?.trim() || firstNonEmptyLines(findingsMd, 1)[0] || "");
  const affectedArea = normalizeAffectedArea(rawArea, fallbackArea);

  const discoveryAbs = toFsPath(store.projectRoot, DISCOVERY_PATH);
  let discoveryBody = "";
  if (existsSync(discoveryAbs)) {
    await assertNoLinkInPath(discoveryAbs, { root: store.projectRoot });
    discoveryBody = await readFile(discoveryAbs, "utf8");
  }
  const existingSnapshot = /^Source snapshot: ([a-f0-9]{64})$/m.exec(discoveryBody)?.[1];
  const sourceFingerprint = existingSnapshot ?? createHash("sha256")
    .update(JSON.stringify({
      runId,
      preSpawnRef: run.preSpawnRef,
      prId: selectedNode?.id ?? null,
      goal,
      affectedArea,
      intentMd,
      findingsMd,
      designMd,
    }))
    .digest("hex");

  const project = await store.readProject();
  if (!existingSnapshot && project.data.mode === "brownfield" && project.data.brownfieldGoal === "audit") {
    const stubDiscovery = [
      "# Brownfield discovery",
      "",
      "Intent: repository audit",
      `Source snapshot: ${sourceFingerprint}`,
      "",
      `Adopted from brownfield run ${runId}${selectedNode ? ` (${selectedNode.id})` : ""}.`,
      "",
    ].join("\n");
    await writeTextFile(discoveryAbs, stubDiscovery, { root: store.projectRoot });
  }

  const selection: DiscoverySelection = { goal, affectedArea, sourceFingerprint };
  await writeTextFile(
    toFsPath(store.projectRoot, SELECTION_PATH),
    `${JSON.stringify({ schemaVersion: "legion-cli-discovery-selection/v1", ...selection }, null, 2)}\n`,
    { root: store.projectRoot },
  );

  const specId = await opts.allocateSpecId(selectedNode ? `${selectedNode.title} ${runId}` : title);
  const mustBeTrue = selectedNode
    ? [
        `Deliver ${selectedNode.title} within ${affectedArea}.`,
        ...(selectedNode.files.length > 0 ? [`Scope changes cleanly to: ${selectedNode.files.join(", ")}.`] : []),
        ...(selectedNode.tracesTo ? [`Address traced findings: ${selectedNode.tracesTo}.`] : []),
      ]
    : [fallbackGoal];

  const problemLines = selectedNode?.risk
    ? `${title}. Risk notes: ${selectedNode.risk}`
    : (intentLines.join(" ") || title);

  const spec = buildSpecFromIntent({
    specId,
    title,
    mapped: {
      problem: problemLines,
      personas: ["Maintainer"],
      mustBeTrue,
      mustNotChange: ["Preserve existing unrelated behavior and public contracts."],
      outOfScope: ["Unselected brownfield backlog items outside this adopted scope."],
      happyPath: `Scoped remediation for ${goal} passes verification cleanly.`,
      screens: [],
    },
    skipWireframes: true,
    decisions: [],
    failureCases: [],
  });
  // Keep `workflowPolicyVersion` undefined unless policy-2 preparation is explicitly requested,
  // so adopted brownfield drafts can move directly through `spec approve` and `plan`.
  const traceLines = [
    "",
    "## Brownfield trace",
    "",
    `- Run: ${runId}`,
    ...(selectedNode ? [
      `- PR: ${selectedNode.id}`,
      `- Title: ${selectedNode.title}`,
      ...(selectedNode.files.length > 0 ? [`- Files: ${selectedNode.files.join(", ")}`] : []),
      ...(selectedNode.tracesTo ? [`- Traces to: ${selectedNode.tracesTo}`] : []),
    ] : []),
    `- Selection: ${SELECTION_PATH}`,
    "",
  ];
  const specBody = `${specMarkdownBody(spec).trimEnd()}\n${traceLines.join("\n")}`;

  return {
    spec,
    specBody,
    result: {
      runId,
      prId: selectedNode?.id ?? null,
      specId,
      specPath: `.legion-cli/specs/${specId}/SPEC.md`,
      selectionPath: SELECTION_PATH,
      phase: "spec_draft",
      selection,
    },
  };
}
