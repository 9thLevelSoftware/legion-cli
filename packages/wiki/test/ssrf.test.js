import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import test from "node:test";

import {
  fetchPublicHttps,
  isGithubSource,
  isPrivateOrLocalHost,
  isUrlSource,
  resolvePublicAddress,
  SsrfError,
} from "../dist/index.js";

function urlHost(href) {
  return new URL(href).hostname;
}

const PRIVATE_HOSTS = [
  "127.0.0.1",
  "127.0.0.2",
  "0.0.0.0",
  "localhost",
  "app.localhost",
  "10.0.0.4",
  "10.255.255.255",
  "192.168.1.8",
  "192.168.0.1",
  "172.16.0.1",
  "172.31.255.255",
  "169.254.1.1",
  "169.254.169.254",
  "metadata.google.internal",
  "printer.local",
  "foo.local",
  "::1",
  "0:0:0:0:0:0:0:1",
  "::",
  "::0",
  "0:0:0:0:0:0:0:0",
  "fe80::1",
  "fe90::1",
  "feb0::1",
  "fc00::1",
  "fd12:3456:789a:1::1",
];

const PUBLIC_HOSTS = ["example.com", "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "2001:4860:4860::8888"];

test("SSRF deny list: loopback, RFC1918, ULA, link-local, metadata, .local", () => {
  for (const host of PRIVATE_HOSTS) {
    assert.equal(isPrivateOrLocalHost(host), true, host);
  }
  for (const host of PUBLIC_HOSTS) {
    assert.equal(isPrivateOrLocalHost(host), false, host);
  }
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::]/")), true);
  assert.equal(isPrivateOrLocalHost("[::]"), true);
});

test("SSRF deny list: IPv4-mapped and IPv4-compatible IPv6", () => {
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::ffff:127.0.0.1]/")), true);
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::ffff:10.0.0.1]/")), true);
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::ffff:192.168.1.8]/")), true);
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::ffff:172.16.0.1]/")), true);
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::ffff:169.254.169.254]/")), true);
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::ffff:a9fe:a9fe]/")), true);
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::127.0.0.1]/")), true);
  assert.equal(isPrivateOrLocalHost("::ffff:7f00:1"), true);
  assert.equal(isPrivateOrLocalHost("[::ffff:7f00:1]"), true);
  assert.equal(isPrivateOrLocalHost("::ffff:c0a8:1"), true);
});

test("resolvePublicAddress refuses private hosts before DNS", async () => {
  await assert.rejects(() => resolvePublicAddress("127.0.0.1"), SsrfError);
  await assert.rejects(() => resolvePublicAddress("localhost"), SsrfError);
  await assert.rejects(() => resolvePublicAddress("169.254.169.254"), SsrfError);
  await assert.rejects(() => resolvePublicAddress("metadata.google.internal"), SsrfError);
  await assert.rejects(() => resolvePublicAddress("printer.local"), SsrfError);
  await assert.rejects(() => resolvePublicAddress("10.1.2.3"), SsrfError);
  await assert.rejects(() => resolvePublicAddress("192.168.0.9"), SsrfError);
  await assert.rejects(() => resolvePublicAddress("172.16.0.9"), SsrfError);
  await assert.rejects(() => resolvePublicAddress("fd00::1"), SsrfError);
  await assert.rejects(() => resolvePublicAddress("::"), SsrfError);
  await assert.rejects(() => resolvePublicAddress(urlHost("https://[::]/")), SsrfError);
  await assert.rejects(() => resolvePublicAddress(urlHost("https://[::ffff:127.0.0.1]/")), SsrfError);
});

test("DNS rebinding: public hostname that resolves to a private IP is refused", async () => {
  await assert.rejects(
    () => resolvePublicAddress("evil.example", async () => ({ address: "127.0.0.1", family: 4 })),
    SsrfError,
  );
  await assert.rejects(
    () => resolvePublicAddress("evil.example", async () => ({ address: "169.254.169.254", family: 4 })),
    SsrfError,
  );
  await assert.rejects(
    () => resolvePublicAddress("evil.example", async () => ({ address: "10.0.0.1", family: 4 })),
    SsrfError,
  );
  await assert.rejects(
    () => resolvePublicAddress("evil.example", async () => ({ address: "fd00::1", family: 6 })),
    SsrfError,
  );
  await assert.rejects(
    () => resolvePublicAddress("evil.example", async () => ({ address: "::", family: 6 })),
    SsrfError,
  );
  const publicIp = await resolvePublicAddress("evil.example", async () => ({ address: "8.8.8.8", family: 4 }));
  assert.deepEqual(publicIp, { address: "8.8.8.8", family: 4 });
});

test("fetchPublicHttps refuses http, file, github, and private URLs without connecting", async (t) => {
  t.mock.method(https, "request", () => {
    throw new Error("SSRF test must not connect");
  });
  await assert.rejects(() => fetchPublicHttps("http://example.com/doc"), (err) => {
    assert.equal(err instanceof SsrfError, true);
    assert.match(err.message, /http:/);
    return true;
  });
  await assert.rejects(() => fetchPublicHttps("file:///etc/passwd"), SsrfError);
  await assert.rejects(() => fetchPublicHttps("https://127.0.0.1/secret"), SsrfError);
  await assert.rejects(() => fetchPublicHttps("https://[::ffff:127.0.0.1]/"), SsrfError);
  await assert.rejects(() => fetchPublicHttps("https://169.254.169.254/latest/meta-data"), SsrfError);
  await assert.rejects(() => fetchPublicHttps("https://metadata.google.internal/"), SsrfError);
  await assert.rejects(() => fetchPublicHttps("https://printer.local/doc"), SsrfError);
  await assert.rejects(() => fetchPublicHttps("https://[::]/"), SsrfError);
  assert.equal(isUrlSource("https://example.com"), true);
  assert.equal(isUrlSource("http://example.com"), true);
  assert.equal(isGithubSource("github:pr:123"), true);
});

function mockHttpsRequest(t, handler) {
  const requests = [];
  t.mock.method(https, "request", (options, callback) => {
    requests.push(options);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => req;
    req.end = () => {
      const result = handler(options, requests);
      const res = new EventEmitter();
      res.statusCode = result.status ?? 200;
      res.headers = result.headers ?? {};
      callback(res);
      process.nextTick(() => {
        if (result.body) res.emit("data", Buffer.from(result.body));
        res.emit("end");
      });
    };
    return req;
  });
  return requests;
}

function invokePinnedLookup(options, lookupOptions) {
  assert.equal(typeof options.lookup, "function");
  let result;
  options.lookup("attacker.example", lookupOptions, (err, address, family) => {
    result = { err, address, family };
  });
  assert.ok(result, "pinned lookup must invoke the callback");
  return result;
}

test("fetchPublicHttps pins the resolved IP (no happy-eyeballs to a second address)", async (t) => {
  const requests = mockHttpsRequest(t, () => ({ status: 200, body: "public doc", headers: {} }));
  const fetched = await fetchPublicHttps("https://evil.example/doc", {
    lookup: async () => ({ address: "8.8.8.8", family: 4 }),
  });
  assert.equal(fetched.body, "public doc");
  assert.equal(requests.length, 1);
  const options = requests[0];
  assert.equal(options.host, "evil.example");
  assert.equal(options.family, 4);
  assert.equal(options.autoSelectFamily, false);

  const all = invokePinnedLookup(options, { all: true });
  assert.equal(all.err, null);
  assert.deepEqual(all.address, [{ address: "8.8.8.8", family: 4 }]);
  assert.equal(all.address.length, 1);
  assert.equal(all.family, undefined);

  const one = invokePinnedLookup(options, {});
  assert.equal(one.err, null);
  assert.equal(one.address, "8.8.8.8");
  assert.equal(one.family, 4);
});

test("fetchPublicHttps refuses redirect-to-https that still fails the deny list", async (t) => {
  mockHttpsRequest(t, () => ({
    status: 302,
    headers: { location: "http://169.254.169.254/latest/meta-data" },
    body: "",
  }));
  await assert.rejects(
    () =>
      fetchPublicHttps("https://evil.example/bounce", {
        lookup: async () => ({ address: "8.8.8.8", family: 4 }),
      }),
    (err) => {
      assert.equal(err instanceof SsrfError, true);
      assert.match(err.message, /private-network|http:/);
      return true;
    },
  );
});

test("fetchPublicHttps refuses a redirect whose host resolves to loopback", async (t) => {
  let hops = 0;
  mockHttpsRequest(t, () => {
    hops += 1;
    return { status: 302, headers: { location: "https://127.0.0.1/secret" }, body: "" };
  });
  await assert.rejects(
    () =>
      fetchPublicHttps("https://evil.example/bounce", {
        lookup: async () => ({ address: "8.8.8.8", family: 4 }),
      }),
    SsrfError,
  );
  assert.equal(hops, 1);
});
