import assert from "node:assert/strict";
import test from "node:test";

import {
  isConcretePosixRepoRelativePath,
  isPrivateOrLocalHost,
  normalizePathKey,
} from "../dist/index.js";

test("concrete path refuses .git aliases: case, trailing dot/space, stream, 8.3 short name", () => {
  for (const bad of [".GIT/x", ".Git./x", ".git /x", "GIT~1/x", ".git:$INDEX_ALLOCATION/x", "a/.GIT/x", "src/x:stream", "GIT~1./x", "GIT~1 /x", "a/.. /b", "a/.../b"]) {
    assert.equal(isConcretePosixRepoRelativePath(bad), false, bad);
  }
});

test("concrete path keeps ordinary names, including notes~2.md and .gitignore", () => {
  for (const ok of ["notes~2.md", "src/a.ts", ".gitignore", "docs/GIT.md", "a.b/c"]) {
    assert.equal(isConcretePosixRepoRelativePath(ok), true, ok);
  }
});

test("normalizePathKey lowercases and strips trailing dots and spaces per segment", () => {
  assert.equal(normalizePathKey("Src./Foo .TS"), "src/foo .ts");
  assert.equal(normalizePathKey(".LEGION-CLI/STATE.md"), ".legion-cli/state.md");
});

test("shared SSRF classifier is exported from schema and covers the reserved ranges", () => {
  for (const host of [
    "169.254.169.254",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.0.1",
    "100.100.100.200",
    "198.18.0.1",
    "198.19.255.255",
    "192.0.0.8",
    "224.0.0.1",
    "239.255.255.250",
    "255.255.255.255",
    "::ffff:10.0.0.1",
    "fe80::1%12",
    "fe80::1%eth0",
    "[fe80::1%25eth0]",
    "::ffff:0:a00:1",
    "not:an:ipv6:literal",
    "::ffff:a9fe:a9fe",
    "ff02::1",
    "64:ff9b::7f00:1",
    "64:ff9b::10.0.0.1",
    "2002:c0a8:101::1",
    "fe80::1",
    "fd00::1",
    "::1",
  ]) {
    assert.equal(isPrivateOrLocalHost(host), true, host);
  }
  for (const host of ["8.8.8.8", "1.1.1.1", "198.17.0.1", "198.20.0.1", "192.0.2.1", "2606:4700:4700::1111", "example.com"]) {
    assert.equal(isPrivateOrLocalHost(host), false, host);
  }
});
