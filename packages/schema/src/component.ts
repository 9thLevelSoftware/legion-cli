import { z } from "zod";
import { normalizePathKey } from "./paths.js";
import { SCHEMA_VERSION } from "./versions.js";
import { AssuranceConfigurationSchema, AssuranceDetailSchema, AssuranceIdSchema, AssuranceIdsSchema, AssuranceJsonValueSchema, AssurancePathSchema, AssurancePathsSchema, AssuranceSha256Schema, JsonPointerSchema, OpaqueIdsSchema, boundedRecord, uniqueBy } from "./assurance-primitives.js";

export const COMPONENT_LIMITS = {
  fuel: 20_000_000, wasmStackBytes: 1_048_576, instances: 32, memories: 4,
  memoryBytes: 67_108_864, tables: 16, tableElements: 100_000, deadlineMs: 20_000,
  outputBytes: 1_048_576, nativeBudgetBytes: 2_147_483_648,
} as const;
export const ComponentLimitsSchema = z.strictObject({
  fuel: z.literal(COMPONENT_LIMITS.fuel), wasmStackBytes: z.literal(COMPONENT_LIMITS.wasmStackBytes),
  instances: z.literal(COMPONENT_LIMITS.instances), memories: z.literal(COMPONENT_LIMITS.memories),
  memoryBytes: z.literal(COMPONENT_LIMITS.memoryBytes), tables: z.literal(COMPONENT_LIMITS.tables),
  tableElements: z.literal(COMPONENT_LIMITS.tableElements), deadlineMs: z.literal(COMPONENT_LIMITS.deadlineMs),
  outputBytes: z.literal(COMPONENT_LIMITS.outputBytes), nativeBudgetBytes: z.literal(COMPONENT_LIMITS.nativeBudgetBytes),
});
export const ComponentRequestSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.componentRequest), abi: z.literal("legion-validator/v1"),
  moduleSha256: AssuranceSha256Schema, inputSha256: AssuranceSha256Schema,
  componentBytes: z.number().int().min(1).max(16 * 1024 * 1024),
  inputBytes: z.number().int().min(1).max(8 * 1024 * 1024), limits: ComponentLimitsSchema,
}), 16 * 1024);
export type ComponentRequest = z.infer<typeof ComponentRequestSchema>;
export const ComponentInvocationSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.componentInvocation),
  checks: z.array(z.strictObject({ id: AssuranceIdSchema, configuration: AssuranceConfigurationSchema, files: AssurancePathsSchema.refine((v) => v.length > 0) })).min(1).max(256),
}).superRefine((v, ctx) => uniqueBy(v.checks, (x) => x.id, ctx, ["checks"])), 1024 * 1024);
export type ComponentInvocation = z.infer<typeof ComponentInvocationSchema>;
export function validateComponentInvocation(invocation: ComponentInvocation, requiredChecks: readonly string[]): void {
  if (requiredChecks.length !== new Set(requiredChecks).size || requiredChecks.length !== invocation.checks.length || invocation.checks.some((x) => !requiredChecks.includes(x.id))) throw new Error("Invocation must select each required extension check exactly once");
}
export const ValidatorOutputSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.validatorOutput), checkId: AssuranceIdSchema,
  status: z.enum(["passed", "failed"]),
  observations: z.array(z.strictObject({
    id: AssuranceIdSchema, status: z.enum(["passed", "failed", "error"]), code: AssuranceIdSchema,
    detail: AssuranceDetailSchema.optional(),
  })).max(256),
  recommendations: z.array(z.strictObject({
    title: z.string().min(1).max(256), priority: z.enum(["P0", "P1", "P2"]).optional(),
    type: z.enum(["feature", "fix", "bug"]).optional(), detail: AssuranceDetailSchema.optional(),
  })).max(32).optional(),
}).superRefine((v, ctx) => {
  uniqueBy(v.observations, (x) => x.id, ctx, ["observations"]);
  if (v.status === "passed" && v.observations.some((x) => x.status !== "passed")) ctx.addIssue({ code: "custom", message: "Failed/error observation cannot yield passed" });
}), 1024 * 1024);
export type ValidatorOutput = z.infer<typeof ValidatorOutputSchema>;
export const NativeTargetSchema = z.enum([
  "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-apple-darwin", "aarch64-apple-darwin",
]);
export const NativeHostManifestSchema = boundedRecord(z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION.nativeHostManifest), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  abi: z.literal("legion-validator/v1"), scope: z.enum(["local", "release"]),
  hosts: z.array(z.strictObject({ target: NativeTargetSchema, path: AssurancePathSchema, sha256: AssuranceSha256Schema, size: z.number().int().positive().max(256 * 1024 * 1024) })).min(1).max(7),
}).superRefine((v, ctx) => {
  uniqueBy(v.hosts, (x) => x.target, ctx, ["hosts"]);
  uniqueBy(v.hosts, (x) => normalizePathKey(x.path), ctx, ["hosts"]);
  if (v.scope === "release" && v.hosts.length !== 7) ctx.addIssue({ code: "custom", message: "Release requires all seven targets" });
  if (v.hosts.some((x, i) => i > 0 && v.hosts[i - 1]!.target >= x.target)) ctx.addIssue({ code: "custom", message: "Hosts must be sorted by target" });
}), 1024 * 1024);
export type NativeHostManifest = z.infer<typeof NativeHostManifestSchema>;
const NativeHostProbeShape = {
  version: z.string().max(128).regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/), abi: z.literal("legion-validator/v1"),
  target: NativeTargetSchema, settingsDigest: AssuranceSha256Schema,
  guard: z.enum(["windows-job-committed", "unix-address-space"]), guardVerified: z.literal(true),
};
function validateGuard(v: { target: string; guard: string }, ctx: z.RefinementCtx): void {
  if ((v.target === "x86_64-pc-windows-msvc") !== (v.guard === "windows-job-committed")) ctx.addIssue({ code: "custom", message: "Native budget kind must match platform" });
}
export const NativeHostProbeSchema = boundedRecord(z.strictObject(NativeHostProbeShape).superRefine(validateGuard), 16 * 1024);
export type NativeHostProbe = z.infer<typeof NativeHostProbeSchema>;
export const ComponentRuntimeIdentitySchema = z.strictObject({ hostSha256: AssuranceSha256Schema, ...NativeHostProbeShape }).superRefine(validateGuard);
export type ComponentRuntimeIdentity = z.infer<typeof ComponentRuntimeIdentitySchema>;
export const KnowledgeSelectorSchema = z.strictObject({ kind: z.enum(["function", "class", "method", "type", "interface", "variable"]), qualifiedName: z.string().min(1).max(1024) });
export type KnowledgeSelector = z.infer<typeof KnowledgeSelectorSchema>;
export const ComponentRawInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("missing"), path: AssurancePathSchema }),
  z.strictObject({ kind: z.literal("file"), path: AssurancePathSchema, mode: z.string().regex(/^(?:100644|100755|native:[0-7]{3,6})$/), sha256: AssuranceSha256Schema, encoding: z.enum(["utf8", "base64"]), content: z.string() }),
]);
export type ComponentRawInput = z.infer<typeof ComponentRawInputSchema>;
export const ComponentUnitInputSchema = z.strictObject({ unitId: AssuranceIdSchema, path: AssurancePathSchema, selector: KnowledgeSelectorSchema.optional(), syntaxDigest: AssuranceSha256Schema, syntaxProjection: AssuranceJsonValueSchema });
export const ComponentInputSchema = boundedRecord(z.strictObject({
  abi: z.literal("legion-validator/v1"), projectCheckId: AssuranceIdSchema, extensionCheckId: AssuranceIdSchema,
  acceptanceIds: OpaqueIdsSchema, unitIds: AssuranceIdsSchema, configuration: AssuranceConfigurationSchema,
  files: z.array(ComponentRawInputSchema).max(256), units: z.array(ComponentUnitInputSchema).max(256),
}).superRefine((v, ctx) => {
  uniqueBy(v.files, (x) => normalizePathKey(x.path), ctx, ["files"]);
  uniqueBy(v.units, (x) => x.unitId, ctx, ["units"]);
  if (v.unitIds.length !== v.units.length || v.units.some((x) => !v.unitIds.includes(x.unitId))) ctx.addIssue({ code: "custom", message: "Unit IDs must equal supplied unit records" });
}), 8 * 1024 * 1024);
export type ComponentInput = z.infer<typeof ComponentInputSchema>;

export type JsonContractPredicate = { file: string; pointer: string; op: "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "in"; expected: z.infer<typeof AssuranceJsonValueSchema> } | { op: "all" | "any"; children: JsonContractPredicate[] } | { op: "not"; child: JsonContractPredicate };
const PredicateTreeSchema: z.ZodType<JsonContractPredicate> = z.lazy(() => z.union([
  z.strictObject({ file: AssurancePathSchema, pointer: JsonPointerSchema, op: z.enum(["eq", "ne", "lt", "le", "gt", "ge", "in"]), expected: AssuranceJsonValueSchema }),
  z.strictObject({ op: z.enum(["all", "any"]), children: z.array(PredicateTreeSchema).min(1).max(256) }),
  z.strictObject({ op: z.literal("not"), child: PredicateTreeSchema }),
]));
export const JsonContractConfigurationSchema = boundedRecord(z.strictObject({ assertions: z.array(z.strictObject({ id: AssuranceIdSchema, predicate: PredicateTreeSchema })).min(1).max(256) }).superRefine((v, ctx) => {
  uniqueBy(v.assertions, (x) => x.id, ctx, ["assertions"]);
  function numbers(value: unknown): boolean {
    if (typeof value === "number") return !Number.isInteger(value) || Number.isSafeInteger(value);
    if (value && typeof value === "object") return Object.values(value).every(numbers);
    return true;
  }
  function visit(p: JsonContractPredicate, depth: number): void {
    if (depth > 16) { ctx.addIssue({ code: "custom", message: "Predicate depth exceeds 16" }); return; }
    if ("file" in p) {
      if (!numbers(p.expected)) ctx.addIssue({ code: "custom", message: "Unsafe integer in predicate" });
      if (p.op === "in" && !Array.isArray(p.expected)) ctx.addIssue({ code: "custom", message: "in requires an array" });
      if (["lt", "le", "gt", "ge"].includes(p.op) && typeof p.expected !== "number") ctx.addIssue({ code: "custom", message: "Numeric comparison requires number" });
    } else if ("child" in p) visit(p.child, depth + 1);
    else p.children.forEach((x) => visit(x, depth + 1));
  }
  v.assertions.forEach((x) => visit(x.predicate, 1));
}), 1024 * 1024);
export type JsonContractConfiguration = z.infer<typeof JsonContractConfigurationSchema>;
export function jsonContractFiles(predicate: JsonContractPredicate): string[] {
  if ("file" in predicate) return [predicate.file];
  return "child" in predicate ? jsonContractFiles(predicate.child) : predicate.children.flatMap(jsonContractFiles);
}
