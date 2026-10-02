import type { ContextFile, DiscussDecision, IntentMapped } from "@9thlevelsoftware/legion-cli-schema";

/** Decisions that land in a drafted spec (accepted and rejected; proposed are still open). */
export function capturedDecisions(decisions: readonly DiscussDecision[] | undefined): DiscussDecision[] {
  return (decisions ?? []).filter((item) => item.status === "accepted" || item.status === "rejected");
}

export function quoteDecision(decision: DiscussDecision): string {
  return `${decision.id} (${decision.status}): ${decision.statement}`;
}

export function templateDecisions(mapped: IntentMapped, context: ContextFile): DiscussDecision[] {
  const platforms = context.platforms;
  let platform: string | undefined;
  if (platforms.length === 1 && platforms[0] === "desktop") {
    platform = "The requested interface includes desktop or browser use.";
  } else if (platforms.includes("phone") && platforms.includes("desktop")) {
    platform = "The requested interface includes phone and desktop or browser use.";
  } else if (platforms.length === 1 && platforms[0] === "phone") {
    platform = "The requested interface includes phone or mobile use.";
  }

  const out =
    mapped.outOfScope.length > 0
      ? `v0 will not include: ${mapped.outOfScope.join(", ")}.`
      : undefined;

  return [platform, out]
    .filter((statement): statement is string => Boolean(statement))
    .map((statement, index) => ({ id: `D-${String(index + 1).padStart(3, "0")}`, statement, status: "proposed" }));
}

export function decisionFileName(id: string, statement: string): string {
  const num = id.replace(/^D-/, "").padStart(4, "0");
  const slug = statement
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "decision";
  return `${num}-${slug}.md`;
}
