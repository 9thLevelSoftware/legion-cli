import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../dist/index.js";

test("canonical JSON sorts UTF-16 keys recursively and preserves array order", () => {
  const input = { "\ue000": 1, "𐀀": 2, z: [{ b: true, a: null }, 3, 2], "2": "two", "10": "ten" };
  const expected = '{"10":"ten","2":"two","z":[{"a":null,"b":true},3,2],"𐀀":2,"\ue000":1}';
  assert.equal(canonicalJson(input), expected);
  assert.equal(canonicalJson({ z: input.z, "10": "ten", "𐀀": 2, "2": "two", "\ue000": 1 }), expected);
  assert.notEqual(canonicalJson({ list: [1, 2] }), canonicalJson({ list: [2, 1] }));
  assert.equal(canonicalJson({ text: 'quote " and newline\n', number: -0 }), '{"number":0,"text":"quote \\" and newline\\n"}');
});

test("canonical JSON rejects values that JSON serialization would lose or coerce", () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol("id"), new Date(), new Map(), new Set()]) {
    assert.throws(() => canonicalJson(value), TypeError);
    assert.throws(() => canonicalJson({ value }), TypeError);
    assert.throws(() => canonicalJson([value]), TypeError);
  }
  assert.throws(() => canonicalJson({ [Symbol("hidden")]: 1 }), TypeError);
  assert.throws(() => canonicalJson(Object.defineProperty({}, "hidden", { value: 1 })), TypeError);
  let accessed = false;
  const accessor = { get value() { accessed = true; return 1; } };
  assert.throws(() => canonicalJson(accessor), TypeError);
  assert.equal(accessed, false);
  assert.throws(() => canonicalJson(new Array(1)), TypeError);
  assert.throws(() => canonicalJson(Object.assign([1], { extra: 2 })), TypeError);
  assert.equal(canonicalJson(Object.assign(Object.create(null), { safe: 1 })), '{"safe":1}');
});

test("canonical JSON rejects cycles but permits repeated noncyclic values", () => {
  const object = {};
  object.self = object;
  assert.throws(() => canonicalJson(object), /cycles/);
  const array = [];
  array.push(array);
  assert.throws(() => canonicalJson(array), /cycles/);
  const shared = { x: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"x":1},{"x":1}]');
});

test("canonical JSON enforces container depth at the exact boundary", () => {
  let value = 0;
  for (let depth = 0; depth < 32; depth++) value = [value];
  assert.equal(canonicalJson(value), "[".repeat(32) + "0" + "]".repeat(32));
  assert.throws(() => canonicalJson([value]), RangeError);
  assert.equal(canonicalJson({ value: 1 }, { maxDepth: 1 }), '{"value":1}');
  assert.throws(() => canonicalJson({ value: [] }, { maxDepth: 1 }), RangeError);
  assert.equal(canonicalJson(1, { maxDepth: 0 }), "1");
  for (const maxDepth of [-1, 33, 1.5, NaN]) assert.throws(() => canonicalJson(0, { maxDepth }), RangeError);
});

test("legacy undefined omission is explicit and restricted to object properties", () => {
  const value = { optional: undefined, nested: { omitted: undefined, kept: null } };
  assert.throws(() => canonicalJson(value), TypeError);
  assert.equal(canonicalJson(value, { omitUndefinedObjectValues: true }), '{"nested":{"kept":null}}');
  assert.throws(() => canonicalJson([undefined], { omitUndefinedObjectValues: true }), TypeError);
});
