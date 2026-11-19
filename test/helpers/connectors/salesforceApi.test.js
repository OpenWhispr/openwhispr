const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSalesforceApi,
  normalizeSalesforceOrigin,
  SALESFORCE_API_BASE,
} = require("../../../src/helpers/connectors/salesforceApi");

const INSTANCE = "https://acme.my.salesforce.com";
const REQUEST = {
  instanceUrl: INSTANCE,
  accessToken: "access-private",
  method: "POST",
  path: "/services/data/v66.0/sobjects/Task",
  body: { Subject: "Meeting" },
};

function setup(response = new Response('{"id":"task"}', { status: 201 })) {
  const calls = [];
  const api = createSalesforceApi({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return { api, calls };
}

test("allows only HTTPS Salesforce My Domain origins and explicit OAuth login hosts", () => {
  for (const origin of [
    INSTANCE,
    "https://acme--test.sandbox.my.salesforce.com",
    "https://acme.develop.my.salesforce.com",
  ])
    assert.equal(normalizeSalesforceOrigin(origin), origin);
  for (const origin of ["https://login.salesforce.com", "https://test.salesforce.com"]) {
    assert.equal(normalizeSalesforceOrigin(origin), null);
    assert.equal(normalizeSalesforceOrigin(origin, { login: true }), origin);
  }
  for (const origin of [
    "http://acme.my.salesforce.com",
    "https://999.999.999.999",
    "https://acme.my.salesforce.com.evil.test",
    "https://user:secret@acme.my.salesforce.com",
    INSTANCE + "/path",
    INSTANCE + "/../",
    INSTANCE + "?x=1",
    INSTANCE + "#",
    INSTANCE + ":444",
    "https://acme.lightning.force.com",
    "https://my.salesforce.com",
    "https://evil.test",
  ])
    assert.equal(normalizeSalesforceOrigin(origin, { login: true }), null, origin);
});

test("refuses unsafe paths, destinations, methods and headers without dispatch", async () => {
  const { api, calls } = setup();
  for (const path of [
    "https://evil.test",
    "//evil.test",
    SALESFORCE_API_BASE + "/../oauth2/token",
    SALESFORCE_API_BASE + "/%2e%2e/token",
    SALESFORCE_API_BASE + "/sobjects/Task#x",
    SALESFORCE_API_BASE + "/sobjects\\Task",
    "/services/data/v99.0/query",
    "/services/oauth2/userinfo?x=1",
  ]) {
    assert.equal((await api.request({ ...REQUEST, path })).outcome, "failed", path);
  }
  for (const changes of [
    { instanceUrl: "https://evil.test" },
    { method: "DELETE" },
    { headers: { Authorization: "Bearer override" } },
    { headers: { Host: "evil.test" } },
  ])
    assert.equal((await api.request({ ...REQUEST, ...changes })).ok, false);
  assert.equal(calls.length, 0);
});

test("sends a bounded REST request with redirects disabled and supports empty PATCH success", async () => {
  const { api, calls } = setup(new Response(null, { status: 204 }));
  assert.deepEqual(
    await api.request({
      ...REQUEST,
      method: "PATCH",
      headers: { "If-Unmodified-Since": "Mon, 02 Nov 2026 12:00:00 GMT" },
    }),
    { ok: true, data: null }
  );
  assert.equal(calls[0].url, INSTANCE + REQUEST.path);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Authorization, "Bearer access-private");
  assert.equal(calls[0].init.headers["If-Unmodified-Since"], "Mon, 02 Nov 2026 12:00:00 GMT");
});

test("OAuth exchanges post forms without secrets or redirects and reject unknown hosts", async () => {
  const { api, calls } = setup(new Response('{"access_token":"private"}'));
  await api.exchangeToken(
    { code: "code", client_id: "client", code_verifier: "verifier" },
    "https://test.salesforce.com"
  );
  assert.equal(calls[0].url, "https://test.salesforce.com/services/oauth2/token");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(new URLSearchParams(calls[0].init.body).get("code_verifier"), "verifier");
  assert.equal((await api.refreshToken({}, "https://evil.test")).ok, false);
  assert.equal((await api.revokeToken("private", "https://evil.test")).ok, false);
  assert.equal(calls.length, 1);
});

test("classifies definitive refusals and uncertain responses without exposing CRM messages", async () => {
  for (const [status, body, outcome, errorCode] of [
    [
      401,
      '[{"errorCode":"INVALID_SESSION_ID","message":"private"}]',
      "failed",
      "INVALID_SESSION_ID",
    ],
    [412, '[{"errorCode":"PRECONDITION_FAILED"}]', "failed", "PRECONDITION_FAILED"],
    [
      400,
      '[{"errorCode":"FIELD_CUSTOM_VALIDATION_EXCEPTION","message":"private"}]',
      "failed",
      "FIELD_CUSTOM_VALIDATION_EXCEPTION",
    ],
    [503, '{"message":"private"}', "unknown", "http_503"],
    // Without a Location header net.fetch does return the 3xx.
    [302, "", "unknown", "redirect_refused"],
    [201, "broken", "unknown", "bad_response"],
  ]) {
    const { api, calls } = setup(new Response(body, { status }));
    const result = await api.request(REQUEST);
    assert.equal(result.outcome, outcome);
    assert.equal(result.errorCode, errorCode);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.equal(calls.length, 1);
  }
});

test("a redirect, which Electron's net.fetch rejects, is refused and never followed", async () => {
  const { api, calls } = setup(new Error("Redirect was cancelled"));
  const result = await api.request(REQUEST);
  assert.equal(result.errorCode, "redirect_refused");
  assert.equal(result.outcome, "unknown");
  assert.equal(calls.length, 1);
});

test("transport failures are never retried and distinguish preconnect from uncertain writes", async () => {
  for (const [code, outcome] of [
    ["ENOTFOUND", "failed"],
    ["ECONNRESET", "unknown"],
  ]) {
    const { api, calls } = setup(Object.assign(new Error("private"), { code }));
    const result = await api.request(REQUEST);
    assert.equal(result.outcome, outcome);
    // Never an upper-case transport code, which would read as Salesforce's own.
    assert.equal(result.errorCode, "network");
    assert.equal(calls.length, 1);
  }
});
