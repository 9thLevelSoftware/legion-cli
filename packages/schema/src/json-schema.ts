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

export function legionJsonSchemas(): Record<JsonSchemaFileName, Record<string, unknown>> {
  const out = {} as Record<JsonSchemaFileName, Record<string, unknown>>;
  for (const name of JSON_SCHEMA_FILES) {
    out[name] = toLegionJsonSchema(schemaByFile[name]);
  }
  return out;
}
