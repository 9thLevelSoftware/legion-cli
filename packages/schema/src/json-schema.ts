import { z } from "zod";
import {
  AssumptionSchema,
  AuditEventSchema,
  ContextFileSchema,
  DiscussFileSchema,
  FileContractSchema,
  IngestReceiptSchema,
  IntentAnswersFileSchema,
  LegionConfigSchema,
  ProjectFileSchema,
  QAScoreSchema,
  ResumeFileSchema,
  SessionBriefSchema,
  SkillContractSchema,
  SpecSchema,
  StateFileSchema,
  TaskSchema,
} from "./schemas.js";
import { PhaseSchema, SkillIdSchema, TaskStatusSchema } from "./versions.js";

export const JSON_SCHEMA_FILES = [
  "phase",
  "task-status",
  "skill-id",
  "project-file",
  "state-file",
  "context-file",
  "intent-answers-file",
  "legion-config",
  "spec",
  "task",
  "file-contract",
  "skill-contract",
  "assumption",
  "discuss-file",
  "ingest-receipt",
  "audit-event",
  "resume-file",
  "qa-score",
  "session-brief",
] as const;

export type JsonSchemaFileName = (typeof JSON_SCHEMA_FILES)[number];

const schemaByFile = {
  phase: PhaseSchema,
  "task-status": TaskStatusSchema,
  "skill-id": SkillIdSchema,
  "project-file": ProjectFileSchema,
  "state-file": StateFileSchema,
  "context-file": ContextFileSchema,
  "intent-answers-file": IntentAnswersFileSchema,
  "legion-config": LegionConfigSchema,
  spec: SpecSchema,
  task: TaskSchema,
  "file-contract": FileContractSchema,
  "skill-contract": SkillContractSchema,
  assumption: AssumptionSchema,
  "discuss-file": DiscussFileSchema,
  "ingest-receipt": IngestReceiptSchema,
  "audit-event": AuditEventSchema,
  "resume-file": ResumeFileSchema,
  "qa-score": QAScoreSchema,
  "session-brief": SessionBriefSchema,
} as const satisfies Record<JsonSchemaFileName, z.ZodType>;

export function toLegionJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "any",
    io: "input",
  }) as Record<string, unknown>;
  const { ["~standard"]: _standard, ...json } = raw;
  return json;
}

function withAllOf(
  json: Record<string, unknown>,
  clause: Record<string, unknown>,
): Record<string, unknown> {
  const existing = Array.isArray(json.allOf) ? json.allOf : [];
  return { ...json, allOf: [...existing, clause] };
}

/** Overlay Zod refinements that `toJSONSchema` cannot represent. */
function overlayJsonSchema(
  name: JsonSchemaFileName,
  json: Record<string, unknown>,
): Record<string, unknown> {
  if (name === "legion-config") {
    return withAllOf(json, {
      if: {
        type: "object",
        properties: {
          adapter: {
            type: "object",
            properties: { default: { const: "generic" } },
            required: ["default"],
          },
        },
        required: ["adapter"],
      },
      then: {
        type: "object",
        properties: {
          adapter: {
            type: "object",
            required: ["default", "generic"],
          },
        },
      },
    });
  }
  if (name === "qa-score") {
    return withAllOf(json, {
      if: {
        type: "object",
        properties: {
          mode: { const: "full" },
          total: { minimum: 85 },
          buckets: {
            type: "object",
            properties: {
              p0: {
                type: "object",
                properties: { failed: { const: 0 } },
                required: ["failed"],
              },
              visual: {
                type: "object",
                properties: { regressions: { const: 0 } },
                required: ["regressions"],
              },
            },
            required: ["p0", "visual"],
          },
        },
        required: ["mode", "total", "buckets"],
      },
      then: {
        type: "object",
        properties: { pass: { const: true } },
        required: ["pass"],
      },
      else: {
        type: "object",
        properties: { pass: { const: false } },
        required: ["pass"],
      },
    });
  }
  return json;
}

export function legionJsonSchemas(): Record<JsonSchemaFileName, Record<string, unknown>> {
  const out = {} as Record<JsonSchemaFileName, Record<string, unknown>>;
  for (const name of JSON_SCHEMA_FILES) {
    out[name] = overlayJsonSchema(name, toLegionJsonSchema(schemaByFile[name]));
  }
  return out;
}
