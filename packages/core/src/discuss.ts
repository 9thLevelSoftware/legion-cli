import type { ContextFile, DiscussDecision, IntentMapped } from "@9thlevelsoftware/legion-cli-schema";

export function templateDecisions(mapped: IntentMapped, context: ContextFile): DiscussDecision[] {
  const platforms = context.platforms;
  let platform = "Ship as mobile web, not a native app.";
  if (platforms.length === 1 && platforms[0] === "desktop") {
    platform = "Ship as desktop web, not a native app.";
  } else if (platforms.includes("phone") && platforms.includes("desktop")) {
    platform = "Ship as mobile and desktop web, not a native app.";
  } else if (platforms.length === 1 && platforms[0] === "phone") {
    platform = "Ship as mobile web, not a native app.";
  }

  const out =
    mapped.outOfScope.length > 0
      ? `v0 will not include: ${mapped.outOfScope.join(", ")}.`
      : "v0 will not include unspecified extras.";

  return [
    { id: "D-001", statement: platform, status: "proposed" },
    { id: "D-002", statement: out, status: "proposed" },
    { id: "D-003", statement: "Product data is stored on the device, not on a remote server.", status: "proposed" },
  ];
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
