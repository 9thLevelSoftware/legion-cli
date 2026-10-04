import { Ajv } from "ajv";

const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });

type Container = Record<string, unknown> | unknown[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectContainers(value: unknown, into: Set<object>): void {
  if (value === null || typeof value !== "object") return;
  into.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) collectContainers(nested, into);
}

function parseValue(content: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    throw new Error("invalid-output");
  }
}

function childSchemaOf(schema: Record<string, unknown>, segment: string): Record<string, unknown> {
  const properties = schema.properties;
  if (!isPlainObject(properties) || !Object.hasOwn(properties, segment) ||
      segment === "__proto__" || segment === "prototype" || segment === "constructor") {
    throw new Error("unsupported MCP object pointer");
  }
  const child = properties[segment];
  if (!isPlainObject(child)) throw new Error("unsupported MCP property schema");
  return child;
}

/**
 * Builds the exact governed MCP tool arguments: the approved fixed authority, plus each data value placed only at its
 * declared schema-defined pointer. A pointer that lands on, inside, or above an authority-populated location, or that
 * overlaps another data pointer, is refused; the assembled arguments must satisfy the tool input schema.
 */
export function assembleGovernedMcpArguments(
  inputSchema: Record<string, unknown>,
  fixedAuthority: Readonly<Record<string, unknown>>,
  data: readonly { pointer: string; content: Uint8Array }[],
): Record<string, unknown> {
  if (inputSchema.type !== "object" || !isPlainObject(inputSchema.properties)) throw new Error("unsupported MCP root input schema");
  if (!isPlainObject(fixedAuthority)) throw new Error("MCP fixed authority must be an object");
  const args = structuredClone(fixedAuthority) as Record<string, unknown>;
  const authority = new Set<object>();
  collectContainers(args, authority);
  const created = new Set<object>();
  for (const item of data) {
    if (!item.pointer.startsWith("/") || /~(?![01])/.test(item.pointer)) throw new Error("unsupported MCP JSON pointer");
    const path = item.pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    let container: Container = args;
    let schema = inputSchema;
    for (let index = 0; index < path.length; index += 1) {
      const segment = path[index]!;
      const last = index === path.length - 1;
      let childSchema: Record<string, unknown>;
      let existing: unknown;
      let present: boolean;
      if (schema.type === "object") {
        if (Array.isArray(container)) throw new Error("unsupported MCP object container");
        childSchema = childSchemaOf(schema, segment);
        present = Object.hasOwn(container, segment);
        existing = present ? container[segment] : undefined;
      } else if (schema.type === "array") {
        if (!Array.isArray(container) || authority.has(container)) throw new Error("MCP data pointer overlaps fixed authority");
        if (!/^(0|[1-9]\d*)$/.test(segment) || !Number.isSafeInteger(Number(segment))) throw new Error("unsupported MCP array pointer");
        const items = schema.items;
        if (!isPlainObject(items)) throw new Error("unsupported MCP array item schema");
        childSchema = items;
        const arrayIndex = Number(segment);
        if (arrayIndex > container.length) throw new Error("sparse MCP array pointer");
        present = arrayIndex < container.length;
        existing = present ? container[arrayIndex] : undefined;
      } else {
        throw new Error("unsupported MCP pointer schema");
      }
      if (last) {
        if (present) throw new Error(authority.has(container) ? "MCP data pointer overlaps fixed authority or another data pointer" : "duplicate MCP data pointer");
        const value = parseValue(item.content);
        if (Array.isArray(container)) container.push(value);
        else container[segment] = value;
        continue;
      }
      const childType = childSchema.type;
      if (childType !== "object" && childType !== "array") throw new Error("unsupported MCP pointer through scalar");
      let child: unknown;
      if (!present) {
        child = childType === "object" ? {} : [];
        created.add(child as object);
        if (Array.isArray(container)) container.push(child);
        else container[segment] = child;
      } else if (existing !== null && typeof existing === "object" && authority.has(existing)) {
        if (childType !== "object" || !isPlainObject(existing)) throw new Error("MCP data pointer overlaps fixed authority");
        child = existing;
      } else if (existing !== null && typeof existing === "object" && created.has(existing)) {
        if (childType === "array" ? !Array.isArray(existing) : !isPlainObject(existing)) throw new Error("conflicting MCP pointer containers");
        child = existing;
      } else {
        throw new Error(authority.has(container) ? "MCP data pointer overlaps fixed authority or another data pointer" : "duplicate MCP data pointer");
      }
      container = child as Container;
      schema = childSchema;
    }
  }
  let valid: unknown;
  try {
    valid = ajv.validate(inputSchema, args);
  } catch {
    throw new Error("unsupported MCP input schema");
  }
  if (valid !== true) throw new Error("MCP arguments do not satisfy the tool input schema");
  return args;
}
