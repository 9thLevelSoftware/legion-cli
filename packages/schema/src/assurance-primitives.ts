import { z } from "zod";
import { ConcretePosixPathSchema, normalizePathKey } from "./paths.js";

export const AssuranceIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const OpaqueIdSchema = z.string().min(1).max(256).refine((s) => !/[\u0000-\u001f\u007f]/.test(s));
export const AssuranceSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const UtcTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((s) => {
  const n = Date.parse(s);
  return Number.isFinite(n) && new Date(n).toISOString() === s;
});
export const AssurancePathSchema = ConcretePosixPathSchema.refine((s) => s.length <= 4096 && s.split("/").every((p) => !/[\u0000-\u001f\u007f]/.test(p) && !/[. ]$/.test(p)));
export const JsonPointerSchema = z.string().max(4096).regex(/^(?:\/(?:[^~]|~[01])*)*$/);
export type AssuranceJsonValue = null | boolean | number | string | AssuranceJsonValue[] | { [key: string]: AssuranceJsonValue };
const JsonTreeSchema: z.ZodType<AssuranceJsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(JsonTreeSchema), z.record(z.string(), JsonTreeSchema),
]));
function isJsonObject(value: object): value is Record<string, unknown> {
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}
export function validateAssuranceJson(value: unknown, maxDepth = 32): boolean {
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 32) return false;
  const active = new Set<object>();
  function visit(v: unknown, depth: number): boolean {
    if (depth > maxDepth) return false;
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "string") return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v !== "object" || active.has(v)) return false;
    if (!Array.isArray(v) && !isJsonObject(v)) return false;
    active.add(v);
    let valid = true;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (!visit(v[i], depth + 1)) { valid = false; break; }
    } else if (isJsonObject(v)) {
      for (const key in v) if (Object.hasOwn(v, key) && (!visit(key, depth + 1) || !visit(v[key], depth + 1))) { valid = false; break; }
    }
    active.delete(v);
    return valid;
  }
  return visit(value, 0);
}
export const AssuranceJsonValueSchema = z.preprocess((v, ctx) => {
  if (!validateAssuranceJson(v)) {
    ctx.addIssue({ code: "custom", message: "Expected finite JSON with depth at most 32 and valid Unicode" });
    return z.NEVER;
  }
  return v;
}, JsonTreeSchema);
export const AssuranceConfigurationSchema = z.preprocess((v, ctx) => {
  if (!validateAssuranceJson(v)) {
    ctx.addIssue({ code: "custom", message: "Configuration exceeds JSON depth 32 or is not finite JSON" });
    return z.NEVER;
  }
  return v;
}, z.record(z.string(), JsonTreeSchema));
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string, ctx: z.RefinementCtx, path: (string | number)[] = []): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const id = key(item);
    if (seen.has(id)) ctx.addIssue({ code: "custom", message: `Duplicate declaration: ${id}`, path: [...path, i] });
    seen.add(id);
  });
}
export const AssurancePathsSchema = z.array(AssurancePathSchema).max(256).superRefine((v, ctx) => uniqueBy(v, normalizePathKey, ctx));
export const AssuranceIdsSchema = z.array(AssuranceIdSchema).max(256).superRefine((v, ctx) => uniqueBy(v, String, ctx));
export const OpaqueIdsSchema = z.array(OpaqueIdSchema).max(256).superRefine((v, ctx) => uniqueBy(v, String, ctx));
function jsonByteLength(value: unknown, limit: number): number {
  let bytes = 0;
  function string(v: string): void {
    bytes += 2;
    for (let i = 0; i < v.length && bytes <= limit; i++) {
      const code = v.charCodeAt(i);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
      else if (code < 32) bytes += 6;
      else if (code < 128) bytes++;
      else if (code < 2048) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
      else bytes += 3;
    }
  }
  function visit(v: unknown): void {
    if (bytes > limit) return;
    if (typeof v === "string") string(v);
    else if (v === null) bytes += 4;
    else if (typeof v === "boolean") bytes += v ? 4 : 5;
    else if (typeof v === "number") bytes += JSON.stringify(v).length;
    else if (Array.isArray(v)) {
      bytes += 2 + Math.max(0, v.length - 1);
      for (const item of v) { visit(item); if (bytes > limit) break; }
    } else if (typeof v === "object" && v !== null && isJsonObject(v)) {
      bytes += 2;
      let first = true;
      for (const key in v) {
        if (!Object.hasOwn(v, key)) continue;
        if (!first) bytes++;
        first = false;
        string(key); bytes++; visit(v[key]);
        if (bytes > limit) break;
      }
    }
  }
  visit(value);
  return bytes;
}
export function boundedRecord<T extends z.ZodType>(schema: T, maxBytes: number) {
  return z.preprocess((v, ctx) => {
    if (!validateAssuranceJson(v)) {
      ctx.addIssue({ code: "custom", message: "Record must be finite acyclic JSON with depth at most 32" });
      return z.NEVER;
    }
    if (jsonByteLength(v, maxBytes) > maxBytes) {
      ctx.addIssue({ code: "custom", message: `Record exceeds ${maxBytes} UTF-8 bytes` });
      return z.NEVER;
    }
    return v;
  }, schema);
}
export const AssuranceDetailSchema = z.string().max(4096).refine((v) => new TextEncoder().encode(v).byteLength <= 4096, "Detail exceeds 4 KiB UTF-8");

