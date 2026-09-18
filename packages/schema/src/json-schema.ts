import { z } from "zod";
import {
  AssumptionSchema,
  AuditEventSchema,
  BrownfieldRunSchema,
  ChatActionSchema,
  ChatSessionFileSchema,
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
  "chat-session",
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
  "chat-session": ChatSessionFileSchema,
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

function adapterTargetIfThen(id: string, requiredKey: string): Record<string, unknown> {
  const adapterIf = (clause: Record<string, unknown>): Record<string, unknown> => ({
    type: "object",
    properties: clause,
    required: Object.keys(clause),
  });
  return {
    if: {
      type: "object",
      properties: {
        adapter: {
          anyOf: [
            adapterIf({ default: { const: id } }),
            ...SkillIdSchema.options.map((skillId) =>
              adapterIf({
                routes: {
                  type: "object",
                  properties: { [skillId]: { const: id } },
                  required: [skillId],
                },
              }),
            ),
            {
              type: "object",
              properties: {
                named: {
                  type: "object",
                  not: { additionalProperties: { not: { const: id } } },
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
          required: ["default", requiredKey],
        },
      },
    },
  };
}

const HTTPS_HOST =
  "(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\\d{1,3}(?:\\.\\d{1,3}){3}|\\[[0-9A-Fa-f:]*[0-9A-Fa-f][0-9A-Fa-f:]*\\])";
const HTTPS_PORT =
  "(?::(?:0|[1-9]\\d{0,3}|[1-5]\\d{4}|6[0-4]\\d{3}|65[0-4]\\d{2}|655[0-2]\\d|6553[0-5]))?";
const HTTPS_BASE_URL = `^https://${HTTPS_HOST}${HTTPS_PORT}([/?#].*)?$`;
const LOOPBACK_OR_HTTPS_BASE_URL =
  `^(https://${HTTPS_HOST}${HTTPS_PORT}|http://(127\\.0\\.0\\.1|localhost|\\[::1\\])${HTTPS_PORT})([/?#].*)?$`;

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
    const adapterProps = objectProperties(objectProperties(json)?.adapter);
    const httpProps = objectProperties(adapterProps?.http);
    const headers = httpProps?.headers;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      const headerObj = headers as Record<string, unknown>;
      const names =
        headerObj.propertyNames &&
        typeof headerObj.propertyNames === "object" &&
        !Array.isArray(headerObj.propertyNames)
          ? (headerObj.propertyNames as Record<string, unknown>)
          : ((headerObj.propertyNames = {}) as Record<string, unknown>);
      names.not = {
        anyOf: [
          { pattern: "^[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]$" },
          { pattern: "^[Xx]-[Aa][Pp][Ii]-[Kk][Ee][Yy]$" },
        ],
      };
    }
    return withAllOf(
      withAllOf(
        withAllOf(json, adapterTargetIfThen("generic", "generic")),
        adapterTargetIfThen("http", "http"),
      ),
      {
        if: {
          type: "object",
          properties: {
            adapter: {
              type: "object",
              properties: {
                http: {
                  type: "object",
                  properties: { allowLoopback: { const: true } },
                  required: ["allowLoopback"],
                },
              },
              required: ["http"],
            },
          },
          required: ["adapter"],
        },
        then: {
          type: "object",
          properties: {
            adapter: {
              type: "object",
              properties: {
                http: {
                  type: "object",
                  properties: { baseUrl: { type: "string", pattern: LOOPBACK_OR_HTTPS_BASE_URL } },
                },
              },
            },
          },
        },
        else: {
          type: "object",
          properties: {
            adapter: {
              type: "object",
              properties: {
                http: {
                  type: "object",
                  properties: { baseUrl: { type: "string", pattern: HTTPS_BASE_URL } },
                },
              },
            },
          },
        },
      },
    );
  }
  if (name === "skill-overlay-pin") {
    return withAllOf(json, {
      if: {
        type: "object",
        properties: {
          source: {
            type: "object",
            properties: { type: { const: "github" } },
            required: ["type"],
          },
        },
        required: ["source"],
      },
      then: {
        type: "object",
        properties: {
          source: {
            type: "object",
            required: ["type", "origin", "ref"],
            properties: {
              origin: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
            },
          },
          integrity: {
            type: "object",
            required: ["sha256", "minisign"],
          },
        },
        required: ["source", "integrity"],
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
