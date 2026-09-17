import { z } from "zod";
import {
  AssumptionSchema,
  AuditEventSchema,
  BrownfieldRunSchema,
  ChatActionSchema,
  ContextFileSchema,
  DesignActiveSchema,
  DesignSystemPackageSchema,
  DiscussFileSchema,
  FileContractSchema,
  FingerprintFileSchema,
  IngestReceiptSchema,
  IntentAnswersFileSchema,
  LegionConfigSchema,
  PacketSchema,
  ProjectFileSchema,
  QAScoreSchema,
  ResumeFileSchema,
  ServeFileSchema,
  SessionBriefSchema,
  SkillCatalogSchema,
  SkillContractSchema,
  SkillOverlayPinSchema,
  TopicsFileSchema,
  SpecSchema,
  StateFileSchema,
  TaskSchema,
} from "./schemas.js";
import { ADAPTER_IDS, PhaseSchema, SkillIdSchema, TaskStatusSchema } from "./versions.js";

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
  "skill-catalog",
  "topics-file",
  "assumption",
  "discuss-file",
  "ingest-receipt",
  "audit-event",
  "resume-file",
  "brownfield-run",
  "qa-score",
  "session-brief",
  "design-system-package",
  "design-active",
  "packet",
  "fingerprint-file",
  "skill-overlay-pin",
  "chat-action",
  "serve-file",
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
  "skill-catalog": SkillCatalogSchema,
  "topics-file": TopicsFileSchema,
  assumption: AssumptionSchema,
  "discuss-file": DiscussFileSchema,
  "ingest-receipt": IngestReceiptSchema,
  "audit-event": AuditEventSchema,
  "resume-file": ResumeFileSchema,
  "brownfield-run": BrownfieldRunSchema,
  "qa-score": QAScoreSchema,
  "session-brief": SessionBriefSchema,
  "design-system-package": DesignSystemPackageSchema,
  "design-active": DesignActiveSchema,
  packet: PacketSchema,
  "fingerprint-file": FingerprintFileSchema,
  "skill-overlay-pin": SkillOverlayPinSchema,
  "chat-action": ChatActionSchema,
  "serve-file": ServeFileSchema,
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

function objectProperties(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const properties = (value as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  return properties as Record<string, unknown>;
}

function namedPropertyNames(
  json: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const adapterProps = objectProperties(objectProperties(json)?.adapter);
  if (!adapterProps) return undefined;
  const named = adapterProps.named;
  if (!named || typeof named !== "object" || Array.isArray(named)) return undefined;
  const propertyNames = (named as Record<string, unknown>).propertyNames;
  if (!propertyNames || typeof propertyNames !== "object" || Array.isArray(propertyNames)) return undefined;
  return propertyNames as Record<string, unknown>;
}

function httpHeadersPropertyNames(
  json: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const adapterProps = objectProperties(objectProperties(json)?.adapter);
  const httpProps = objectProperties(adapterProps?.http);
  const headers = httpProps?.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
  const headerObj = headers as Record<string, unknown>;
  const existing = headerObj.propertyNames;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  headerObj.propertyNames = {};
  return headerObj.propertyNames as Record<string, unknown>;
}

/** Overlay Zod refinements that `toJSONSchema` cannot represent. */
function overlayJsonSchema(
  name: JsonSchemaFileName,
  json: Record<string, unknown>,
): Record<string, unknown> {
  if (name === "legion-config") {
    const propertyNames = namedPropertyNames(json);
    if (propertyNames) {
      propertyNames.not = { enum: [...ADAPTER_IDS] };
    }
    const httpHeadersNames = httpHeadersPropertyNames(json);
    if (httpHeadersNames) {
      httpHeadersNames.not = {
        anyOf: [
          { pattern: "^[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]$" },
          { pattern: "^[Xx]-[Aa][Pp][Ii]-[Kk][Ee][Yy]$" },
        ],
      };
    }
    const genericAdapterIf = (clause: Record<string, unknown>): Record<string, unknown> => ({
      type: "object",
      properties: clause,
      required: Object.keys(clause),
    });
    return withAllOf(json, {
      if: {
        type: "object",
        properties: {
          adapter: {
            anyOf: [
              genericAdapterIf({ default: { const: "generic" } }),
              ...SkillIdSchema.options.map((skillId) =>
                genericAdapterIf({
                  routes: {
                    type: "object",
                    properties: { [skillId]: { const: "generic" } },
                    required: [skillId],
                  },
                }),
              ),
              {
                type: "object",
                properties: {
                  named: {
                    type: "object",
                    not: { additionalProperties: { not: { const: "generic" } } },
                  },
                },
                required: ["named"],
              },
            ],
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
