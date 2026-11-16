const { test } = require("node:test");
const assert = require("node:assert/strict");
const { issueSession, BASE_URL } = require("../../docs/integrations/orukeet/issue-session.cjs");
const token = "us-west1.test-one-use-token.signature";
const payload = { token, expires_in: 60, single_use: true, protocol: "orukeet.pcm.v1" };

test("backend uses fixed TLS destination and returns only desktop-safe fields", async () => {
  const session = await issueSession({
    serviceKey: "test-service-key",
    fetchImpl: async (url, options) => {
      assert.equal(url, BASE_URL + "/v1/client-token");
      assert.equal(options.headers.Authorization, "Bearer test-service-key");
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      return { ok: true, json: async () => ({ ...payload, extra: "private" }) };
    },
  });
  assert.equal(session.clientToken, token);
  assert.equal(session.singleUse, true);
  assert.ok(!JSON.stringify(session).includes("test-service-key"));
  assert.ok(!("extra" in session));
});

test("missing backend credential fails before any network call", async () => {
  await assert.rejects(
    issueSession({ fetchImpl: () => assert.fail("network called") }),
    /required/
  );
});

test("backend binds an opaque account and requires gateway acknowledgement", async () => {
  const session = await issueSession({
    serviceKey: "private",
    accountId: "opaque-user-1234",
    fetchImpl: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), {
        account_id: "opaque-user-1234",
        socket_role: "warm",
      });
      return { ok: true, json: async () => ({ ...payload, account_limits: true }) };
    },
  });
  assert.ok(!JSON.stringify(session).includes("opaque-user-1234"));
  await assert.rejects(
    issueSession({
      serviceKey: "private",
      accountId: "opaque-user-1234",
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
    }),
    /Invalid Orukeet session response/
  );
});

test("invalid account claims fail before network access", async () => {
  for (const accountId of ["email@example.com", "short", null, 123]) {
    await assert.rejects(
      issueSession({
        serviceKey: "private",
        accountId,
        fetchImpl: () => assert.fail("network called"),
      }),
      /accountId must/
    );
  }
});

test("upstream errors do not disclose credentials or response bodies", async () => {
  await assert.rejects(
    issueSession({
      serviceKey: "private",
      fetchImpl: async () => {
        throw new Error("private request");
      },
    }),
    /^Error: Orukeet session service is unavailable$/
  );
  await assert.rejects(
    issueSession({
      serviceKey: "private",
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        json: () => assert.fail("should not read body"),
      }),
    }),
    /HTTP 429/
  );
});

for (const invalid of [
  null,
  { ...payload, token: "bad,token" },
  { ...payload, single_use: false },
  { ...payload, expires_in: 0 },
  { ...payload, protocol: "other" },
]) {
  test(`reject invalid session contract ${JSON.stringify(invalid)}`, async () => {
    await assert.rejects(
      issueSession({
        serviceKey: "private",
        fetchImpl: async () => ({
          ok: true,
          json: async () => invalid,
        }),
      }),
      /Invalid Orukeet session response/
    );
  });
}
