import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_STRICT_JSON_MAX_BYTES, parseStrictJson } from "../dist/index.js";

test("strict JSON accepts legal values and preserves ordinary JSON object semantics", () => {
  const text = ' \r\n\t{"list":[null,true,false,-0,1.25e2],"text":"escaped \\" \\uD800\\uDC00", "__proto__":{"safe":true}}\n';
  const result = parseStrictJson(Buffer.from(text));
  assert.deepEqual(result.list, [null, true, false, -0, 125]);
  assert.equal(result.text, 'escaped " 𐀀');
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.deepEqual(result.__proto__, { safe: true });
  assert.deepEqual(parseStrictJson('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }]);
  assert.equal(parseStrictJson('"a\\/b\\t\\b\\f\\r\\n"'), "a/b\t\b\f\r\n");
});

test("strict JSON refuses duplicate decoded keys at every nesting level", () => {
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"outer":[{"a":1,"a":2}]}',
    '{"__proto__":1,"__proto__":2}',
    '{"𐀀":1,"\\ud800\\udc00":2}',
    '{"a/b":1,"a\\/b":2}',
  ]) assert.throws(() => parseStrictJson(text), /duplicate/);
  assert.deepEqual(parseStrictJson('{"a":{"x":1},"b":{"x":2}}'), { a: { x: 1 }, b: { x: 2 } });
});

test("strict JSON refuses malformed UTF-8, BOM and invalid Unicode", () => {
  for (const bytes of [
    [0x22, 0xc0, 0xaf, 0x22],
    [0x22, 0xe2, 0x82],
    [0x22, 0xed, 0xa0, 0x80, 0x22],
    [0x22, 0xf4, 0x90, 0x80, 0x80, 0x22],
    [0x22, 0xff, 0x22],
  ]) assert.throws(() => parseStrictJson(new Uint8Array(bytes)), /UTF-8/);
  for (const text of ['"\\ud800"', '"\\udc00"', '"\\ud800x"', '"\ud800"', '"\udc00"', '{"\\ud800":1}']) {
    assert.throws(() => parseStrictJson(text), /surrogate/);
  }
  assert.throws(() => parseStrictJson(Buffer.from('\ufeff{}')), SyntaxError);
  assert.equal(parseStrictJson('"\\ud800\\udc00"'), "𐀀");
  assert.equal(parseStrictJson(Buffer.from('"é𐀀"')), "é𐀀");
});

test("strict JSON refuses nonfinite values and invalid number grammar", () => {
  for (const text of ['1e309', '-1e309', '{"n":1e9999}', 'NaN', 'Infinity', '-Infinity', '01', '-01', '1.', '.1', '+1', '1e', '1e+', '--1']) {
    assert.throws(() => parseStrictJson(text), SyntaxError);
  }
  assert.equal(parseStrictJson('1.7976931348623157e308'), Number.MAX_VALUE);
  assert.equal(parseStrictJson('1e-9999'), 0);
});

test("strict JSON enforces UTF-8 byte limits before decoding", () => {
  assert.equal(parseStrictJson('"é"', { maxBytes: 4 }), "é");
  assert.throws(() => parseStrictJson('"é"', { maxBytes: 3 }), RangeError);
  assert.equal(parseStrictJson(Buffer.from('"é"'), { maxBytes: 4 }), "é");
  assert.throws(() => parseStrictJson(Buffer.from('"é"'), { maxBytes: 3 }), RangeError);
  assert.throws(() => parseStrictJson(new Uint8Array([0xff, 0xff]), { maxBytes: 1 }), RangeError);
  const atLimit = '"' + "x".repeat(DEFAULT_STRICT_JSON_MAX_BYTES - 2) + '"';
  assert.equal(parseStrictJson(atLimit), "x".repeat(DEFAULT_STRICT_JSON_MAX_BYTES - 2));
  const aboveLimit = atLimit + " ";
  assert.throws(() => parseStrictJson(aboveLimit), RangeError);
  assert.equal(parseStrictJson(aboveLimit, { maxBytes: DEFAULT_STRICT_JSON_MAX_BYTES + 1 }), "x".repeat(DEFAULT_STRICT_JSON_MAX_BYTES - 2));
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseStrictJson("0", { maxBytes }), RangeError);
  }
});

test("strict JSON enforces depth for arrays and objects without counting scalar leaves", () => {
  const arrays = "[".repeat(32) + "0" + "]".repeat(32);
  let expected = 0;
  for (let depth = 0; depth < 32; depth++) expected = [expected];
  assert.deepEqual(parseStrictJson(arrays), expected);
  assert.throws(() => parseStrictJson("[" + arrays + "]"), RangeError);
  const objects = '{"x":'.repeat(32) + "0" + "}".repeat(32);
  expected = 0;
  for (let depth = 0; depth < 32; depth++) expected = { x: expected };
  assert.deepEqual(parseStrictJson(objects), expected);
  assert.throws(() => parseStrictJson('{"x":' + objects + "}"), RangeError);
  assert.deepEqual(parseStrictJson('{"x":1}', { maxDepth: 1 }), { x: 1 });
  assert.throws(() => parseStrictJson('{"x":[]}', { maxDepth: 1 }), RangeError);
  assert.equal(parseStrictJson("true", { maxDepth: 0 }), true);
  for (const maxDepth of [-1, 33, 1.5, NaN]) assert.throws(() => parseStrictJson("0", { maxDepth }), RangeError);
});

test("strict JSON rejects trailing data, invalid escapes, separators and whitespace", () => {
  for (const text of ["", " ", "{}{}", "true false", '[1,]', '{"x":1,}', '[,1]', '{"x" 1}', '{x:1}', '"\\x20"', '"\\u000"', '"line\nbreak"', '[1;2]', 'null\u00a0', '/*comment*/0']) {
    assert.throws(() => parseStrictJson(text), SyntaxError);
  }
});
