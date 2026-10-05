import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Strictly decode one Quint ITF value: integers, sets, maps and scalars only. */
export function decodeItfValue(value, label) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Object.keys(value).length === 1 && Object.hasOwn(value, "#bigint")) {
      const number = Number(value["#bigint"]);
      if (!Number.isSafeInteger(number)) throw new Error(`${label}: non-safe Quint integer`);
      return number;
    }
    if (Object.keys(value).length === 1 && Object.hasOwn(value, "#set")) {
      if (!Array.isArray(value["#set"])) throw new Error(`${label}: malformed Quint set`);
      return value["#set"].map((entry, i) => decodeItfValue(entry, `${label}[${i}]`));
    }
    if (Object.keys(value).length === 1 && Object.hasOwn(value, "#map")) {
      if (!Array.isArray(value["#map"])) throw new Error(`${label}: malformed Quint map`);
      const result = new Map();
      for (const [i, pair] of value["#map"].entries()) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`${label}: malformed Quint map entry ${i}`);
        const key = decodeItfValue(pair[0], `${label}.key`);
        if (result.has(key)) throw new Error(`${label}: duplicate Quint map key ${String(key)}`);
        result.set(key, decodeItfValue(pair[1], `${label}[${String(key)}]`));
      }
      return result;
    }
    throw new Error(`${label}: unsupported ITF value ${JSON.stringify(value)}`);
  }
  if (Array.isArray(value)) throw new Error(`${label}: unexpected array value`);
  if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") {
    throw new Error(`${label}: malformed scalar value`);
  }
  return value;
}

/**
 * Decode the `mbt::nondetPicks` record: every declared pick is `{ tag: "Some", value }` or
 * `{ tag: "None", value: { "#tup": [] } }`. Returns a Map of the picks that were made.
 */
export function decodeNondetPicks(raw, names, label) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label}: malformed mbt::nondetPicks`);
  const keys = Object.keys(raw).sort();
  const expected = [...names].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    throw new Error(`${label}: mbt::nondetPicks names [${keys.join(", ")}] differ from [${expected.join(", ")}]`);
  }
  const picks = new Map();
  for (const name of keys) {
    const pick = raw[name];
    if (!pick || typeof pick !== "object" || Array.isArray(pick) || Object.keys(pick).length !== 2) {
      throw new Error(`${label}: malformed nondet pick ${name}`);
    }
    if (pick.tag === "None") {
      const empty = pick.value;
      if (!empty || typeof empty !== "object" || !Array.isArray(empty["#tup"]) || empty["#tup"].length !== 0 || Object.keys(empty).length !== 1) {
        throw new Error(`${label}: malformed empty nondet pick ${name}`);
      }
      continue;
    }
    if (pick.tag !== "Some") throw new Error(`${label}: unknown nondet pick tag for ${name}`);
    picks.set(name, decodeItfValue(pick.value, `${label}.${name}`));
  }
  return picks;
}

/**
 * Read one successful Quint `--mbt --out-itf` trace with exactly `stateCount` states, requiring
 * `fields` among its vars, a known action per state and `init` only at index 0. Each returned
 * state is `{ action, raw }`; callers decode their own fields strictly.
 */
export async function readItfStates(path, { fields, actions, stateCount, maxBytes = 1024 * 1024 }) {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error(`${path}: expected an ITF file no larger than ${maxBytes} bytes`);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      parsed["#meta"]?.format !== "ITF" || parsed["#meta"]?.status !== "ok") {
    throw new Error(`${path}: not a successful Quint ITF document`);
  }
  if (!Array.isArray(parsed.vars) || !Array.isArray(parsed.states) || parsed.states.length !== stateCount) {
    throw new Error(`${path}: expected vars and exactly ${stateCount} states (init plus ${stateCount - 1} actions)`);
  }
  for (const name of [...fields, "mbt::actionTaken"]) {
    if (!parsed.vars.includes(name)) throw new Error(`${path}: ITF vars omit ${name}`);
  }
  return parsed.states.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw["#meta"]?.index !== index) {
      throw new Error(`${path}: malformed state index ${index}`);
    }
    const action = raw["mbt::actionTaken"];
    const isInitialAction = index === 0 && action === "init";
    if (typeof action !== "string" || (!isInitialAction && !actions.has(action)) || (index > 0 && action === "init")) {
      throw new Error(`${path}: unknown or unmapped model action ${JSON.stringify(action)} at state ${index}`);
    }
    for (const field of fields) {
      if (!Object.hasOwn(raw, field)) throw new Error(`${path}: state ${index} is missing ${field}`);
    }
    return { action, raw };
  });
}

/** Action names dispatched by the Quint module's `step` (the `any { ... }` branches). */
export function parseStepActions(source) {
  const body = source.match(/^\s*action\s+step\s*:\s*bool\s*=[\s\S]*?\bany\s*\{([\s\S]*?)\n\s*\}/m)?.[1];
  if (!body) throw new Error("model has no `action step` with an `any { ... }` block");
  const names = [...body.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:\(|,|$)/gm)].map((match) => match[1]);
  const declared = new Set(names);
  if (declared.size !== names.length) throw new Error("model step dispatches an action more than once");
  return declared;
}

/** Require the directory to hold exactly trace0.itf.json .. trace{count-1}.itf.json. */
export async function requireContiguousCorpus(directory, count) {
  const names = await readdir(directory);
  const expectedNames = Array.from({ length: count }, (_, index) => `trace${index}.itf.json`);
  const actualNames = names.filter((name) => name.endsWith(".itf.json")).sort((left, right) => {
    const a = Number(left.match(/^trace(\d+)\.itf\.json$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
    const b = Number(right.match(/^trace(\d+)\.itf\.json$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
    return a - b;
  });
  if (actualNames.length !== expectedNames.length || expectedNames.some((name, index) => actualNames[index] !== name)) {
    throw new Error(`ITF corpus must contain exactly ${count} contiguous traces named trace0.itf.json through trace${count - 1}.itf.json; found ${actualNames.length}`);
  }
  return expectedNames.map((name) => join(directory, name));
}
