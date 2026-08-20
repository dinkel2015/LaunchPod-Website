/* Guard-rail tests that need no live credentials: the things that must
   fail closed. */

import test from "node:test";
import assert from "node:assert/strict";
import { money } from "./square.js";
import { requireEnv, bearerToken, methodGuard } from "./http.js";

function mockRes() {
  const res = {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
  };
  return res;
}

test("money() rejects anything that isn't a non-negative integer of cents", () => {
  assert.deepEqual(money(0), { amount: 0n, currency: "USD" });
  assert.deepEqual(money(129900), { amount: 129900n, currency: "USD" });

  // Floats are the dangerous case: 1299.5 cents silently truncating would
  // charge the wrong amount.
  for (const bad of [1299.5, -1, NaN, Infinity, "1299", null, undefined]) {
    assert.throws(() => money(bad), /non-negative integer of cents/, `accepted ${bad}`);
  }
});

test("requireEnv throws rather than defaulting when a secret is unset", () => {
  const key = "LPM_TEST_ENV_THAT_IS_NOT_SET";
  delete process.env[key];
  assert.throws(() => requireEnv(key), /Missing required environment variable/);

  process.env[key] = "value";
  assert.equal(requireEnv(key), "value");
  delete process.env[key];
});

test("requireEnv treats an empty string as missing", () => {
  // Vercel returns "" for a variable added but left blank; that must not
  // pass as a valid Square token or cron secret.
  const key = "LPM_TEST_EMPTY_ENV";
  process.env[key] = "";
  assert.throws(() => requireEnv(key), /Missing required environment variable/);
  delete process.env[key];
});

test("bearerToken only accepts a well-formed Bearer header", () => {
  assert.equal(bearerToken({ headers: { authorization: "Bearer abc123" } }), "abc123");
  assert.equal(bearerToken({ headers: {} }), null);
  assert.equal(bearerToken({ headers: { authorization: "abc123" } }), null);
  assert.equal(bearerToken({ headers: { authorization: "Basic abc123" } }), null);
  assert.equal(bearerToken({ headers: { authorization: "Bearer" } }), null);
});

test("methodGuard rejects the wrong verb with 405 and an Allow header", () => {
  const res = mockRes();
  assert.equal(methodGuard({ method: "GET" }, res, "POST"), false);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");

  const ok = mockRes();
  assert.equal(methodGuard({ method: "POST" }, ok, "POST"), true);
  assert.equal(ok.statusCode, null);
});

test("the cron route refuses to run without a matching CRON_SECRET", async () => {
  process.env.CRON_SECRET = "correct-horse";
  const { default: chargeCycle } = await import("../billing/charge-cycle.js");

  for (const authorization of [undefined, "Bearer wrong", "Bearer ", "correct-horse"]) {
    const res = mockRes();
    await chargeCycle({ method: "GET", headers: authorization ? { authorization } : {} }, res);
    assert.equal(res.statusCode, 401, `expected 401 for authorization=${authorization}`);
  }
  delete process.env.CRON_SECRET;
});

test("checkout refuses an unauthenticated caller before touching Square", async () => {
  const { default: checkout } = await import("../checkout.js");
  const res = mockRes();
  await checkout({ method: "POST", headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /bearer token/i);
});
