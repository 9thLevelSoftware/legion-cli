import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedLoopbackOrigins,
  echoAllowedOrigin,
  originIsAllowed,
  writeOriginIsAllowed,
} from "../dist/index.js";

test("loopback origins on 127.0.0.1 bind are allowed; others are not", () => {
  const port = 7420;
  const bind = "127.0.0.1";
  for (const origin of allowedLoopbackOrigins(port)) {
    assert.equal(
      originIsAllowed({ origin, hostHeader: `127.0.0.1:${port}`, bind, port }),
      true,
      origin,
    );
  }
  assert.equal(
    originIsAllowed({
      origin: "http://evil.example",
      hostHeader: `127.0.0.1:${port}`,
      bind,
      port,
    }),
    false,
  );
  assert.equal(
    originIsAllowed({
      origin: "http://127.0.0.1:9",
      hostHeader: `127.0.0.1:${port}`,
      bind,
      port,
    }),
    false,
  );
  assert.equal(
    originIsAllowed({
      origin: "https://127.0.0.1:7420",
      hostHeader: "127.0.0.1:7420",
      bind,
      port,
    }),
    false,
  );
  assert.equal(
    originIsAllowed({
      origin: undefined,
      hostHeader: "127.0.0.1:7420",
      bind,
      port,
    }),
    true,
  );
  assert.equal(
    originIsAllowed({
      origin: undefined,
      hostHeader: "evil.example",
      bind,
      port,
    }),
    false,
  );
});

test("expose allows Origin that matches Host, still not *", () => {
  const port = 7420;
  const bind = "0.0.0.0";
  assert.equal(
    originIsAllowed({
      origin: "http://192.168.1.9:7420",
      hostHeader: "192.168.1.9:7420",
      bind,
      port,
    }),
    true,
  );
  assert.equal(
    originIsAllowed({
      origin: "http://evil.example",
      hostHeader: "192.168.1.9:7420",
      bind,
      port,
    }),
    false,
  );
  assert.equal(echoAllowedOrigin("*", true), undefined);
  assert.equal(echoAllowedOrigin("http://127.0.0.1:7420", true), "http://127.0.0.1:7420");
});

test("IPv4-mapped loopback is loopback; other mapped addresses are not", () => {
  const port = 7420;
  const bind = "127.0.0.1";
  assert.equal(
    originIsAllowed({
      origin: "http://[::ffff:127.0.0.1]:7420",
      hostHeader: "[::ffff:127.0.0.1]:7420",
      bind,
      port,
    }),
    true,
  );
  assert.equal(
    originIsAllowed({
      origin: "http://[::ffff:192.168.1.9]:7420",
      hostHeader: "[::ffff:192.168.1.9]:7420",
      bind,
      port,
    }),
    false,
  );
  assert.equal(
    writeOriginIsAllowed({
      origin: undefined,
      hostHeader: "127.0.0.1:7420",
      bind,
      port,
    }),
    false,
  );
  assert.equal(
    writeOriginIsAllowed({
      origin: "http://127.0.0.1:7420",
      hostHeader: "127.0.0.1:7420",
      bind,
      port,
    }),
    true,
  );
  assert.equal(
    originIsAllowed({
      origin: undefined,
      hostHeader: "[::]:7420",
      bind,
      port,
    }),
    false,
  );
  assert.equal(
    originIsAllowed({
      origin: undefined,
      hostHeader: "0.0.0.0:7420",
      bind,
      port,
    }),
    false,
  );
  assert.equal(
    writeOriginIsAllowed({
      origin: "http://127.0.0.1:7420",
      hostHeader: "[::]:7420",
      bind,
      port,
    }),
    false,
  );
  assert.equal(
    writeOriginIsAllowed({
      origin: "http://127.0.0.1:7420",
      hostHeader: "0.0.0.0:7420",
      bind,
      port,
    }),
    false,
  );
});
