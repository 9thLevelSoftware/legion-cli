export interface CanonicalJsonOptions {
  maxDepth?: number;
  /** Only for legacy manifests that already omit undefined object properties. */
  omitUndefinedObjectValues?: boolean;
}

export const MAX_JSON_DEPTH = 32;

export function jsonDepthLimit(maxDepth = MAX_JSON_DEPTH): number {
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_JSON_DEPTH) {
    throw new RangeError(`JSON maxDepth must be an integer from 0 to ${MAX_JSON_DEPTH}`);
  }
  return maxDepth;
}

/** Sorted UTF-16 object keys, ordered arrays, and finite JSON values only. */
export function canonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  const maxDepth = jsonDepthLimit(options.maxDepth);
  const ancestors = new Set<object>();

  function serialize(item: unknown, depth: number): string {
    if (item === null) return "null";
    switch (typeof item) {
      case "string":
      case "boolean":
        return JSON.stringify(item);
      case "number":
        if (!Number.isFinite(item)) throw new TypeError("Canonical JSON requires finite numbers");
        return JSON.stringify(item);
      case "object":
        break;
      default:
        throw new TypeError("Unsupported canonical JSON value");
    }
    if (depth >= maxDepth) throw new RangeError("Canonical JSON exceeds maximum depth");
    const object = item as object;
    if (ancestors.has(object)) throw new TypeError("Canonical JSON cannot contain cycles");
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON requires plain objects and arrays");
    }
    ancestors.add(object);
    try {
      const keys = Reflect.ownKeys(object);
      for (const key of keys) {
        if (array && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("Canonical JSON requires enumerable string-keyed data properties");
        }
      }
      if (array) {
        if (keys.length !== object.length + 1) {
          throw new TypeError("Canonical JSON refuses sparse arrays or extra array properties");
        }
        const parts: string[] = [];
        for (let index = 0; index < object.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
          if (!descriptor || !("value" in descriptor)) {
            throw new TypeError("Canonical JSON refuses sparse arrays or extra array properties");
          }
          parts.push(serialize(descriptor.value, depth + 1));
        }
        return `[${parts.join(",")}]`;
      }
      const parts: string[] = [];
      for (const key of (keys as string[]).sort()) {
        const child = Object.getOwnPropertyDescriptor(object, key)!.value;
        if (child === undefined && options.omitUndefinedObjectValues) continue;
        parts.push(`${JSON.stringify(key)}:${serialize(child, depth + 1)}`);
      }
      return `{${parts.join(",")}}`;
    } finally {
      ancestors.delete(object);
    }
  }

  return serialize(value, 0);
}
