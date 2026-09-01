import { SCHEMA_VERSION, type AcceptanceCriterion, type IntentMapped, type Spec } from "@9thlevelsoftware/legion-cli-schema";

export function buildSpecFromIntent(opts: {
  specId: string;
  title: string;
  mapped: IntentMapped;
  extraAcceptance?: AcceptanceCriterion[];
  skipWireframes: boolean;
}): Spec {
  const p0: AcceptanceCriterion[] = opts.mapped.mustBeTrue.map((statement, i) => ({
    id: `AC-P0-${String(i + 1).padStart(2, "0")}`,
    statement,
    kind: "behavior" as const,
    priority: "P0" as const,
  }));
  const extra = opts.extraAcceptance ?? [];
  const seen = new Set(p0.map((ac) => ac.statement.toLowerCase()));
  const merged = [...p0];
  for (const ac of extra) {
    if (seen.has(ac.statement.toLowerCase())) continue;
    seen.add(ac.statement.toLowerCase());
    merged.push(ac);
  }
  if (merged.length === 0) {
    merged.push({
      id: "AC-P0-01",
      statement: opts.mapped.problem || "The product does what the intent brief says.",
      kind: "behavior",
      priority: "P0",
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION.spec,
    id: opts.specId,
    title: opts.title,
    status: "draft",
    mustBeTrue: opts.mapped.mustBeTrue,
    mustNotChange: opts.mapped.mustNotChange,
    outOfScope: opts.mapped.outOfScope,
    acceptance: merged,
    personas: opts.mapped.personas,
    happyPath: opts.mapped.happyPath,
    stories: null,
    wireframesIndex: opts.skipWireframes ? null : "wireframes/INDEX.html",
    frozenAt: null,
    frozenBy: null,
  };
}

export function specMarkdownBody(spec: Spec): string {
  const ac = spec.acceptance.map((item) => `- ${item.id} (${item.priority}): ${item.statement}`).join("\n");
  return [
    `# ${spec.title}`,
    ``,
    spec.personas[0] ? `${spec.personas[0]}.` : "",
    ``,
    `## Must be true`,
    ...spec.mustBeTrue.map((line) => `- ${line}`),
    ``,
    `## Must not change`,
    ...(spec.mustNotChange.length > 0 ? spec.mustNotChange.map((line) => `- ${line}`) : ["- (none)"]),
    ``,
    `## Out of scope`,
    ...(spec.outOfScope.length > 0 ? spec.outOfScope.map((line) => `- ${line}`) : ["- (none)"]),
    ``,
    `## Happy path`,
    spec.happyPath || "(unspecified)",
    ``,
    `## Acceptance`,
    ac,
    ``,
  ].join("\n");
}
