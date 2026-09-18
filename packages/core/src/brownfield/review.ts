import { copyFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PathEscapeError, runStorePath, toFsPath, type LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { HINT, refuse } from "../errors.js";
import type {
  BrownfieldIgnoredBlock,
  BrownfieldReviewItem,
  BrownfieldReviewStatusOptions,
  BrownfieldReviewStatusResult,
  BrownfieldSeverity,
} from "../types.js";
import { normSeverity, normStatus, SEVERITIES, splitBlocks, titleOf } from "./markdown.js";
import { assertBrownfieldReady, readRun } from "./state.js";

/** Statuses that are no longer the reviewer's open item. */
const CLOSED = new Set(["resolved", "addressed", "wontfix", "fixed", "closed", "done"]);

export function parseReview(text: string, source = "review"): { items: BrownfieldReviewItem[]; ignored: BrownfieldIgnoredBlock[] } {
  const items: BrownfieldReviewItem[] = [];
  const ignored: BrownfieldIgnoredBlock[] = [];
  for (const block of splitBlocks(text)) {
    if (!("severity" in block.fields)) {
      ignored.push({ source, heading: block.heading, reason: "review item has no Severity field" });
      continue;
    }
    const id = /^(R-\d+|[A-Z]+-\d+|\d+)/.exec(block.heading)?.[1] ?? block.heading.slice(0, 40);
    items.push({
      id,
      title: titleOf(block.heading),
      severity: normSeverity(block.fields.severity),
      status: normStatus(block.fields.status, "open"),
    });
  }
  return { items, ignored };
}

export function isOpen(item: BrownfieldReviewItem): boolean {
  return !CLOSED.has(item.status) && item.status !== "needs-user-input";
}

/**
 * Default gate: critical/major must reach zero (minor/nit get one fix pass, then are recorded).
 * `strict` gates on every severity. A wontfix the reviewer reopened is a stalemate → escalate.
 */
export function reviewStatus(
  items: readonly BrownfieldReviewItem[],
  previous: readonly BrownfieldReviewItem[] | null,
  strict: boolean,
): Omit<BrownfieldReviewStatusResult, "runId" | "file" | "previous" | "ignoredBlocks" | "snapshot"> {
  const openItems = items.filter(isOpen);
  const needsUserInput = items.filter((item) => item.status === "needs-user-input");
  const before = new Map((previous ?? []).map((item) => [item.id, item]));
  const stalemates = openItems.filter((item) => before.get(item.id)?.status === "wontfix");
  const gating: readonly BrownfieldSeverity[] = strict ? SEVERITIES : ["critical", "major"];
  const blocking = openItems.filter((item) => gating.includes(item.severity));
  const openBySeverity = { critical: 0, major: 0, minor: 0, nit: 0 };
  for (const item of openItems) openBySeverity[item.severity] += 1;
  let verdict: BrownfieldReviewStatusResult["verdict"];
  if (needsUserInput.length > 0 || stalemates.some((item) => gating.includes(item.severity))) verdict = "escalate";
  else if (blocking.length > 0) verdict = "revise";
  else if (openItems.length > 0) verdict = "pass-with-minor";
  else verdict = "pass";
  return {
    verdict,
    total: items.length,
    open: openItems.length,
    openBlocking: blocking.length,
    openBySeverity,
    needsUserInput,
    stalemates,
    openItems,
  };
}

/** Resolve a run-dir-relative POSIX path; refuse anything that escapes the run directory. */
function runRelative(projectRoot: string, runId: string, rel: string, hint: string): { store: string; abs: string } {
  const cleaned = rel.replaceAll("\\", "/").replace(/^\.\//, "");
  const storePath = `${runStorePath(runId)}/${cleaned}`;
  if (cleaned.split("/").includes("..") || /^[A-Za-z]:|^\//.test(cleaned)) {
    refuse(`brownfield review file must stay inside the run directory: ${rel}`, hint);
  }
  try {
    return { store: storePath, abs: toFsPath(projectRoot, storePath) };
  } catch (err) {
    if (err instanceof PathEscapeError) refuse(`brownfield review file must stay inside the run directory: ${rel}`, hint);
    throw err;
  }
}

export function snapshotName(rel: string): string {
  return rel.replace(/(\.md)?$/i, ".prev.md");
}

export async function reviewStatusRun(
  store: LegionStore,
  runId: string,
  opts: BrownfieldReviewStatusOptions = {},
): Promise<BrownfieldReviewStatusResult> {
  await assertBrownfieldReady(store);
  await readRun(store, runId);
  const hint = HINT.brownfieldState(runId);
  const rel = opts.file?.trim() || "reviews/design-review.md";
  const file = runRelative(store.projectRoot, runId, rel, hint);
  if (!existsSync(file.abs)) {
    refuse(`brownfield review file not found: ${file.store}`, hint);
  }
  const parsed = parseReview(await readFile(file.abs, "utf8"), rel);

  const prevRel = opts.previous?.trim() || snapshotName(rel);
  const prev = runRelative(store.projectRoot, runId, prevRel, hint);
  let previousItems: BrownfieldReviewItem[] | null = null;
  if (existsSync(prev.abs)) {
    previousItems = parseReview(await readFile(prev.abs, "utf8"), prevRel).items;
  } else if (opts.previous) {
    refuse(`brownfield previous review not found: ${prev.store}`, hint);
  }

  const status = reviewStatus(parsed.items, previousItems, Boolean(opts.strict));
  let snapshot: string | null = null;
  if (opts.snapshot) {
    const snap = runRelative(store.projectRoot, runId, snapshotName(rel), hint);
    await copyFile(file.abs, snap.abs);
    snapshot = snap.store;
  }
  return {
    runId,
    file: file.store,
    previous: previousItems ? prev.store : null,
    ...status,
    ignoredBlocks: parsed.ignored,
    snapshot,
  };
}
