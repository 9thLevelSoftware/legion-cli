import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isPrivateOrLocalHost as fromSchema } from "@9thlevelsoftware/legion-cli-schema";
import { isPrivateOrLocalHost as fromPersist } from "../../persist/dist/index.js";
import { isPrivateOrLocalHost as fromHttp } from "../dist/index.js";
import { assertHttpBaseUrlAllowed } from "../dist/ssrf.js";

const PRIVATE = [
  "169.254.169.254",
  "10.0.0.1",
  "172.16.5.5",
  "192.168.1.1",
  "100.64.0.1",
  "::ffff:169.254.169.254",
  "::ffff:7f00:1",
  "198.18.0.1",
  "192.0.2.1",
  "198.51.100.1",
  "203.0.113.1",
  "192.88.99.1",
  "fec0::1",
  "2001:db8::1",
  "2001:0db8:0:0:0:0:0:1",
  "192.0.0.1",
  "224.0.0.1",
  "255.255.255.255",
  "ff02::1",
  "64:ff9b::a00:1",
  "2002:a00:1::",
  "localhost",
  "metadata.google.internal",
  "fe80::ffff:808:808",
  "fc00::ffff:808:808",
  "ff02::ffff:808:808",
  "fe80::ffff:8.8.8.8",
  "::ffff:127.0.0.1",
];
const PUBLIC = ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"];

test("http and persist resolve the same classifier as schema", () => {
  assert.equal(fromHttp, fromSchema);
  assert.equal(fromPersist, fromSchema);
});

test("http keeps no private-host list of its own (schema owns the classifier)", async () => {
  const src = await readFile(new URL("../src/ssrf.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /PRIVATE_HOSTS|metadata\.google\.internal/);
});

test("one table passes through both the ingest and the http entry points", () => {
  for (const host of PRIVATE) {
    assert.equal(fromPersist(host), true, `persist ${host}`);
    assert.equal(fromHttp(host), true, `http ${host}`);
  }
  for (const host of PUBLIC) {
    assert.equal(fromPersist(host), false, `persist ${host}`);
    assert.equal(fromHttp(host), false, `http ${host}`);
  }
});

test("adapter base URL gate refuses the new ranges", () => {
  for (const host of ["198.18.0.1", "224.0.0.1", "[64:ff9b::a00:1]"]) {
    assert.throws(() => assertHttpBaseUrlAllowed({ baseUrl: `https://${host}/v1`, allowLoopback: false }), /public HTTPS/);
  }
});
