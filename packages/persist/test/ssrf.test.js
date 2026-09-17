import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  fetchPublicHttpsBinary,
  fetchPublicHttpsPinned,
  GITHUB_ZIPBALL_HOSTS,
  isPrivateOrLocalHost,
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
  "100.64.0.0",
  "100.64.1.1",
  "100.100.100.200",
  "100.127.255.255",
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

const PUBLIC_HOSTS = [
  "example.com",
  "8.8.8.8",
  "1.1.1.1",
  "172.15.0.1",
  "172.32.0.1",
  "100.63.255.255",
  "100.128.0.1",
  "2001:4860:4860::8888",
];

const ZIP_OPTS = {
  maxBytes: 1024,
  accept: "application/zip",
  hostAllowlist: GITHUB_ZIPBALL_HOSTS,
};

test("SSRF deny list: loopback, RFC1918, ULA, link-local, metadata, .local", () => {
  for (const host of PRIVATE_HOSTS) {
    assert.equal(isPrivateOrLocalHost(host), true, host);
  }
  for (const host of PUBLIC_HOSTS) {
    assert.equal(isPrivateOrLocalHost(host), false, host);
  }
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::]/")), true);
  assert.equal(isPrivateOrLocalHost("[::]"), true);
  assert.equal(isPrivateOrLocalHost("[::1]"), true);
});

test("SSRF deny list: IPv4-mapped and IPv4-compatible IPv6", () => {
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::ffff:127.0.0.1]/")), true);
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::ffff:10.0.0.1]/")), true);
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::ffff:192.168.1.8]/")), true);
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::ffff:172.16.0.1]/")), true);
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::ffff:169.254.169.254]/")), true);
  assert.equal(isPrivateOrLocalHost(urlHost("https://[::ffff:100.64.1.1]/")), true);
  assert.equal(isPrivateOrLocalHost("::ffff:6440:101"), true);
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
  await assert.rejects(() => resolvePublicAddress("100.64.1.1"), SsrfError);
  await assert.rejects(() => resolvePublicAddress("100.100.100.200"), SsrfError);
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
    () => resolvePublicAddress("evil.example", async () => ({ address: "100.64.1.1", family: 4 })),
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

test("fetchPublicHttpsBinary refuses http, file, userinfo, and private URLs without connecting", async (t) => {
  t.mock.method(https, "request", () => {
    throw new Error("SSRF test must not connect");
  });
  await assert.rejects(() => fetchPublicHttpsBinary("http://github.com/acme/brand/archive/refs/tags/v1.zip", ZIP_OPTS), (err) => {
    assert.equal(err instanceof SsrfError, true);
    assert.match(err.message, /http:/);
    return true;
  });
  await assert.rejects(() => fetchPublicHttpsBinary("file:///etc/passwd", ZIP_OPTS), SsrfError);
  await assert.rejects(
    () => fetchPublicHttpsBinary("https://user:secret@github.com/acme/brand/archive/refs/tags/v1.zip", ZIP_OPTS),
    (err) => {
      assert.equal(err instanceof SsrfError, true);
      assert.match(err.message, /userinfo/);
      return true;
    },
  );
  await assert.rejects(() => fetchPublicHttpsBinary("https://127.0.0.1/secret.zip", ZIP_OPTS), SsrfError);
  await assert.rejects(() => fetchPublicHttpsBinary("https://[::ffff:127.0.0.1]/", ZIP_OPTS), SsrfError);
  await assert.rejects(() => fetchPublicHttpsBinary("https://169.254.169.254/latest/meta-data", ZIP_OPTS), SsrfError);
  await assert.rejects(() => fetchPublicHttpsBinary("https://printer.local/doc.zip", ZIP_OPTS), SsrfError);
});

test("fetchPublicHttpsBinary refuses a host that is not allowlisted", async (t) => {
  t.mock.method(https, "request", () => {
    throw new Error("SSRF test must not connect");
  });
  await assert.rejects(
    () =>
      fetchPublicHttpsBinary("https://evil.example/pkg.zip", {
        ...ZIP_OPTS,
        lookup: async () => ({ address: "8.8.8.8", family: 4 }),
      }),
    (err) => {
      assert.equal(err instanceof SsrfError, true);
      assert.match(err.message, /allowlist/);
      return true;
    },
  );
});

test("fetchPublicHttpsBinary refuses mock lookup to 127.0.0.1", async (t) => {
  t.mock.method(https, "request", () => {
    throw new Error("SSRF test must not connect");
  });
  await assert.rejects(
    () =>
      fetchPublicHttpsBinary("https://github.com/acme/brand/archive/refs/tags/v1.zip", {
        ...ZIP_OPTS,
        lookup: async () => ({ address: "127.0.0.1", family: 4 }),
      }),
    SsrfError,
  );
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

test("fetchPublicHttpsBinary pins the resolved IP and returns a Buffer", async (t) => {
  const requests = mockHttpsRequest(t, () => ({ status: 200, body: "PK\x03\x04zip", headers: { "content-type": "application/zip" } }));
  const fetched = await fetchPublicHttpsBinary("https://github.com/acme/brand/archive/refs/tags/v1.zip", {
    ...ZIP_OPTS,
    lookup: async () => ({ address: "8.8.8.8", family: 4 }),
  });
  assert.equal(Buffer.isBuffer(fetched.body), true);
  assert.equal(fetched.body.toString(), "PK\x03\x04zip");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].host, "github.com");
  assert.equal(requests[0].family, 4);
  assert.equal(requests[0].autoSelectFamily, false);
  assert.equal(requests[0].headers.Accept, "application/zip");
});

test("fetchPublicHttpsBinary refuses http: redirects (no silent upgrade)", async (t) => {
  mockHttpsRequest(t, () => ({
    status: 302,
    headers: { location: "http://codeload.github.com/acme/brand/zip/refs/tags/v1" },
    body: "",
  }));
  await assert.rejects(
    () =>
      fetchPublicHttpsBinary("https://github.com/acme/brand/archive/refs/tags/v1.zip", {
        ...ZIP_OPTS,
        lookup: async () => ({ address: "8.8.8.8", family: 4 }),
      }),
    (err) => {
      assert.equal(err instanceof SsrfError, true);
      assert.match(err.message, /http:/);
      return true;
    },
  );
});

test("fetchPublicHttpsPinned wiki path still upgrades http: redirects", async (t) => {
  let hops = 0;
  mockHttpsRequest(t, () => {
    hops += 1;
    if (hops === 1) {
      return { status: 302, headers: { location: "http://example.com/doc" }, body: "" };
    }
    return { status: 200, body: "public doc", headers: { "content-type": "text/plain" } };
  });
  const fetched = await fetchPublicHttpsPinned("https://evil.example/bounce", {
    maxBytes: 1024,
    accept: "text/*",
    lookup: async () => ({ address: "8.8.8.8", family: 4 }),
    httpRedirect: "upgrade",
  });
  assert.equal(fetched.body.toString("utf8"), "public doc");
  assert.equal(hops, 2);
});

test("fetchPublicHttpsBinary refuses a redirect whose host resolves to loopback", async (t) => {
  let hops = 0;
  mockHttpsRequest(t, () => {
    hops += 1;
    return { status: 302, headers: { location: "https://127.0.0.1/secret.zip" }, body: "" };
  });
  await assert.rejects(
    () =>
      fetchPublicHttpsBinary("https://github.com/acme/brand/archive/refs/tags/v1.zip", {
        ...ZIP_OPTS,
        lookup: async () => ({ address: "8.8.8.8", family: 4 }),
      }),
    SsrfError,
  );
  assert.equal(hops, 1);
});

test("persist source does not import wiki", async () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = await readdir(srcDir, { recursive: true });
  for (const file of files) {
    if (!String(file).endsWith(".ts")) continue;
    assert.equal(String(file).includes("wiki/src"), false, file);
  }
  const { readFile } = await import("node:fs/promises");
  for (const file of files) {
    if (!String(file).endsWith(".ts")) continue;
    const text = await readFile(join(srcDir, file), "utf8");
    assert.doesNotMatch(text, /@9thlevelsoftware\/legion-cli-wiki/, file);
  }
});
